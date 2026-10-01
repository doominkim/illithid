/**
 * Actual handling of write IPC. Runs synchronously on the main thread (engine write APIs are atomic and short).
 *
 * Rules
 * - Library writes (toggle, edit, import) require a ready library (exists, not legacy). After saving, sync immediately if allowRealApply.
 * - Tool file writes (sync, delete candidates, default model) require allowRealApply, otherwise Refused. The source always wins (force).
 * - Never send target file contents to the renderer. Results carry only status, counts, and reasons.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import matter from 'gray-matter'
import {
  createAgent,
  deleteAgent,
  readAgentDoc,
  renameAgent,
  writeAgentDoc,
  type AgentDocInput,
  applyImport,
  ConfigError,
  createRule,
  createSkill,
  deleteMcpServer,
  deleteRule,
  deleteSkill,
  readSkillDoc,
  renameSkill,
  renameRule,
  writeSkillDoc,
  deleteMemoryFile,
  listMemoryFiles,
  readMemoryFile,
  writeMemoryFile,
  LibraryError,
  libraryPaths,
  libraryRoot,
  listSkillFiles,
  ManifestError,
  planImport,
  readConfig,
  readManifest,
  readRule,
  readSkillFile,
  readSources,
  setModel,
  SetModelError,
  setToggle,
  tilde,
  upsertMcpServer,
  writeConfig,
  writeRule,
  writeSkillFile,
  type AppConfig,
  type Env,
  type ImportSelection,
  type ManifestKind,
  type McpServer,
  type SkillDocInput,
  type SwitchLossItem,
  type ToolId,
  seedNewToolToggles,
  createHook,
  createHookToolScript,
  deleteHook,
  dropHookToolScript,
  readHook,
  saveHookDoc,
  convertHookToScript,
  HOOK_SCRIPT_TEMPLATE,
  HOOK_TOOLS,
  hookTriggers,
  toolScript,
  renderAskPrompt,
  saveHookScript,
  isHookTool,
  keepHookCopy,
  type HookDoc,
  type NewHookInput,
  savePermissionRules,
  type PermissionRules
} from '../engine'
import { previewSwitch } from '../engine'
import { LEGACY_LIBRARY_DIR } from '../engine/config'
import { mergeUiPrefs, type UiPrefs, type UiPrefsPatch } from '../engine/uiPrefs'
import { initLibrary } from '../engine/init'
import { renamePendingPaths } from '../engine/rename'
import { ensureLibrary } from '../engine/startup'
import {
  detectTools,
  importAllFromLegacy,
  listImportSources,
  type ImportSource
} from '../engine/importer'
import { setToolsInUse, toolsInUse } from '../engine/config'
import { libraryExists } from '../engine/sources'
import { syncAll, type SyncAllResult } from '../engine/sync'
import { ALL_TARGETS } from '../engine/targets'
import { readState } from '../engine/state'
import { deleteSyncCandidates } from '../engine/deleteCopies'
import {
  createWorkspace,
  deleteWorkspace,
  renameWorkspace,
  exportWorkspace,
  importWorkspace,
  listWorkspaces,
  switchWorkspace,
  WorkspaceError,
  WORKSPACE_ZIP_EXT
} from '../engine/workspace'
import { defaultSecretBackend, SecretError, type SecretBackend } from '../engine/secrets'
import {
  MASK,
  type ConfigView,
  type DeleteCandidateRequest,
  type WorkspaceImportView,
  type WorkspaceView,
  type DeleteCandidateResult,
  type ImportPlanView,
  type LibraryInitResult,
  type NotInitializedView,
  type McpEditView,
  type HookEditView,
  type Refused,
  type SyncStatusView,
  type SyncTargetView,
  type ToolsInUseView,
  type WriteResult
} from '../shared/api'

type Json = Record<string, unknown>

// ---------------------------------------------------------------- Common

/** Engine error → WriteErr. Uses only the engine error message so no file contents leak in */
export function wrap<T>(fn: () => T): WriteResult<T> {
  try {
    return { ok: true, value: fn() }
  } catch (e) {
    if (e instanceof LibraryError) return { ok: false, code: e.code, message: e.message }
    if (e instanceof ManifestError) return { ok: false, code: 'manifest', message: e.message }
    if (e instanceof ConfigError) return { ok: false, code: 'config', message: e.message }
    if (e instanceof SetModelError) return { ok: false, code: 'model', message: e.message }
    if (e instanceof SecretError) return { ok: false, code: 'secret', message: e.message }
    if (e instanceof WorkspaceError) return { ok: false, code: e.code, message: e.message }
    const err = e as NodeJS.ErrnoException
    return { ok: false, code: err.code ?? 'error', message: err.message ?? String(e) }
  }
}

