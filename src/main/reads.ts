/**
 * Actual computation behind the IPC read channels. Everything uses sync fs, so it runs in a worker thread (worker.ts).
 * This file only reads. Raw target file text (which may contain tokens) is processed here and never sent to the renderer.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import {
  buildContext,
  canonicalPaths,
  canonicalSkills,
  libraryPaths,
  mcpEntries,
  listAgents,
  pendingSyncCount,
  plan,
  planAgentSync,
  planSkillSync,
  readAgentDoc,
  readSources,
  scanArtifacts,
  scanSessions,
  indexSessions,
  indexStatus,
  searchSessions,
  type IndexResult,
  scanClaudeMemory,
  scanCodexMemory,
  skillOverrideHits,
  SKILL_OVERRIDE_TARGET_OF,
  statusReport,
  tilde,
  type AgentSyncItem,
  type Env,
  type FileChange,
  type SkillSyncItem,
  type TargetId,
  type ToolId
} from '../engine'
import type {
  AgentsData,
  McpData,
  McpServerView,
  McpToolState,
  RulesData,
  SessionSearchFilters,
  SkillsData,
  SyncState
} from '../shared/api'
import { skillDescriptions, toggles } from './writes'

export function rules(home: string): RulesData {
  const dir = canonicalPaths(home).rules
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
    return { dir: tilde(home, dir), files, toggles: toggles(home, 'rules') }
  } catch (e) {
    return {
      dir: tilde(home, dir),
      files: [],
      toggles: {},
      error: `read failed: ${(e as NodeJS.ErrnoException).code ?? 'unknown'}`
    }
  }
}

const SEVERITY: SyncState[] = ['error', 'needsSync', 'skipped', 'synced']
const worse = (a: SyncState | undefined, b: SyncState): SyncState =>
  a && SEVERITY.indexOf(a) < SEVERITY.indexOf(b) ? a : b

/** Skill copy plan item -> sync status */
function skillItemState(i: SkillSyncItem): SyncState {
  switch (i.action) {
    case 'inSync':
      return 'synced'
    case 'skip':
      return i.reason === 'userOwned' ? (i.sameContent ? 'synced' : 'skipped') : 'error'
    default:
      return 'needsSync'
  }
}

/** OpenCode puts a single library skills path into opencode.json -> every skill has the same status */
function opencodeSkillsState(home: string, env: Env): SyncState {
  try {
    const c = plan(home, env, ['opencodeSkills'])[0]
    if (!c || c.error) return 'error'
    return c.changed ? 'needsSync' : 'synced'
  } catch {
    return 'error'
  }
}

/** Library skills disabled by the tool's own settings (skillOverrides etc.) -> needsSync. On a target error, the whole tool is error */
function markSkillOverrides(home: string, env: Env, state: SkillsData['state']): void {
  const ids = Object.values(SKILL_OVERRIDE_TARGET_OF)
  let changes: FileChange[]
  let sources: ReturnType<typeof readSources>
  try {
    sources = readSources(home)
    changes = plan(home, env, ids)
  } catch {
    return
  }
  const ctx = buildContext(home, sources, env)
  for (const [tool, id] of Object.entries(SKILL_OVERRIDE_TARGET_OF) as [ToolId, TargetId][]) {
    const c = changes.find((x) => x.id === id)
    if (!c) continue
    let hits: string[]
    try {
      hits = c.error ? [] : skillOverrideHits(id, c.before, sources, ctx)
    } catch {
      hits = []
    }
    for (const [name, cur] of Object.entries(state)) {
      if (c.error) cur[tool] = worse(cur[tool], 'error')
      else if (hits.includes(name)) cur[tool] = worse(cur[tool], 'needsSync')
    }
  }
}

export function skills(home: string, env: Env): SkillsData {
  const names = canonicalSkills(home)
  const oc = opencodeSkillsState(home, env)
  const state: SkillsData['state'] = Object.fromEntries(names.map((n) => [n, { opencode: oc }]))
  let syncError: string | undefined
  try {
    for (const i of planSkillSync(home, env)) {
      const cur = state[i.name]
      if (cur) cur[i.tool] = worse(cur[i.tool], skillItemState(i))
    }
  } catch (e) {
    syncError = (e as Error).message
  }
  markSkillOverrides(home, env, state)
  return {
    dir: tilde(home, canonicalPaths(home).skills),
    names,
    state,
    ...(syncError ? { syncError } : {}),
    toggles: toggles(home, 'skills'),
    descriptions: skillDescriptions(home, names)
  }
}

