/**
 * Hook entries in each tool's config. Only app-owned entries (commands that run a script copy under
 * `<tool home>/hooks/illithid/`) are written or removed; the user's own hooks and every other key stay as they are.
 *
 * - claudeHooks   ~/.claude/settings.json      hooks.<Event>[] = { matcher?, hooks: [{ type, command, timeout }] }
 * - geminiHooks   ~/.gemini/settings.json      same shape, plus `name`; timeout in milliseconds
 * - codexHooks    ~/.codex/config.toml         [[hooks.<Event>]] tables inside the app marker block
 * - copilotHooks  ~/.copilot/hooks/illithid.json  the whole file: { version: 1, hooks: { <event>: [{ type, bash, matcher?, timeoutSec? }] } }
 * - grokHooks     ~/.grok/hooks/illithid.json     the whole file: { hooks: { <Event>: [{ matcher?, hooks: [...] }] } }
 */
import { createHash } from 'node:crypto'
import { parse as parseToml } from 'smol-toml'
import { HOOK_CATALOG, type HookTool } from '../hookEvents'
import { hookCommand, hooksForTool, toolTimeout, type ToolHook } from '../hookRender'
import {
  blockBodyMulti,
  parseJsonObject,
  presentMarkers,
  removeBlockMulti,
  spliceBlockMulti,
  toJsonText,
  untouchedKeysSame,
  type MarkerPair
} from '../text'
import {
  TargetError,
  type BuildContext,
  type BuildResult,
  type ServerChange,
  type TargetDef,
  type TargetId
} from '../types'
import { LEGACY_TOML_MCP_MARKERS, TOML_MCP_MARKERS } from './codexMcp'
import { parsePlainJsonConfig, toSettingsText } from './geminiMcp'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** `/.<tool home>/hooks/illithid/<hook>/<file>' <tool>` at the end of an app command */
const APP_COMMAND: Readonly<Record<HookTool, RegExp>> = {
  claude: /\/\.claude\/hooks\/illithid\/([^/']+)\/[^/']+' claude$/,
  codex: /\/\.codex\/hooks\/illithid\/([^/']+)\/[^/']+' codex$/,
  gemini: /\/\.gemini\/hooks\/illithid\/([^/']+)\/[^/']+' gemini$/,
  copilot: /\/\.copilot\/hooks\/illithid\/([^/']+)\/[^/']+' copilot$/,
  grok: /\/\.grok\/hooks\/illithid\/([^/']+)\/[^/']+' grok$/
}

/** Identity of one original handler (event + matcher + handler) — stays the same as long as the user doesn't edit it */
export function hookEntryHash(
  event: string,
  matcher: string | undefined,
  handler: unknown
): string {
  return createHash('sha256')
    .update(JSON.stringify([event, matcher ?? null, handler]))
    .digest('hex')
}

/**
 * Imported originals (pendingRetire kind hook) whose library hook goes in now: their handlers leave the user's groups (a group
 * left with no handler goes too). Returns the table and the hashes still present afterwards
 */
function dropImported(
  table: unknown,
  hashes: ReadonlySet<string>
): { table: unknown; present: Set<string> } {
  const present = new Set<string>()
  if (!isObj(table)) return { table, present }
  const next: Json = {}
  for (const [event, groups] of Object.entries(table)) {
    if (!Array.isArray(groups)) {
      next[event] = groups
      continue
    }
    const kept: unknown[] = []
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks)) {
        kept.push(g)
        continue
      }
      const matcher = typeof g.matcher === 'string' && g.matcher ? g.matcher : undefined
      const handlers = g.hooks.filter((h) => {
        const hash = hookEntryHash(event, matcher, h)
        if (hashes.has(hash)) return false
        present.add(hash)
        return true
      })
      if (handlers.length === g.hooks.length) kept.push(g)
      else if (handlers.length) kept.push({ ...g, hooks: handlers })
    }
    if (kept.length || !groups.length) next[event] = kept
  }
  return { table: next, present }
}

/** Hook name an app command belongs to, or null for the user's commands */
export function appHookName(tool: HookTool, command: unknown): string | null {
  if (typeof command !== 'string' || !command.startsWith("'")) return null
  return APP_COMMAND[tool].exec(command)?.[1] ?? null
}

/** Which hook a config entry belongs to: the hook of its command(s) when every command is the app's, else null */
function entryHook(tool: HookTool, entry: unknown): string | null {
  if (!isObj(entry)) return null
  if (HOOK_CATALOG[tool].shape === 'flat') return appHookName(tool, entry.bash)
  const list = entry.hooks
  if (!Array.isArray(list) || !list.length) return null
  const names = list.map((h) => (isObj(h) ? appHookName(tool, h.command) : null))
  return names.every((n) => n !== null && n === names[0]) ? names[0] : null
}

/** The `hooks` table → app entries per hook name (canonical JSON, events in key order) */
function appEntries(tool: HookTool, hooksTable: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!isObj(hooksTable)) return out
  for (const [event, list] of Object.entries(hooksTable)) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const name = entryHook(tool, entry)
      if (name) out.set(name, (out.get(name) ?? '') + JSON.stringify([event, entry]))
    }
  }
  return out
}

