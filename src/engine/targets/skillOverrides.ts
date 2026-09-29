/**
 * Tools' own skill-disable settings (source wins).
 * If a skill enabled in the library is separately disabled in a tool's settings, remove just that entry.
 * - Claude   ~/.claude/settings.json  skillOverrides.<name> = "off"
 * - Codex    ~/.codex/config.toml     [[skills.config]] name|path + enabled = false
 * - OpenCode opencode.json            permission.skill.<name> = "deny"
 * Skills not in the library, skills disabled in the library (handled by deleting copies), partial-disable values
 * (Claude name-only/user-invocable-only, OpenCode ask), and wildcard rules are user-owned and preserved.
 * OpenCode also works the other way: it has no skill copies to delete, so a library skill off for OpenCode gets a "deny".
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { ToolId } from '../agents'
import { isEnabled } from '../manifest'
import { parseJsonObject, toJsonText, untouchedKeysSame } from '../text'
import {
  TargetError,
  type BuildContext,
  type Sources,
  type TargetDef,
  type TargetId
} from '../types'
import { previouslyOwned } from './toggles'

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Skill names (folders) in library skills/ */
export function librarySkillNames(sources: Sources): string[] {
  const dir = join(sources.agentsDir, 'skills')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => {
      if (n.startsWith('.')) return false
      try {
        return statSync(join(dir, n)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}

/** Skills in the library and enabled for this tool */
function enabledLibrarySkills(sources: Sources, tool: ToolId): Set<string> {
  return new Set(
    librarySkillNames(sources).filter((n) => isEnabled(sources.manifest, 'skills', n, tool))
  )
}

// ---------------------------------------------------------------- Claude

const CLAUDE_KEY = 'skillOverrides'

function claudeHits(settings: Json, sources: Sources): string[] {
  const so = settings[CLAUDE_KEY]
  if (so === undefined) return []
  if (!isObj(so)) throw new TargetError(`${CLAUDE_KEY} is not an object`)
  const on = enabledLibrarySkills(sources, 'claude')
  return Object.keys(so)
    .filter((k) => on.has(k) && so[k] === 'off')
    .sort()
}

/** 10. ~/.claude/settings.json — remove only "off" entries in skillOverrides for skills enabled in the library */
export const claudeSkillOverrides: TargetDef = {
  id: 'claudeSkillOverrides',
  tool: 'claude',
  rel: '.claude/settings.json',
  optional: true,
  region: (text, sources) => {
    try {
      const hits = claudeHits(parseJsonObject(text), sources)
      return hits.length ? JSON.stringify(hits) : null
    } catch {
      return null
    }
  },
  build(before, { sources }) {
    if (!before.trim()) return { after: before, notes: ['settings.json missing — left untouched'] }
    const settings = parseJsonObject(before)
    const hits = claudeHits(settings, sources)
    if (!hits.length)
      return { after: before, notes: [`${CLAUDE_KEY}: no library skills disabled`] }
    const next = structuredClone(settings)
    const so = { ...(next[CLAUDE_KEY] as Json) }
    for (const k of hits) delete so[k]
    if (Object.keys(so).length) next[CLAUDE_KEY] = so
    else delete next[CLAUDE_KEY]
    const after = toJsonText(next, before)
    const kept = Object.keys(so).length
    const rest = untouchedKeysSame(settings, next, CLAUDE_KEY)
    const keptSame = Object.entries(so).every(([k, v]) =>
      same((settings[CLAUDE_KEY] as Json)[k], v)
    )
    const notes = [
      `${CLAUDE_KEY}: removed "off" for ${hits.length} library skill(s) (${hits.join(', ')}), kept ${kept} other(s)`,
      `${rest.count} keys other than ${CLAUDE_KEY} unchanged: ${rest.same ? 'OK' : 'broken!'}`
    ]
    return rest.same && keptSame
      ? { after, notes }
      : { after, notes, error: `keys other than ${CLAUDE_KEY} changed` }
  }
}

// ---------------------------------------------------------------- Codex

interface CodexEntry {
  name?: unknown
  path?: unknown
  enabled?: unknown
}

/** Codex skill copy path → skill name (folder or SKILL.md, absolute or ~ form) */
function codexPathMap(home: string | undefined, on: Set<string>): Map<string, string> {
  const m = new Map<string, string>()
  if (!home) return m
  for (const n of on) {
    const dir = join(home, '.codex/skills', n)
    for (const p of [dir, join(dir, 'SKILL.md')]) {
      m.set(p, n)
      m.set('~' + p.slice(home.length), n)
    }
  }
  return m
}

function codexHitName(e: unknown, on: Set<string>, paths: Map<string, string>): string | null {
  if (!isObj(e)) return null
  const { name, path, enabled } = e as CodexEntry
  if (enabled !== false) return null
  if (typeof name === 'string' && path === undefined) return on.has(name) ? name : null
  if (typeof path === 'string' && name === undefined) return paths.get(path) ?? null
  return null
}

function parseTomlOrThrow(text: string): Json {
  try {
    return parseToml(text) as Json
  } catch {
    throw new TargetError('TOML parse failed')
  }
}

/** skills.config array of the parsed config ([] if absent) */
function codexConfigList(root: Json): unknown[] {
  const skills = root.skills
  if (skills === undefined) return []
  if (!isObj(skills)) throw new TargetError('skills is not a table')
  const list = skills.config
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new TargetError('skills.config is not an array')
  return list
}

const ARRAY_HEADER = /^\s*\[\[\s*skills\s*\.\s*config\s*\]\]\s*(#.*)?$/
const ANY_HEADER = /^\s*\[/

/** [[skills.config]] blocks to remove (line ranges) */
function codexRemovals(
  text: string,
  on: Set<string>,
  paths: Map<string, string>
): { start: number; end: number; name: string }[] {
  const lines = text.split('\n')
  const out: { start: number; end: number; name: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!ARRAY_HEADER.test(lines[i])) continue
    let j = i + 1
    while (j < lines.length && !ANY_HEADER.test(lines[j])) j++
    let body: Json
    try {
      body = parseToml(lines.slice(i + 1, j).join('\n')) as Json
    } catch {
      continue
    }
    const name = codexHitName(body, on, paths)
    if (name) out.push({ start: i, end: j, name })
    i = j - 1
  }
  return out
}

function codexContext(
  sources: Sources,
  ctx: BuildContext | undefined
): {
  on: Set<string>
  paths: Map<string, string>
} {
  const on = enabledLibrarySkills(sources, 'codex')
  return { on, paths: codexPathMap(ctx?.home, on) }
}

/** Everything except skills.config, for comparison (an empty skills table equals none) */
function withoutSkillConfig(root: Json): Json {
  const r = structuredClone(root)
  if (isObj(r.skills)) {
    const s = { ...r.skills }
    delete s.config
    if (Object.keys(s).length) r.skills = s
    else delete r.skills
  }
  return r
}

/** 11. ~/.codex/config.toml — remove only [[skills.config]] enabled = false blocks for skills enabled in the library */
export const codexSkillConfig: TargetDef = {
  id: 'codexSkillConfig',
  tool: 'codex',
  rel: '.codex/config.toml',
  optional: true,
  region: (text, sources, ctx) => {
    try {
      const { on, paths } = codexContext(sources, ctx)
      const hits = codexConfigList(parseTomlOrThrow(text))
        .map((e) => codexHitName(e, on, paths))
        .filter((n): n is string => !!n)
        .sort()
      return hits.length ? JSON.stringify(hits) : null
    } catch {
      return null
    }
  },
  build(before, ctx) {
    if (!before.trim()) return { after: before, notes: ['config.toml missing — left untouched'] }
    const root = parseTomlOrThrow(before)
    const { on, paths } = codexContext(ctx.sources, ctx)
    const list = codexConfigList(root)
    const hitIdx = list.map((e) => codexHitName(e, on, paths) !== null)
    const want = hitIdx.filter(Boolean).length
    if (!want) return { after: before, notes: ['skills.config: no library skills disabled'] }
    const removals = codexRemovals(before, on, paths)
    if (removals.length !== want)
      return {
        after: before,
        notes: [],
        error: 'skills.config not in [[skills.config]] table form is not modified'
      }
    const lines = before.split('\n')
    const drop = new Set<number>()
    for (const r of removals) for (let k = r.start; k < r.end; k++) drop.add(k)
    const after = lines
      .filter((_, k) => !drop.has(k))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
    // Verify: only the targeted skills.config entries are removed, the rest is unchanged
    const next = parseTomlOrThrow(after)
    const keptList = list.filter((_, k) => !hitIdx[k])
    const listOk = same(codexConfigList(next), keptList)
    const restOk = same(withoutSkillConfig(root), withoutSkillConfig(next))
    const names = removals.map((r) => r.name)
    const notes = [
      `skills.config: removed enabled = false for ${names.length} library skill(s) (${names.join(', ')}), kept ${keptList.length} other(s)`,
      `everything other than skills.config unchanged: ${listOk && restOk ? 'OK' : 'broken!'}`
    ]
    return listOk && restOk
      ? { after, notes }
      : { after: before, notes, error: 'content other than skills.config changed' }
  }
}

// ---------------------------------------------------------------- OpenCode

const OC_KEY = 'permission'
const OC_SUB = 'skill'
const OC_TARGET: TargetId = 'opencodeSkillPermissions'

/**
 * Library skills turned off for OpenCode — the sync writes permission.skill.<name> = "deny" for them.
 * OpenCode finds skills in every root (library skills.paths, ~/.claude/skills, ~/.agents/skills), so a name rule is the only
 * switch that hides a skill whichever root it comes from. A retiring OpenCode gets none (its own entries are removed)
 */
function opencodeDenied(src: Sources, ctx: BuildContext | undefined): Set<string> {
  if (ctx?.retiring || src.manifest?.offTools?.includes('opencode')) return new Set()
  return new Set(librarySkillNames(src).filter((n) => !isEnabled(src.manifest, 'skills', n, 'opencode')))
}

/** permission.skill as a per-skill object ({} if absent). A string applies to every skill and is kept as "*". undefined if not usable */
function opencodeRule(config: Json): Json | undefined {
  const perm = config[OC_KEY]
  if (perm === undefined) return {}
  if (!isObj(perm)) return undefined
  const rule = perm[OC_SUB]
  if (rule === undefined) return {}
  if (typeof rule === 'string') return { '*': rule }
  return isObj(rule) ? rule : undefined
}

/** Library skills on for OpenCode but denied in opencode.json (the sync removes the deny) */
function opencodeHits(config: Json, src: Sources, ctx?: BuildContext): string[] {
  const rule = opencodeRule(config)
  if (!rule) return []
  const off = opencodeDenied(src, ctx)
  const lib = new Set(librarySkillNames(src))
  return Object.keys(rule)
    .filter((k) => lib.has(k) && !off.has(k) && rule[k] === 'deny')
    .sort()
}

/**
 * 12. opencode.json permission.skill — "deny" for library skills off for OpenCode, placed last so they win over the user's
 * wildcard rules (OpenCode applies the last matching rule). A library skill on for OpenCode loses its "deny" (tool settings don't
 * override the library). Previously owned entries of skills that left the library are removed. Other values (ask, allow),
 * wildcards and names outside the library are user-owned and kept in place
 */
export const opencodeSkillPermissions: TargetDef = {
  id: OC_TARGET,
  tool: 'opencode',
  rel: '.config/opencode/opencode.json',
  optional: true,
  alternates: ['.config/opencode/opencode.jsonc'],
  region: (text, src, ctx) => {
    try {
      const rule = opencodeRule(parseJsonObject(text))
      if (!rule) return null
      // Only the "deny" entries the sync manages (library or previously owned names) — ask/allow values are the user's
      const names = new Set([...librarySkillNames(src), ...previouslyOwned(ctx, OC_TARGET)])
      const own = Object.keys(rule)
        .filter((k) => names.has(k) && rule[k] === 'deny')
        .sort()
      return own.length ? JSON.stringify(own) : null
    } catch {
      return null
    }
  },
  build(before, ctx) {
    const src = ctx.sources
    if (!before.trim()) return { after: before, notes: ['opencode.json missing — left untouched'] }
    const config = parseJsonObject(before)
    const deny = opencodeDenied(src, ctx)
    const owned = [...deny].sort()
    const rule = opencodeRule(config)
    if (!rule) {
      const bad = isObj(config[OC_KEY]) ? `${OC_KEY}.${OC_SUB}` : OC_KEY
      if (!deny.size) return { after: before, notes: [`${bad} is not a per-skill object — left untouched`] }
      return { after: before, notes: [], error: `${bad} is not an object` }
    }
    const lib = new Set(librarySkillNames(src))
    const prev = new Set(previouslyOwned(ctx, OC_TARGET))
    // Entries the sync removes: denies of library skills on for OpenCode, and of previously owned skills no longer denied
    const drop = (k: string): boolean =>
      rule[k] === 'deny' && !deny.has(k) && (lib.has(k) || prev.has(k))
    const kept = Object.fromEntries(Object.entries(rule).filter(([k]) => !deny.has(k) && !drop(k)))
    const nextRule: Json = { ...kept, ...Object.fromEntries(owned.map((k) => [k, 'deny'])) }
    // JSON objects always list integer-like keys first, so such a deny can't be placed after the user's rules
    const numeric = owned.filter((k) => /^(0|[1-9]\d*)$/.test(k))
    const numericNote =
      numeric.length && Object.keys(kept).length
        ? [`${OC_KEY}.${OC_SUB}: ${numeric.join(', ')} can't be placed last (numeric name) — a later wildcard rule may still show it`]
        : []
    if (JSON.stringify(Object.entries(nextRule)) === JSON.stringify(Object.entries(rule)))
      return {
        after: before,
        notes: [`${OC_KEY}.${OC_SUB}: ${owned.length} library skill(s) denied — already in place`, ...numericNote],
        owned
      }

    const next = structuredClone(config)
    const perm: Json = { ...((next[OC_KEY] as Json | undefined) ?? {}) }
    if (Object.keys(nextRule).length) perm[OC_SUB] = nextRule
    else delete perm[OC_SUB]
    if (Object.keys(perm).length) next[OC_KEY] = perm
    else delete next[OC_KEY]
    const after = toJsonText(next, before)
    const rest = untouchedKeysSame(config, next, OC_KEY)
    const origPerm = (config[OC_KEY] as Json | undefined) ?? {}
    const permSame = Object.keys(origPerm)
      .filter((k) => k !== OC_SUB)
      .every((k) => same(origPerm[k], perm[k]))
    const keptSame = Object.entries(kept).every(([k, v]) => same(rule[k], v))
    const ok = rest.same && permSame && keptSame
    const removed = Object.keys(rule).filter((k) => drop(k))
    const notes = [
      `${OC_KEY}.${OC_SUB}: "deny" for ${owned.length} library skill(s) off for OpenCode${owned.length ? ` (${owned.join(', ')})` : ''}, removed ${removed.length}${removed.length ? ` (${removed.join(', ')})` : ''}, kept ${Object.keys(kept).length} other(s)`,
      `everything other than ${OC_KEY}.${OC_SUB} unchanged: ${ok ? 'OK' : 'broken!'}`,
      ...numericNote
    ]
    return ok
      ? { after, notes, owned }
      : { after, notes, owned, error: `keys other than ${OC_KEY}.${OC_SUB} changed` }
  }
}

// ---------------------------------------------------------------- shared

export const SKILL_OVERRIDE_TARGETS: readonly TargetDef[] = [
  claudeSkillOverrides,
  codexSkillConfig,
  opencodeSkillPermissions
]

/**
 * Tool → skill-disable settings target. Gemini CLI has one (settings.json skills.disabled) but the app doesn't clear it yet —
 * geminiMcp only warns about library skills listed there (read-only)
 */
export const SKILL_OVERRIDE_TARGET_OF: Readonly<Partial<Record<ToolId, TargetId>>> = {
  claude: 'claudeSkillOverrides',
  codex: 'codexSkillConfig',
  opencode: 'opencodeSkillPermissions'
}

/**
 * Library skill names disabled by tool settings in the target file's raw text (only those a sync would re-enable).
 * TargetError on parse failure.
 */
export function skillOverrideHits(
  id: TargetId,
  text: string,
  src: Sources,
  ctx?: BuildContext
): string[] {
  if (!text.trim()) return []
  switch (id) {
    case 'claudeSkillOverrides':
      return claudeHits(parseJsonObject(text), src)
    case 'codexSkillConfig': {
      const { on, paths } = codexContext(src, ctx)
      return codexConfigList(parseTomlOrThrow(text))
        .map((e) => codexHitName(e, on, paths))
        .filter((n): n is string => !!n)
        .sort()
    }
    case 'opencodeSkillPermissions':
      return opencodeHits(parseJsonObject(text), src, ctx)
    default:
      return []
  }
}