/** Tool file write gate. Refused unless enabled */
export function gate(home: string): Refused | null {
  const c = readConfig(home)
  if (c.error) return { refused: 'configError', message: `config.json: ${c.error}` }
  if (!c.config.allowRealApply)
    return { refused: 'allowRealApplyOff', message: '"Allow real apply" is off in settings' }
  return null
}

function isObj(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// ---------------------------------------------------------------- Masking

/** Not a secret if the whole value is ${VAR} (Bearer prefix allowed) */
const PLACEHOLDER_ONLY = /^(Bearer\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
const SECRET_TABLES = new Set(['headers', 'env'])

/** Mask string values in a headers/env object (placeholder references are kept). Returns the masked keys */
function maskServer(def: Json, prefix = ''): string[] {
  const masked: string[] = []
  for (const [k, v] of Object.entries(def)) {
    if (SECRET_TABLES.has(k) && isObj(v)) {
      for (const [hk, hv] of Object.entries(v)) {
        if (typeof hv === 'string' && !PLACEHOLDER_ONLY.test(hv)) {
          v[hk] = MASK
          masked.push(`${prefix}${k}.${hk}`)
        }
      }
    } else if (isObj(v)) {
      masked.push(...maskServer(v, `${prefix}${k}.`))
    }
  }
  return masked
}

// ---------------------------------------------------------------- Library readiness and sync

/** Library state: writable only if it exists and is not legacy (~/.agents) */
export function libraryState(home: string): {
  root: string
  exists: boolean
  legacy: boolean
  ready: boolean
} {
  const root = libraryRoot(home)
  const legacy = resolve(root) === resolve(join(home, LEGACY_LIBRARY_DIR))
  const exists = libraryExists(home)
  return { root, exists, legacy, ready: exists && !legacy }
}

/** Library with no rules, skills, MCPs, memory, or permissions — route to the first-run screen */
function libraryIsEmpty(home: string): boolean {
  const p = libraryPaths(home)
  const has = (dir: string, re: RegExp): boolean =>
    existsSync(dir) && readdirSync(dir).some((f) => !f.startsWith('.') && re.test(f))
  return (
    !has(p.rulesDir, /\.md$/) &&
    !has(p.skillsDir, /./) &&
    !has(p.agentsDir, /\.md$/) &&
    !has(p.mcpsDir, /\.json$/) &&
    !has(p.memoryDir, /\.md$/) &&
    !existsSync(p.permissions)
  )
}

/** Library write gate */
export function libGate(home: string): Refused | null {
  const c = readConfig(home)
  if (c.error) return { refused: 'configError', message: `config.json: ${c.error}` }
  const st = libraryState(home)
  if (!st.ready)
    return {
      refused: 'libraryNotReady',
      message: st.legacy ? 'Library points to legacy ~/.agents' : 'Library does not exist'
    }
  return null
}

let libraryStartError: ConfigView['libraryStartError'] = undefined

/**
 * On app start: if the library is missing, create an empty skeleton at the current location (config.libraryPath ?? default) (idempotent, no import).
 * If old-name paths remain and the new path is missing (or an empty skeleton), do not create it; stay in an error state (so the existing library is not hidden).
 */
export function ensureLibraryOnStart(home: string): void {
  markSelfWrite(3000)
  const r = ensureLibrary(home)
  libraryStartError =
    r.status === 'renamePending'
      ? { code: 'renamePending', detail: r.paths.map((p) => tilde(home, p)).join(', ') }
      : r.status === 'failed'
        ? { code: 'initFailed', detail: r.reason }
        : r.status === 'migrateFailed'
          ? { code: 'migrateFailed', detail: r.reason }
          : undefined
}

/** path is retired (workspace layout) — accepted but ignored */
export function libraryInitRun(
  home: string,
  _path?: string,
  importLegacy = false
): LibraryInitResult {
  void _path
  const r = initLibrary(home)
  const out: LibraryInitResult = { root: tilde(home, r.root), created: r.created }
  if (importLegacy) {
    const all = importAllFromLegacy(home)
    const imported: Record<string, number> = {}
    const errors: string[] = []
    for (const x of all.results) {
      if (x.status === 'imported') imported[x.kind] = (imported[x.kind] ?? 0) + 1
      else errors.push(`${x.kind}:${x.name} ${x.status}${x.reason ? ` (${x.reason})` : ''}`)
    }
    out.imported = imported
    if (errors.length) out.importErrors = errors
  }
  return out
}

/** Right after the app itself writes the library — ignore watch events until this time */
let selfWriteUntil = 0
export function markSelfWrite(ms = 1500): void {
  selfWriteUntil = Date.now() + ms
}
export function isSelfWriteWindow(): boolean {
  return Date.now() < selfWriteUntil
}

let lastSync: SyncStatusView = {
  wrote: false,
  targets: [],
  rules: [],
  skills: [],
  agents: [],
  errors: [],
  needsSync: 0,
  errorCount: 0,
  deleteCandidates: [],
  notInitialized: []
}

export function syncStatus(): SyncStatusView {
  return lastSync
}

/** Per-server error → one line (server and account names only, no values) */
function serverErrorDetail(e: Record<string, string> | undefined): string {
  return e ? Object.values(e).join('; ') : ''
}

function toView(home: string, r: SyncAllResult, at: string): SyncStatusView {
  const targets: SyncTargetView[] = r.results
    ? r.results.targets.map((t) => {
        const se = serverErrorDetail(t.serverErrors)
        return {
          id: t.id,
          label: t.label,
          status:
            se ||
            (t.status === 'skipped' &&
              (t.reason === 'error' || t.reason === 'writeFailed' || t.reason === 'stateError'))
              ? 'error'
              : t.status,
          ...(t.reason ? { reason: t.reason } : se ? { reason: 'serverError' } : {}),
          ...(t.detail || se ? { detail: [t.detail, se].filter(Boolean).join(' · ') } : {})
        }
      })
    : r.plan.targets.map((c) => {
        const se = serverErrorDetail(c.serverErrors)
        return {
          id: c.id,
          label: c.label,
          status: c.error || se ? 'error' : c.changed ? 'planned' : 'unchanged',
          ...(c.error || se ? { detail: [c.error, se].filter(Boolean).join(' · ') } : {})
        }
      })
  const rules = (r.results?.rules ?? []).map((x) => ({ ...x, path: tilde(home, x.path) }))
  const skills = (r.results?.skills ?? []).map((x) => ({ ...x, path: tilde(home, x.path) }))
  const agents = (r.results?.agents ?? []).map((x) => ({ ...x, path: tilde(home, x.path) }))
  const planned = r.results
    ? 0
    : r.plan.targets.filter((c) => c.changed && !c.error).length +
      r.plan.rules.filter(
        (x) => x.action === 'copy' || x.action === 'update' || x.action === 'retireImported'
      ).length +
      r.plan.skills.filter(
        (x) =>
          x.action === 'copy' ||
          x.action === 'update' ||
          x.action === 'replaceLink' ||
          x.action === 'replaceImported' ||
          x.action === 'retireImported'
      ).length +
      r.plan.agents.filter(
        (x) =>
          x.action === 'copy' ||
          x.action === 'update' ||
          x.action === 'replaceImported' ||
          x.action === 'retireImported'
      ).length
  const skipped =
    targets.filter((t) => t.status === 'skipped').length +
    [...rules, ...skills, ...agents].filter((x) => x.status === 'skipped' || x.status === 'refused')
      .length
  // Error list: plan errors + target file errors + copy/delete failures (no contents — names and reasons only)
  const itemLabel = (kind: string, x: { name: string; tool?: string }): string =>
    `${kind} ${x.tool ? `${x.tool}/` : ''}${x.name}`
  const errors = [
    ...r.plan.errors,
    ...targets
      .filter((t) => t.status === 'error')
      .map((t) => `${t.label}${t.detail ? `: ${t.detail}` : ''}`),
    ...(
      [
        ...rules.map((x) => ['rule', x] as const),
        ...skills.map((x) => ['skill', x] as const),
        ...agents.map((x) => ['agent', x] as const)
      ] as const
    )
      .filter(([, x]) => x.status === 'failed')
      .map(([k, x]) => `${itemLabel(k, x)}: ${x.reason ?? 'failed'}`)
  ]
  const errorCount = errors.length
  // If sync also ran deletions, only the remaining (refused/failed) candidates
  const doneDelete = (kind: string, tool: string | undefined, name: string): boolean =>
    !!r.results &&
    [
      ...r.results.rules.map((x) => ({ k: 'rule', t: x.tool as string | undefined, x })),
      ...r.results.skills.map((x) => ({ k: 'skill', t: x.tool as string | undefined, x })),
      ...r.results.agents.map((x) => ({ k: 'agent', t: x.tool as string | undefined, x }))
    ].some(
      (e) =>
        e.k === kind &&
        e.t === tool &&
        e.x.name === name &&
        e.x.action === 'deleteCandidate' &&
        e.x.status === 'done'
    )
  const allCandidates: DeleteCandidateRequest[] = [
    ...r.plan.skills
      .filter((x) => x.action === 'deleteCandidate')
      .map((x) => ({
        kind: 'skill' as const,
        tool: x.tool,
        name: x.name,
        path: x.path,
        currentHash: x.currentHash,
        currentLink: x.currentLink
      })),
    ...r.plan.rules
      .filter((x) => x.action === 'deleteCandidate')
      .map((x) => ({
        kind: 'rule' as const,
        ...(x.tool ? { tool: x.tool } : {}),
        name: x.name,
        path: x.path,
        currentHash: x.currentHash
      })),
    ...r.plan.agents
      .filter((x) => x.action === 'deleteCandidate')
      .map((x) => ({
        kind: 'agent' as const,
        tool: x.tool,
        name: x.name,
        path: x.path,
        currentHash: x.currentHash
      }))
  ]
  const deleteCandidates = allCandidates.filter((d) => !doneDelete(d.kind, d.tool, d.name))
  const notInitialized = notInitializedOf(r.plan.targets)
  return {
    at,
    wrote: !!r.results,
    ...(r.refused ? { refused: r.refused } : {}),
    targets: targets.map((t) => ({ ...t, label: t.label })),
    rules,
    skills,
    agents,
    errors,
    needsSync: planned + skipped,
    errorCount,
    deleteCandidates,
    notInitialized
  }
}

const TARGET_TOOL = new Map(ALL_TARGETS.map((t) => [t.id, t.tool]))

/** Plan targets skipped because the tool has not created its file yet, or COPILOT_HOME points elsewhere (one entry per file). nothingToWrite is not shown */
export function notInitializedOf(changes: SyncAllResult['plan']['targets']): NotInitializedView[] {
  const out = new Map<string, NotInitializedView>()
  for (const c of changes) {
    const tool = TARGET_TOOL.get(c.id)
    if (!tool || out.has(c.path)) continue
    if (c.skip === 'toolNotInitialized') out.set(c.path, { tool, label: c.label })
    else if (
      c.skip === 'copilotHomeOverride' ||
      c.skip === 'grokHomeOverride' ||
      c.skip === 'jsoncUnsupported'
    )
      out.set(c.path, { tool, label: c.label, reason: c.skip })
  }
  return [...out.values()]
}

/** Failure count of the last sync (red state of the sidebar sync button) */
export function syncFailedCount(): number {
  return lastSync.errorCount
}

/**
 * Source → tool sync. approvedOnce = user explicitly approved this one run (ignores allowRealApply, settings unchanged). Writes for real if allowRealApply (or fixture HOME), otherwise plans only.
 * The source always wins, so drift is ignored (forced here until the engine defaults to force).
 */
export function syncNow(
  home: string,
  env: Env,
  approvedOnce = false,
  expectFingerprint?: string
): SyncStatusView {
  const at = new Date().toISOString()
  try {
    const allowReal = approvedOnce || !!readConfig(home).config.allowRealApply
    const r = syncAll(home, env, {
      allowReal,
      approvedOnce,
      ...(expectFingerprint !== undefined ? { expectFingerprint } : {})
    })
    lastSync = toView(home, r, at)
  } catch (e) {
    lastSync = {
      ...lastSync,
      at,
      wrote: false,
      errors: [(e as Error).message],
      errorCount: lastSync.errorCount + 1
    }
  }
  return lastSync
}

// ---------------------------------------------------------------- Settings

export function configView(home: string, fixture: boolean): ConfigView {
  const c = readConfig(home)
  const st = libraryState(home)
  return {
    path: tilde(home, c.path),
    exists: c.exists,
    ...(c.error ? { error: c.error } : {}),
    config: c.config,
    libraryRoot: tilde(home, st.root),
    libraryExists: st.exists,
    home: fixture ? home : '~',
    fixture,
    libraryReady: st.ready,
    libraryLegacy: st.legacy,
    libraryEmpty: st.ready && libraryIsEmpty(home),
    inUse: toolsInUse(home),
    ...(libraryStartError &&
    !(libraryStartError.code === 'renamePending' && !renamePendingPaths(home).length)
      ? { libraryStartError }
      : {})
  }
}

/** config.json `ui`. Empty when the file is missing or unreadable (the renderer then falls back to its old localStorage values) */
export function uiPrefsGet(home: string): UiPrefs {
  return readConfig(home).config.ui ?? {}
}

/** Merge a preference patch into config.json `ui`; a config.json that fails to read is left alone */
export function uiPrefsSet(home: string, patch: UiPrefsPatch): UiPrefs {
  const cur = readConfig(home)
  if (cur.error) throw new ConfigError(`config.json: ${cur.error}`)
  const ui = mergeUiPrefs(cur.config.ui, patch)
  writeConfig(home, { ...cur.config, version: 1, ui })
  return ui
}

/** Apply patch over the current settings. undefined values remove the key */
export function configSet(home: string, patch: Partial<AppConfig>): void {
  const cur = readConfig(home)
  if (cur.error) throw new ConfigError(`config.json: ${cur.error}`)
  const next: Json = { ...(cur.config as unknown as Json), version: 1 }
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'version') continue
    if (v === undefined || v === null) delete next[k]
    else next[k] = v
  }
  writeConfig(home, next as unknown as AppConfig)
}