/** Agent plan item -> sync status (userOwned is synced only when content matches) */
function agentItemState(i: AgentSyncItem): SyncState {
  switch (i.action) {
    case 'inSync':
      return 'synced'
    case 'skip':
      return i.reason === 'userOwned' ? (i.sameContent ? 'synced' : 'skipped') : 'error'
    default:
      return 'needsSync'
  }
}

export function agents(home: string, env: Env): AgentsData {
  const names = listAgents(home)
  const state: AgentsData['state'] = Object.fromEntries(names.map((n) => [n, {}]))
  const descriptions: Record<string, string> = {}
  let syncError: string | undefined
  for (const n of names) {
    try {
      descriptions[n] = readAgentDoc(home, n).description.trim()
    } catch {
      // No description — the sync plan surfaces it as sourceUnreadable
    }
  }
  try {
    for (const i of planAgentSync(home, env)) {
      const cur = state[i.name]
      if (cur) cur[i.tool] = worse(cur[i.tool], agentItemState(i))
    }
  } catch (e) {
    syncError = (e as Error).message
  }
  return {
    dir: tilde(home, libraryPaths(home).agentsDir),
    names,
    state,
    ...(syncError ? { syncError } : {}),
    toggles: toggles(home, 'agents'),
    descriptions
  }
}

// ---------------------------------------------------------------- MCP

const MCP_TARGETS: { tool: ToolId; id: TargetId }[] = [
  { tool: 'claude', id: 'claudeMcp' },
  { tool: 'codex', id: 'codexMcp' },
  { tool: 'opencode', id: 'opencodeMcp' }
]

/** Target file's server table. {} if the file is empty, null on parse failure */
function serversIn(id: TargetId, text: string): Record<string, unknown> | null {
  if (!text.trim()) return {}
  try {
    const root =
      id === 'codexMcp'
        ? (parseToml(text) as Record<string, unknown>)
        : (JSON.parse(text) as Record<string, unknown>)
    const key = id === 'claudeMcp' ? 'mcpServers' : id === 'opencodeMcp' ? 'mcp' : 'mcp_servers'
    const v = root?.[key]
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return null
  }
}

const SECRET_NAME = /(key|token|secret|passw|bearer|auth|credential)/i
const LONG_OPAQUE = /^[A-Za-z0-9_\-+=]{32,}$/

/** Strips user info, query, and hash from a URL. null if not a URL */
function safeUrl(v: string): string | null {
  try {
    const u = new URL(v)
    if (!/^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) || !u.host) return null
    const q = [...u.searchParams.keys()]
    return `${u.protocol}//${u.host}${u.pathname}${q.length ? `?${q.map((k) => `${k}=…`).join('&')}` : ''}`
  } catch {
    return null
  }
}

/** For displaying argument lists. Masks values that look like secrets */
function safeArgs(args: unknown): string[] | undefined {
  if (!Array.isArray(args)) return undefined
  const out: string[] = []
  let maskNext = false
  for (const raw of args) {
    const a = String(raw)
    if (maskNext) {
      out.push('***')
      maskNext = false
      continue
    }
    const eq = a.indexOf('=')
    if (a.startsWith('-') && eq > 0 && SECRET_NAME.test(a.slice(0, eq))) {
      out.push(`${a.slice(0, eq)}=***`)
    } else if (a.startsWith('-') && eq < 0 && SECRET_NAME.test(a)) {
      out.push(a)
      maskNext = true
    } else if (LONG_OPAQUE.test(a)) {
      out.push('***')
    } else {
      out.push(safeUrl(a) ?? a)
    }
  }
  return out
}

function keysOf(v: unknown): string[] {
  return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []
}

