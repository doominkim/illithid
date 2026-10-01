import { parse as parseToml } from 'smol-toml'
import type { ToolId } from '../toolIds'
import type { ServerChange, TargetDef, TargetId } from '../types'
import { claudeMcp } from './claudeMcp'
import { claudePermissions } from './claudePermissions'
import { codexAgents } from './codexAgents'
import { codexMcp } from './codexMcp'
import { codexRules } from './codexRules'
import { copilotMcp } from './copilotMcp'
import { geminiMcp } from './geminiMcp'
import { grokCompat } from './grokCompat'
import { grokMcp } from './grokMcp'
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
 * The skill-disable targets (claudeSkillOverrides, codexSkillConfig, opencodeSkillPermissions) likewise write other keys of files used by earlier targets;
 * grokCompat writes its own block in grokMcp's config.toml
 */
export const EXTRA_TARGETS: readonly TargetDef[] = [
  opencodeRules,
  opencodeSkills,
  ...SKILL_OVERRIDE_TARGETS,
  geminiRules,
  geminiMcp,
  copilotMcp,
  grokMcp,
  grokCompat
]

/** All targets. Targets writing the same file come later */
export const ALL_TARGETS: readonly TargetDef[] = [...TARGETS, ...EXTRA_TARGETS]

export const ALL_TARGET_IDS: readonly TargetId[] = ALL_TARGETS.map((t) => t.id)

/** Tool -> its MCP target */
export const MCP_TARGET_OF: Readonly<Record<ToolId, TargetId>> = {
  claude: 'claudeMcp',
  codex: 'codexMcp',
  opencode: 'opencodeMcp',
  gemini: 'geminiMcp',
  copilot: 'copilotMcp',
  grok: 'grokMcp'
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
  gemini: { format: 'json', key: 'mcpServers' },
  copilot: { format: 'json', key: 'mcpServers' },
  grok: { format: 'toml', key: 'mcp_servers' }
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
    const root = (format === 'toml' ? parseToml(text) : JSON.parse(text)) as Record<
      string,
      unknown
    > | null
    const o = root?.[key]
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {}
  } catch {
    return null
  }
}

/** JSON with object keys sorted — a server whose keys were only reordered is not an update */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([p], [q]) =>
            p < q ? -1 : p > q ? 1 : 0
          )
        )
      : x
  )
}

/**
 * Server-level changes between two versions of an MCP target file (names only — never definitions, which can hold resolved
 * secrets). Empty for non-MCP targets or when either side can't be parsed
 */
export function serverChanges(id: TargetId, before: string, after: string): ServerChange[] {
  const b = parseServerTable(id, before)
  const a = parseServerTable(id, after)
  // Unparseable side: no server rows at all (the file row still shows; guessing from half a diff would mislead)
  if (!b || !a) return []
  const out: ServerChange[] = []
  for (const n of Object.keys(a).sort())
    if (!(n in b)) out.push({ name: n, action: 'add' })
    else if (stableJson(a[n]) !== stableJson(b[n])) out.push({ name: n, action: 'update' })
  for (const n of Object.keys(b).sort()) if (!(n in a)) out.push({ name: n, action: 'remove' })
  return out
}

/** MCP target file text -> server name -> definition (in tool syntax). Empty object on parse failure or non-MCP target */
export function toolServerDefs(id: TargetId, text: string): Record<string, unknown> {
  return parseServerTable(id, text) ?? {}
}
