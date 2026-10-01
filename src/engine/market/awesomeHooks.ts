/**
 * github/awesome-copilot `hooks/` packs (MIT) as hook sources. There is no data index for hooks, so the list comes from the
 * repository tree (HEAD + recursive tree: 2 API calls) and each pack's README.md and hooks.json from raw files pinned to that
 * commit. The list is cached for a day under the app config folder.
 *
 * A pack is a Copilot CLI hooks.json ({version, hooks: {<event>: [{type, bash, powershell?, cwd, env, timeoutSec}]}}) with its
 * scripts. Each bash entry becomes one library hook (script action) whose run.sh is the entry's script. Entries Illithid can't
 * carry over are kept in the list with a reason: Windows-only (no bash), an event Copilot doesn't have, a script that isn't in
 * the pack, or a script that loads other files of its pack (only run.sh is copied into the tools)
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import { appConfigDir } from '../config'
import { HOOK_CATALOG, type HookTiming } from '../hookEvents'
import { atomicWrite } from '../write'
import { dirSha, listTree, rawFile, resolveSha, type TreeEntry } from './github'
import { isObj, MarketError, str, type FetchFn } from './http'
import { INDEX_TTL_MS } from './awesomeCopilot'

export const HOOKS_REPO = 'github/awesome-copilot'
const PACK_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/
const SCRIPT_MAX_BYTES = 256 * 1024

export type HookEntryProblem = 'noBash' | 'unknownEvent' | 'notInPack' | 'needsOtherFiles'

export interface MarketHookEntry {
  /** Copilot event name */
  event: string
  timing: HookTiming
  /** Script path inside the pack folder ('' when it can't be resolved) */
  script: string
  env: Record<string, string>
  timeoutSec?: number
  problem?: HookEntryProblem
}

export interface MarketHookPack {
  /** Folder name under hooks/ */
  id: string
  name: string
  description: string
  tags: string[]
  entries: MarketHookEntry[]
  /** At least one entry can be installed */
  installable: boolean
  /** Commit the pack was read at */
  sha: string
  /** Tree SHA of the pack folder (update marker) */
  treeSha: string
  /** Files of the pack (paths inside its folder) */
  files: string[]
}

function cachePath(home: string): string {
  return join(appConfigDir(home), 'cache', 'awesome-copilot-hooks.json')
}

const decode = (b: Uint8Array): string => new TextDecoder().decode(b)

/** Copilot event → timing (Copilot is the format these packs are written for) */
function timingOf(event: string): HookTiming | null {
  return HOOK_CATALOG.copilot.events.find((e) => e.event === event)?.timing ?? null
}

