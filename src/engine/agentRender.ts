/**
 * Library agent source (agents/<name>.md) -> per-tool agent file text.
 * - Claude   ~/.claude/agents/<name>.md          frontmatter name, description, model, effort + body
 * - Codex    ~/.codex/agents/<name>.toml         name·description·model·model_reasoning_effort·developer_instructions
 * - OpenCode ~/.config/opencode/agents/<name>.md frontmatter description, mode: subagent, model, reasoningEffort + body
 * - Gemini   ~/.gemini/agents/<name>.md          frontmatter name, description, model + body (no effort setting)
 * - Copilot  ~/.copilot/agents/<name>.agent.md   frontmatter name, description, model, reasoning-effort + body
 * - Grok     ~/.grok/agents/<name>.md            frontmatter name, description, model + body (the Claude format Grok also loads)
 * Keys without a value are omitted (the tool's default applies). The name is the library file name.
 */
import { join } from 'node:path'
import { stringify as stringifyToml } from 'smol-toml'
import type { ToolId } from './agents'
import { yamlValueLines, type AgentDoc } from './library'

/** Per-tool agent folder and extension */
export function agentToolDir(home: string, tool: ToolId): { dir: string; ext: '.md' | '.toml' | '.agent.md' } {
  switch (tool) {
    case 'claude':
      return { dir: join(home, '.claude/agents'), ext: '.md' }
    case 'codex':
      return { dir: join(home, '.codex/agents'), ext: '.toml' }
    case 'opencode':
      return { dir: join(home, '.config/opencode/agents'), ext: '.md' }
    case 'gemini':
      return { dir: join(home, '.gemini/agents'), ext: '.md' }
    case 'copilot':
      return { dir: join(home, '.copilot/agents'), ext: '.agent.md' }
    case 'grok':
      return { dir: join(home, '.grok/agents'), ext: '.md' }
  }
}

/** Gemini CLI agent names: lowercase letters, digits, `-` and `_` only (library names may also contain `.`) */
export const GEMINI_AGENT_NAME_RE = /^[a-z0-9_-]+$/

/** Whether the tool accepts the library name as an agent name */
export function agentNameOk(tool: ToolId, name: string): boolean {
  switch (tool) {
    case 'gemini':
      return GEMINI_AGENT_NAME_RE.test(name)
    case 'copilot':
      // Copilot: printable ASCII, not empty, not starting with `.`
      return /^[\x21-\x7e]+$/.test(name) && !name.startsWith('.')
    default:
      return true
  }
}

/**
 * File name endings the tool loads as agents, the app's own first. Copilot also loads a plain `<name>.md` from its agents
 * folder, so a user file of that name and the app's `<name>.agent.md` would both load
 */
export function agentExts(tool: ToolId): string[] {
  const { ext } = agentToolDir('', tool)
  return tool === 'copilot' ? [ext, '.md'] : [ext]
}

/** Library name of an agent file in the tool's agent folder (null if the tool doesn't load it) */
export function agentNameOfFile(tool: ToolId, file: string): string | null {
  if (file.startsWith('.')) return null
  const ext = agentExts(tool).find((e) => file.endsWith(e))
  return ext ? file.slice(0, -ext.length) : null
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
    case 'copilot':
      if (!agentNameOk(tool, doc.name)) throw new Error(`${doc.name} is not a valid Copilot agent name`)
      return mdDoc(
        [
          ['name', doc.name],
          ['description', description],
          ['model', t.model],
          ['reasoning-effort', t.effort]
        ],
        doc.body
      )
    case 'grok':
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