export function mcp(home: string, env: Env): McpData {
  let changes: FileChange[]
  let source: ReturnType<typeof mcpEntries>
  try {
    changes = plan(
      home,
      env,
      MCP_TARGETS.map((x) => x.id)
    )
    source = mcpEntries(readSources(home).mcp)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return {
      servers: [],
      toggles: {},
      error: `${tilde(home, libraryPaths(home).mcpsDir)} read failed${code ? ` (${code})` : ''}`
    }
  }

  const perTool = MCP_TARGETS.map(({ tool, id }) => {
    const c = changes.find((x) => x.id === id)
    const before = c ? serversIn(id, c.before) : null
    const after = c ? serversIn(id, c.after) : null
    return {
      tool,
      broken: !c || !!c.error || before === null || after === null,
      before,
      after,
      serverErrors: c?.serverErrors ?? {}
    }
  })

  const stateOf = (t: (typeof perTool)[number], name: string): McpToolState => {
    if (t.broken || t.serverErrors[name]) return 'error'
    const b = t.before![name]
    const a = t.after![name]
    if (a === undefined) return b === undefined ? 'notApplicable' : 'needsSync'
    if (b === undefined) return 'needsSync'
    return JSON.stringify(a) === JSON.stringify(b) ? 'synced' : 'needsSync'
  }

  const servers: McpServerView[] = source.map(([name, s]) => {
    const url = typeof s.url === 'string' ? (safeUrl(s.url) ?? '(not a URL)') : undefined
    return {
      name,
      transport: typeof s.transport === 'string' ? s.transport : undefined,
      ...(url ? { url } : {}),
      ...(typeof s.command === 'string' ? { command: s.command } : {}),
      ...(s.args ? { args: safeArgs(s.args) } : {}),
      headerKeys: keysOf(s.headers),
      envKeys: keysOf(s.env),
      ...(typeof s.bearerEnv === 'string' ? { bearerEnv: s.bearerEnv } : {}),
      ...(typeof s.bearerToken === 'string' ? { bearerToken: true } : {}),
      tools: Object.fromEntries(perTool.map((t) => [t.tool, stateOf(t, name)]))
    }
  })
  return { servers, toggles: toggles(home, 'mcp') }
}

// ---------------------------------------------------------------- dispatch

export type Op =
  | 'status'
  | 'rules'
  | 'skills'
  | 'agents'
  | 'mcp'
  | 'artifacts'
  | 'sessions'
  | 'toolMemory'
  | 'syncPending'
  | 'searchIndex'
  | 'searchSessions'
  | 'searchStatus'

/** Session scan -> incremental index. Index entries for tools whose scan failed are kept */
async function searchIndex(home: string, onProgress?: (p: unknown) => void): Promise<IndexResult> {
  const { sessions, errors } = scanSessions(home)
  const failed = new Set(errors.map((e) => e.tool))
  return indexSessions(home, sessions, {
    completeTools: (['claude', 'codex', 'opencode'] as const).filter((t) => !failed.has(t)),
    onProgress
  })
}

export function runOp(op: Op, home: string, env: Env, args: unknown[] = [], onProgress?: (p: unknown) => void): unknown {
  switch (op) {
    case 'searchIndex':
      return searchIndex(home, onProgress)
    case 'searchSessions': {
      const [q, filters] = args as [unknown, SessionSearchFilters | undefined]
      const f = filters ?? {}
      return searchSessions(home, typeof q === 'string' ? q : '', {
        ...(f.tool === 'claude' || f.tool === 'codex' || f.tool === 'opencode' ? { tool: f.tool } : {}),
        ...(typeof f.project === 'string' && f.project ? { project: f.project } : {}),
        ...(f.role === 'user' || f.role === 'assistant' ? { role: f.role } : {})
      })
    }
    case 'searchStatus':
      return indexStatus(home)
    case 'status':
      return statusReport(home, env)
    case 'rules':
      return rules(home)
    case 'skills':
      return skills(home, env)
    case 'agents':
      return agents(home, env)
    case 'mcp':
      return mcp(home, env)
    case 'artifacts':
      return scanArtifacts(home)
    case 'sessions':
      return scanSessions(home)
    case 'toolMemory':
      return { claude: scanClaudeMemory(home), codex: scanCodexMemory(home) }
    case 'syncPending':
      return pendingSyncCount(home, env)
  }
}
