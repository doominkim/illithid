/**
 * Importing hooks a tool already runs (user-level config). Each command a tool runs on an event becomes one candidate:
 * - a command that is a single existing script file → its content becomes the hook's script (the file itself is left alone)
 * - any other command → wrapped in a bash script (inlineCommand)
 * A candidate whose script matches a library hook with the same timing that isn't connected to this tool yet joins that hook
 * instead of making a new one (joins).
 *
 * Originals:
 * - Claude Code, Gemini CLI, Codex hooks.json: recorded in state.json pendingRetire (kind hook) — the next approved sync removes the
 *   original entry as it writes the app entry, so the tool never runs it twice and never goes without it
 * - Codex config.toml (outside the app block), GitHub Copilot, Grok CLI: the originals live in files the app does not edit (other
 *   hooks/*.json, tables outside the app block). They are left alone and the hook comes in turned off for that tool (originalKept)
 * A copy of each original entry is saved to backups/imported at import time.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { activeWorkspaceId } from './config'
import { hookEventInfo, isHookTool, type HookTiming, type HookTool } from './hookEvents'
import { HOOK_TOOLS } from './hookEvents'
import {
  hooksDir,
  hookTriggers,
  readHooks,
  type HookDoc,
  type HookToolSettings,
  type HookTrigger
} from './hooks'
import { LibraryError } from './libpath'
import { setToggle } from './manifest'
import { addPending, importedBackupRoot, importStamp, type PendingRetire } from './pendingRetire'
import { readScript, scanScriptFolder, scriptDirPath } from './scripts'
import { readState, writeState } from './state'
import {
  appHookName,
  CODEX_HOOKS_JSON,
  hookEntryHash,
  PROMPT_MARK,
  TOML_HOOK_MARKERS
} from './targets/hooks'
import { outsideBlockMulti } from './text'
import type { ToolId } from './toolIds'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Tools whose original entries the next sync replaces (the app edits their settings.json entry by entry) */
export const HOOK_REPLACE_TOOLS: readonly HookTool[] = ['claude', 'gemini']

/** Whether the next sync replaces this original: Claude Code and Gemini CLI settings, and Codex hooks.json */
function replacesOriginal(home: string, tool: HookTool, configPath: string): boolean {
  return (
    HOOK_REPLACE_TOOLS.includes(tool) ||
    (tool === 'codex' && configPath === join(home, CODEX_HOOKS_JSON))
  )
}

export type HookImportWarning =
  | 'inlineCommand'
  | 'originalKept'
  | 'toolVariable'
  /** The script calls files next to it: it comes in with its folder, as a folder library script */
  | 'folderScript'
  /** The script calls files next to it, in a folder it shares with others: it can't come in whole, so the original stays */
  | 'usesSiblings'

export interface HookImportVariant {
  /** First 12 chars of sha256 of the original entry */
  id: string
  tools: ToolId[]
  timing: HookTiming
  /** Trigger as the library stores it (timeout in seconds) */
  trigger: HookTrigger
  /** The tool's command, as written */
  command: string
  /** Script file the command runs (absolute), when it is a single existing file */
  scriptPath?: string
  /** What the hook becomes: a script running the command, or (Claude Code prompt hooks) a natural-language check */
  action: 'script' | 'ask'
  /** script: run.sh stored in the library */
  script: string
  /** ask: the original prompt */
  prompt?: string
  /** Library hook this one connects to instead of making a new hook */
  joins?: string
  /** The folder the script comes in with (a folder library script the hook uses), and the file it runs */
  folder?: { path: string; entry: string }
  warnings: HookImportWarning[]
  /** Config file the entry is in (absolute) */
  configPath: string
  portability: 'ok'
  reasons: []
  sources: { origin: 'tool'; sourceId: string; label: string; path: string }[]
}

export interface HookImportCandidate {
  kind: 'hook'
  name: string
  status: 'new' | 'conflict'
  conflicts: ('existsInLibrary' | 'sourcesDiffer' | 'invalidName')[]
  portability: 'ok'
  reasons: []
  variants: HookImportVariant[]
}