/** Tools in use + detection (read-only) */
export function toolsInUseView(home: string, env: Env): ToolsInUseView {
  return {
    inUse: toolsInUse(home),
    configured: readConfig(home).config.toolsInUse !== undefined,
    retiring: readConfig(home).config.toolsRetiring ?? [],
    detected: detectTools(home, env)
  }
}

/** Tools the app has written to (state records): while toolsInUse is unset, only these retire when turned off */
function toolsWritten(home: string): ToolId[] {
  const st = readState(home).state
  const targetTool = new Map<string, ToolId>(ALL_TARGETS.map((t) => [t.id, t.tool]))
  const out = new Set<ToolId>()
  for (const id of Object.keys(st.applied)) {
    const t = targetTool.get(id)
    if (t) out.add(t)
  }
  if (Object.keys(st.rules ?? {}).length) out.add('claude')
  for (const rec of [st.skills, st.toolRules, st.agents])
    for (const [t, v] of Object.entries(rec ?? {}))
      if (v && Object.keys(v).length) out.add(t as ToolId)
  return [...out]
}

/**
 * Save tools in use (null/undefined = unset → the default tools). Config only; nothing is applied to tools here.
 * `retiring` (undo after a cancelled preview) restores the retiring list exactly
 */
export function toolsInUseSet(
  home: string,
  list: ToolId[] | null | undefined,
  retiring?: ToolId[]
): void {
  if (list !== null && list !== undefined && !Array.isArray(list))
    throw new ConfigError('toolsInUse must be an array')
  if (retiring !== undefined && !Array.isArray(retiring))
    throw new ConfigError('toolsRetiring must be an array')
  const before = toolsInUse(home)
  setToolsInUse(home, list ?? undefined, retiring ? { retiring } : { wrote: toolsWritten(home) })
  // Tools added to the app later (Grok CLI) don't inherit items that are explicitly off everywhere else
  for (const t of toolsInUse(home))
    if (t === 'grok' && !before.includes(t)) {
      try {
        seedNewToolToggles(home, t)
      } catch {
        // the library may not exist yet (onboarding): nothing to seed
      }
    }
}

