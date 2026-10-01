import { existsSync } from 'node:fs'
import { tilde, TOOL_IDS, type ToolId } from './agents'
import { planAgentSync, type AgentSyncItem } from './agentSync'
import { agentToolDir } from './agentRender'
import { readModels, type ToolModels } from './models'
import { planAll } from './plan'
import type { SecretBackend } from './secrets'
import {
  claudeRulesPaths,
  copyRulesDir,
  planRuleSync,
  type CopyRuleTool,
  type RuleSyncItem
} from './ruleSync'
import { readRoster, type Roster } from './roster'
import { skillsReport, type SkillsReport, type ToolSkills } from './skills'
import { planSkillSync, type SkillSyncItem } from './skillSync'
import { toolsInUse } from './config'
import { readState, type StateRead } from './state'
import { MCP_TARGET_OF } from './targets'
import { geminiDisabledSkillsOf } from './targets/geminiMcp'
import { readSources } from './sources'
import { SKILL_OVERRIDE_TARGET_OF } from './targets/skillOverrides'
import type { Env, FileChange, TargetId } from './types'

export type Resource = 'rules' | 'skills' | 'mcp' | 'permissions' | 'models' | 'agents'
export const RESOURCES: readonly Resource[] = [
  'rules',
  'skills',
  'mcp',
  'permissions',
  'models',
  'agents'
]

/**
 * Cell state (simplified in M7d). The source always wins, so "changed on the tool side (drift)" is not a separate state.
 * - synced         the tool side matches what the source generates
 * - needsSync      it differs (including missing file/item) — the next sync aligns it to the source
 * - error          source/target read or parse failure, cannot generate
 * - notApplicable  this tool has no such resource
 */
export type CellState = 'synced' | 'needsSync' | 'error' | 'notApplicable' | LegacyCellState

/** @deprecated Pre-M7c values. No longer produced — CELL_STATE_MAP maps them to new values */
export type LegacyCellState = 'inSync' | 'pending' | 'drift' | 'missing' | 'otherSource'

/** Old value → new value */
export const CELL_STATE_MAP: Record<LegacyCellState, CellState> = {
  inSync: 'synced',
  pending: 'needsSync',
  drift: 'needsSync',
  missing: 'needsSync',
  otherSource: 'needsSync'
}

export function normalizeCellState(s: CellState): CellState {
  return s in CELL_STATE_MAP ? CELL_STATE_MAP[s as LegacyCellState] : s
}

export interface StatusCell {
  resource: Resource
  tool: ToolId
  state: CellState
  detail: string
  /** Target id for plan-based cells */
  target?: TargetId
  /** Per-state counts for the skills cell */
  counts?: Record<string, number>
}

/** Change summary (no raw content) */
export interface ChangeSummary {
  id: TargetId
  label: string
  changed: boolean
  error?: string
  beforeRegionHash: string | null
  afterRegionHash: string | null
}

export interface StatusReport {
  cells: StatusCell[]
  skills: SkillsReport
  models: ToolModels[]
  roster: Roster
  state: StateRead
  changes: ChangeSummary[]
  /** Failed to read the library source (whole plan failed) */
  sourcesError?: string
}

/** Resource × tool → plan target */
const TARGET_OF: Partial<Record<Resource, Partial<Record<ToolId, TargetId>>>> = {
  rules: { codex: 'codexAgents', opencode: 'opencodeRules', gemini: 'geminiRules' },
  skills: { opencode: 'opencodeSkills' }, // withSkillOverride merges in the tool's own skill-disable settings
  mcp: MCP_TARGET_OF,
  permissions: { claude: 'claudePermissions', codex: 'codexRules' }
}

/** Ordered by severity (when mixed, the earlier one wins) */
const SEVERITY: CellState[] = ['error', 'needsSync', 'synced']
const worst = (states: Iterable<CellState>): CellState => {
  const set = new Set(states)
  return SEVERITY.find((s) => set.has(s)) ?? 'synced'
}

function changeCell(
  resource: Resource,
  tool: ToolId,
  c: FileChange | undefined,
  sourcesError: string | undefined
): StatusCell {
  const base = { resource, tool }
  if (!c) {
    return { ...base, state: 'error', detail: sourcesError ?? 'no plan result' }
  }
  const target = c.id
  if (c.skip === 'nothingToWrite')
    return {
      ...base,
      target,
      state: 'notApplicable',
      detail: `${c.label} absent — nothing to write`
    }
  if (c.skip === 'copilotHomeOverride' || c.skip === 'grokHomeOverride')
    return {
      ...base,
      target,
      state: 'notApplicable',
      detail:
        c.notes[0] ?? `${c.skip === 'grokHomeOverride' ? 'GROK_HOME' : 'COPILOT_HOME'} override`
    }
  if (c.skip === 'jsoncUnsupported')
    return {
      ...base,
      target,
      state: 'notApplicable',
      detail: c.notes[0] ?? `${c.label} is not plain JSON`
    }
  if (c.skip === 'toolNotInitialized')
    return {
      ...base,
      target,
      state: 'notApplicable',
      detail: `${c.label} absent — run the tool once so it creates it`
    }
  if (c.error) {
    if (!existsSync(c.path))
      return { ...base, target, state: 'error', detail: `${c.label} missing` }
    return { ...base, target, state: 'error', detail: `${c.label}: ${c.error}` }
  }
  if (c.serverErrors && Object.keys(c.serverErrors).length) {
    const list = Object.entries(c.serverErrors).map(([n, m]) => `${n}: ${m}`)
    return { ...base, target, state: 'error', detail: `${c.label}: ${list.join('; ')}` }
  }
  if (!existsSync(c.path)) {
    return { ...base, target, state: 'needsSync', detail: `${c.label} missing — created on sync` }
  }
  if (c.changed) {
    const region = c.beforeRegionHash === null ? '— added on sync' : '— sync needed'
    return { ...base, target, state: 'needsSync', detail: `${c.label} ${region}` }
  }
  return { ...base, target, state: 'synced', detail: `${c.label} synced` }
}