interface FoundEntry {
  event: string
  matcher?: string
  /** Handler object as written ({ type, command, timeout } or a flat Copilot entry) */
  handler: Json
  /** Claude Code prompt hook text (command is then '') */
  prompt?: string
  command: string
  configPath: string
}

/** pendingRetire path of an original handler: `<config file>#<hash>` (several handlers share one file) */
export const hookRetirePath = (configPath: string, hash: string): string => `${configPath}#${hash}`

function readJson(p: string): Json | null {
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as unknown
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/** Handlers of a nested hooks table ({ <Event>: [{ matcher?, hooks: [{ type, command, timeout? }] }] }), app entries left out */
function nested(tool: HookTool, table: unknown, configPath: string): FoundEntry[] {
  const out: FoundEntry[] = []
  if (!isObj(table)) return out
  for (const [event, groups] of Object.entries(table)) {
    if (!Array.isArray(groups)) continue
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks)) continue
      const matcher = typeof g.matcher === 'string' && g.matcher ? g.matcher : undefined
      for (const h of g.hooks) {
        if (!isObj(h)) continue
        if (
          tool === 'claude' &&
          h.type === 'prompt' &&
          typeof h.prompt === 'string' &&
          !(typeof h.statusMessage === 'string' && h.statusMessage.startsWith(PROMPT_MARK))
        ) {
          out.push({
            event,
            ...(matcher ? { matcher } : {}),
            handler: h,
            command: '',
            prompt: h.prompt,
            configPath
          })
          continue
        }
        if (h.type !== 'command' || typeof h.command !== 'string') continue
        if (appHookName(tool, h.command)) continue
        out.push({
          event,
          ...(matcher ? { matcher } : {}),
          handler: h,
          command: h.command,
          configPath
        })
      }
    }
  }
  return out
}

/** Handlers of a flat Copilot table ({ <event>: [{ type, bash, matcher?, timeoutSec? }] }) */
function flat(table: unknown, configPath: string): FoundEntry[] {
  const out: FoundEntry[] = []
  if (!isObj(table)) return out
  for (const [event, list] of Object.entries(table)) {
    if (!Array.isArray(list)) continue
    for (const h of list) {
      const command = isObj(h) ? (h.bash ?? h.command) : undefined
      if (!isObj(h) || h.type !== 'command' || typeof command !== 'string') continue
      if (appHookName('copilot', command)) continue
      const matcher = typeof h.matcher === 'string' && h.matcher ? h.matcher : undefined
      out.push({ event, ...(matcher ? { matcher } : {}), handler: h, command, configPath })
    }
  }
  return out
}

function jsonFiles(dir: string, skip: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f !== skip && !f.startsWith('.'))
      .sort()
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

/** User-level hook handlers a tool runs */
function scanTool(home: string, tool: HookTool, notes: string[]): FoundEntry[] {
  const fromJson = (p: string, read: (o: Json) => FoundEntry[]): FoundEntry[] => {
    if (!existsSync(p)) return []
    const o = readJson(p)
    if (!o) {
      notes.push(`${p}: hooks not read (not plain JSON)`)
      return []
    }
    return read(o)
  }
  switch (tool) {
    case 'claude': {
      const p = join(home, '.claude/settings.json')
      return fromJson(p, (o) => nested(tool, o.hooks, p))
    }
    case 'gemini': {
      const p = join(home, '.gemini/settings.json')
      return fromJson(p, (o) => nested(tool, o.hooks, p))
    }
    case 'codex': {
      const hooksJson = join(home, CODEX_HOOKS_JSON)
      const toml = join(home, '.codex/config.toml')
      let fromToml: FoundEntry[] = []
      if (existsSync(toml))
        try {
          const outside = outsideBlockMulti(readFileSync(toml, 'utf8'), [TOML_HOOK_MARKERS])
          fromToml = nested(tool, (parseToml(outside) as Json).hooks, toml)
        } catch {
          notes.push(`${toml}: hooks not read (TOML parse failed)`)
        }
      return [...fromJson(hooksJson, (o) => nested(tool, o.hooks, hooksJson)), ...fromToml]
    }
    case 'copilot':
      return jsonFiles(join(home, '.copilot/hooks'), 'illithid.json').flatMap((p) =>
        fromJson(p, (o) => flat(o.hooks, p))
      )
    case 'grok':
      return jsonFiles(join(home, '.grok/hooks'), 'illithid.json').flatMap((p) =>
        fromJson(p, (o) => nested(tool, o.hooks, p))
      )
  }
}