/** `.github/hooks/<pack>/x.sh`, `hooks/<pack>/x.sh` or `x.sh` → `x.sh` when it is a file of the pack */
function resolveScript(pack: string, bash: string, files: string[]): string {
  let p = bash.trim().replace(/^\.\//, '')
  for (const prefix of [`.github/hooks/${pack}/`, `hooks/${pack}/`])
    if (p.startsWith(prefix)) p = p.slice(prefix.length)
  return files.includes(p) && !p.split('/').includes('..') ? p : ''
}

function parseEntries(pack: string, hooksJson: unknown, files: string[]): MarketHookEntry[] {
  if (!isObj(hooksJson) || !isObj(hooksJson.hooks)) return []
  const out: MarketHookEntry[] = []
  for (const [event, list] of Object.entries(hooksJson.hooks)) {
    if (!Array.isArray(list)) continue
    const timing = timingOf(event)
    for (const e of list) {
      if (!isObj(e)) continue
      const bash = str(e.bash)
      const env: Record<string, string> = {}
      if (isObj(e.env))
        for (const [k, v] of Object.entries(e.env))
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string') env[k] = v
      const script = bash ? resolveScript(pack, bash, files) : ''
      const problem: HookEntryProblem | undefined = !bash
        ? 'noBash'
        : !timing
          ? 'unknownEvent'
          : !script
            ? 'notInPack'
            : undefined
      out.push({
        event,
        timing: timing ?? 'session-end',
        script,
        env,
        ...(typeof e.timeoutSec === 'number' && e.timeoutSec > 0
          ? { timeoutSec: Math.min(Math.round(e.timeoutSec), 3600) }
          : {}),
        ...(problem ? { problem } : {})
      })
    }
  }
  return out
}

function packFiles(entries: TreeEntry[], id: string): string[] {
  const dir = `hooks/${id}/`
  return entries
    .filter((e) => e.type === 'blob' && e.path.startsWith(dir))
    .map((e) => e.path.slice(dir.length))
    .sort()
}

/** The packs, from cache when younger than a day (force = refetch) */
export async function listHookPacks(
  fetchFn: FetchFn,
  home: string,
  opts: { force?: boolean; now?: number } = {}
): Promise<MarketHookPack[]> {
  const now = opts.now ?? Date.now()
  const p = cachePath(home)
  if (!opts.force && existsSync(p)) {
    try {
      const c = JSON.parse(readFileSync(p, 'utf8')) as {
        fetchedAt?: number
        packs?: MarketHookPack[]
      }
      if (
        typeof c.fetchedAt === 'number' &&
        now - c.fetchedAt < INDEX_TTL_MS &&
        Array.isArray(c.packs)
      )
        return c.packs
    } catch {
      // broken cache: refetch
    }
  }
  const sha = await resolveSha(fetchFn, HOOKS_REPO)
  const tree = await listTree(fetchFn, HOOKS_REPO, sha)
  const ids = tree.entries
    .filter((e) => e.type === 'tree' && /^hooks\/[^/]+$/.test(e.path))
    .map((e) => e.path.slice('hooks/'.length))
    .filter((id) => PACK_RE.test(id))
    .sort()
  const packs: MarketHookPack[] = []
  for (const id of ids) {
    const files = packFiles(tree.entries, id)
    if (!files.includes('hooks.json')) continue
    const [readme, hooksJson] = await Promise.all([
      files.includes('README.md')
        ? rawFile(fetchFn, HOOKS_REPO, sha, `hooks/${id}/README.md`, 256 * 1024).then(decode)
        : Promise.resolve(''),
      rawFile(fetchFn, HOOKS_REPO, sha, `hooks/${id}/hooks.json`, 64 * 1024).then(decode)
    ])
    let fm: Record<string, unknown> = {}
    try {
      fm = matter(readme).data
    } catch {
      fm = {}
    }
    let json: unknown = null
    try {
      json = JSON.parse(hooksJson)
    } catch {
      json = null
    }
    const entries = parseEntries(id, json, files)
    packs.push({
      id,
      name: str(fm.name) ?? id,
      description: str(fm.description) ?? '',
      tags: Array.isArray(fm.tags) ? fm.tags.filter((t): t is string => typeof t === 'string') : [],
      entries,
      installable: entries.some((e) => !e.problem),
      sha,
      treeSha: dirSha(tree, `hooks/${id}`),
      files
    })
  }
  try {
    atomicWrite(p, JSON.stringify({ fetchedAt: now, packs }), { mode: 0o600 })
  } catch {
    // cache is optional
  }
  return packs
}

export interface PreparedHook {
  /** Library hook name */
  name: string
  when: HookTiming
  event: string
  /** run.sh content: the pack's script with the entry's env as defaults */
  content: string
  timeout?: number
  problem?: HookEntryProblem
}

export interface PreparedHookPack {
  pack: MarketHookPack
  readme: string
  hooks: PreparedHook[]
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The entry's env as defaults right after the shebang (a value the user already set wins). Python scripts get
 * os.environ.setdefault lines instead
 */
export function withEnvDefaults(script: string, env: Record<string, string>, file: string): string {
  const keys = Object.keys(env)
  const python = file.endsWith('.py')
  const shebang = script.startsWith('#!')
    ? ''
    : python
      ? '#!/usr/bin/env python3\n'
      : '#!/usr/bin/env bash\n'
  const text = shebang + script
  if (!keys.length) return text
  const nl = text.indexOf('\n')
  const head = nl === -1 ? text + '\n' : text.slice(0, nl + 1)
  const rest = nl === -1 ? '' : text.slice(nl + 1)
  const lines = keys.map((k) =>
    python
      ? `import os; os.environ.setdefault(${JSON.stringify(k)}, ${JSON.stringify(env[k])})`
      : `[ -n "\${${k}+x}" ] || ${k}=${q(env[k])}; export ${k}`
  )
  return head + lines.join('\n') + '\n' + rest
}

/** Library names for a pack's entries: the pack name, or pack-<timing> when it has several */
function entryNames(pack: MarketHookPack): string[] {
  const count = pack.entries.length
  const seen = new Map<string, number>()
  return pack.entries.map((e) => {
    const base = count === 1 ? pack.id : `${pack.id}-${e.timing}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return (n === 1 ? base : `${base}-${n}`).slice(0, 64)
  })
}

/** Download a pack's scripts at the listed commit. invalid when nothing in it can be installed */
export async function preparePack(
  fetchFn: FetchFn,
  pack: MarketHookPack
): Promise<PreparedHookPack> {
  if (!pack.installable) throw new MarketError('invalid', 'nothing in this pack can be installed')
  const names = entryNames(pack)
  const readme = pack.files.includes('README.md')
    ? decode(await rawFile(fetchFn, HOOKS_REPO, pack.sha, `hooks/${pack.id}/README.md`, 256 * 1024))
    : ''
  const hooks: PreparedHook[] = []
  for (const [i, e] of pack.entries.entries()) {
    const base = { name: names[i], when: e.timing, event: e.event }
    if (e.problem) {
      hooks.push({ ...base, content: '', problem: e.problem })
      continue
    }
    const script = decode(
      await rawFile(fetchFn, HOOKS_REPO, pack.sha, `hooks/${pack.id}/${e.script}`, SCRIPT_MAX_BYTES)
    )
    // Only run.sh reaches the tools: a script that loads another file of its pack would not find it
    const others = pack.files.filter(
      (f) =>
        f !== e.script && !['README.md', 'hooks.json', 'LICENSE'].includes(f) && !f.endsWith('.ps1')
    )
    const needsOther = others.some((f) => script.includes(f.split('/').pop()!))
    hooks.push({
      ...base,
      content: needsOther ? '' : withEnvDefaults(script, e.env, e.script),
      ...(e.timeoutSec !== undefined ? { timeout: e.timeoutSec } : {}),
      ...(needsOther ? { problem: 'needsOtherFiles' as const } : {})
    })
  }
  return { pack, readme, hooks }
}

/** One pack by id, listed and prepared (force = refetch the list, for updates) */
export async function prepareHookPack(
  fetchFn: FetchFn,
  home: string,
  id: string,
  opts: { force?: boolean } = {}
): Promise<PreparedHookPack> {
  if (!PACK_RE.test(id)) throw new MarketError('invalid', 'invalid pack id')
  const pack = (await listHookPacks(fetchFn, home, opts)).find((p) => p.id === id)
  if (!pack) throw new MarketError('notFound', 'hook pack not found')
  return preparePack(fetchFn, pack)
}
