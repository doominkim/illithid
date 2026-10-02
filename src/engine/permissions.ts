/**
 * Permission rules as the app edits them: one list of shell command rules, each allow / ask / deny, optionally in a named group.
 * Stored in permissions.json beside the older allow-only shape (types.ts Allowlist): bash = allow, bashAsk, bashDeny. A rule's
 * group is its `group` field; the groups' order, description and default decision are the top-level `groups` list. Groups only
 * organize the menu — the tools get the same rules either way.
 * Dependency-free so the renderer can use it too.
 */
import type { Allowlist, AllowlistEntry } from './types'

export const PERMISSION_DECISIONS = ['deny', 'ask', 'allow'] as const
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

export interface CommandRule {
  decision: PermissionDecision
  /** Command words the rule matches from the start */
  argv: string[]
  /** Match the whole command only (not commands that start with it) */
  exact: boolean
  description?: string
  /** Name of the group the rule is in */
  group?: string
}

/** A named set of rules */
export interface RuleGroup {
  name: string
  description?: string
  /** Decision a command added to the group starts with */
  decision: PermissionDecision
}

export interface PermissionRules {
  commands: CommandRule[]
  /** In menu order. Read rules always have it; a group no rule names is dropped on save */
  groups?: RuleGroup[]
}

const DEFAULT_GROUP_DECISION: PermissionDecision = 'deny'

const LIST_OF: Record<PermissionDecision, 'bash' | 'bashAsk' | 'bashDeny'> = {
  allow: 'bash',
  ask: 'bashAsk',
  deny: 'bashDeny'
}

function entryRule(decision: PermissionDecision, e: AllowlistEntry): CommandRule {
  if (Array.isArray(e)) return { decision, argv: e, exact: false }
  // note is the older name of description
  const description = e.description ?? e.note
  return {
    decision,
    argv: e.argv,
    exact: !!e.claudeExact,
    ...(description ? { description } : {}),
    ...(e.group ? { group: e.group } : {})
  }
}

function ruleEntry(r: CommandRule): AllowlistEntry {
  if (!r.exact && !r.description && !r.group) return r.argv
  return {
    argv: r.argv,
    ...(r.exact ? { claudeExact: true } : {}),
    ...(r.description ? { description: r.description } : {}),
    ...(r.group ? { group: r.group } : {})
  }
}

function storedGroup(g: RuleGroup): RuleGroup {
  return {
    name: g.name,
    ...(g.description ? { description: g.description } : {}),
    decision: g.decision
  }
}

/** permissions.json → rules (allow rules first, in file order) */
export function permissionRules(a: Allowlist): PermissionRules {
  const commands = (['allow', 'ask', 'deny'] as const).flatMap((d) =>
    (a[LIST_OF[d]] ?? []).map((e) => entryRule(d, e))
  )
  const groups = (a.groups ?? []).map((g) =>
    storedGroup({ ...g, decision: g.decision ?? DEFAULT_GROUP_DECISION })
  )
  // A group named only on a rule (hand-written file) still reads as a group, after the listed ones
  for (const r of commands)
    if (r.group && !groups.some((g) => g.name === r.group))
      groups.push({ name: r.group, decision: DEFAULT_GROUP_DECISION })
  return { commands, groups }
}

/** Rules written back into permissions.json, keeping claudeOnly and any other keys. Empty optional lists are left out */
export function withPermissionRules(a: Allowlist, rules: PermissionRules): Allowlist {
  const out: Allowlist = { ...a, bash: [] }
  delete out.bashAsk
  delete out.bashDeny
  delete out.groups
  for (const d of ['allow', 'ask', 'deny'] as const) {
    const list = rules.commands.filter((r) => r.decision === d).map(ruleEntry)
    if (d === 'allow') out.bash = list
    else if (list.length) out[LIST_OF[d]] = list
  }
  // Keep the key order of a hand-written file: bash first, claudeOnly and the rest after
  const { bash, bashAsk, bashDeny, ...rest } = out
  const used = (rules.groups ?? [])
    .filter((g) => rules.commands.some((r) => r.group === g.name))
    .map(storedGroup)
  return {
    bash,
    ...(bashAsk ? { bashAsk } : {}),
    ...(bashDeny ? { bashDeny } : {}),
    ...rest,
    ...(used.length ? { groups: used } : {})
  } as Allowlist
}

/** Problems with a rule set (empty when fine): bad values, or the same command under two rules */
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
    if (r.group !== undefined && !(rules.groups ?? []).some((g) => g.name === r.group))
      errs.push(`commands[${i}]: no such group`)
  })
  const names = new Set<string>()
  ;(rules.groups ?? []).forEach((g, i) => {
    if (typeof g.name !== 'string' || !g.name.trim()) errs.push(`groups[${i}]: the name is empty`)
    else if (names.has(g.name)) errs.push(`groups[${i}]: same name as another group`)
    else names.add(g.name)
    if (!(PERMISSION_DECISIONS as readonly string[]).includes(g.decision))
      errs.push(`groups[${i}]: unknown decision`)
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

/** argv → a line parseCommand reads back as the same words: a word with spaces, quotes or backslashes is quoted */
export function commandLine(argv: readonly string[]): string {
  return argv
    .map((a) => {
      if (a && !/[\s'"\\]/.test(a)) return a
      if (!a.includes("'")) return `'${a}'`
      return `"${a.replace(/["\\]/g, '\\$&')}"`
    })
    .join(' ')
}