function regionOf(entries: Map<string, string>): string | null {
  if (!entries.size) return null
  return [...entries.keys()]
    .sort()
    .map((k) => `${k}=${entries.get(k)}`)
    .join('\n')
}

/** One config entry for a tool */
function renderEntry(home: string, tool: HookTool, h: ToolHook): Json {
  const command = hookCommand(home, tool, h.hook.name, h.file)
  const timeout = toolTimeout(tool, h.trigger.timeout)
  if (tool === 'copilot')
    return {
      type: 'command',
      bash: command,
      ...(h.trigger.matcher ? { matcher: h.trigger.matcher } : {}),
      ...(timeout !== undefined ? { timeoutSec: timeout } : {})
    }
  const handler: Json = {
    ...(tool === 'gemini' ? { name: `illithid-${h.hook.name}` } : {}),
    type: 'command',
    command,
    ...(timeout !== undefined ? { timeout } : {})
  }
  return { ...(h.trigger.matcher ? { matcher: h.trigger.matcher } : {}), hooks: [handler] }
}

/** Hooks this target writes (none for a retiring tool or a missing home) */
function wanted(tool: HookTool, ctx: BuildContext): ToolHook[] {
  if (ctx.retiring || !ctx.home) return []
  return hooksForTool(ctx.home, tool, ctx.sources.hooks ?? [], ctx.sources.manifest)
}

/**
 * `hooks` table with the app entries replaced: user entries keep their place, app entries go after them (sorted by hook name).
 * Event lists the app emptied are dropped; lists the user left empty stay
 */
function mergeHooksTable(
  home: string,
  tool: HookTool,
  table: unknown,
  hooks: ToolHook[]
): Json | undefined {
  if (table !== undefined && !isObj(table)) throw new TargetError('hooks is not an object')
  const next: Json = {}
  for (const [event, list] of Object.entries(table ?? {})) {
    if (!Array.isArray(list)) {
      next[event] = list
      continue
    }
    const kept = list.filter((e) => !entryHook(tool, e))
    if (kept.length || !list.length) next[event] = kept
  }
  for (const h of hooks) {
    const event = h.trigger.event
    const cur = Array.isArray(next[event]) ? (next[event] as unknown[]) : []
    next[event] = [...cur, renderEntry(home, tool, h)]
  }
  return Object.keys(next).length || table !== undefined ? next : undefined
}

/** User entries per event (for the "nothing else changed" check) */
function userEntries(tool: HookTool, table: unknown): string {
  if (table === undefined) return '{}'
  if (!isObj(table)) return JSON.stringify(table)
  const out: Json = {}
  for (const [event, list] of Object.entries(table))
    out[event] = Array.isArray(list) ? list.filter((e) => !entryHook(tool, e)) : list
  return JSON.stringify(
    Object.fromEntries(Object.entries(out).filter(([, v]) => !Array.isArray(v) || v.length))
  )
}

