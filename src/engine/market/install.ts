/**
 * Marketplace installs. Each kind is split in two: an async `prepare*` that does all network work, and a sync `commit*`
 * that only touches the library (so it runs inside the app's normal library-write path and sync).
 * New items are turned on only for the tools in use. Updates move the old copy to the library trash first.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import matter from 'gray-matter'
import { toolsInUse } from '../config'
import {
  copySkillIntoLibrary,
  createRule,
  deleteRule,
  deleteSkill,
  LibraryError,
  NAME_RE,
  readMcpServer,
  saveHookDoc,
  saveHookScript,
  upsertMcpServer,
  writeNewHook
} from '../library'
import { assertInsideLibrary } from '../libpath'
import { MANIFEST_TOOLS, setToggle, type ManifestKind } from '../manifest'
import type { SecretBackend } from '../secrets'
import type { McpServer } from '../types'
import { instructionBody, listInstructions, type MarketRuleItem } from './awesomeCopilot'
import { HOOKS_REPO, type PreparedHookPack } from './awesomeHooks'
import { HOOK_TOOLS } from '../hookEvents'
import { readHook, SHARED_SCRIPT, type HookDoc } from '../hooks'
import { dirSha, findSkillDir, listTree, rawFile, resolveSha, skillFilePlan } from './github'
import { MarketError, type FetchFn } from './http'
import {
  installChoices,
  packageRef,
  serverDetail,
  toMcpServer,
  type RegistryServer
} from './mcpRegistry'
import {
  itemExists,
  itemPath,
  liveOrigins,
  readOrigins,
  originKey,
  recordOrigin,
  type MarketKind,
  type MarketOrigin
} from './origins'
import { SKILL_ID_RE } from './skillsSh'

const MANIFEST_KIND: Record<MarketKind, ManifestKind> = {
  skill: 'skills',
  mcp: 'mcp',
  rule: 'rules',
  hook: 'hooks'
}

/** Turn a new item off for tools not in use (missing key = on) */
function applyInUseToggles(home: string, kind: MarketKind, name: string): void {
  const inUse = toolsInUse(home)
  const mk = MANIFEST_KIND[kind]
  for (const tool of MANIFEST_TOOLS[mk])
    if (!inUse.includes(tool)) setToggle(home, mk, name, tool, false)
}

function assertName(kind: MarketKind, name: string): void {
  if (
    typeof name !== 'string' ||
    !NAME_RE.test(name) ||
    name.includes('..') ||
    (kind === 'rule' && !name.endsWith('.md'))
  )
    throw new LibraryError('invalidName', `invalid ${kind} name format`)
}

function assertFree(home: string, kind: MarketKind, name: string): void {
  assertName(kind, name)
  if (itemExists(home, kind, name))
    throw new LibraryError('exists', `a ${kind} with the same name exists`)
}

function toName(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const n = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)
  return NAME_RE.test(n) ? n : undefined
}

// ---------------------------------------------------------------- skills

export interface PreparedSkill {
  source: string
  skillId: string
  sha: string
  /** Tree SHA of the skill folder (update marker) */
  treeSha: string
  dir: string
  files: { rel: string; data: Uint8Array; exec?: boolean }[]
  skipped: string[]
  /** Suggested library name */
  name: string
  description?: string
}

/** One HEAD + tree per repository, shared by bulk installs (the unauthenticated GitHub API allows 60 calls an hour) */
export type RepoTrees = Map<
  string,
  Promise<{ sha: string; tree: Awaited<ReturnType<typeof listTree>> }>
>