// ---------------------------------------------------------------- Library

export const lib = {
  permissionsSave: (home: string, rules: PermissionRules) => ({
    path: savePermissionRules(home, rules)
  }),
  toggle: (home: string, kind: ManifestKind, name: string, tool: ToolId, on: boolean) =>
    setToggle(home, kind, name, tool, !!on),
  ruleRead: (home: string, name: string) => readRule(home, name),
  ruleSave: (home: string, name: string, content: string) => {
    writeRule(home, name, String(content))
  },
  ruleCreate: (home: string, name: string, content: string) => {
    createRule(home, name, String(content ?? ''))
  },
  ruleDelete: (home: string, name: string) => deleteRule(home, name),
  ruleRename: (home: string, from: string, to: string) => renameRule(home, from, to),
  skillFiles: (home: string, name: string) => listSkillFiles(home, name),
  skillFileRead: (home: string, name: string, rel: string) => readSkillFile(home, name, rel),
  skillFileSave: (home: string, name: string, rel: string, content: string) => {
    writeSkillFile(home, name, rel, String(content))
  },
  skillCreate: (home: string, name: string, description: string) => {
    createSkill(home, name, String(description))
  },
  skillDelete: (home: string, name: string) => deleteSkill(home, name),
  skillDoc: (home: string, name: string) => readSkillDoc(home, name),
  skillDocSave: (home: string, name: string, doc: SkillDocInput) => {
    const d = (doc ?? {}) as Partial<SkillDocInput>
    writeSkillDoc(home, name, {
      description: String(d.description ?? ''),
      body: String(d.body ?? '')
    })
  },
  skillRename: (home: string, from: string, to: string) => renameSkill(home, from, to),
  agentCreate: (home: string, name: string, description: string) => {
    createAgent(home, name, String(description))
  },
  agentDelete: (home: string, name: string) => deleteAgent(home, name),
  agentDoc: (home: string, name: string) => readAgentDoc(home, name),
  agentDocSave: (home: string, name: string, doc: AgentDocInput) => {
    const d = (doc ?? {}) as Partial<AgentDocInput>
    writeAgentDoc(home, name, {
      description: String(d.description ?? ''),
      body: String(d.body ?? ''),
      tools: (d.tools ?? {}) as AgentDocInput['tools']
    })
  },
  agentRename: (home: string, from: string, to: string) => renameAgent(home, from, to),
  mcpDelete: (home: string, name: string) => {
    const { trashPath } = deleteMcpServer(home, name, { secrets: defaultSecretBackend() })
    return { trashPath }
  },
  memoryFiles: (home: string) => listMemoryFiles(home),
  memoryRead: (home: string, rel: string) => readMemoryFile(home, rel),
  memorySave: (home: string, rel: string, content: string) => {
    writeMemoryFile(home, rel, String(content))
  },
  memoryDelete: (home: string, rel: string) => deleteMemoryFile(home, rel),
  hookCreate: (home: string, name: string, input: NewHookInput) => {
    const i = (input ?? {}) as Partial<NewHookInput>
    createHook(home, name, {
      description: String(i.description ?? ''),
      when: i.when as NewHookInput['when'],
      action: i.action as NewHookInput['action'],
      options: (i.options ?? {}) as NewHookInput['options'],
      ...(typeof i.body === 'string' ? { body: i.body } : {}),
      ...(typeof i.script === 'string' ? { script: i.script } : {})
    })
    return { name }
  },
  hookSave: (home: string, name: string, doc: HookDoc) => {
    saveHookDoc(home, name, doc)
    return { name }
  },
  /** Make a built-in action hook a script hook, starting from what it runs in this tool */
  hookConvert: (home: string, name: string, tool: string) => {
    if (!isHookTool(tool)) throw new LibraryError('invalidSchema', 'not a hook tool')
    const h = readHook(home, name)
    const runs = toolScript(tool, h)
    convertHookToScript(home, name, runs?.content ?? HOOK_SCRIPT_TEMPLATE)
    return { name }
  },
  hookDelete: (home: string, name: string) => deleteHook(home, name),
  hookScriptSave: (home: string, name: string, file: string, content: string) => {
    saveHookScript(home, name, file, String(content))
    return { file }
  },
  hookToolScriptCreate: (home: string, name: string, tool: string) => {
    if (!isHookTool(tool)) throw new LibraryError('invalidSchema', 'not a hook tool')
    return { file: createHookToolScript(home, name, tool) }
  },
  hookToolScriptDrop: (home: string, name: string, tool: string) => {
    if (!isHookTool(tool)) throw new LibraryError('invalidSchema', 'not a hook tool')
    return dropHookToolScript(home, name, tool)
  },
  hookKeepCopy: (home: string, name: string, tool: string, file: string) => {
    if (!isHookTool(tool)) throw new LibraryError('invalidSchema', 'not a hook tool')
    keepHookCopy(home, tool, name, file)
    return { file }
  }
}

