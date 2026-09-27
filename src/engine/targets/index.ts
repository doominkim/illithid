import { parse as parseToml } from 'smol-toml'
import type { ToolId } from '../toolIds'
import type { TargetDef, TargetId } from '../types'
import { claudeMcp } from './claudeMcp'
import { claudePermissions } from './claudePermissions'
import { codexAgents } from './codexAgents'
import { codexMcp } from './codexMcp'
import { codexRules } from './codexRules'
import { geminiMcp } from './geminiMcp'
import { geminiRules } from './geminiRules'
import { opencodeMcp } from './opencodeMcp'
import { opencodeRules } from './opencodeRules'
import { opencodeSkills } from './opencodeSkills'
import { SKILL_OVERRIDE_TARGETS } from './skillOverrides'

/** The 6 default targets (run in this order). Default targets for plan() and apply() */
export const TARGETS: readonly TargetDef[] = [
  codexAgents,
  codexRules,
  claudePermissions,
  claudeMcp,
  codexMcp,
  opencodeMcp
]

/**
 * Targets added in M7. opencodeRules and opencodeSkills write other keys of the same file as opencodeMcp.
 * The skill-disable targets (claudeSkillOverrides, codexSkillConfig, opencodeSkillPermissions) likewise write other keys of files used by earlier targets
 */
export const EXTRA_TARGETS: readonly TargetDef[] = [
  opencodeRules,
  opencodeSkills,
  ...SKILL_OVERRIDE_TARGETS,
  geminiRules,
  geminiMcp
]

/** All targets. Targets writing the same file come later */
export const ALL_TARGETS: readonly TargetDef[] = [...TARGETS, ...EXTRA_TARGETS]

export const ALL_TARGET_IDS: readonly TargetId[] = ALL_TARGETS.map((t) => t.id)

/** Tool -> its MCP target */
export const MCP_TARGET_OF: Readonly<Record<ToolId, TargetId>> = {
  claude: 'claudeMcp',
  codex: 'codexMcp',
  opencode: 'opencodeMcp',
  gemini: 'geminiMcp'
}

/** MCP target id -> tool */
export const MCP_TARGET_TOOL: Partial<Record<TargetId, ToolId>> = Object.fromEntries(
  Object.entries(MCP_TARGET_OF).map(([tool, id]) => [id, tool])
)

/** Where each tool keeps its MCP server table */
const MCP_TABLE: Readonly<Record<ToolId, { format: 'json' | 'toml'; key: string }>> = {
  claude: { format: 'json', key: 'mcpServers' },
  codex: { format: 'toml', key: 'mcp_servers' },
  opencode: { format: 'json', key: 'mcp' },
  gemini: { format: 'json', key: 'mcpServers' }
}

/**
 * MCP target file text -> server name -> definition (in tool syntax).
 * {} for an empty file, a missing table or a non-MCP target; null on parse failure
 */
export function parseServerTable(id: TargetId, text: string): Record<string, unknown> | null {
  const tool = MCP_TARGET_TOOL[id]
  if (!tool || !text.trim()) return {}
  const { format, key } = MCP_TABLE[tool]
  try {
    const root = (format === 'toml' ? parseToml(text) : JSON.parse(text)) as Record<string, unknown> | null
    const o = root?.[key]
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {}
  } catch {
    return null
  }
}

/** MCP target file text -> server name -> definition (in tool syntax). Empty object on parse failure or non-MCP target */
export function toolServerDefs(id: TargetId, text: string): Record<string, unknown> {
  return parseServerTable(id, text) ?? {}
}
