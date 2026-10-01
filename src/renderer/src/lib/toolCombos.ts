import type { ToolId } from '../../../shared/api'

/** Tools that also read Claude Code's files when both are used */
export const CLAUDE_READERS: readonly ToolId[] = ['grok', 'copilot']

/** Readers of Claude's files that `next` turns on together with Claude while `prev` did not have that pair */
export function claudeCombos(prev: readonly ToolId[], next: readonly ToolId[]): ToolId[] {
  if (!next.includes('claude')) return []
  return CLAUDE_READERS.filter(
    (t) => next.includes(t) && !(prev.includes(t) && prev.includes('claude'))
  )
}
