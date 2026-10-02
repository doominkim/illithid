/**
 * Actual computation behind the IPC read channels. Everything uses sync fs, so it runs in a worker thread (worker.ts).
 * This file only reads. Raw target file text (which may contain tokens) is processed here and never sent to the renderer.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  importedBackupRoot,
  readMcpServer,
  readRuleDescriptions,
  type HookTool,
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
  indexAllDocs,
  searchDocs,
  searchAll,
  DOC_KINDS,
  type DocIndexResult,
  type DocKind,
  planBackupCleanup,
  type IndexResult,
  scanClaudeMemory,
  scanCodexMemory,
  skillOverrideHits,
  SKILL_OVERRIDE_TARGET_OF,
  statusReport,
  tilde,
  MCP_TARGET_OF,
  geminiDisabledSkillsOf,
  toolsInUse,
  parseServerTable,
  TOOL_IDS,
  type AgentSyncItem,
  type Env,
  type FileChange,
  type SkillSyncItem,
  type TargetId,
  type ToolId,
  marketLiveOrigins,
  usageOf,
  usageSummaries,
  modelDetail,
  modelList,
  sessionModels,
  sessionTitles,
  type Artifact,
  HOOK_TARGETS,
  HOOK_TOOLS,
  hookTable,
  hooksDir,
  planHookSync,
  readHooks,
  grokReadsClaudeHooks,
  hookSupport,
  type HookSupport,
  type HookSyncItem,
  readPermissions,
  permissionRules,
  readScripts,
  scriptsDir,
  hookNames,
  readHook,
  type HookDoc,
  usedScript,
  PERMISSION_HOOK,
  type Allowlist
} from '../engine'
import type {
  ScriptsData,
  PermissionsData,
  AgentsData,
  HooksData,
  HookToolState,
  HookView,
  McpData,
  McpServerView,
  McpToolState,
  RulesData,
  DocSearchFilters,
  SessionSearchFilters,
  SkillsData,
  SyncState
} from '../shared/api'
import { skillDescriptions, toggles } from './writes'
import { grokClaudeReading } from '../engine/targets/grokCompat'
import { applyPreview } from './preview'

export function rules(home: string): RulesData {
  const dir = canonicalPaths(home).rules
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
    const descriptions = readRuleDescriptions(home)
    return {
      dir: tilde(home, dir),
      files,
      ...(Object.keys(descriptions).length ? { descriptions } : {}),
      toggles: toggles(home, 'rules')
    }
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

/** Why a (name, tool) cell is in error: a plan reason code or an error message. The first one recorded wins */
type Reasons = Record<string, Partial<Record<ToolId, string>>>
function noteReason(reasons: Reasons, name: string, tool: ToolId, why: string | undefined): void {
  const cur = (reasons[name] ??= {})
  cur[tool] ??= why || 'unknown'
}
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
function opencodeSkillsState(home: string, env: Env): { state: SyncState; error?: string } {
  try {
    const c = plan(home, env, ['opencodeSkills'])[0]
    if (!c) return { state: 'error', error: 'noPlan' }
    if (c.error) return { state: 'error', error: c.error }
    return { state: c.changed ? 'needsSync' : 'synced' }
  } catch (e) {
    return { state: 'error', error: (e as Error).message }
  }
}

/** Library skills disabled by the tool's own settings (skillOverrides etc.) -> needsSync. On a target error, the whole tool is error */
function markSkillOverrides(
  home: string,
  env: Env,
  state: SkillsData['state'],
  reasons: Reasons
): void {
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
      if (c.error) {
        cur[tool] = worse(cur[tool], 'error')
        noteReason(reasons, name, tool, c.error)
      } else if (hits.includes(name)) cur[tool] = worse(cur[tool], 'needsSync')
    }
  }
}

/** Skills installed from the Market (market.json entries whose skill still exists) */
function marketSkills(home: string): Record<string, string> {
  try {
    return Object.fromEntries(
      marketLiveOrigins(home)
        .filter((o) => o.kind === 'skill')
        .map((o) => [o.name, o.id])
    )
  } catch {
    return {}
  }
}

