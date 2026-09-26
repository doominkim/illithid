import type { ToolId } from '../../../shared/api'

export const TOOLS: readonly ToolId[] = ['claude', 'codex', 'opencode']

export const TOOL_NAME: Record<ToolId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode'
}

/** Tool identity colors (pill and icon background). Orange, black, blue to avoid clashing with status colors */
export const TOOL_COLOR: Record<ToolId, string> = {
  claude: '#D97757',
  codex: '#3F3F46',
  opencode: '#3B82F6'
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
