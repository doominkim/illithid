/**
 * Single entry point: apply the library source to all targets at once (7 targets + Claude rule copies + skill copies + agents).
 * The source always wins (tool-side changes are backed up, then overwritten). Unmanaged items (user-owned skill folders and rule files,
 * servers absent from the source) are left alone. Delete candidates (app-owned rule/skill/agent copies, source skill symlinks) are
 * executed in the same sync — not deleted permanently but moved to backups/deleted/<ts>/ with their state records cleared (deleteCopies.ts).
 * Only removing the `~/.claude/rules/shared` symlink goes through an approval gate (allowLinkRemoval).
 */
import { homedir } from 'node:os'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { applyAgentSync, planAgentSync, type AgentSyncItem, type AgentSyncResult } from './agentSync'
import { apply, type ApplyResult } from './apply'
import { deleteSyncCandidates, type DeleteRequest, type DeleteResult } from './deleteCopies'
import { activeWorkspaceId, readConfig, withActiveWorkspace, workspaceIds } from './config'
import type { ToolId } from './agents'
import { rulesBlockItems } from './targets/codexAgents'
import { planAll } from './plan'
import { applyRuleSync, planRuleSync, type RuleSyncItem, type RuleSyncResult } from './ruleSync'
import {
  applySkillSync,
  planSkillSync,
  type SkillSyncItem,
  type SkillSyncResult
} from './skillSync'
import type { SecretBackend } from './secrets'
import { libraryExists } from './sources'
import { activePending, dropPending, retireHash, type RetireKind } from './pendingRetire'
import { readState, writeState } from './state'
import { ALL_TARGET_IDS, MCP_TARGET_TOOL, toolServerDefs } from './targets'
import type { Env, FileChange } from './types'

export interface SyncAllOptions {
  /** If true, actually write. If false, return only the plan */
  allowReal: boolean
  /** Allow removing the `~/.claude/rules/shared` symlink (only after passing the approval gate) */
  allowLinkRemoval?: boolean
  /** Backend that resolves `secret:` references (default = macOS Keychain) */
  secrets?: SecretBackend
  /**
   * The user explicitly approved this one apply (clicked the sidebar sync button).
   * Writes to the real HOME for this call even if config.allowRealApply is off. The setting is not changed
   */
  approvedOnce?: boolean
}

/** Plan (raw file content is in targets[].before/after — excerpt/mask it before showing in UI or logs) */
export interface SyncPlan {
  targets: FileChange[]
  rules: RuleSyncItem[]
  skills: SkillSyncItem[]
  agents: AgentSyncItem[]
  /** Errors raised during planning (no raw content) */
  errors: string[]
}

export interface SyncResults {
  targets: ApplyResult[]
  rules: RuleSyncResult[]
  skills: SkillSyncResult[]
  agents: AgentSyncResult[]
}

export interface SyncAllResult {
  libraryExists: boolean
  plan: SyncPlan
  /** Result, when allowReal and not refused */
  results?: SyncResults
  /**
   * Why writing was refused
   * - libraryMissing       no library (run initLibrary or import first)
   * - realHomeNotAllowed   home is the real HOME but config.allowRealApply is off
   */
  refused?: 'libraryMissing' | 'realHomeNotAllowed'
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return resolve(a) === resolve(b)
  }
}

/** Writing to the real HOME requires config.allowRealApply to be on */
export function realApplyAllowed(home: string): boolean {
  if (!sameDir(home, homedir())) return true
  return !!readConfig(home).config.allowRealApply
}

/** Plan only (read-only) */
export function planSyncAll(
  home: string,
  env: Env = process.env,
  secrets?: SecretBackend
): SyncPlan {
  const errors: string[] = []
  let targets: FileChange[] = []
  let rules: RuleSyncItem[] = []
  let skills: SkillSyncItem[] = []
  let agents: AgentSyncItem[] = []
  try {
    targets = planAll(home, env, secrets)
  } catch (e) {
    errors.push(`targets: ${(e as Error).message}`)
  }
  try {
    rules = planRuleSync(home, env)
  } catch (e) {
    errors.push(`rules: ${(e as Error).message}`)
  }
  try {
    skills = planSkillSync(home, env)
  } catch (e) {
    errors.push(`skills: ${(e as Error).message}`)
  }
  try {
    agents = planAgentSync(home, env)
  } catch (e) {
    errors.push(`agents: ${(e as Error).message}`)
  }
  return { targets, rules, skills, agents, errors }
}