export function skills(home: string, env: Env): SkillsData {
  const names = canonicalSkills(home)
  // A tool not in use has no sync plan at all; like the other tools it gets no state rather than an error
  const oc = toolsInUse(home).includes('opencode') ? opencodeSkillsState(home, env) : undefined
  const state: SkillsData['state'] = Object.fromEntries(
    names.map((n) => [n, oc ? { opencode: oc.state } : {}])
  )
  const reasons: Reasons = {}
  if (oc?.error) for (const n of names) noteReason(reasons, n, 'opencode', oc.error)
  let syncError: string | undefined
  try {
    for (const i of planSkillSync(home, env)) {
      const cur = state[i.name]
      if (!cur) continue
      const s = skillItemState(i)
      cur[i.tool] = worse(cur[i.tool], s)
      if (s === 'error') noteReason(reasons, i.name, i.tool, i.reason)
    }
  } catch (e) {
    syncError = (e as Error).message
  }
  markSkillOverrides(home, env, state, reasons)
  let geminiOff: string[] = []
  try {
    if (toolsInUse(home).includes('gemini'))
      geminiOff = geminiDisabledSkillsOf(home, readSources(home))
  } catch {
    geminiOff = []
  }
  return {
    dir: tilde(home, canonicalPaths(home).skills),
    names,
    state,
    ...(Object.keys(reasons).length ? { reasons } : {}),
    ...(syncError ? { syncError } : {}),
    toggles: toggles(home, 'skills'),
    descriptions: skillDescriptions(home, names),
    ...(geminiOff.length ? { toolDisabled: { gemini: geminiOff } } : {}),
    market: marketSkills(home),
    ...(grokClaudeReading(home).skills ? {} : { grokReadsClaude: false })
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
  const reasons: Reasons = {}
  try {
    for (const i of planAgentSync(home, env)) {
      const cur = state[i.name]
      if (!cur) continue
      const s = agentItemState(i)
      cur[i.tool] = worse(cur[i.tool], s)
      if (s === 'error') noteReason(reasons, i.name, i.tool, i.reason)
    }
  } catch (e) {
    syncError = (e as Error).message
  }
  return {
    dir: tilde(home, libraryPaths(home).agentsDir),
    names,
    state,
    ...(Object.keys(reasons).length ? { reasons } : {}),
    ...(syncError ? { syncError } : {}),
    toggles: toggles(home, 'agents'),
    descriptions
  }
}

// ---------------------------------------------------------------- MCP

const MCP_TARGETS: { tool: ToolId; id: TargetId }[] = TOOL_IDS.map((tool) => ({
  tool,
  id: MCP_TARGET_OF[tool]
}))

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

/** An MCP server's description: its meta key `_.description` (the sources drop `_` before the tools see it) */
function mcpDescription(home: string, name: string): string | undefined {
  try {
    const meta = readMcpServer(home, name)._
    const d =
      meta && typeof meta === 'object' ? (meta as { description?: unknown }).description : undefined
    return typeof d === 'string' && d.trim() ? d.trim() : undefined
  } catch {
    return undefined
  }
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
    const before = c ? parseServerTable(id, c.before) : null
    const after = c ? parseServerTable(id, c.after) : null
    return {
      tool,
      // No plan for a tool that isn't in use (plan() leaves it out): not applicable, not an error
      unused: !c,
      broken: !!c && (!!c.error || before === null || after === null),
      // Why the tool's config can't be used: the generator's message, else it doesn't parse
      brokenWhy: c?.error ?? 'configUnreadable',
      before,
      after,
      serverErrors: c?.serverErrors ?? {}
    }
  })

  const stateOf = (t: (typeof perTool)[number], name: string): McpToolState => {
    if (t.unused) return 'notApplicable'
    if (t.broken || t.serverErrors[name]) return 'error'
    const b = t.before![name]
    const a = t.after![name]
    if (a === undefined) return b === undefined ? 'notApplicable' : 'needsSync'
    if (b === undefined) return 'needsSync'
    return JSON.stringify(a) === JSON.stringify(b) ? 'synced' : 'needsSync'
  }

  const mcpReasons = (tools: typeof perTool, name: string): Pick<McpServerView, 'reasons'> => {
    const reasons: Partial<Record<ToolId, string>> = {}
    for (const t of tools) {
      if (t.unused) continue
      if (t.broken) reasons[t.tool] = t.brokenWhy
      else if (t.serverErrors[name]) reasons[t.tool] = t.serverErrors[name]
    }
    return Object.keys(reasons).length ? { reasons } : {}
  }

  const servers: McpServerView[] = source.map(([name, s]) => {
    const url = typeof s.url === 'string' ? (safeUrl(s.url) ?? '(not a URL)') : undefined
    const description = mcpDescription(home, name)
    return {
      name,
      ...(description ? { description } : {}),
      transport: typeof s.transport === 'string' ? s.transport : undefined,
      ...(url ? { url } : {}),
      ...(typeof s.command === 'string' ? { command: s.command } : {}),
      ...(s.args ? { args: safeArgs(s.args) } : {}),
      headerKeys: keysOf(s.headers),
      envKeys: keysOf(s.env),
      ...(typeof s.bearerEnv === 'string' ? { bearerEnv: s.bearerEnv } : {}),
      ...(typeof s.bearerToken === 'string' ? { bearerToken: true } : {}),
      tools: Object.fromEntries(perTool.map((t) => [t.tool, stateOf(t, name)])),
      ...mcpReasons(perTool, name)
    }
  })
  return {
    dir: tilde(home, libraryPaths(home).mcpsDir),
    servers,
    toggles: toggles(home, 'mcp'),
    ...(grokClaudeReading(home).mcps ? {} : { grokReadsClaude: false })
  }
}

