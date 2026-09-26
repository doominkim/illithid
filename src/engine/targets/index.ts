import { parse as parseToml } from 'smol-toml'
import type { TargetDef, TargetId } from '../types'
import { claudeMcp } from './claudeMcp'
import { claudePermissions } from './claudePermissions'
import { codexAgents } from './codexAgents'
import { codexMcp } from './codexMcp'
import { codexRules } from './codexRules'
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
  ...SKILL_OVERRIDE_TARGETS
]

/** All targets. Targets writing the same file come later */
export const ALL_TARGETS: readonly TargetDef[] = [...TARGETS, ...EXTRA_TARGETS]

export const ALL_TARGET_IDS: readonly TargetId[] = ALL_TARGETS.map((t) => t.id)

/** MCP target id -> tool */
export const MCP_TARGET_TOOL: Partial<Record<TargetId, 'claude' | 'codex' | 'opencode'>> = {
  claudeMcp: 'claude',
  codexMcp: 'codex',
  opencodeMcp: 'opencode'
}

/** MCP target file text -> server name -> definition (in tool syntax). Empty object on parse failure or non-MCP target */
export function toolServerDefs(id: TargetId, text: string): Record<string, unknown> {
  if (!text.trim()) return {}
  try {
    const o =
      id === 'codexMcp'
        ? (parseToml(text) as Record<string, unknown>).mcp_servers
        : id === 'claudeMcp'
          ? (JSON.parse(text) as Record<string, unknown>).mcpServers
          : id === 'opencodeMcp'
            ? (JSON.parse(text) as Record<string, unknown>).mcp
            : undefined
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
