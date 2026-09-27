/**
 * Tool ids and per-kind toggle tools. Dependency-free so config.ts and the renderer can use them without pulling in node modules.
 */

const IDS = ['claude', 'codex', 'opencode', 'gemini'] as const

export type ToolId = (typeof IDS)[number]

/** Tools the app syncs, in display order */
export const TOOL_IDS: readonly ToolId[] = IDS

/**
 * Tools in use while config.toolsInUse is unset (users who never chose). Fixed to the tools that existed before the setting,
 * so tools added later (Gemini CLI) are only written once the user turns them on
 */
export const DEFAULT_TOOLS_IN_USE: readonly ToolId[] = ['claude', 'codex', 'opencode']

export type ManifestKind = 'rules' | 'skills' | 'mcp' | 'agents'
export const MANIFEST_KINDS: readonly ManifestKind[] = ['rules', 'skills', 'mcp', 'agents']

/** Tools that can be toggled per kind. OpenCode skills scan the library directly, so they aren't toggleable */
export const MANIFEST_TOOLS: Readonly<Record<ManifestKind, readonly ToolId[]>> = {
  rules: TOOL_IDS,
  skills: ['claude', 'codex', 'gemini'],
  mcp: TOOL_IDS,
  agents: TOOL_IDS
}
