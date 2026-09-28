import { join } from 'node:path'
import { LEGACY_LIBRARY_DIR } from '../config'
import { retireHash, UNREADABLE_HASH, type PendingRetire } from '../pendingRetire'
import { isEnabled } from '../manifest'
import { parseJsonObject, toJsonText, untouchedKeysSame } from '../text'
import type { BuildContext, Sources, TargetDef } from '../types'
import { legacyLibraryAliases, previouslyOwned } from './toggles'

const KEY = 'instructions'

/** Absolute paths of enabled rule files (sorted by file name) */
export function enabledRulePaths(sources: Sources): string[] {
  return sources.rules
    .filter((r) => isEnabled(sources.manifest, 'rules', r.name, 'opencode'))
    .map((r) => join(sources.agentsDir, 'rules', r.name))
}

/** Library memory index path (only if present) */
export function memoryIndexPath(sources: Sources): string[] {
  return sources.memoryIndex === null ? [] : [join(sources.agentsDir, 'memory/MEMORY.md')]
}

/** App-owned entries for instructions = enabled rules + memory index */
export function ownedInstructionItems(sources: Sources): string[] {
  return [...enabledRulePaths(sources), ...memoryIndexPath(sources)]
}

/**
 * Entries from the previous system (sync.mjs era) — the `~/.agents/rules/*.md` glob and `~/.agents/memory/MEMORY.md`.
 * Treated as app-owned and replaced with the new library entries (both forms recognized until G3 retirement).
 * Also includes the library's own glob (when the library was registered the old way).
 */
export function legacyRuleGlobs(sources: Sources, home?: string): string[] {
  const out = new Set<string>([join(sources.agentsDir, 'rules', '*.md')])
  if (home) {
    const legacy = join(home, LEGACY_LIBRARY_DIR)
    for (const abs of [
      join(legacy, 'rules', '*.md'),
      join(legacy, 'memory', 'MEMORY.md'),
      join(sources.agentsDir, 'rules', '*.md')
    ]) {
      out.add(abs)
      if (abs.startsWith(home + '/')) out.add('~' + abs.slice(home.length))
    }
  }
  return [...out]
}

/** Owned entries = enabled rules and memory ∪ previously owned in state ∪ legacy entries ∪ library paths under previous app names */
function ownedSet(sources: Sources, ctx: BuildContext | undefined): Set<string> {
  const base = [
    ...ownedInstructionItems(sources),
    ...previouslyOwned(ctx, 'opencodeRules'),
    ...legacyRuleGlobs(sources, ctx?.home)
  ]
  return new Set([...base, ...legacyLibraryAliases(ctx?.home, base)])
}

/**
 * Replaces app-owned entries in instructions with the enabled rule list.
 * The list goes where the first owned entry was (or at the front if none); non-owned entries keep their order.
 */
export function rebuildInstructions(
  list: unknown[],
  enabled: string[],
  owned: Set<string>
): unknown[] {
  const out: unknown[] = []
  let placed = false
  for (const x of list) {
    if (typeof x === 'string' && owned.has(x)) {
      if (!placed) out.push(...enabled)
      placed = true
    } else out.push(x)
  }
  return placed ? out : [...enabled, ...out]
}

/**
 * Imported rule originals (pendingRetire kind=instruction): an entry pointing at a file that still matches its import hash is removed
 * only when the library entry for that rule goes in instead (enabled lists it) — otherwise OpenCode would lose the rule, so the entry
 * and its record stay. Changed files keep their entry (kept → importedChanged); unreadable ones too (not reported as changed).
 * Returns the list without the dropped entries + record paths no longer referenced
 */