/** A command that is one script file (`~/x.sh`, `$HOME/x.sh`, `/abs/x.sh`, quoted or not) → its absolute path */
function scriptFileOf(home: string, command: string): string | null {
  let c = command.trim()
  if ((c.startsWith("'") && c.endsWith("'")) || (c.startsWith('"') && c.endsWith('"')))
    c = c.slice(1, -1)
  if (!c || /\s/.test(c)) return null
  c = c.replace(/^~\//, `${home}/`).replace(/^\$\{?HOME\}?\//, `${home}/`)
  if (!c.startsWith('/')) return null
  try {
    return lstatSync(c).isFile() ? c : null
  } catch {
    return null
  }
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/-+$/, '')
      .slice(0, 64) || 'hook'
  )
}

/** A script that finds other files by its own location */
const SIBLING_RE =
  /\$\(\s*dirname\s+["']?\$\{?0|\$\{BASH_SOURCE(?:\[0\])?%\/\*\}|dirname\s+["']?\$\{?BASH_SOURCE|(?:^|[\s;&|])(?:source|\.)\s+["']?\.{1,2}\/|__dirname|__file__|import\.meta\.url/m

/**
 * The folder a script can come in with: its own folder when that holds only this script's files — not HOME, not a dot folder
 * in HOME (~/.claude), not a hooks folder shared by several scripts — and a copy of it would be accepted
 */
function ownFolder(home: string, script: string): string | null {
  const dir = dirname(script)
  const parent = dirname(dir)
  if (dir === home || parent === dirname(home) || basename(dir) === 'hooks') return null
  if (parent === home && basename(dir).startsWith('.')) return null
  try {
    return scanScriptFolder(dir).problem ? null : dir
  } catch {
    return null
  }
}

/** Library timeout (whole seconds) from the tool's own value */
function seconds(tool: HookTool, handler: Json): number | undefined {
  const v = tool === 'copilot' ? (handler.timeoutSec ?? handler.timeout) : handler.timeout
  if (typeof v !== 'number' || !(v > 0)) return undefined
  const s = tool === 'gemini' ? Math.ceil(v / 1000) : Math.ceil(v)
  return Math.min(Math.max(s, 1), 3600)
}

/** Import candidates from one tool. Read-only */
export function hookImportCandidates(
  home: string,
  tool: ToolId,
  sourceId: string,
  notes: string[]
): HookImportCandidate[] {
  if (!isHookTool(tool)) return []
  const library = readHooks(home)
  const out: HookImportCandidate[] = []
  // Folders under hooks/ that are not library hooks (no HOOK.md) still hold their names
  const dir = hooksDir(home)
  const taken = new Set(
    (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])
      .filter((d) => d.isDirectory() && !library.some((h) => h.name === d.name))
      .map((d) => d.name)
  )
  for (const e of scanTool(home, tool, notes)) {
    const info = hookEventInfo(tool, e.event)
    if (!info) {
      notes.push(`${tool} ${e.event}: no matching hook timing — not offered`)
      continue
    }
    const ask = e.prompt !== undefined
    if (ask && !['stop', 'before-tool', 'prompt'].includes(info.timing)) {
      notes.push(
        `${tool} ${e.event}: prompt hook at a timing Illithid has no check for — not offered`
      )
      continue
    }
    const scriptPath = ask ? undefined : (scriptFileOf(home, e.command) ?? undefined)
    const script = ask
      ? ''
      : scriptPath
        ? readFileSync(scriptPath, 'utf8')
        : `#!/usr/bin/env bash\n${e.command}\n`
    const warnings: HookImportWarning[] = []
    if (!ask && !scriptPath) warnings.push('inlineCommand')
    if (/\b(CLAUDE|GEMINI|CODEX)_[A-Z_]*DIR\b/.test(e.command)) warnings.push('toolVariable')
    // A script calling files next to it: with its own folder, or not at all (the original then stays)
    const siblings = !!scriptPath && SIBLING_RE.test(script)
    const folderPath = siblings ? ownFolder(home, scriptPath!) : null
    if (folderPath) warnings.push('folderScript')
    else if (siblings) warnings.push('usesSiblings')
    if (!replacesOriginal(home, tool, e.configPath) || (siblings && !folderPath))
      warnings.push('originalKept')
    const timeout = seconds(tool, e.handler)
    const trigger: HookTrigger = {
      event: e.event,
      ...(e.matcher && info.matcher ? { matcher: e.matcher } : {}),
      ...(timeout !== undefined ? { timeout } : {})
    }
    // A library script hook at the same timing running the same script: this original is that hook in another tool
    // A folder script only joins a hook running a folder script too (a run.sh of the same content lacks the other files)
    const joins = ask
      ? undefined
      : library.find(
          (h) =>
            h.doc.action === 'script' &&
            h.doc.when === info.timing &&
            !!folderPath === !!h.folder &&
            Object.values(h.scripts).includes(script)
        )?.name
    let name =
      joins ??
      (folderPath
        ? slug(basename(folderPath))
        : scriptPath
          ? slug(basename(scriptPath).replace(/\.[^.]+$/, ''))
          : slug(`${tool}-${e.event}`))
    if (!joins) {
      const base = name
      for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
    }
    taken.add(name)
    const conflicts: HookImportCandidate['conflicts'] = []
    if (!NAME_RE.test(name)) conflicts.push('invalidName')
    if (!joins && library.some((h) => h.name === name)) conflicts.push('existsInLibrary')
    out.push({
      kind: 'hook',
      name,
      status: conflicts.length ? 'conflict' : 'new',
      conflicts,
      portability: 'ok',
      reasons: [],
      variants: [
        {
          id: hookEntryHash(e.event, e.matcher, e.handler).slice(0, 12),
          tools: [tool],
          timing: info.timing,
          trigger,
          command: e.command,
          ...(scriptPath ? { scriptPath } : {}),
          action: ask ? 'ask' : 'script',
          script,
          ...(ask ? { prompt: e.prompt } : {}),
          ...(joins ? { joins } : {}),
          ...(folderPath && !joins
            ? { folder: { path: folderPath, entry: basename(scriptPath!) } }
            : {}),
          warnings,
          configPath: e.configPath,
          portability: 'ok',
          reasons: [],
          sources: [{ origin: 'tool', sourceId, label: tool, path: e.configPath }]
        }
      ]
    })
  }
  return out
}