/** Copy-sync plan items (shared by rules and skills) → cell state. User-owned (skip) items are unmanaged and excluded */
function syncActionState(action: string, reason: string | undefined): CellState | null {
  switch (action) {
    case 'inSync':
      return 'synced'
    case 'copy':
    case 'update':
    case 'replaceLink':
    case 'deleteCandidate':
    case 'migrateLegacyDir':
    case 'replaceImported':
    case 'retireImported':
      return 'needsSync'
    case 'skip':
      return reason === 'sourceUnreadable' || reason === 'invalidName' ? 'error' : null
    default:
      return null
  }
}

function countActions(items: { action: string; reason?: string }[]): string {
  const n = new Map<string, number>()
  for (const i of items) {
    const k = i.action === 'skip' && i.reason === 'userOwned' ? 'userOwned' : i.action
    n.set(k, (n.get(k) ?? 0) + 1)
  }
  return [...n.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')
}

/** Claude rules: based on copy sync (~/.claude/rules/illithid). needsSync if the shared symlink remains */
function claudeRulesCell(home: string, all: RuleSyncItem[] | Error): StatusCell {
  const base = { resource: 'rules' as const, tool: 'claude' as const }
  const where = tilde(home, claudeRulesPaths(home).dir)
  if (all instanceof Error) return { ...base, state: 'error', detail: `${where}: ${all.message}` }
  const items = all.filter((i) => i.tool === undefined)
  const link = items.find((i) => i.action === 'replaceLink')
  const detail = `${where} (copy sync): ${countActions(items) || 'no items'}${
    link ? ` — symlink ${tilde(home, link.path)} remains (removed after approval)` : ''
  }`
  const states = items
    .map((i) => syncActionState(i.action, i.reason))
    .filter((s): s is CellState => s !== null)
  return { ...base, state: worst(states), detail }
}

function skillsCell(home: string, t: ToolSkills, sync: SkillSyncItem[]): StatusCell {
  const base = { resource: 'skills' as const, tool: t.tool, counts: { ...t.counts } }
  const where = t.mode === 'symlinkDir' ? tilde(home, t.dir ?? '') : 'auto scan'
  if (t.error) return { ...base, state: 'error', detail: `${where}: ${t.error}` }
  if (t.mode === 'symlinkDir') {
    // Copy model: synced if app-owned copies match the source. Symlinks await replaceLink (needsSync)
    const mine = sync.filter((i) => i.tool === t.tool)
    const states = mine
      .map((i) => syncActionState(i.action, i.reason))
      .filter((s): s is CellState => s !== null)
    return {
      ...base,
      state: worst(states),
      detail: `${where} (copy sync): ${countActions(mine) || 'no items'}`
    }
  }
  // autoScan (OpenCode): reads the source directory directly, so always current — info only
  const counts = Object.entries(t.counts)
    .filter(([, n]) => n)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ')
  return { ...base, state: 'synced', detail: `${where}: ${counts || 'no items'}` }
}

/** Agents: based on syncing library agents/ into tool agent folders */
function agentsCell(home: string, tool: ToolId, items: AgentSyncItem[] | Error): StatusCell {
  const base = { resource: 'agents' as const, tool }
  const where = tilde(home, agentToolDir(home, tool).dir)
  if (items instanceof Error)
    return { ...base, state: 'error', detail: `${where}: ${items.message}` }
  const mine = items.filter((i) => i.tool === tool)
  const states = mine
    .map((i) => syncActionState(i.action, i.reason))
    .filter((s): s is CellState => s !== null)
  return {
    ...base,
    state: worst(states),
    detail: `${where} (copy sync): ${countActions(mine) || 'no items'}`
  }
}

/** Rule copies of other tools (Copilot instructions/illithid) */
function copyRulesCell(home: string, tool: CopyRuleTool, all: RuleSyncItem[] | Error): StatusCell {
  const base = { resource: 'rules' as const, tool }
  const where = tilde(home, copyRulesDir(home, tool))
  if (all instanceof Error) return { ...base, state: 'error', detail: `${where}: ${all.message}` }
  const mine = all.filter((i) => i.tool === tool)
  const states = mine
    .map((i) => syncActionState(i.action, i.reason))
    .filter((s): s is CellState => s !== null)
  return {
    ...base,
    state: worst(states),
    detail: `${where} (copy sync): ${countActions(mine) || 'no items'}`
  }
}

/** Merge the tool's own skill-disable settings (target) state into the skills cell */
function withSkillOverride(
  cell: StatusCell,
  c: FileChange | undefined,
  sourcesError: string | undefined
): StatusCell {
  const o = changeCell('skills', cell.tool, c, sourcesError)
  // No file means no disable settings
  if (c && !c.error && !existsSync(c.path)) return cell
  if (o.state === 'synced') return cell
  const state = worst([cell.state, o.state])
  return { ...cell, state, detail: `${cell.detail} · ${o.detail}` }
}

/** Full status report. Read-only */
export function statusReport(
  home: string,
  env: Env = process.env,
  secrets?: SecretBackend
): StatusReport {
  const st = readState(home)
  let changes: FileChange[] = []
  let sourcesError: string | undefined
  try {
    changes = planAll(home, env, secrets)
  } catch (e) {
    // Source parse errors may contain raw content, so keep only the code/kind
    const code = (e as NodeJS.ErrnoException).code
    sourcesError = `Failed to read library source${code ? ` (${code})` : ` (${(e as Error).name})`}`
  }
  let ruleItems: RuleSyncItem[] | Error
  try {
    ruleItems = planRuleSync(home, env)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    ruleItems = new Error(`Rule copy plan failed${code ? ` (${code})` : ''}`)
  }
  const byId = new Map(changes.map((c) => [c.id, c]))

  const skills = skillsReport(home, env)
  let sync: SkillSyncItem[] = []
  try {
    sync = planSkillSync(home, env)
  } catch {
    sync = []
  }
  let agentItems: AgentSyncItem[] | Error
  try {
    agentItems = planAgentSync(home, env)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    agentItems = new Error(`Agent plan failed${code ? ` (${code})` : ''}`)
  }
  const models = readModels(home)
  const roster = readRoster(home)
  const cells: StatusCell[] = []
  const inUse = toolsInUse(home)
  const geminiOff = (): string[] => {
    try {
      return geminiDisabledSkillsOf(home, readSources(home))
    } catch {
      return []
    }
  }

  for (const resource of RESOURCES) {
    for (const tool of TOOL_IDS) {
      if (!inUse.includes(tool)) {
        cells.push({ resource, tool, state: 'notApplicable', detail: 'tool not in use' })
        continue
      }
      const targetId = TARGET_OF[resource]?.[tool]
      const overrideId = SKILL_OVERRIDE_TARGET_OF[tool]
      const overrideOf = (cell: StatusCell): StatusCell =>
        resource === 'skills' && overrideId
          ? withSkillOverride(cell, byId.get(overrideId), sourcesError)
          : cell
      if (resource === 'rules' && tool === 'claude') cells.push(claudeRulesCell(home, ruleItems))
      else if (resource === 'rules' && (tool === 'copilot' || tool === 'grok'))
        cells.push(copyRulesCell(home, tool, ruleItems))
      else if (targetId) {
        cells.push(overrideOf(changeCell(resource, tool, byId.get(targetId), sourcesError)))
      } else if (resource === 'skills') {
        const cell = overrideOf(
          skillsCell(
            home,
            skills.tools.find((t) => t.tool === tool)!,
            sync
          )
        )
        // Gemini's own settings turning library skills off: shown (warning in the detail), never changed
        const off = tool === 'gemini' ? geminiOff() : []
        cells.push(
          off.length
            ? { ...cell, detail: `${cell.detail} · disabled in Gemini settings: ${off.join(', ')}` }
            : cell
        )
      } else if (resource === 'models') {
        const m = models.find((x) => x.tool === tool)!
        cells.push(
          !m.values.length
            ? { resource, tool, state: 'notApplicable', detail: 'default model not managed' }
            : m.error
              ? { resource, tool, state: 'error', detail: `${tilde(home, m.path)}: ${m.error}` }
              : {
                  resource,
                  tool,
                  state: 'synced',
                  detail: m.values.map((v) => `${v.key}=${v.value ?? '(unset)'}`).join(' ')
                }
        )
      } else if (resource === 'agents') {
        cells.push(agentsCell(home, tool, agentItems))
      } else {
        cells.push({ resource, tool, state: 'notApplicable', detail: 'not applicable' })
      }
    }
  }

  const summary: ChangeSummary[] = changes.map((c) => ({
    id: c.id,
    label: c.label,
    changed: c.changed,
    ...(c.error ? { error: c.error } : {}),
    beforeRegionHash: c.beforeRegionHash,
    afterRegionHash: c.afterRegionHash
  }))

  return {
    cells,
    skills,
    models,
    roster,
    state: st,
    changes: summary,
    ...(sourcesError ? { sourcesError } : {})
  }
}

/** Resource × tool cells */
export function status(home: string, env: Env = process.env): StatusCell[] {
  return statusReport(home, env).cells
}