/** HOOK.md, its scripts and what each tool runs, for the detail sheet */
export function hookRead(home: string, name: string): HookEditView {
  try {
    const h = readHook(home, name)
    const triggers = hookTriggers(h.doc)
    const runs: HookEditView['runs'] = {}
    for (const tool of HOOK_TOOLS) {
      const t = triggers[tool]
      if (!t) continue
      const script = toolScript(tool, h)
      runs[tool] = script
        ? { trigger: t, file: script.file, content: script.content }
        : { trigger: t, prompt: renderAskPrompt(h.doc) }
    }
    return { name: h.name, doc: h.doc, scripts: h.scripts, runs }
  } catch (e) {
    if (e instanceof LibraryError) throw e
    throw new LibraryError('notFound', (e as Error).message)
  }
}

export function mcpRead(home: string, name: string): McpEditView {
  const servers = readSources(home).mcp.servers
  if (!Object.prototype.hasOwnProperty.call(servers, name))
    throw new LibraryError('notFound', 'Server not found')
  const def = structuredClone(servers[name]) as unknown as Json
  const masked = maskServer(def)
  if (typeof def.bearerToken === 'string') {
    def.bearerToken = MASK
    masked.push('bearerToken')
  }
  return { name, def: def as unknown as McpServer, masked }
}