// ---------------------------------------------------------------- artifacts

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Codex generated images live in a folder named after the session: attach that session's title from the index */
function withSessionTitles(home: string, list: Artifact[]): Artifact[] {
  const ids = [
    ...new Set(
      list
        .filter((a) => a.tool === 'codex' && a.project && SESSION_ID.test(a.project))
        .map((a) => a.project!)
    )
  ]
  let titles: Map<string, string>
  try {
    titles = sessionTitles(home, 'codex', ids)
  } catch {
    return list
  }
  return list.map((a) =>
    a.tool === 'codex' && a.project && titles.has(a.project)
      ? { ...a, sessionId: a.project, sessionTitle: titles.get(a.project) }
      : a
  )
}

// ---------------------------------------------------------------- dispatch

export type Op =
  | 'status'
  | 'hooks'
  | 'rules'
  | 'skills'
  | 'agents'
  | 'mcp'
  | 'permissions'
  | 'scripts'
  | 'artifacts'
  | 'sessions'
  | 'toolMemory'
  | 'syncPending'
  | 'syncPreview'
  | 'searchIndex'
  | 'searchSessions'
  | 'searchStatus'
  | 'usage'
  | 'usageSummary'
  | 'models'
  | 'modelDetail'
  | 'sessionModels'
  | 'searchDocs'
  | 'searchAll'
  | 'backupCleanupPlan'

/**
 * Session scan -> incremental index, then documents (artifacts + library). Index entries for tools whose scan failed are kept.
 * Progress events count sessions only (documents are quick)
 */