export async function prepareSkill(
  fetchFn: FetchFn,
  source: string,
  skillId: string,
  trees?: RepoTrees
): Promise<PreparedSkill> {
  if (!SKILL_ID_RE.test(skillId)) throw new MarketError('invalid', 'invalid skill id')
  const load = async (): Promise<{ sha: string; tree: Awaited<ReturnType<typeof listTree>> }> => {
    const sha = await resolveSha(fetchFn, source)
    return { sha, tree: await listTree(fetchFn, source, sha) }
  }
  let pending = trees?.get(source)
  if (!pending) {
    pending = load()
    trees?.set(source, pending)
  }
  const { sha, tree } = await pending
  const dir = findSkillDir(tree.entries, skillId)
  if (dir === null) throw new MarketError('notFound', 'SKILL.md not found')
  const plan = skillFilePlan(tree.entries, dir)
  const files: PreparedSkill['files'] = []
  // Small parallel batches: raw.githubusercontent.com is not API-limited, but don't open hundreds of sockets
  for (let i = 0; i < plan.files.length; i += 8) {
    const batch = plan.files.slice(i, i + 8)
    const got = await Promise.all(batch.map((f) => rawFile(fetchFn, source, sha, f.path)))
    got.forEach((data, j) => files.push({ rel: batch[j].rel, data, exec: batch[j].exec }))
  }
  const md = files.find((f) => f.rel === 'SKILL.md' || f.rel === 'skill.md')
  let fm: Record<string, unknown> = {}
  try {
    fm = matter(new TextDecoder().decode(md!.data)).data
  } catch {
    fm = {}
  }
  // A repository-root SKILL.md is only accepted when it is the skill that was asked for
  if (dir === '' && toName(typeof fm.name === 'string' ? fm.name : undefined) !== toName(skillId))
    throw new MarketError('notFound', 'SKILL.md not found')
  const name =
    toName(typeof fm.name === 'string' ? fm.name : undefined) ?? toName(skillId) ?? 'skill'
  return {
    source,
    skillId,
    sha,
    treeSha: dirSha(tree, dir),
    dir,
    files,
    skipped: plan.skipped,
    name,
    description: typeof fm.description === 'string' ? fm.description : undefined
  }
}

/** Write the prepared files into a temp folder (paths already validated; guarded again here) */
function stage(prep: PreparedSkill): string {
  const tmp = mkdtempSync(join(tmpdir(), 'illithid-skill-'))
  const root = join(tmp, 'skill')
  mkdirSync(root)
  for (const f of prep.files) {
    const dst = join(root, ...f.rel.split('/'))
    if (!dst.startsWith(root + sep)) throw new MarketError('invalid', 'invalid file path')
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, f.data, { flag: 'wx', mode: f.exec ? 0o755 : 0o644 })
  }
  return tmp
}

