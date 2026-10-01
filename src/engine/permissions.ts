/**
 * Permission rules as the app edits them: one list of shell command rules and one of MCP tool rules, each allow / ask / deny.
 * Stored in permissions.json beside the older allow-only shape (types.ts Allowlist): bash = allow, bashAsk, bashDeny, mcp.
 * Dependency-free so the renderer can use it too.
 */
import type { Allowlist, AllowlistEntry, McpPermissionEntry } from './types'

export const PERMISSION_DECISIONS = ['deny', 'ask', 'allow'] as const
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

export interface CommandRule {
  decision: PermissionDecision
  /** Command words the rule matches from the start */
  argv: string[]
  /** Match the whole command only (not commands that start with it) */
  exact: boolean
  note?: string
}

export type McpRule = McpPermissionEntry

export interface PermissionRules {
  commands: CommandRule[]
  mcp: McpRule[]
}

const LIST_OF: Record<PermissionDecision, 'bash' | 'bashAsk' | 'bashDeny'> = {
  allow: 'bash',
  ask: 'bashAsk',
  deny: 'bashDeny'
}

function entryRule(decision: PermissionDecision, e: AllowlistEntry): CommandRule {
  if (Array.isArray(e)) return { decision, argv: e, exact: false }
  return {
    decision,
    argv: e.argv,
    exact: !!e.claudeExact,
    ...(e.note ? { note: e.note } : {})
  }
}

function ruleEntry(r: CommandRule): AllowlistEntry {
  if (!r.exact && !r.note) return r.argv
  return {
    argv: r.argv,
    ...(r.exact ? { claudeExact: true } : {}),
    ...(r.note ? { note: r.note } : {})
  }
}

/** permissions.json → rules (allow rules first, in file order) */
export function permissionRules(a: Allowlist): PermissionRules {
  return {
    commands: (['allow', 'ask', 'deny'] as const).flatMap((d) =>
      (a[LIST_OF[d]] ?? []).map((e) => entryRule(d, e))
    ),
    mcp: (a.mcp ?? []).map((m) => ({ decision: m.decision, server: m.server, tool: m.tool }))
  }
}

/** Rules written back into permissions.json, keeping claudeOnly and any other keys. Empty optional lists are left out */
export function withPermissionRules(a: Allowlist, rules: PermissionRules): Allowlist {
  const out: Allowlist = { ...a, bash: [] }
  delete out.bashAsk
  delete out.bashDeny
  delete out.mcp
  for (const d of ['allow', 'ask', 'deny'] as const) {
    const list = rules.commands.filter((r) => r.decision === d).map(ruleEntry)
    if (d === 'allow') out.bash = list
    else if (list.length) out[LIST_OF[d]] = list
  }
  if (rules.mcp.length)
    out.mcp = rules.mcp.map((m) => ({ decision: m.decision, server: m.server, tool: m.tool }))
  // Keep the key order of a hand-written file: bash first, claudeOnly and the rest after
  const { bash, bashAsk, bashDeny, mcp, ...rest } = out
  return {
    bash,
    ...(bashAsk ? { bashAsk } : {}),
    ...(bashDeny ? { bashDeny } : {}),
    ...(mcp ? { mcp } : {}),
    ...rest
  } as Allowlist
}

/** Problems with a rule set (empty when fine): bad values, or the same command / MCP tool under two rules */
export function ruleProblems(rules: PermissionRules): string[] {
  const errs: string[] = []
  const seen = new Map<string, number>()
  rules.commands.forEach((r, i) => {
    if (!(PERMISSION_DECISIONS as readonly string[]).includes(r.decision))
      errs.push(`commands[${i}]: unknown decision`)
    if (
      !Array.isArray(r.argv) ||
      !r.argv.length ||
      !r.argv.every((a) => typeof a === 'string' && a)
    )
      errs.push(`commands[${i}]: the command is empty`)
    const key = JSON.stringify([r.argv, !!r.exact])
    if (seen.has(key)) errs.push(`commands[${i}]: same command as commands[${seen.get(key)}]`)
    else seen.set(key, i)
  })
  const seenMcp = new Map<string, number>()
  rules.mcp.forEach((m, i) => {
    if (!(PERMISSION_DECISIONS as readonly string[]).includes(m.decision))
      errs.push(`mcp[${i}]: unknown decision`)
    if (typeof m.server !== 'string' || !m.server.trim()) errs.push(`mcp[${i}]: server is empty`)
    if (typeof m.tool !== 'string' || !m.tool.trim()) errs.push(`mcp[${i}]: tool is empty`)
    const key = `${m.server}\u0000${m.tool}`
    if (seenMcp.has(key)) errs.push(`mcp[${i}]: same tool as mcp[${seenMcp.get(key)}]`)
    else seenMcp.set(key, i)
  })
  return errs
}

/** A typed command → argv, split the way a shell does (whitespace, single and double quotes, backslash) */
export function parseCommand(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i]
      else cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && i + 1 < text.length) {
      cur += text[++i]
      has = true
    } else if (/\s/.test(c)) {
      if (has) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}