/**
 * Pending apply count (read-only — no writes). Counts only what planSyncAll would actually change:
 * - Target config files: content that would change (errors excluded)
 * - Rules (incl. Claude MEMORY.md copy), skills, agents: copy, update, replaceLink (skills), migrateLegacyDir (rules),
 *   replaceImported / retireImported (imported originals switched to the app copy)
 * - Delete candidates (deleteCandidate — the plan only includes app-owned ones)
 * inSync and skip (userOwned etc.) are excluded. Rule replaceLink (removing the shared symlink) has its own approval gate
 * and is not resolved by sync, so it is excluded. 0 if there is no library.
 */
export function pendingSyncCount(home: string, env: Env = process.env, secrets?: SecretBackend): number {
  if (!libraryExists(home)) return 0
  const p = planSyncAll(home, env, secrets)
  const change = (a: string): boolean =>
    a === 'copy' || a === 'update' || a === 'deleteCandidate' || a === 'replaceImported' || a === 'retireImported'
  return (
    p.targets.filter((c) => c.changed && !c.error).length +
    p.rules.filter((x) => change(x.action) || x.action === 'migrateLegacyDir').length +
    p.skills.filter((x) => change(x.action) || x.action === 'replaceLink').length +
    p.agents.filter((x) => change(x.action)).length
  )
}

export function syncAll(home: string, env: Env, opts: SyncAllOptions): SyncAllResult {
  if (!libraryExists(home)) {
    return {
      libraryExists: false,
      plan: { targets: [], rules: [], skills: [], agents: [], errors: [] },
      refused: 'libraryMissing'
    }
  }
  const plan = planSyncAll(home, env, opts.secrets)
  if (!opts.allowReal) return { libraryExists: true, plan }
  if (!opts.approvedOnce && !realApplyAllowed(home)) return { libraryExists: true, plan, refused: 'realHomeNotAllowed' }
  const results: SyncResults = {
    targets: apply(home, env, [...ALL_TARGET_IDS], opts.secrets ? { secrets: opts.secrets } : {}),
    rules: applyRuleSync(home, env, plan.rules, { allowLinkRemoval: !!opts.allowLinkRemoval }),
    skills: applySkillSync(home, env, plan.skills),
    agents: applyAgentSync(home, env, plan.agents)
  }
  applyDeletes(home, env, plan, results)
  pruneGonePending(home)
  return { libraryExists: true, plan, results }
}

/** Drop the active workspace's pendingRetire records whose original no longer exists (the user removed it — nothing left to switch over) */
function pruneGonePending(home: string): void {
  const st = readState(home)
  if (st.error || !st.state.pendingRetire?.length) return
  const state = { ...st.state }
  if (dropPending(state, activePending(home, st.state.pendingRetire).filter((p) => retireHash(p.path) === null))) writeState(home, state)
}