/**
 * headers/env/bearerToken values that arrive as MASK are restored from the existing definition (invalidSchema if absent).
 * Other plaintext goes to the Keychain and only secret: references are written to the library (${VAR} stays as is)
 */
export function mcpSave(
  home: string,
  name: string,
  def: McpServer,
  secrets: SecretBackend = defaultSecretBackend()
): ReturnType<typeof upsertMcpServer> {
  if (!isObj(def)) throw new LibraryError('invalidSchema', 'Server definition is not an object')
  let current: Json | undefined
  try {
    const servers = readSources(home).mcp.servers
    current = servers[name] as unknown as Json | undefined
  } catch {
    current = undefined
  }
  const next = structuredClone(def) as unknown as Json
  for (const table of SECRET_TABLES) {
    const t = next[table]
    if (!isObj(t)) continue
    for (const [k, v] of Object.entries(t)) {
      if (v === MASK) {
        const prev = current && isObj(current[table]) ? (current[table] as Json)[k] : undefined
        if (typeof prev !== 'string')
          throw new LibraryError(
            'invalidSchema',
            `${table}.${k} arrived masked but there is no existing value`
          )
        t[k] = prev
      }
    }
    if (!Object.keys(t).length) delete next[table]
  }
  if (next.bearerToken === MASK) {
    const prev = current?.bearerToken
    if (typeof prev !== 'string')
      throw new LibraryError(
        'invalidSchema',
        'bearerToken arrived masked but there is no existing value'
      )
    next.bearerToken = prev
  }
  return upsertMcpServer(home, name, next as unknown as McpServer, { secrets })
}

