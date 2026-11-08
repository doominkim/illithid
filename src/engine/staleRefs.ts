/**
 * Library documents that still name a skill the library no longer has — a rule saying "follow the `x` skill" after x was
 * removed keeps steering every session toward nothing. Read-only; only names, files and line numbers are reported.
 *
 * A backticked name is a reference when the word skill sits right next to it (`x` 스킬, the `x` skill, Skill tool with `x`).
 * A skill the sync is about to delete also counts wherever its name appears, if the name is hyphenated (`to-spec`; a plain word
 * like `implement` is too common). Skill bodies get only that second check: market skills name built-in and external skills
 * freely. Plugin skills (`plugin:name`) and names inside fenced code blocks are not checked.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readSources } from './sources'
import { librarySkillNames } from './targets/skillOverrides'

export interface StaleSkillRef {
  name: string
  /** Library-relative path with `/` separators */
  file: string
  /** 1-based */
  line: number
}

interface Doc {
  file: string
  text: string
  /** Check names next to the word skill against the library (default true; false for skill bodies) */
  nearSkill?: boolean
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const TICK_RE = /`([^`\n]+)`/g
/** Text that joins backticked names into one list: `a`·`b`, `c` and `d` */
const JOINER_RE = /^\s*(?:(?:[·,/]|and|or|및|와|과)\s*)?$/i
const SKILL_AFTER_RE = /^\s*(?:스킬|skills?\b)/i
const SKILL_BEFORE_RE = /(?:스킬|\bskills?)(?: tool with)?\s*$/i

export function findStaleSkillRefs(
  docs: Doc[],
  known: Set<string>,
  removed: Set<string>
): StaleSkillRef[] {
  const out: StaleSkillRef[] = []
  for (const { file, text, nearSkill: checkNear = true } of docs) {
    let fenced = false
    text.split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('```')) {
        fenced = !fenced
        return
      }
      if (fenced) return
      const ticks = [...line.matchAll(TICK_RE)].map((m) => ({
        name: m[1],
        start: m.index,
        end: m.index + m[0].length
      }))
      const groups: (typeof ticks)[] = []
      for (const t of ticks) {
        const last = groups[groups.length - 1]
        const prev = last?.[last.length - 1]
        if (prev && JOINER_RE.test(line.slice(prev.end, t.start))) last.push(t)
        else groups.push([t])
      }
      const seen = new Set<string>()
      for (const g of groups) {
        const nearSkill =
          SKILL_BEFORE_RE.test(line.slice(0, g[0].start)) ||
          SKILL_AFTER_RE.test(line.slice(g[g.length - 1].end))
        for (const { name } of g) {
          if (!NAME_RE.test(name) || seen.has(name)) continue
          const deleted = removed.has(name) && (nearSkill || name.includes('-'))
          if (deleted || (checkNear && nearSkill && !known.has(name))) {
            seen.add(name)
            out.push({ name, file, line: i + 1 })
          }
        }
      }
    })
  }
  return out
}

function markdownIn(dir: string, rel: string): Doc[] {
  if (!existsSync(dir)) return []
  const out: Doc[] = []
  for (const n of readdirSync(dir).sort()) {
    if (n.startsWith('.')) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...markdownIn(p, `${rel}/${n}`))
    else if (n.endsWith('.md')) out.push({ file: `${rel}/${n}`, text: readFileSync(p, 'utf8') })
  }
  return out
}

/** Rules, the shared memory index and skill bodies of the active library. `removed`: skills the pending sync deletes */
export function staleSkillRefs(home: string, removed: Iterable<string> = []): StaleSkillRef[] {
  const sources = readSources(home)
  const root = sources.agentsDir
  const known = new Set(librarySkillNames(sources))
  const docs = markdownIn(join(root, 'rules'), 'rules')
  const memory = join(root, 'memory', 'MEMORY.md')
  if (existsSync(memory))
    docs.push({ file: 'memory/MEMORY.md', text: readFileSync(memory, 'utf8') })
  for (const name of known) {
    const skill = join(root, 'skills', name, 'SKILL.md')
    if (existsSync(skill))
      docs.push({
        file: `skills/${name}/SKILL.md`,
        text: readFileSync(skill, 'utf8'),
        nearSkill: false
      })
  }
  return findStaleSkillRefs(docs, known, new Set(removed))
}
