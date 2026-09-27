/**
 * Tools' own skill-disable settings (source wins).
 * If a skill enabled in the library is separately disabled in a tool's settings, remove just that entry.
 * - Claude   ~/.claude/settings.json  skillOverrides.<name> = "off"
 * - Codex    ~/.codex/config.toml     [[skills.config]] name|path + enabled = false
 * - OpenCode opencode.json            permission.skill.<name> = "deny"
 * Skills not in the library, skills disabled in the library (handled by deleting copies), partial-disable values
 * (Claude name-only/user-invocable-only, OpenCode ask), and wildcard rules are user-owned and preserved.
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
    const after = toJsonText(next)
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

function opencodeHits(config: Json, src: Sources): string[] {
  const perm = config[OC_KEY]
  if (perm === undefined) return []
  if (!isObj(perm)) return []
  const rule = perm[OC_SUB]
  // A string (one value for all skills) is not a per-skill setting — user-owned
  if (!isObj(rule)) return []
  // OpenCode has no skill toggle — library skills are always on
  const lib = new Set(librarySkillNames(src))
  return Object.keys(rule)
    .filter((k) => lib.has(k) && rule[k] === 'deny')
    .sort()
}

/** 12. opencode.json — remove only "deny" entries in permission.skill for library skills (wildcard rules are kept) */
export const opencodeSkillPermissions: TargetDef = {
  id: 'opencodeSkillPermissions',
  tool: 'opencode',
  rel: '.config/opencode/opencode.json',
  optional: true,
  region: (text, src) => {
    try {
      const hits = opencodeHits(parseJsonObject(text), src)
      return hits.length ? JSON.stringify(hits) : null
    } catch {
      return null
    }
  },
  build(before, { sources: src }) {
    if (!before.trim()) return { after: before, notes: ['opencode.json missing — left untouched'] }
    const config = parseJsonObject(before)
    if (config[OC_KEY] !== undefined && !isObj(config[OC_KEY]))
      return { after: before, notes: [], error: `${OC_KEY} is not an object` }
    const hits = opencodeHits(config, src)
    if (!hits.length)
      return { after: before, notes: [`${OC_KEY}.${OC_SUB}: no library skills denied`] }
    const next = structuredClone(config)
    const perm = { ...(next[OC_KEY] as Json) }
    const rule = { ...(perm[OC_SUB] as Json) }
    for (const k of hits) delete rule[k]
    if (Object.keys(rule).length) perm[OC_SUB] = rule
    else delete perm[OC_SUB]
    if (Object.keys(perm).length) next[OC_KEY] = perm
    else delete next[OC_KEY]
    const after = toJsonText(next)
    const rest = untouchedKeysSame(config, next, OC_KEY)
    const origPerm = config[OC_KEY] as Json
    const permSame = Object.keys(origPerm)
      .filter((k) => k !== OC_SUB)
      .every((k) => same(origPerm[k], perm[k]))
    const origRule = origPerm[OC_SUB] as Json
    const ruleSame = Object.entries(rule).every(([k, v]) => same(origRule[k], v))
    const ok = rest.same && permSame && ruleSame
    const notes = [
      `${OC_KEY}.${OC_SUB}: removed "deny" for ${hits.length} library skill(s) (${hits.join(', ')}), kept ${Object.keys(rule).length} other(s)`,
      `everything other than ${OC_KEY}.${OC_SUB} unchanged: ${ok ? 'OK' : 'broken!'}`
    ]
    return ok ? { after, notes } : { after, notes, error: `keys other than ${OC_KEY}.${OC_SUB} changed` }
  }
}

// ---------------------------------------------------------------- shared

export const SKILL_OVERRIDE_TARGETS: readonly TargetDef[] = [
  claudeSkillOverrides,
  codexSkillConfig,
  opencodeSkillPermissions
]

/** Tool → skill-disable settings target */
export const SKILL_OVERRIDE_TARGET_OF: Readonly<Record<ToolId, TargetId>> = {
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
      return opencodeHits(parseJsonObject(text), src)
    default:
      return []
  }
}
