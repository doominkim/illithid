/**
 * Library agent source (agents/<name>.md) -> per-tool agent file text.
 * - Claude   ~/.claude/agents/<name>.md          frontmatter name, description, model, effort + body
 * - Codex    ~/.codex/agents/<name>.toml         name·description·model·model_reasoning_effort·developer_instructions
 * - OpenCode ~/.config/opencode/agents/<name>.md frontmatter description, mode: subagent, model, reasoningEffort + body
 * - Gemini   ~/.gemini/agents/<name>.md          frontmatter name, description, model + body (no effort setting)
 * Keys without a value are omitted (the tool's default applies). The name is the library file name.
 */
import { join } from 'node:path'
import { stringify as stringifyToml } from 'smol-toml'
import type { ToolId } from './agents'
import { yamlValueLines, type AgentDoc } from './library'

/** Per-tool agent folder and extension */
export function agentToolDir(home: string, tool: ToolId): { dir: string; ext: '.md' | '.toml' } {
  switch (tool) {
    case 'claude':
      return { dir: join(home, '.claude/agents'), ext: '.md' }
    case 'codex':
      return { dir: join(home, '.codex/agents'), ext: '.toml' }
    case 'opencode':
      return { dir: join(home, '.config/opencode/agents'), ext: '.md' }
    case 'gemini':
      return { dir: join(home, '.gemini/agents'), ext: '.md' }
  }
}

/** Gemini CLI agent names: lowercase letters, digits, `-` and `_` only (library names may also contain `.`) */
export const GEMINI_AGENT_NAME_RE = /^[a-z0-9_-]+$/

/** Whether the tool accepts the library name as an agent name */
export function agentNameOk(tool: ToolId, name: string): boolean {
  return tool !== 'gemini' || GEMINI_AGENT_NAME_RE.test(name)
}

export function agentToolPath(home: string, tool: ToolId, name: string): string {
  const { dir, ext } = agentToolDir(home, tool)
  return join(dir, name + ext)
}

function fmLine(key: string, value: string): string[] {
  const v = yamlValueLines(value)
  return [`${key}: ${v[0]}`, ...v.slice(1)]
}

function mdDoc(fields: [string, string | undefined][], body: string): string {
  const lines = fields.flatMap(([k, v]) => (v === undefined || v === '' ? [] : fmLine(k, v)))
  const text = body.replace(/^\s*\n/, '')
  return `---\n${lines.join('\n')}\n---\n${text ? `\n${text.endsWith('\n') ? text : text + '\n'}` : ''}`
}

/** One tool's agent file content */
export function renderAgent(tool: ToolId, doc: AgentDoc): string {
  const t = doc.tools[tool] ?? {}
  const description = doc.description.trim()
  switch (tool) {
    case 'claude':
      return mdDoc(
        [
          ['name', doc.name],
          ['description', description],
          ['model', t.model],
          ['effort', t.effort]
        ],
        doc.body
      )
    case 'opencode':
      return mdDoc(
        [
          ['description', description],
          ['mode', 'subagent'],
          ['model', t.model],
          ['reasoningEffort', t.effort]
        ],
        doc.body
      )
    case 'gemini':
      if (!agentNameOk(tool, doc.name)) throw new Error(`${doc.name} is not a valid Gemini CLI agent name`)
      // Without model Gemini uses the session model (inherit)
      return mdDoc(
        [
          ['name', doc.name],
          ['description', description],
          ['model', t.model]
        ],
        doc.body
      )
    case 'codex': {
      const o: Record<string, string> = { name: doc.name, description }
      if (t.model) o.model = t.model
      if (t.effort) o.model_reasoning_effort = t.effort
      o.developer_instructions = doc.body.trim()
      return stringifyToml(o).replace(/\n*$/, '\n')
    }
  }
}