/** Execute delete candidates → set each result's (action deleteCandidate) status to done/refused/failed */
function applyDeletes(home: string, env: Env, plan: SyncPlan, results: SyncResults): void {
  const reqs: DeleteRequest[] = [
    ...plan.rules
      .filter((x) => x.action === 'deleteCandidate')
      .map((x) => ({ kind: 'rule' as const, ...(x.tool ? { tool: x.tool } : {}), name: x.name, path: x.path, currentHash: x.currentHash })),
    ...plan.skills
      .filter((x) => x.action === 'deleteCandidate')
      .map((x) => ({
        kind: 'skill' as const,
        tool: x.tool,
        name: x.name,
        path: x.path,
        currentHash: x.currentHash,
        currentLink: x.currentLink
      })),
    ...plan.agents
      .filter((x) => x.action === 'deleteCandidate')
      .map((x) => ({ kind: 'agent' as const, tool: x.tool, name: x.name, path: x.path, currentHash: x.currentHash }))
  ]
  if (!reqs.length) return
  let del: DeleteResult[]
  try {
    del = deleteSyncCandidates(home, env, reqs)
  } catch (e) {
    const reason = (e as NodeJS.ErrnoException).code ?? (e as Error).name
    del = reqs.map((r) => ({ kind: r.kind, ...(r.tool ? { tool: r.tool } : {}), name: r.name, status: 'failed', reason }))
  }
  const merge = <R extends { action: string; name: string; status: string; reason?: string; backupPath?: string }>(
    list: R[],
    kind: DeleteRequest['kind'],
    toolOf: (r: R) => string | undefined
  ): R[] =>
    list.map((r) => {
      if (r.action !== 'deleteCandidate') return r
      const d = del.find((x) => x.kind === kind && x.name === r.name && x.tool === toolOf(r))
      if (!d) return r
      const { reason: _old, ...rest } = r
      void _old
      return {
        ...rest,
        status: d.status === 'deleted' ? 'done' : d.status,
        ...(d.reason ? { reason: d.reason } : {}),
        ...(d.backupPath ? { backupPath: d.backupPath } : {})
      } as R
    })
  results.rules = merge(results.rules, 'rule', (r) => r.tool)
  results.skills = merge(results.skills, 'skill', (r) => r.tool)
  results.agents = merge(results.agents, 'agent', (r) => r.tool)
}

/** An imported original kept in place because it changed since import (sync reports it instead of replacing it) */
export interface ImportedChange {
  kind: RetireKind
  tool: ToolId
  name: string
  /** Absolute path of the original */
  path: string
}

/** Imported originals changed since import, from a plan: rule/skill/agent skip(importedChanged) + opencode.json instructions entries */
export function importedChangedOf(p: SyncPlan): ImportedChange[] {
  return [
    ...p.rules.filter((x) => x.action === 'skip' && x.reason === 'importedChanged').map((x) => ({ kind: 'rule' as const, tool: x.tool ?? ('claude' as const), name: x.name, path: x.path })),
    ...p.skills.filter((x) => x.action === 'skip' && x.reason === 'importedChanged').map((x) => ({ kind: 'skill' as const, tool: x.tool, name: x.name, path: x.path })),
    ...p.agents.filter((x) => x.action === 'skip' && x.reason === 'importedChanged').map((x) => ({ kind: 'agent' as const, tool: x.tool, name: x.name, path: x.path })),
    ...p.targets.flatMap((c) => (c.error ? [] : (c.importedChanged ?? []).map((r) => ({ kind: r.kind, tool: r.tool, name: r.name, path: r.path }))))
  ]
}

/** Result summary (counts only) */
export function summarizeSync(r: SyncAllResult): Record<string, number> {
  const n: Record<string, number> = {}
  const bump = (k: string): void => {
    n[k] = (n[k] ?? 0) + 1
  }
  if (!r.results) {
    for (const c of r.plan.targets) {
      bump(c.error ? 'target.error' : c.changed ? 'target.changed' : 'target.same')
      Object.keys(c.serverErrors ?? {}).forEach(() => bump('target.serverError'))
    }
    for (const i of r.plan.rules) bump(`rule.${i.action}`)
    for (const i of r.plan.skills) bump(`skill.${i.action}`)
    for (const i of r.plan.agents) bump(`agent.${i.action}`)
    return n
  }
  for (const t of r.results.targets) {
    bump(`target.${t.status}${t.reason ? `:${t.reason}` : ''}`)
    Object.keys(t.serverErrors ?? {}).forEach(() => bump('target.serverError'))
  }
  for (const t of r.results.rules) bump(`rule.${t.status}`)
  for (const t of r.results.skills) bump(`skill.${t.status}`)
  for (const t of r.results.agents) bump(`agent.${t.status}`)
  return n
}

// ---------------------------------------------------------------- Workspace switch preview

export type SwitchLossKind = 'rule' | 'skill' | 'agent' | 'mcp' | 'memory'