/** Import sources (engine). Paths are for display (~) */
export function importSources(home: string): ImportSource[] {
  return listImportSources(home).map((x) => ({ ...x, path: tilde(home, x.path) }))
}

/** Candidates from the chosen source. headers/env values of MCP variants are masked */
export function importPlanView(home: string, sourceId: string): ImportPlanView {
  const plan = planImport(home, sourceId || undefined)
  for (const c of plan.mcp) for (const v of c.variants) maskServer(v.server as unknown as Json)
  return {
    ...plan,
    sources: plan.sources.map((x) => ({ ...x, path: tilde(home, x.path) })),
    masked: true,
    sourceId
  }
}

export function importApplyRun(
  home: string,
  sourceId: string,
  selections: ImportSelection[]
): ReturnType<typeof applyImport> {
  return applyImport(home, Array.isArray(selections) ? selections : [], sourceId || undefined, {
    secrets: defaultSecretBackend()
  })
}

/** SKILL.md description (frontmatter) of a library skill. Empty string if absent */
export function skillDescriptions(home: string, names: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const noEval = (): never => {
    throw new Error('js front matter is not supported')
  }
  for (const name of names) {
    try {
      const text = readSkillFile(home, name, 'SKILL.md')
      const { data } = matter(text, { engines: { js: noEval, javascript: noEval } })
      const d = (data as Json).description
      if (typeof d === 'string') out[name] = d.trim()
    } catch {
      // no description
    }
  }
  return out
}