export interface HookImportDeps {
  createHookFiles: (name: string, doc: HookDoc, script?: string) => void
  /** A folder comes in as a folder library script */
  importFolder: (name: string, from: string, entry: string) => void
  saveDoc: (name: string, doc: HookDoc) => void
  trashHook: (name: string) => string
}

/** The trigger as advanced per-tool settings (only what differs from what the hook would pick itself) */
function toolSettings(doc: HookDoc, tool: HookTool, t: HookTrigger): HookToolSettings {
  const auto = hookTriggers({ ...doc, tools: {} })[tool]
  return {
    ...(t.event !== auto?.event ? { event: t.event } : {}),
    ...(t.matcher !== auto?.matcher && t.matcher !== undefined ? { matcher: t.matcher } : {}),
    ...(t.timeout !== undefined ? { timeout: t.timeout } : {})
  }
}

/**
 * Add one candidate to the library. Library writes go through deps (library.ts) so this module stays free of library internals.
 * A new hook is on only for the tool it came from (like other imports). Returns where an overwritten hook went
 */
export function applyHookCandidate(
  home: string,
  c: HookImportCandidate,
  v: HookImportVariant,
  overwrite: boolean,
  deps: HookImportDeps
): { trashPath?: string } {
  const tool = v.tools[0]
  if (!isHookTool(tool)) throw new LibraryError('invalidSchema', `${tool} has no hooks`)
  let trashPath: string | undefined
  if (v.joins) {
    const h = readHooks(home).find((x) => x.name === v.joins)
    if (!h) throw new LibraryError('notFound', 'hook to join is gone')
    const s = toolSettings(h.doc, tool, v.trigger)
    const tools = { ...h.doc.tools }
    if (Object.keys(s).length) tools[tool] = s
    else delete tools[tool]
    deps.saveDoc(h.name, { ...h.doc, ...(Object.keys(tools).length ? { tools } : {}) })
    setToggle(home, 'hooks', h.name, tool, true)
  } else {
    if (c.conflicts.includes('existsInLibrary')) {
      if (!overwrite) throw new LibraryError('exists', 'a hook with the same name exists')
      trashPath = deps.trashHook(c.name)
    }
    // A script with its folder: a folder library script under a free name, which the hook uses
    let use: string | undefined
    if (v.folder) {
      const base = slug(basename(v.folder.path))
      use = base
      for (let i = 2; readScript(home, use) || existsSync(scriptDirPath(home, use)); i++)
        use = `${base}-${i}`
      deps.importFolder(use, v.folder.path, v.folder.entry)
    }
    const base: HookDoc = {
      description: '',
      when: v.timing,
      action: v.action,
      options: v.action === 'ask' ? { verbatim: true } : use ? { use } : {},
      body: v.prompt ?? '',
      importedFrom: tool
    }
    const s = toolSettings(base, tool, v.trigger)
    const doc: HookDoc = { ...base, ...(Object.keys(s).length ? { tools: { [tool]: s } } : {}) }
    deps.createHookFiles(c.name, doc, v.action === 'script' && !use ? v.script : undefined)
    // Like other imports: on only for the tool it came from
    for (const other of HOOK_TOOLS)
      if (other !== tool && hookTriggers(doc)[other]) setToggle(home, 'hooks', c.name, other, false)
  }
  // A copy of the original entry, before anything on the tool side changes
  const ts = importStamp()
  const backup = join(importedBackupRoot(home), ts, tool, 'hooks', `${c.name}.json`)
  mkdirSync(join(backup, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(
    backup,
    JSON.stringify({ configPath: v.configPath, trigger: v.trigger, command: v.command }, null, 2) +
      '\n',
    { mode: 0o600 }
  )
  const name = v.joins ?? c.name
  if (replacesOriginal(home, tool, v.configPath) && !v.warnings.includes('usesSiblings')) {
    // The next approved sync removes the original as it writes the app entry
    const st = readState(home)
    if (st.error) throw new LibraryError('configError', `state.json: ${st.error}`)
    const state = { ...st.state }
    const hash = fullHash(home, tool, v)
    const record: PendingRetire = {
      kind: 'hook',
      tool,
      name,
      path: hookRetirePath(v.configPath, hash),
      hash,
      at: new Date().toISOString(),
      workspace: activeWorkspaceId(home)
    }
    addPending(state, [record])
    writeState(home, state)
  } else setToggle(home, 'hooks', name, tool, false)
  return trashPath ? { trashPath } : {}
}

/** Full hash of the variant's original handler (the variant id is its first 12 chars) */
function fullHash(home: string, tool: HookTool, v: HookImportVariant): string {
  const e = scanTool(home, tool, []).find(
    (x) =>
      x.configPath === v.configPath && hookEntryHash(x.event, x.matcher, x.handler).startsWith(v.id)
  )
  if (!e) throw new LibraryError('notFound', 'the original hook changed since the plan')
  return hookEntryHash(e.event, e.matcher, e.handler)
}