/** Items the post-switch sync removes from tools (names only) */
export interface SwitchLossItem {
  kind: SwitchLossKind
  tool: ToolId
  name: string
}

const jsonOr = (text: string): Record<string, unknown> => {
  try {
    const o = JSON.parse(text) as unknown
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** `<!-- rules/x.md -->` / `<!-- memory/MEMORY.md -->` labels inside the AGENTS.md app block */
function skillNamesIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.') && existsSync(`${dir}/${n}/SKILL.md`))
  } catch {
    return []
  }
}

/**
 * Items that would be removed from tools by switching to workspace toId and syncing (read-only — writes no settings or files).
 * Computes the post-switch sync plan (planSyncAll) for that workspace and counts only what exists on the tool side now but not after the plan:
 * - Rule/skill/agent copies = the plan's deleteCandidate (the Claude MEMORY.md copy counts as memory)
 * - MCP servers = server-name difference in target files before/after
 * - Rules/memory in the Codex AGENTS.md and Gemini GEMINI.md blocks, rules/memory in OpenCode instructions, skills in OpenCode skills.paths = name difference before/after
 * A name that also exists in the new workspace (content change only) is not counted as removed.
 */
export function previewSwitch(
  home: string,
  env: Env = process.env,
  toId: string,
  secrets?: SecretBackend
): SwitchLossItem[] {
  if (!workspaceIds(home).includes(toId) || toId === activeWorkspaceId(home)) return []
  const p = withActiveWorkspace(toId, () => planSyncAll(home, env, secrets))
  const out: SwitchLossItem[] = []
  const add = (kind: SwitchLossKind, tool: ToolId, name: string): void => {
    if (!out.some((x) => x.kind === kind && x.tool === tool && x.name === name)) out.push({ kind, tool, name })
  }
  for (const r of p.rules)
    if (r.action === 'deleteCandidate') add(r.name === 'MEMORY.md' ? 'memory' : 'rule', r.tool ?? 'claude', r.name)
  for (const r of p.skills) if (r.action === 'deleteCandidate') add('skill', r.tool, r.name)
  for (const r of p.agents) if (r.action === 'deleteCandidate') add('agent', r.tool, r.name)
  for (const c of p.targets) {
    if (c.error) continue
    const mcpTool = MCP_TARGET_TOOL[c.id]
    if (mcpTool) {
      const after = toolServerDefs(c.id, c.after)
      for (const n of Object.keys(toolServerDefs(c.id, c.before))) if (!(n in after)) add('mcp', mcpTool, n)
    } else if (c.id === 'codexAgents' || c.id === 'geminiRules') {
      const tool = c.id === 'codexAgents' ? 'codex' : 'gemini'
      const b = rulesBlockItems(c.before)
      const a = rulesBlockItems(c.after)
      for (const n of b.rules) if (!a.rules.includes(n)) add('rule', tool, n)
      if (b.memory && !a.memory) add('memory', tool, 'MEMORY.md')
    } else if (c.id === 'opencodeRules') {
      const list = (t: string): string[] => {
        const v = jsonOr(t).instructions
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
      }
      const a = list(c.after)
      const aNames = new Set(a.map((x) => basename(x)))
      for (const x of list(c.before))
        if (!a.includes(x) && !aNames.has(basename(x)))
          add(basename(x) === 'MEMORY.md' ? 'memory' : 'rule', 'opencode', basename(x))
    } else if (c.id === 'opencodeSkills') {
      const paths = (t: string): string[] => {
        const s = jsonOr(t).skills as Record<string, unknown> | undefined
        const v = s && typeof s === 'object' ? s.paths : undefined
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
      }
      const a = paths(c.after)
      const keep = new Set(a.flatMap(skillNamesIn))
      for (const x of paths(c.before)) if (!a.includes(x)) for (const n of skillNamesIn(x)) if (!keep.has(n)) add('skill', 'opencode', n)
    }
  }
  const order: SwitchLossKind[] = ['rule', 'memory', 'skill', 'agent', 'mcp']
  return out.sort(
    (x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) || x.tool.localeCompare(y.tool) || x.name.localeCompare(y.name)
  )
}