export function commitSkill(
  home: string,
  prep: PreparedSkill,
  name: string,
  opts: { update?: boolean } = {}
): { name: string } {
  if (opts.update) assertName('skill', name)
  else assertFree(home, 'skill', name)
  const tmp = stage(prep)
  try {
    if (opts.update && itemExists(home, 'skill', name)) {
      // Copy next to the old one first, then swap: a failed copy leaves the installed skill untouched
      const side = `${name.slice(0, 40)}.update-${Date.now().toString(36)}`
      const sidePath = copySkillIntoLibrary(home, side, join(tmp, 'skill'))
      try {
        deleteSkill(home, name)
      } catch (e) {
        rmSync(sidePath, { recursive: true, force: true })
        throw e
      }
      renameSync(sidePath, assertInsideLibrary(home, itemPath(home, 'skill', name)))
    } else copySkillIntoLibrary(home, name, join(tmp, 'skill'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  if (!opts.update) applyInUseToggles(home, 'skill', name)
  recordOrigin(home, {
    kind: 'skill',
    name,
    source: 'skills.sh',
    id: `${prep.source}/${prep.skillId}`,
    ref: prep.treeSha || prep.sha,
    path: prep.dir,
    installedAt: new Date().toISOString()
  })
  return { name }
}

// ---------------------------------------------------------------- MCP

export function commitMcp(
  home: string,
  server: RegistryServer,
  choiceId: string,
  values: Record<string, string>,
  name: string,
  secrets?: SecretBackend
): { name: string; warnings: string[] } {
  assertFree(home, 'mcp', name)
  const def = toMcpServer(server, choiceId, values)
  const r = upsertMcpServer(home, name, def, { secrets })
  applyInUseToggles(home, 'mcp', name)
  const [type, idx] = choiceId.split(':')
  const pkg = type === 'package' ? server.packages[Number(idx)] : undefined
  recordOrigin(home, {
    kind: 'mcp',
    name,
    source: 'mcp-registry',
    id: server.name,
    ref: server.version,
    choice: choiceId,
    pkg: pkg ? { type: pkg.registryType, id: baseId(pkg.registryType, pkg.identifier) } : undefined,
    installedAt: new Date().toISOString()
  })
  return { name, warnings: r.warnings }
}

/** Package identity across versions (OCI tags live in the identifier) */
function baseId(type: string, id: string): string {
  if (type !== 'oci') return id
  const at = id.indexOf('@')
  const noDigest = at >= 0 ? id.slice(0, at) : id
  const colon = noDigest.lastIndexOf(':')
  return colon > noDigest.lastIndexOf('/') ? noDigest.slice(0, colon) : noDigest
}

/**
 * Update an installed MCP server to a newer registry version: only the pinned package reference changes, so values the
 * user entered and Keychain references stay. Refuses when the package can't be matched (reinstall instead).
 * Remote servers have nothing to pin — only the recorded version moves
 */
export function commitMcpUpdate(
  home: string,
  name: string,
  server: RegistryServer
): { name: string; changed: boolean } {
  const o = readOrigins(home)[originKey('mcp', name)]
  if (!o) throw new LibraryError('notFound', 'not installed from the marketplace')
  let changed = false
  if (o.choice?.startsWith('package:')) {
    const want = o.pkg
    const next = want
      ? server.packages.find(
          (p) => p.registryType === want.type && baseId(p.registryType, p.identifier) === want.id
        )
      : undefined
    if (!want || !next)
      throw new MarketError('unsupported', 'package changed in the registry — reinstall to update')
    const def = readMcpServer(home, name) as McpServer
    const id = want.id
    const isRef = (a: string): boolean =>
      next.registryType === 'oci'
        ? a === id || a.startsWith(`${id}:`) || a.startsWith(`${id}@`)
        : a === id || a.startsWith(`${id}@`) || a.startsWith(`${id}==`)
    const args = Array.isArray(def.args) ? def.args : []
    if (!args.some(isRef))
      throw new MarketError(
        'unsupported',
        'installed command no longer matches — reinstall to update'
      )
    const nextRef = next.registryType === 'oci' ? next.identifier : packageRef(next)
    const updated = args.map((a) => (isRef(a) ? nextRef : a))
    changed = updated.some((a, i) => a !== args[i])
    if (changed) upsertMcpServer(home, name, { ...def, args: updated })
  }
  recordOrigin(home, { ...o, ref: server.version, installedAt: new Date().toISOString() })
  return { name, changed }
}

// ---------------------------------------------------------------- rules

export interface PreparedRule {
  item: MarketRuleItem
  body: string
  /** Suggested library name (with .md) */
  name: string
}

export async function prepareRule(
  fetchFn: FetchFn,
  home: string,
  id: string
): Promise<PreparedRule> {
  const item = (await listInstructions(fetchFn, home)).find((x) => x.id === id)
  if (!item) throw new MarketError('notFound', 'rule not found')
  return { item, body: await instructionBody(fetchFn, item.path), name: `${item.id}.md` }
}

export function commitRule(
  home: string,
  prep: PreparedRule,
  name: string,
  opts: { update?: boolean } = {}
): { name: string } {
  const file = name.endsWith('.md') ? name : `${name}.md`
  if (opts.update && itemExists(home, 'rule', file)) {
    // Old copy (with any local edits) goes to the library trash first; restored if the new write fails
    assertName('rule', file)
    const prev = readFileSync(assertInsideLibrary(home, itemPath(home, 'rule', file)), 'utf8')
    deleteRule(home, file)
    try {
      createRule(home, file, prep.body)
    } catch (e) {
      if (!existsSync(itemPath(home, 'rule', file))) createRule(home, file, prev)
      throw e
    }
  } else {
    assertFree(home, 'rule', file)
    createRule(home, file, prep.body)
    applyInUseToggles(home, 'rule', file)
  }
  recordOrigin(home, {
    kind: 'rule',
    name: file,
    source: 'awesome-copilot',
    id: prep.item.id,
    ref: prep.item.lastUpdated ?? '',
    installedAt: new Date().toISOString()
  })
  return { name: file }
}

// ---------------------------------------------------------------- hooks (awesome-copilot packs)

/**
 * Add a prepared pack: one script hook per installable entry, on for Copilot only (the scripts read Copilot's input), with the
 * entry's timeout. update: replace the scripts and timeouts of hooks already there (their toggles stay); new entries are added.
 * invalid when nothing in the pack can be installed; exists when a new hook's name is taken
 */
export function commitHookPack(
  home: string,
  prep: PreparedHookPack,
  opts: { update?: boolean } = {}
): { names: string[] } {
  const usable = prep.hooks.filter((h) => !h.problem)
  if (!usable.length) throw new MarketError('invalid', 'nothing in this pack can be installed')
  const fresh = usable.filter((h) => !(opts.update && itemExists(home, 'hook', h.name)))
  for (const h of fresh) assertFree(home, 'hook', h.name)
  for (const h of usable) {
    const doc: HookDoc = {
      description: prep.pack.description,
      when: h.when,
      action: 'script',
      options: { use: '' },
      ...(h.timeout !== undefined ? { tools: { copilot: { timeout: h.timeout } } } : {}),
      body: `From github/awesome-copilot hooks/${prep.pack.id} (Copilot ${h.event}).`
    }
    if (fresh.includes(h)) {
      writeNewHook(home, h.name, doc, h.content)
      for (const tool of HOOK_TOOLS)
        if (tool !== 'copilot') setToggle(home, 'hooks', h.name, tool, false)
    } else {
      saveHookScript(home, h.name, SHARED_SCRIPT, h.content)
      const cur = readHook(home, h.name).doc
      saveHookDoc(home, h.name, { ...cur, tools: { ...cur.tools, ...doc.tools } })
    }
    recordOrigin(home, {
      kind: 'hook',
      name: h.name,
      source: 'awesome-copilot',
      id: prep.pack.id,
      ref: prep.pack.treeSha,
      choice: h.event,
      installedAt: new Date().toISOString()
    })
  }
  return { names: usable.map((h) => h.name) }
}

// ---------------------------------------------------------------- updates

export interface MarketUpdate {
  kind: MarketKind
  name: string
  id: string
  current: string
  latest: string
}

/**
 * Items whose source moved on. One GitHub call per distinct skill repository, one registry call per server, one rule
 * index fetch. Per-item failures are skipped (reported in `failed`)
 */
export async function checkUpdates(
  fetchFn: FetchFn,
  home: string
): Promise<{ updates: MarketUpdate[]; failed: string[] }> {
  const updates: MarketUpdate[] = []
  const failed: string[] = []
  const origins = liveOrigins(home)
  const trees = new Map<string, Promise<Awaited<ReturnType<typeof listTree>>>>()
  let rules: Promise<MarketRuleItem[]> | undefined
  const one = async (o: MarketOrigin): Promise<void> => {
    try {
      const latest = await latestRef(
        fetchFn,
        o,
        trees,
        () => (rules ??= listInstructions(fetchFn, home, { force: true }))
      )
      if (latest && latest !== o.ref)
        updates.push({ kind: o.kind, name: o.name, id: o.id, current: o.ref, latest })
    } catch {
      failed.push(originKey(o.kind, o.name))
    }
  }
  for (let i = 0; i < origins.length; i += 6) await Promise.all(origins.slice(i, i + 6).map(one))
  const order = (k: string): number => origins.findIndex((o) => originKey(o.kind, o.name) === k)
  updates.sort((a, b) => order(originKey(a.kind, a.name)) - order(originKey(b.kind, b.name)))
  return { updates, failed }
}

async function latestRef(
  fetchFn: FetchFn,
  o: MarketOrigin,
  trees: Map<string, Promise<Awaited<ReturnType<typeof listTree>>>>,
  rules: () => Promise<MarketRuleItem[]>
): Promise<string | undefined> {
  if (o.kind === 'skill') {
    const repo = o.id.split('/').slice(0, 2).join('/')
    if (!trees.has(repo))
      trees.set(
        repo,
        resolveSha(fetchFn, repo).then((sha) => listTree(fetchFn, repo, sha))
      )
    return dirSha(await trees.get(repo)!, o.path ?? '') || undefined
  }
  if (o.kind === 'mcp') return (await serverDetail(fetchFn, o.id)).version
  if (o.kind === 'hook') {
    if (!trees.has(HOOKS_REPO))
      trees.set(
        HOOKS_REPO,
        resolveSha(fetchFn, HOOKS_REPO).then((sha) => listTree(fetchFn, HOOKS_REPO, sha))
      )
    return dirSha(await trees.get(HOOKS_REPO)!, `hooks/${o.id}`) || undefined
  }
  return (await rules()).find((r) => r.id === o.id)?.lastUpdated
}

/** Installed badge lookup: source id → library name (live items only) */
export function installedIndex(home: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const o of liveOrigins(home)) out[`${o.kind}:${o.id}`] = o.name
  return out
}

export { installChoices }
