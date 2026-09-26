import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import matter from 'gray-matter'
import { parse as parseToml, TomlError } from 'smol-toml'
import { tools, TOOL_IDS, type ToolId } from './agents'
import { readConfigObject } from './models'

export interface RosterEntry {
  tool: ToolId
  name: string
  model: string | null
  effort: string | null
  description: string | null
  /** Body instructions (Claude md body, Codex developer_instructions, OpenCode prompt) */
  instructions: string
  /** Definition file. For inline definitions, config file path + `#agent.<name>` */
  path: string
  error?: string
}

export interface RosterRow {
  name: string
  entries: Partial<Record<ToolId, RosterEntry>>
}

export interface RosterToolSummary {
  tool: ToolId
  displayName: string
  /** Definition directories that actually exist */
  dirs: string[]
  count: number
  errors: number
  /** Set when reading the directory or config itself failed */
  error?: string
}

export interface Roster {
  rows: RosterRow[]
  tools: RosterToolSummary[]
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/** YAML/TOML error messages include source fragments. Keep only the position. */
function safeError(e: unknown, kind: string): string {
  if (e instanceof TomlError) return `${kind} parse failed (line ${e.line}, column ${e.column})`
  const mark = (e as { mark?: { line?: number; column?: number } })?.mark
  if (mark && typeof mark.line === 'number') {
    return `${kind} parse failed (line ${mark.line + 1}, column ${(mark.column ?? 0) + 1})`
  }
  return `${kind} parse failed`
}

const noEval = (): never => {
  throw new Error('js front matter is not supported')
}

/** Frontmatter md (Claude, OpenCode). The JS front matter engine is disabled (prevents eval) */
function parseMdAgent(tool: ToolId, path: string, text: string): RosterEntry {
  const stem = basename(path, extname(path))
  try {
    const { data, content } = matter(text, { engines: { js: noEval, javascript: noEval } })
    return {
      tool,
      name: str(data.name) ?? stem,
      model: str(data.model),
      effort: str(data.effort ?? data.reasoningEffort ?? data.model_reasoning_effort),
      description: str(data.description),
      instructions: content.trim(),
      path
    }
  } catch (e) {
    return {
      tool,
      name: stem,
      model: null,
      effort: null,
      description: null,
      instructions: '',
      path,
      error: safeError(e, 'frontmatter')
    }
  }
}

function parseTomlAgent(tool: ToolId, path: string, text: string): RosterEntry {
  const stem = basename(path, extname(path))
  try {
    const d = parseToml(text) as Record<string, unknown>
    return {
      tool,
      name: str(d.name) ?? stem,
      model: str(d.model),
      effort: str(d.model_reasoning_effort),
      description: str(d.description),
      instructions: (str(d.developer_instructions) ?? '').trim(),
      path
    }
  } catch (e) {
    return {
      tool,
      name: stem,
      model: null,
      effort: null,
      description: null,
      instructions: '',
      path,
      error: safeError(e, 'TOML')
    }
  }
}

/** Parses roster files (read-only). Groups per-tool definitions into one row by name */
export function readRoster(home: string): Roster {
  const all: RosterEntry[] = []
  const summaries: RosterToolSummary[] = []

  for (const t of tools(home)) {
    const { roster } = t
    const dirs = roster.dirs.filter((d) => existsSync(d))
    const entries: RosterEntry[] = []
    let error: string | undefined
    for (const dir of dirs) {
      let files: string[]
      try {
        files = readdirSync(dir)
          .filter((f) => f.endsWith(roster.ext) && !f.startsWith('.'))
          .sort()
      } catch (e) {
        error = `failed to read directory: ${(e as NodeJS.ErrnoException).code ?? 'unknown'}`
        continue
      }
      for (const f of files) {
        const path = join(dir, f)
        const text = readFileSync(path, 'utf8')
        entries.push(
          roster.ext === '.toml' ? parseTomlAgent(t.id, path, text) : parseMdAgent(t.id, path, text)
        )
      }
    }
    if (roster.inline && existsSync(roster.inline.path)) {
      const res = readConfigObject(roster.inline.path, 'json')
      if ('error' in res) error = res.error
      else {
        const block = res.value[roster.inline.key]
        if (block && typeof block === 'object' && !Array.isArray(block)) {
          for (const [name, def] of Object.entries(block as Record<string, unknown>)) {
            const d = (def ?? {}) as Record<string, unknown>
            entries.push({
              tool: t.id,
              name,
              model: str(d.model),
              effort: str(d.reasoningEffort ?? d.effort),
              description: str(d.description),
              instructions: (str(d.prompt) ?? '').trim(),
              path: `${roster.inline.path}#${roster.inline.key}.${name}`
            })
          }
        }
      }
    }
    all.push(...entries)
    summaries.push({
      tool: t.id,
      displayName: t.displayName,
      dirs,
      count: entries.length,
      errors: entries.filter((e) => e.error).length,
      ...(error ? { error } : {})
    })
  }

  const byName = new Map<string, RosterRow>()
  for (const e of all) {
    const row = byName.get(e.name) ?? { name: e.name, entries: {} }
    // If a tool has the same name twice, keep the one read first (directory, then inline)
    if (!row.entries[e.tool]) row.entries[e.tool] = e
    byName.set(e.name, row)
  }
  const rows = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { rows, tools: summaries }
}

/** How many tools a row spans: paired if present in every tool that has a roster */
export function rosterPairing(roster: Roster): { paired: number; partial: string[] } {
  const active = TOOL_IDS.filter((id) => roster.tools.find((t) => t.tool === id)?.count)
  let paired = 0
  const partial: string[] = []
  for (const row of roster.rows) {
    if (active.every((id) => row.entries[id])) paired++
    else partial.push(row.name)
  }
  return { paired, partial }
}
