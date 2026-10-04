/**
 * Per-tool permissions of a library MCP server: `permissions: { default?, tools? }` in mcps/<name>.json, each allow / ask /
 * deny. The targets map fields explicitly, so this key never reaches a tool's server entry; each tool gets it in its own form:
 * - Claude Code: permissions.allow/ask/deny `mcp__<server>` and `mcp__<server>__<tool>` (deny > ask > allow, whatever the scope)
 * - Codex: default_tools_approval_mode, [tools.<tool>] approval_mode, disabled_tools; a blocked server exposes only the tools let
 *   through (enabled_tools)
 * - Gemini CLI: policy rules with mcpName (+ toolName); a tool's rule sits above its server's
 * A Codex-only approval in `codex.toolApprovals` still applies to the tools these rules leave alone.
 * permissions.json `mcpDefault` is the default of every server without one of its own: the targets pass it as `fallback`, and
 * each server gets it written out under its own name, so no tool needs a wildcard over servers.
 * Checked 2026-10-02: code.claude.com/docs/en/permissions, Codex config reference, geminicli.com/docs/reference/policy-engine/
 */
import type { McpServer } from './types'

export const MCP_DECISIONS = ['allow', 'ask', 'deny'] as const
export type McpDecision = (typeof MCP_DECISIONS)[number]

export interface McpPermissions {
  /** The server's decision for its tools; left out = each tool's own default */
  default?: McpDecision
  tools?: Record<string, McpDecision>
}

/** A tool name the tools accept in rule strings and TOML keys */
export const MCP_TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const isDecision = (v: unknown): v is McpDecision =>
  (MCP_DECISIONS as readonly unknown[]).includes(v)

/** Schema problems of a `permissions` value (empty when fine or absent) */
export function mcpPermissionProblems(v: unknown): string[] {
  if (v === undefined) return []
  if (!isObj(v)) return ['permissions must be an object']
  const errors: string[] = []
  if (v.default !== undefined && !isDecision(v.default))
    errors.push('permissions.default must be allow, ask or deny')
  if (v.tools !== undefined) {
    if (!isObj(v.tools)) errors.push('permissions.tools must be an object')
    else
      for (const [tool, d] of Object.entries(v.tools)) {
        if (!MCP_TOOL_NAME_RE.test(tool)) errors.push(`permissions.tools: bad tool name ${tool}`)
        else if (!isDecision(d)) errors.push(`permissions.tools.${tool} must be allow, ask or deny`)
      }
  }
  return errors
}

/**
 * The server's rules (an unreadable value reads as none: validation refuses it on save). `fallback` is the default for all
 * servers, used when the server has none of its own
 */
export function mcpPermissionsOf(s: McpServer, fallback?: McpDecision): McpPermissions {
  const p = s.permissions
  const ok = isObj(p) && !mcpPermissionProblems(p).length
  const own = ok && isDecision(p.default) ? p.default : undefined
  const def = own ?? (isDecision(fallback) ? fallback : undefined)
  if (!ok) return def ? { default: def } : {}
  return {
    ...(def ? { default: def } : {}),
    ...(isObj(p.tools) && Object.keys(p.tools).length
      ? { tools: { ...(p.tools as Record<string, McpDecision>) } }
      : {})
  }
}

const sortedTools = (p: McpPermissions, d?: McpDecision): string[] =>
  Object.entries(p.tools ?? {})
    .filter(([, x]) => !d || x === d)
    .map(([t]) => t)
    .sort()

/** Claude Code permission rules for one server */
export function claudeMcpRules(
  name: string,
  s: McpServer,
  fallback?: McpDecision
): Record<McpDecision, string[]> {
  const p = mcpPermissionsOf(s, fallback)
  const out: Record<McpDecision, string[]> = { allow: [], ask: [], deny: [] }
  if (p.default) out[p.default].push(`mcp__${name}`)
  for (const d of MCP_DECISIONS)
    for (const t of sortedTools(p, d)) out[d].push(`mcp__${name}__${t}`)
  // A Codex-only approval for a tool the rules leave alone: asked in Claude Code too (as before)
  for (const [tool, mode] of Object.entries(s.codex?.toolApprovals ?? {}))
    if (mode !== 'auto' && !p.tools?.[tool]) out.ask.push(`mcp__${name}__${tool}`)
  return out
}

/** Codex settings for one server: the rules over its Codex-only options */
export function codexMcpSettings(
  s: McpServer,
  fallback?: McpDecision
): {
  defaultMode?: string
  enabledTools?: string[]
  disabledTools?: string[]
  approvals: Record<string, string>
} {
  const p = mcpPermissionsOf(s, fallback)
  const cx = s.codex ?? {}
  const mode = (d: McpDecision): string => (d === 'allow' ? 'approve' : 'prompt')
  const approvals: Record<string, string> = { ...(cx.toolApprovals ?? {}) }
  for (const [tool, d] of Object.entries(p.tools ?? {})) {
    if (d === 'deny') delete approvals[tool]
    else approvals[tool] = mode(d)
  }
  const denied = sortedTools(p, 'deny')
  const passed = [...sortedTools(p, 'allow'), ...sortedTools(p, 'ask')].sort()
  const defaultMode =
    p.default === 'allow' || p.default === 'ask' ? mode(p.default) : cx.defaultToolsApprovalMode
  const enabledTools = p.default === 'deny' ? passed : cx.enabledTools
  return {
    ...(defaultMode ? { defaultMode } : {}),
    ...(enabledTools ? { enabledTools } : {}),
    ...(denied.length ? { disabledTools: denied } : {}),
    approvals
  }
}

/** Gemini CLI policy priorities: a tool's rule above its server's, the stricter above the looser */
const GEMINI_PRIORITY: Record<'server' | 'tool', Record<McpDecision, number>> = {
  server: { allow: 130, ask: 140, deny: 150 },
  tool: { allow: 240, ask: 250, deny: 260 }
}
const GEMINI_DECISION: Record<McpDecision, string> = {
  allow: 'allow',
  ask: 'ask_user',
  deny: 'deny'
}

export interface GeminiMcpRule {
  mcpName: string
  toolName?: string
  decision: string
  priority: number
}

export function geminiMcpRules(
  name: string,
  s: McpServer,
  fallback?: McpDecision
): GeminiMcpRule[] {
  const p = mcpPermissionsOf(s, fallback)
  const out: GeminiMcpRule[] = []
  if (p.default)
    out.push({
      mcpName: name,
      decision: GEMINI_DECISION[p.default],
      priority: GEMINI_PRIORITY.server[p.default]
    })
  for (const [tool, d] of Object.entries(p.tools ?? {}).sort(([a], [b]) => a.localeCompare(b)))
    out.push({
      mcpName: name,
      toolName: tool,
      decision: GEMINI_DECISION[d],
      priority: GEMINI_PRIORITY.tool[d]
    })
  return out
}