function dropImportedEntries(
  list: unknown[],
  ctx: BuildContext,
  enabled: string[]
): { list: unknown[]; retired: string[]; kept: PendingRetire[] } {
  const pending = (ctx.pendingRetire ?? []).filter((p) => p.kind === 'instruction' && p.tool === 'opencode')
  if (!pending.length) return { list, retired: [], kept: [] }
  const home = ctx.home
  const abs = (x: string): string => (home && x.startsWith('~/') ? join(home, x.slice(2)) : x)
  const drop = new Set<string>()
  const kept: PendingRetire[] = []
  for (const p of pending) {
    const listed = list.some((x) => typeof x === 'string' && abs(x) === p.path)
    if (!listed) continue
    const cur = retireHash(p.path)
    const replacement = join(ctx.sources.agentsDir, 'rules', p.name)
    if (cur === p.hash) {
      if (enabled.includes(replacement)) drop.add(p.path)
    } else if (cur !== null && cur !== UNREADABLE_HASH) kept.push(p)
  }
  const next = list.filter((x) => !(typeof x === 'string' && drop.has(abs(x))))
  const retired = pending
    .filter((p) => !next.some((x) => typeof x === 'string' && abs(x) === p.path))
    .map((p) => p.path)
  return { list: next, retired, kept }
}

/** 7. ~/.config/opencode/opencode.json — only the library rule and memory entries in instructions (M7) */
export const opencodeRules: TargetDef = {
  id: 'opencodeRules',
  tool: 'opencode',
  rel: '.config/opencode/opencode.json',
  // opencode.json is plain user config (OpenCode runs without it) — created with only our keys when there is content, OpenCode is
  // explicitly in use and no opencode.jsonc is there (creating a second config file would change how OpenCode merges its settings)
  optional: false,
  createIfInUse: true,
  alternates: ['.config/opencode/opencode.jsonc'],
  seed: '{}\n',
  region: (text, sources, ctx) => {
    let obj: Record<string, unknown>
    try {
      obj = parseJsonObject(text)
    } catch {
      return null
    }
    const list = obj[KEY]
    if (!Array.isArray(list)) return null
    const owned = ownedSet(sources, ctx)
    const picked = list.filter((x) => typeof x === 'string' && owned.has(x))
    return picked.length ? JSON.stringify(picked) : null
  },
  build(before, ctx) {
    const { sources } = ctx
    const config = parseJsonObject(before)
    const next = structuredClone(config)
    const enabled = ownedInstructionItems(sources)
    const cur = config[KEY]
    const notes: string[] = []
    if (cur !== undefined && !Array.isArray(cur)) {
      return { after: before, notes, error: `${KEY} is not an array` }
    }
    const imported = dropImportedEntries((cur as unknown[] | undefined) ?? [], ctx, enabled)
    const list = imported.list
    const owned = ownedSet(sources, ctx)
    next[KEY] = rebuildInstructions(list, enabled, owned)
    const after = toJsonText(next, before)
    const kept = list.filter((x) => !(typeof x === 'string' && owned.has(x))).length
    const legacyHit = list.filter(
      (x) => typeof x === 'string' && legacyRuleGlobs(sources, ctx.home).includes(x)
    ).length
    const { count, same } = untouchedKeysSame(config, next, KEY)
    notes.push(
      `${KEY}: ${enabledRulePaths(sources).length} rules + ${memoryIndexPath(sources).length} memory (app-owned), ${kept} non-owned entries kept`
    )
    if (legacyHit) notes.push(`${legacyHit} legacy ~/.agents entries -> replaced with library paths`)
    const dropped = ((cur as unknown[] | undefined) ?? []).length - list.length
    if (dropped) notes.push(`${dropped} imported rule entries removed (replaced by the library copy)`)
    if (imported.kept.length)
      notes.push(`imported rule entries kept — original changed since import: ${imported.kept.map((p) => p.name).join(', ')}`)
    notes.push(`${count} keys other than ${KEY} unchanged: ${same ? 'OK' : 'broken!'}`)
    const retired = {
      ...(imported.retired.length ? { retired: imported.retired } : {}),
      ...(imported.kept.length ? { importedChanged: imported.kept } : {})
    }
    return same
      ? { after, notes, owned: enabled, ...retired }
      : { after, notes, owned: enabled, ...retired, error: `keys other than ${KEY} changed` }
  }
}
