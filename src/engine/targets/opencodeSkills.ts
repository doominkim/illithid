import { existsSync, readdirSync } from 'node:fs'
import { tildeAliases } from '../pathUtil'
import { join } from 'node:path'
import { parseJsonObject, toJsonText, untouchedKeysSame } from '../text'
import type { BuildContext, Sources, TargetDef } from '../types'
import { legacyLibraryAliases, previouslyOwned } from './toggles'

const KEY = 'skills'
const SUB = 'paths'

/** Library skills directory (the path opencode should scan) */
export function librarySkillsPath(sources: Sources): string {
  return join(sources.agentsDir, 'skills')
}

/** Whether library skills/ has at least one folder containing SKILL.md */
function hasLibrarySkills(dir: string): boolean {
  try {
    return readdirSync(dir).some((n) => !n.startsWith('.') && existsSync(join(dir, n, 'SKILL.md')))
  } catch {
    return false
  }
}

/**
 * Owned entries = current library skills path ∪ previously owned in state (so old paths drop out when the library moves)
 * ∪ library paths under previous app names
 */
function ownedSet(sources: Sources, ctx: BuildContext | undefined): Set<string> {
  const cur = librarySkillsPath(sources)
  const base = [cur, ...previouslyOwned(ctx, 'opencodeSkills')]
  const out = new Set<string>([...base, ...legacyLibraryAliases(ctx?.home, base)])
  if (ctx?.home) for (const a of tildeAliases(ctx.home, cur)) out.add(a)
  return out
}

/**
 * 8. ~/.config/opencode/opencode.json — library skills/ path in `skills.paths` (G3-2: the opencode binary only
 * scans the hardcoded ~/.agents/skills, so this makes library skills visible without ~/.agents).
 * Non-owned entries keep their order; other `skills` subkeys and other top-level keys are untouched.
 */
export const opencodeSkills: TargetDef = {
  id: 'opencodeSkills',
  tool: 'opencode',
  rel: '.config/opencode/opencode.json',
  // opencode.json is plain user config (OpenCode runs without it) — created with only our keys when there is content and OpenCode
  // is in use (in use already means ~/.config/opencode exists or the user chose it). OpenCode itself creates opencode.jsonc on first
  // run: when that is there instead, it is the file written (never a second config file, which would change how OpenCode merges)
  optional: true,
  alternates: ['.config/opencode/opencode.jsonc'],
  seed: '{}\n',
  region: (text, sources, ctx) => {
    let obj: Record<string, unknown>
    try {
      obj = parseJsonObject(text)
    } catch {
      return null
    }
    const skills = obj[KEY]
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return null
    const list = (skills as Record<string, unknown>)[SUB]
    if (!Array.isArray(list)) return null
    const owned = ownedSet(sources, ctx)
    const picked = list.filter((x) => typeof x === 'string' && owned.has(x))
    return picked.length ? JSON.stringify(picked) : null
  },
  build(before, ctx) {
    const { sources } = ctx
    const config = parseJsonObject(before)
    const next = structuredClone(config)
    const notes: string[] = []
    const cur = config[KEY]
    if (cur !== undefined && (typeof cur !== 'object' || cur === null || Array.isArray(cur)))
      return { after: before, notes, error: `${KEY} is not an object` }
    const skills = { ...((cur as Record<string, unknown> | undefined) ?? {}) }
    const list = skills[SUB]
    if (list !== undefined && !Array.isArray(list))
      return { after: before, notes, error: `${KEY}.${SUB} is not an array` }
    const owned = ownedSet(sources, ctx)
    const want = librarySkillsPath(sources)
    // With no library skills, add no path and remove previously added app-owned paths
    if (ctx?.retiring || !hasLibrarySkills(want)) {
      const rest = ((list as unknown[] | undefined) ?? []).filter(
        (x) => !(typeof x === 'string' && owned.has(x))
      )
      const removedN = ((list as unknown[] | undefined) ?? []).length - rest.length
      if (!removedN)
        return { after: before, notes: ['0 library skills — not writing skills.paths'], owned: [] }
      if (rest.length) skills[SUB] = rest
      else delete skills[SUB]
      if (Object.keys(skills).length) next[KEY] = skills
      else delete next[KEY]
      const after = toJsonText(next, before)
      const { count, same } = untouchedKeysSame(config, next, KEY)
      notes.push(
        `0 library skills — removed ${removedN} app-owned paths, kept ${rest.length} non-owned entries`
      )
      notes.push(`${count} keys other than ${KEY} unchanged: ${same ? 'OK' : 'broken!'}`)
      return same
        ? { after, notes, owned: [] }
        : { after, notes, owned: [], error: `keys other than ${KEY} changed` }
    }
    const out: unknown[] = []
    let placed = false
    for (const x of (list as unknown[] | undefined) ?? []) {
      if (typeof x === 'string' && owned.has(x)) {
        if (!placed) out.push(want)
        placed = true
      } else out.push(x)
    }
    if (!placed) out.unshift(want)
    skills[SUB] = out
    next[KEY] = skills
    const after = toJsonText(next, before)
    const kept = out.length - 1
    const { count, same } = untouchedKeysSame(config, next, KEY)
    notes.push(`${KEY}.${SUB}: 1 library skills path (app-owned), ${kept} non-owned entries kept`)
    notes.push(`${count} keys other than ${KEY} unchanged: ${same ? 'OK' : 'broken!'}`)
    return same
      ? { after, notes, owned: [want] }
      : { after, notes, owned: [want], error: `keys other than ${KEY} changed` }
  }
}
