import type { ToolId } from '../../../shared/api'
import { MANIFEST_TOOLS, TOOL_IDS } from '../../../engine/toolIds'

export const TOOLS: readonly ToolId[] = TOOL_IDS

/** Tools whose skills can be toggled (OpenCode reads the library directly; its off skills are denied in opencode.json) */
export const SKILL_TOGGLE_TOOLS: readonly ToolId[] = MANIFEST_TOOLS.skills

export const TOOL_NAME: Record<ToolId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  copilot: 'GitHub Copilot',
  grok: 'Grok CLI'
}

/** Tool identity colors (pill and icon background). Orange, black, blue, violet, slate, teal to avoid clashing with status colors */
export const TOOL_COLOR: Record<ToolId, string> = {
  claude: '#D97757',
  codex: '#3F3F46',
  opencode: '#3B82F6',
  gemini: '#8B5CF6',
  copilot: '#64748B',
  grok: '#0F766E'
}

/** Display state of a single tool pill */
export interface PillState {
  /** On. Dimmed when off */
  on: boolean
  /** Error → amber ring */
  problem?: boolean
  /** Needs sync → small dot */
  pending?: boolean
  /** Not applicable to this tool → hidden */
  na?: boolean
  /** Off here but still reaches the tool through another tool's files (Grok reading Claude Code) → dashed outline, not an error */
  via?: boolean
  /** Tooltip explaining the state (e.g. why it is flagged) */
  hint?: string
}

export type PillMap = Partial<Record<ToolId, PillState>>

/** Map sync state (synced/needsSync/error/notApplicable) to pill state */
export function pillFromCellState(state: string | undefined): PillState {
  switch (state) {
    case 'synced':
      return { on: true }
    case 'needsSync':
      return { on: true, pending: true }
    case 'error':
      return { on: true, problem: true }
    case 'notApplicable':
      return { on: false, na: true }
    case 'skipped':
      // Skipped by sync because it is a user file: gray (off style)
      return { on: false }
    default:
      return { on: false }
  }
}

/** Card status dot among enabled tools: error > needs sync > on > off */
export function dotOfPills(p: PillMap): 'on' | 'off' | 'warn' | 'error' {
  const v = Object.values(p).filter((x) => x && !x.na && x.on)
  if (v.some((x) => x?.problem)) return 'error'
  if (v.some((x) => x?.pending)) return 'warn'
  return v.length ? 'on' : 'off'
}

/**
 * Grok CLI also reads Claude Code's skills, MCP servers and agents: an item off for Grok but on for Claude still reaches Grok
 * while both are in use. Shown as an off pill marked "via Claude" with a hint. `reads` is false when Grok's Claude reading is
 * switched off for that kind (config.grokReadsClaude = false covers skills and MCP servers; agents have no switch in Grok)
 */
export function grokReadsFromClaude(
  inUse: readonly ToolId[],
  onFor: (tool: ToolId) => boolean,
  reads = true
): boolean {
  return reads && inUse.includes('grok') && inUse.includes('claude') && !onFor('grok') && onFor('claude')
}