/** Manifest toggle table for reads (library existence etc.) */
export function toggles(home: string, kind: ManifestKind): Record<string, Record<string, boolean>> {
  const m = readManifest(home)
  return m.error ? {} : (m.manifest[kind] as Record<string, Record<string, boolean>>)
}

// ---------------------------------------------------------------- Tool file writes

export function modelSet(
  home: string,
  tool: ToolId,
  key: string,
  value: string
): ReturnType<typeof setModel> {
  return setModel(home, tool, key, value)
}

/** Run deletions (engine deleteSyncCandidates). Backup paths are for display (~) */
export function deleteCandidates(
  home: string,
  env: Env,
  reqs: DeleteCandidateRequest[]
): DeleteCandidateResult[] {
  return deleteSyncCandidates(home, env, Array.isArray(reqs) ? reqs : []).map((r) => ({
    kind: r.kind,
    name: r.name,
    status: r.status,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.backupPath ? { backupPath: tilde(home, r.backupPath) } : {})
  }))
}

// ---------------------------------------------------------------- Workspaces

export function workspaces(home: string): WorkspaceView[] {
  return listWorkspaces(home)
}

export function workspaceCreate(
  home: string,
  name: string,
  from: 'empty' | 'current'
): WorkspaceView {
  return createWorkspace(home, name, { from })
}

/** Items that would leave the tools on switch (read-only — based on the post-switch sync plan) */
export function workspaceSwitchPreview(home: string, env: Env, id: string): SwitchLossItem[] {
  return previewSwitch(home, env, id)
}

/** Switch (saves config). The IPC layer handles the watcher and sync */
export function workspaceSwitch(home: string, id: string): WorkspaceView {
  return switchWorkspace(home, id)
}

/** Default export file name `<name>.illithid.zip` (path separators and control chars removed) */
export function workspaceExportFileName(home: string): string {
  const cur = listWorkspaces(home).find((w) => w.active)
  const base =
    // eslint-disable-next-line no-control-regex
    (cur?.name ?? 'workspace').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-').trim() ||
    'workspace'
  return base + WORKSPACE_ZIP_EXT
}

export function workspaceExportData(
  home: string,
  appVersion: string
): ReturnType<typeof exportWorkspace> {
  return exportWorkspace(home, { appVersion })
}

export function workspaceImportData(home: string, data: Uint8Array): WorkspaceImportView {
  const r = importWorkspace(home, data, { secrets: defaultSecretBackend() })
  return { id: r.id, name: r.name, files: r.files, missingSecrets: r.missingSecrets }
}

/** ~ path for display */
export function tildePath(home: string, p: string): string {
  return tilde(home, p)
}

export function workspaceRename(home: string, id: string, name: string): WorkspaceView {
  return renameWorkspace(home, id, name)
}

export function workspaceDelete(home: string, id: string): string {
  return tilde(home, deleteWorkspace(home, id).backupPath)
}
