/**
 * Rules edited on the tool side (an agent told to "change the rule" edits the copy it can see, not the library):
 * - copies: Claude, Copilot and Grok rule files the app wrote that changed since (planRuleSync `drift`)
 * - blocks: a `<!-- rules/<name> -->` section of the Codex AGENTS.md / Gemini GEMINI.md block that no longer matches the library
 *   (only when the block changed since the app last wrote it, so a library edit waiting to be applied isn't mistaken for one)
 * The next apply restores the library version; adoptEditedRule saves the tool's version into the library instead, so it reaches
 * every tool. The memory index is left out (it's generated from memory/)
 */
import { readFileSync } from 'node:fs'
import { canonicalPaths } from './agents'
import { writeRule } from './library'
import { CLAUDE_MEMORY_RULE, GROK_MEMORY_RULE_FILE, stripSourceNote } from './ruleSync'
import { readSources } from './sources'
import { readState } from './state'
import { planSyncAll } from './sync'
import { blockBodyMulti, sha256 } from './text'
import type { ToolId } from './toolIds'
import type { Env } from './types'
import { MD_MARKERS } from './targets/codexAgents'

export interface EditedRule {
  tool: ToolId
  /** Library rule name */
  name: string
  /** Tool file (the copy, or the AGENTS.md / GEMINI.md holding the block) */
  path: string
  where: 'copy' | 'block'
  /** The tool's version, as it would be saved into the library */
  text: string
}

const BLOCK_TARGETS: { id: 'codexAgents' | 'geminiRules'; tool: ToolId }[] = [
  { id: 'codexAgents', tool: 'codex' },
  { id: 'geminiRules', tool: 'gemini' }
]

/** Copilot copies get `applyTo: "**"` added when the source has none: take it back out */
function uncopy(tool: ToolId, copy: string, source: string): string {
  if (tool !== 'copilot' || /^---\r?\n[\s\S]*?^applyTo\s*:/m.test(source)) return copy
  const added = /^---\r?\napplyTo: "\*\*"\r?\n---\r?\n\r?\n/
  if (added.test(copy)) return copy.replace(added, '')
  return copy.replace(/^(---\r?\n)applyTo: "\*\*"\r?\n/, '$1')
}

/** `<!-- rules/<name> -->` sections of a rules block (name → trimmed text) */
export function blockSections(body: string): Map<string, string> {
  const out = new Map<string, string>()
  const marks = [...body.matchAll(/^<!-- (?:rules\/(.+?)|memory\/MEMORY\.md) -->$/gm)]
  marks.forEach((m, i) => {
    if (!m[1]) return
    const start = m.index! + m[0].length
    const end = i + 1 < marks.length ? marks[i + 1].index! : body.length
    // Sections are joined with a `---` line between blank lines
    out.set(m[1], body.slice(start, end).replace(/\s*\n---\s*$/, '').trim())
  })
  return out
}

export function editedRules(home: string, env: Env = process.env): EditedRule[] {
  const plan = planSyncAll(home, env)
  const rulesDir = canonicalPaths(home).rules
  const library = new Map(readSources(home).rules.map((r) => [r.name, r.text]))
  const out: EditedRule[] = []
  for (const it of plan.rules) {
    if (it.action !== 'update' || !it.drift) continue
    if (it.name === CLAUDE_MEMORY_RULE || it.name === GROK_MEMORY_RULE_FILE || !it.source?.startsWith(rulesDir + '/')) continue
    const source = library.get(it.name)
    if (source === undefined) continue
    let text: string
    try {
      text = readFileSync(it.path, 'utf8')
    } catch {
      continue
    }
    const tool = (it.tool ?? 'claude') as ToolId
    text = uncopy(tool, stripSourceNote(text), source)
    if (text !== source) out.push({ tool, name: it.name, path: it.path, where: 'copy', text })
  }
  const applied = readState(home).state.applied
  for (const { id, tool } of BLOCK_TARGETS) {
    const c = plan.targets.find((x) => x.id === id)
    const body = c ? blockBodyMulti(c.before, [MD_MARKERS]) : null
    if (body === null || !c) continue
    if (applied[id] && sha256(body) === applied[id]!.regionHash) continue
    for (const [name, section] of blockSections(body)) {
      const source = library.get(name)
      if (source === undefined || section === source.trim()) continue
      out.push({ tool, name, path: c.path, where: 'block', text: section + '\n' })
    }
  }
  return out
}

/** Save the tool's version of a rule into the library (notFound if it isn't edited there any more) */
export function adoptEditedRule(home: string, env: Env, tool: ToolId, name: string): void {
  const e = editedRules(home, env).find((x) => x.tool === tool && x.name === name)
  if (!e) throw new Error('not edited in that tool any more')
  writeRule(home, name, e.text)
}