/** Settings-file targets (Claude, Gemini): only `hooks` changes, and inside it only app entries */
function settingsHooksTarget(id: TargetId, tool: 'claude' | 'gemini', rel: string): TargetDef {
  const parse = (text: string): Json =>
    tool === 'gemini' ? parsePlainJsonConfig(text, 'settings.json') : parseJsonObject(text)
  return {
    id,
    tool,
    rel,
    // Plain user config — created with only our keys when the tool is explicitly in use
    optional: false,
    createIfInUse: true,
    seed: '{}\n',
    region(text) {
      try {
        return regionOf(appEntries(tool, parse(text).hooks))
      } catch {
        return null
      }
    },
    build(before, ctx): BuildResult {
      const hooks = wanted(tool, ctx)
      const settings = parse(before)
      if (!hooks.length && !appEntries(tool, settings.hooks).size)
        return { after: before, notes: ['no app hooks — left untouched'], owned: [] }
      // Imported originals go out as their library hook comes in
      const records = (ctx.pendingRetire ?? []).filter((p) => p.kind === 'hook' && p.tool === tool)
      const names = new Set(hooks.map((h) => h.hook.name))
      const replacing = new Set(records.filter((p) => names.has(p.name)).map((p) => p.hash))
      const cleaned = dropImported(settings.hooks, replacing)
      const retired = records.filter((p) => !cleaned.present.has(p.hash)).map((p) => p.path)
      const table = mergeHooksTable(ctx.home ?? '', tool, cleaned.table, hooks)
      const next: Json = { ...settings }
      if (table && Object.keys(table).length) next.hooks = table
      else delete next.hooks
      const after = tool === 'gemini' ? toSettingsText(before, next) : toJsonText(next, before)
      const others = untouchedKeysSame(settings, next, 'hooks')
      const same = others.same && userEntries(tool, cleaned.table) === userEntries(tool, next.hooks)
      const notes = [
        `${hooks.length} app hooks${retired.length ? `, ${retired.length} imported originals replaced` : ''}, user hooks and other keys unchanged: ${same ? 'OK' : 'broken!'}`
      ]
      const owned = hooks.map((h) => h.hook.name)
      const extra = retired.length ? { retired } : {}
      return same
        ? { after, notes, owned, ...extra }
        : { after, notes, owned, ...extra, error: 'entries other than app hooks changed' }
    }
  }
}

export const claudeHooks = settingsHooksTarget('claudeHooks', 'claude', '.claude/settings.json')
export const geminiHooks = settingsHooksTarget('geminiHooks', 'gemini', '.gemini/settings.json')

/** App-owned whole files (Copilot, Grok) */
function ownFileTarget(id: TargetId, tool: 'copilot' | 'grok', rel: string): TargetDef {
  const render = (home: string, hooks: ToolHook[]): Json => {
    const table: Json = {}
    for (const h of hooks) {
      const list = (table[h.trigger.event] as unknown[] | undefined) ?? []
      table[h.trigger.event] = [...list, renderEntry(home, tool, h)]
    }
    return tool === 'copilot' ? { version: 1, hooks: table } : { hooks: table }
  }
  return {
    id,
    tool,
    rel,
    optional: true,
    seed: '',
    region(text) {
      if (!text.trim()) return null
      try {
        return regionOf(appEntries(tool, parseJsonObject(text).hooks))
      } catch {
        return null
      }
    },
    build(before, ctx): BuildResult {
      const hooks = wanted(tool, ctx)
      if (!before.trim() && !hooks.length)
        return { after: before, notes: ['no app hooks'], owned: [] }
      if (before.trim()) {
        const cur = parseJsonObject(before)
        // A file of the same name the app didn't write (no app entries but something else in it) is left alone
        if (
          !appEntries(tool, cur.hooks).size &&
          JSON.stringify(cur) !== JSON.stringify(render('', []))
        )
          throw new TargetError(`${rel} exists and is not the app's — not written`)
      }
      const after = toJsonText(render(ctx.home ?? '', hooks), before)
      return { after, notes: [`${hooks.length} app hooks`], owned: hooks.map((h) => h.hook.name) }
    }
  }
}

export const copilotHooks = ownFileTarget('copilotHooks', 'copilot', '.copilot/hooks/illithid.json')
export const grokHooks = ownFileTarget('grokHooks', 'grok', '.grok/hooks/illithid.json')

export const TOML_HOOK_MARKERS: MarkerPair = [
  '# BEGIN illithid hooks — DO NOT EDIT: generated from library hooks/',
  '# END illithid hooks'
]

const tomlString = (v: string): string => JSON.stringify(v)