async function searchIndex(
  home: string,
  onProgress?: (p: unknown) => void
): Promise<{ sessions: IndexResult; docs: DocIndexResult }> {
  const { sessions, errors } = scanSessions(home, undefined, { cache: true })
  const failed = new Set(errors.map((e) => e.tool))
  const s = await indexSessions(home, sessions, {
    completeTools: TOOL_IDS.filter((t) => !failed.has(t)),
    onProgress
  })
  return { sessions: s, docs: indexAllDocs(home) }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** Range from the renderer: only whole positive days and YYYY-MM-DD strings pass */
function rangeArg(v: unknown): { days?: number; from?: string; to?: string } {
  const r = (v && typeof v === 'object' ? v : {}) as {
    days?: unknown
    from?: unknown
    to?: unknown
  }
  return {
    ...(typeof r.days === 'number' && Number.isInteger(r.days) && r.days > 0
      ? { days: r.days }
      : {}),
    ...(typeof r.from === 'string' && DAY_RE.test(r.from) ? { from: r.from } : {}),
    ...(typeof r.to === 'string' && DAY_RE.test(r.to) ? { to: r.to } : {})
  }
}

export function runOp(
  op: Op,
  home: string,
  env: Env,
  args: unknown[] = [],
  onProgress?: (p: unknown) => void
): unknown {
  switch (op) {
    case 'searchIndex':
      return searchIndex(home, onProgress)
    case 'searchSessions': {
      const [q, filters] = args as [unknown, SessionSearchFilters | undefined]
      const f = filters ?? {}
      return searchSessions(home, typeof q === 'string' ? q : '', {
        ...((TOOL_IDS as readonly unknown[]).includes(f.tool) ? { tool: f.tool } : {}),
        ...(typeof f.project === 'string' && f.project ? { project: f.project } : {}),
        ...(f.role === 'user' || f.role === 'assistant' ? { role: f.role } : {})
      })
    }
    case 'searchStatus':
      return indexStatus(home)
    case 'models':
      return modelList(home, rangeArg(args[0]))
    case 'modelDetail': {
      const k = args[0] as { tool?: unknown; model?: unknown; effort?: unknown } | undefined
      if (
        !k ||
        typeof k.tool !== 'string' ||
        typeof k.model !== 'string' ||
        typeof k.effort !== 'string'
      )
        return null
      return modelDetail(
        home,
        { tool: k.tool, model: k.model, effort: k.effort },
        rangeArg(args[1])
      )
    }
    case 'sessionModels': {
      const [tool, id] = args
      if (typeof tool !== 'string' || typeof id !== 'string' || !id) return null
      return sessionModels(home, tool, id)
    }
    case 'usage': {
      const [kind, name] = args
      if ((kind !== 'skill' && kind !== 'mcp') || typeof name !== 'string' || !name) return null
      return usageOf(home, kind, name)
    }
    case 'usageSummary': {
      const [kind, names] = args
      if ((kind !== 'skill' && kind !== 'mcp') || !Array.isArray(names)) return null
      return usageSummaries(
        home,
        kind,
        names.filter((n): n is string => typeof n === 'string' && !!n).slice(0, 2000)
      )
    }
    case 'searchDocs': {
      const [q, filters] = args as [unknown, DocSearchFilters | undefined]
      const f = filters ?? {}
      return searchDocs(home, typeof q === 'string' ? q : '', {
        ...(DOC_KINDS.includes(f.kind as DocKind) ? { kind: f.kind } : {}),
        ...(typeof f.tool === 'string' && f.tool ? { tool: f.tool } : {})
      })
    }
    case 'searchAll':
      return searchAll(home, typeof args[0] === 'string' ? args[0] : '')
    case 'backupCleanupPlan':
      return planBackupCleanup(home)
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
    case 'hooks':
      return hooks(home, env)
    case 'permissions':
      return permissions(home, env)
    case 'scripts':
      return scripts(home)
    case 'artifacts':
      return withSessionTitles(home, scanArtifacts(home))
    case 'sessions':
      return scanSessions(home, undefined, { cache: true })
    case 'toolMemory':
      return { claude: scanClaudeMemory(home), codex: scanCodexMemory(home) }
    case 'syncPending':
      return pendingSyncCount(home, env)
    case 'syncPreview':
      return applyPreview(home, env)
  }
}

/** Hook name → the tool an import backup (backups/imported/<time>/<tool>/hooks/<name>.json) says it came from */
function importedHookTools(home: string): Map<string, HookTool> {
  const out = new Map<string, HookTool>()
  const root = importedBackupRoot(home)
  const dirs = (p: string): string[] => {
    try {
      return readdirSync(p).sort()
    } catch {
      return []
    }
  }
  for (const stamp of dirs(root))
    for (const tool of dirs(join(root, stamp)))
      if ((HOOK_TOOLS as readonly string[]).includes(tool))
        for (const f of dirs(join(root, stamp, tool, 'hooks')))
          if (f.endsWith('.json')) out.set(f.slice(0, -5), tool as HookTool)
  return out
}

/** Hooks with per-tool state: the tool's config entry (before vs after the planned sync) and its script copies */
export function hooks(home: string, env: Env): HooksData {
  const dir = tilde(home, hooksDir(home))
  let changes: FileChange[]
  let list: ReturnType<typeof readHooks>
  try {
    changes = plan(
      home,
      env,
      HOOK_TARGETS.map((x) => x.id)
    )
    list = readHooks(home)
  } catch (e) {
    return { dir, hooks: [], toggles: {}, error: `${dir} read failed: ${(e as Error).message}` }
  }
  let copies: HookSyncItem[] = []
  try {
    copies = planHookSync(home, env)
  } catch {
    // copies stay unknown; config entries still tell the state
  }
  const inUse = toolsInUse(home)
  const perTool = HOOK_TARGETS.filter((t) => inUse.includes(t.tool)).map((t) => {
    const c = changes.find((x) => x.id === t.id)
    const before = c ? hookTable(t.id, c.before) : null
    const after = c ? hookTable(t.id, c.after) : null
    return {
      tool: t.tool as (typeof HOOK_TOOLS)[number],
      unused: !c,
      broken: !!c && (!!c.error || before === null || after === null),
      brokenWhy: c?.error ?? 'configUnreadable',
      before,
      after
    }
  })
  const pendingCopy = (tool: string, name: string): boolean =>
    copies.some(
      (x) =>
        x.tool === tool &&
        (x.hook === name || !!x.folder?.users.includes(name)) &&
        (x.action === 'copy' || x.action === 'update' || x.action === 'deleteCandidate')
    )
  // Hooks imported before HOOK.md kept the source: their import backup names the tool
  const importedBefore = importedHookTools(home)
  const view: HookView[] = list.map((h) => {
    const tools: Partial<Record<ToolId, HookToolState>> = {}
    const reasons: Partial<Record<ToolId, string>> = {}
    const unsupported: Partial<Record<ToolId, HookSupport>> = {}
    for (const t of perTool) {
      const support = hookSupport(h.doc.action, h.doc.when, t.tool)
      if (support !== 'ok') unsupported[t.tool] = support
      if (support !== 'ok' || t.unused) {
        tools[t.tool] = 'notApplicable'
        continue
      }
      if (t.broken) {
        tools[t.tool] = 'error'
        reasons[t.tool] = t.brokenWhy
        continue
      }
      const b = t.before!.get(h.name)
      const a = t.after!.get(h.name)
      const copy = pendingCopy(t.tool, h.name)
      tools[t.tool] =
        a === undefined && b === undefined
          ? copy
            ? 'needsSync'
            : 'notApplicable'
          : a !== b || copy
            ? 'needsSync'
            : 'synced'
    }
    const edited: Partial<Record<ToolId, string>> = {}
    for (const x of copies)
      if (x.action === 'update' && x.drift) {
        // A folder script's copy is the hooks' that run it; keeping it takes their entry
        if (x.folder?.users.includes(h.name)) edited[x.tool] = x.folder.entry
        else if (x.hook === h.name) edited[x.tool] = x.file
      }
    return {
      ...(Object.keys(edited).length ? { edited } : {}),
      ...((h.doc.importedFrom ?? importedBefore.get(h.name))
        ? { importedFrom: h.doc.importedFrom ?? importedBefore.get(h.name) }
        : {}),
      name: h.name,
      description: h.doc.description,
      when: h.doc.when,
      action: h.doc.action,
      options: h.doc.options,
      tools,
      ...(Object.keys(unsupported).length ? { unsupported } : {}),
      ...(Object.keys(reasons).length ? { reasons } : {})
    }
  })
  return {
    dir,
    hooks: view,
    toggles: toggles(home, 'hooks'),
    ...(grokReadsClaudeHooks(home) ? {} : { grokReadsClaude: false })
  }
}

// ---------------------------------------------------------------- permissions

/** Targets that carry the permission rules into each tool (Copilot: the deny check hook) */
const PERMISSION_TARGET: Partial<Record<ToolId, TargetId>> = {
  claude: 'claudePermissions',
  codex: 'codexRules',
  gemini: 'geminiPolicy',
  copilot: 'copilotHooks'
}

export function permissions(home: string, env: Env): PermissionsData {
  const file = libraryPaths(home).permissions
  const dir = tilde(home, file)
  let allowlist: Allowlist | null
  try {
    allowlist = readPermissions(home)
  } catch (e) {
    return {
      file: dir,
      rules: { commands: [] },
      claudeOnly: 0,
      tools: {},
      guards: [],
      error: `${dir}: ${(e as Error).message}`
    }
  }
  const rules = allowlist ? permissionRules(allowlist) : { commands: [] }
  const inUse = toolsInUse(home)
  const ids = Object.values(PERMISSION_TARGET).filter((id): id is TargetId => !!id)
  let changes: FileChange[] = []
  try {
    changes = plan(home, env, ids)
  } catch {
    // states stay unknown (shown as waiting)
  }
  let copies: HookSyncItem[] = []
  try {
    copies = planHookSync(home, env)
  } catch {
    // copies unknown
  }
  const hasDeny = rules.commands.some((r) => r.decision === 'deny' && !r.off?.includes('copilot'))
  const tools: PermissionsData['tools'] = {}
  const reasons: Partial<Record<ToolId, string>> = {}
  for (const tool of inUse) {
    const id = PERMISSION_TARGET[tool]
    if (tool === 'grok') {
      tools.grok = inUse.includes('claude') ? 'viaClaude' : 'notApplicable'
      continue
    }
    if (!id) {
      tools[tool] = 'notApplicable'
      continue
    }
    const c = changes.find((x) => x.id === id)
    if (tool === 'copilot') {
      // Only the deny check hook belongs to permissions
      const entry = (text: string | undefined): string | undefined =>
        text ? hookTable('copilotHooks', text)?.get(PERMISSION_HOOK) : undefined
      const copy = copies.some(
        (x) => x.tool === 'copilot' && x.hook === PERMISSION_HOOK && x.action !== 'inSync'
      )
      const b = entry(c?.before)
      const a = entry(c?.after)
      tools.copilot = c?.error
        ? 'error'
        : a !== b || copy
          ? 'needsSync'
          : hasDeny
            ? 'synced'
            : 'notApplicable'
      if (c?.error) reasons.copilot = c.error
      continue
    }
    tools[tool] = !c
      ? 'notApplicable'
      : c.error
        ? 'error'
        : c.changed
          ? 'needsSync'
          : c.skip === 'nothingToWrite'
            ? 'notApplicable'
            : 'synced'
    if (c?.error) reasons[tool] = c.error
  }
  let guards: PermissionsData['guards'] = []
  try {
    guards = readHooks(home)
      .filter((h) => h.doc.action === 'guard')
      .map((h) => ({ name: h.name, patterns: h.doc.options.patterns as string[] }))
  } catch {
    // a broken hook shows in the hooks menu
  }
  return {
    file: dir,
    rules,
    claudeOnly: allowlist
      ? allowlist.claudeOnly.allow.length +
        allowlist.claudeOnly.deny.length +
        (allowlist.claudeOnly.ask?.length ?? 0)
      : 0,
    tools,
    ...(Object.keys(reasons).length ? { reasons } : {}),
    guards
  }
}

// ---------------------------------------------------------------- scripts

export function scripts(home: string): ScriptsData {
  const dir = tilde(home, scriptsDir(home))
  try {
    const users = new Map<string, string[]>()
    const hooksWith = readHooksLenient(home)
    for (const h of hooksWith) {
      const use = usedScript(h)
      if (use) users.set(use, [...(users.get(use) ?? []), h.name])
    }
    return {
      dir,
      scripts: readScripts(home).map((s) => ({ ...s, users: users.get(s.name) ?? [] }))
    }
  } catch (e) {
    return { dir, scripts: [], error: `${dir} read failed: ${(e as Error).message}` }
  }
}

/** Hook docs that can be read (a broken hook shows in the hooks menu, not here) */
function readHooksLenient(home: string): (HookDoc & { name: string })[] {
  const out: (HookDoc & { name: string })[] = []
  for (const name of hookNames(home)) {
    try {
      out.push({ ...readHook(home, name).doc, name })
    } catch {
      // skipped
    }
  }
  return out
}