function codexBody(home: string, hooks: ToolHook[]): string {
  const out: string[] = []
  for (const h of hooks) {
    const event = h.trigger.event
    const timeout = toolTimeout('codex', h.trigger.timeout)
    out.push(`[[hooks.${event}]]`)
    if (h.trigger.matcher) out.push(`matcher = ${tomlString(h.trigger.matcher)}`)
    out.push(
      '',
      `[[hooks.${event}.hooks]]`,
      'type = "command"',
      `command = ${tomlString(hookCommand(home, 'codex', h.hook.name, h.file))}`
    )
    if (timeout !== undefined) out.push(`timeout = ${timeout}`)
    out.push('')
  }
  while (out.length && !out[out.length - 1]) out.pop()
  return out.join('\n')
}

/**
 * Writes the block. A new one goes right before the app MCP block: codexMcp always moves its block to the end of the file, so a
 * hooks block appended after it would swap places on the next sync
 */
function withHookBlock(text: string, body: string): string {
  if (presentMarkers(text, [TOML_HOOK_MARKERS]))
    return spliceBlockMulti(text, TOML_HOOK_MARKERS, [], body)
  const mcp = presentMarkers(text, [TOML_MCP_MARKERS, ...LEGACY_TOML_MCP_MARKERS])
  if (!mcp) return spliceBlockMulti(text, TOML_HOOK_MARKERS, [], body)
  const i = text.indexOf(mcp[0])
  return `${text.slice(0, i)}${TOML_HOOK_MARKERS[0]}\n${body}\n${TOML_HOOK_MARKERS[1]}\n\n${text.slice(i)}`
}

/** ~/.codex/config.toml — app hook tables in their own marker block */
export const codexHooks: TargetDef = {
  id: 'codexHooks',
  tool: 'codex',
  rel: '.codex/config.toml',
  optional: false,
  createIfInUse: true,
  region: (text) => blockBodyMulti(text, [TOML_HOOK_MARKERS]),
  build(before, ctx): BuildResult {
    const hooks = wanted('codex', ctx)
    const after = hooks.length
      ? withHookBlock(before, codexBody(ctx.home ?? '', hooks))
      : removeBlockMulti(before, [TOML_HOOK_MARKERS])
    try {
      parseToml(after)
    } catch {
      return {
        after: before,
        notes: [
          'config.toml would not be valid TOML — a hooks table outside the app block clashes'
        ],
        error: 'invalid TOML result'
      }
    }
    return { after, notes: [`${hooks.length} app hooks`], owned: hooks.map((h) => h.hook.name) }
  }
}

export const HOOK_TARGETS: readonly TargetDef[] = [
  claudeHooks,
  codexHooks,
  geminiHooks,
  copilotHooks,
  grokHooks
]

export const HOOK_TARGET_OF: Readonly<Record<HookTool, TargetId>> = {
  claude: 'claudeHooks',
  codex: 'codexHooks',
  gemini: 'geminiHooks',
  copilot: 'copilotHooks',
  grok: 'grokHooks'
}

export const HOOK_TARGET_TOOL: Partial<Record<TargetId, HookTool>> = Object.fromEntries(
  Object.entries(HOOK_TARGET_OF).map(([tool, id]) => [id, tool])
)

/** App hook entries per hook name in a target file ({} for a missing file, null when it can't be read) */
export function hookTable(id: TargetId, text: string): Map<string, string> | null {
  const tool = HOOK_TARGET_TOOL[id]
  if (!tool) return new Map()
  if (!text.trim()) return new Map()
  try {
    if (tool === 'codex') {
      const body = blockBodyMulti(text, [TOML_HOOK_MARKERS])
      if (body === null) return new Map()
      return appEntries('codex', (parseToml(body) as Json).hooks)
    }
    return appEntries(tool, parseJsonObject(text).hooks)
  } catch {
    return null
  }
}

/** Hooks a change adds, updates or removes in one target file */
export function hookChanges(id: TargetId, before: string, after: string): ServerChange[] {
  const a = hookTable(id, before) ?? new Map<string, string>()
  const b = hookTable(id, after) ?? new Map<string, string>()
  const out: ServerChange[] = []
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!a.has(name)) out.push({ name, action: 'add' })
    else if (!b.has(name)) out.push({ name, action: 'remove' })
    else if (a.get(name) !== b.get(name)) out.push({ name, action: 'update' })
  }
  return out
}
