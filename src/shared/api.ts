/**
 * main ↔ renderer IPC contract. Read channels + library/tool write channels.
 * Engine types are type-only imports, so no engine code ends up in the renderer bundle.
 * Raw target files and secrets are never sent to the renderer (owned-region excerpts + masked values).
 */
import type {
  PermissionRules,
  AgentDoc,
  AgentDocInput,
  HookAction,
  HookDoc,
  HookOptionValue,
  HookSupport,
  HookTiming,
  HookTool,
  HookToolSettings,
  HookTrigger,
  NewHookInput,
  AgentSyncResult,
  AppConfig,
  UiPrefs,
  UiPrefsPatch,
  Artifact,
  ArtifactTool,
  BackupStatus,
  SessionTranscript,
  Snapshot,
  TranscriptMessage,
  TranscriptOptions,
  ImportPlan,
  ImportResult,
  ImportSelection,
  Manifest,
  ManifestKind,
  McpServer,
  McpUpsertResult,
  RuleSyncItem,
  RuleSyncResult,
  SetModelResult,
  SkillDoc,
  SkillDocInput,
  SkillSyncResult,
  TargetId,
  ToolToggles,
  TrashResult,
  Roster,
  SessionScanResult,
  StatusReport,
  ToolId,
  ToolModels
} from '../engine'

import type { ImportSource, RetireKind, SwitchLossItem, ToolDetection } from '../engine'
import type {
  ModelDetail,
  ModelKey,
  ModelSummary,
  UsageKind,
  UsageStats,
  UsageSummary
} from '../engine'
import type {
  AuditPartner,
  HookEntryProblem,
  MarketHookPack,
  MarketInstallChoice,
  MarketKind,
  MarketMcpItem,
  MarketRuleItem,
  MarketSkillItem,
  MarketUpdate
} from '../engine'
export type {
  AuditPartner,
  HookEntryProblem,
  MarketHookPack,
  MarketInputSpec,
  MarketInstallChoice,
  MarketKind,
  MarketMcpItem,
  MarketRuleItem,
  MarketSkillItem,
  MarketUpdate,
  McpRunKind
} from '../engine'
export type { SwitchLossItem } from '../engine'
import type {
  ClaudeMemoryScan,
  ClaudeMemoryProject,
  ClaudeMemoryFile,
  CodexMemoryEntry,
  CodexMemoryChunk,
  CodexRolloutSummary,
  IndexStat,
  MemoryType,
  ToolMemoryMoveResult
} from '../engine'
export type {
  ClaudeMemoryScan,
  ClaudeMemoryProject,
  ClaudeMemoryFile,
  CodexMemoryEntry,
  CodexMemoryChunk,
  CodexRolloutSummary,
  IndexStat,
  MemoryType,
  ToolMemoryMoveResult
}
export type {
  AgentDoc,
  AgentDocInput,
  AgentSyncResult,
  AppConfig,
  UiPrefs,
  UiPrefsPatch,
  Artifact,
  ArtifactTool,
  BackupStatus,
  SessionTranscript,
  Snapshot,
  TranscriptMessage,
  TranscriptOptions,
  ImportPlan,
  ImportResult,
  ImportSelection,
  Manifest,
  ManifestKind,
  McpServer,
  McpUpsertResult,
  RuleSyncItem,
  RuleSyncResult,
  SetModelResult,
  SkillDoc,
  SkillDocInput,
  SkillSyncResult,
  TargetId,
  ToolToggles,
  TrashResult,
  Roster,
  SessionScanResult,
  StatusReport,
  ToolId,
  ToolModels
}
export type {
  ArtifactSourceConfig,
  CellState,
  Resource,
  Session,
  ImportCandidate,
  SkillImportCandidate,
  McpImportCandidate,
  AgentImportCandidate,
  AgentVariant,
  SkillVariant,
  McpVariant,
  ImportConflict,
  ImportSource,
  ImportSourceKind,
  ImportKind,
  RuleImportCandidate,
  MemoryImportCandidate,
  PermissionsImportCandidate,
  FileVariant,
  PermissionsVariant,
  Portability,
  PortabilityReason,
  SkillSyncAction,
  RuleSyncAction,
  AgentSyncAction,
  ToolDetection
} from '../engine'

/** Placeholder for a masked secret. If saved as-is, main keeps the existing value */
export const MASK = '•••'

export interface RulesData {
  /** Display path (~/...) */
  dir: string
  files: { name: string; text: string }[]
  /** Per-rule tool on/off (manifest). Missing key = on */
  toggles: Record<string, ToolToggles>
  error?: string
}

/** Sync state for one tool. skipped = a user file with the same name exists, so sync skipped it (not app-owned) */
export type SyncState = 'synced' | 'needsSync' | 'error' | 'skipped'

export interface SkillsData {
  /** Library skills directory (display ~/...) */
  dir: string
  /** Library skill name */
  names: string[]
  /** Per-skill tool sync state */
  state: Record<string, Partial<Record<ToolId, SyncState>>>
  /** Why a cell is in error: a plan reason code (invalidName, sourceUnreadable, …) or an error message */
  reasons?: Record<string, Partial<Record<ToolId, string>>>
  syncError?: string
  toggles: Record<string, ToolToggles>
  /** SKILL.md frontmatter description */
  descriptions: Record<string, string>
  /** Library skills the tool's own settings turn off (Gemini skills.disabled / skills.enabled=false) — shown as a warning, never changed */
  toolDisabled?: Partial<Record<ToolId, string[]>>
  /** Skills installed from the Market: library name → `owner/repo/skillId` */
  market?: Record<string, string>
  /** false when ~/.grok/config.toml turns off Grok's reading of Claude Code skills (compat.claude.skills = false) */
  grokReadsClaude?: boolean
}

/** Library agent (agents/<name>.md) */
export interface AgentsData {
  /** Library agents directory (display ~/...) */
  dir: string
  names: string[]
  /** Per-agent tool sync state */
  state: Record<string, Partial<Record<ToolId, SyncState>>>
  /** Why a cell is in error: a plan reason code or an error message */
  reasons?: Record<string, Partial<Record<ToolId, string>>>
  syncError?: string
  toggles: Record<string, ToolToggles>
  descriptions: Record<string, string>
}

/**
 * Per-tool sync state for one server.
 * synced: target entry matches the library output / needsSync: differs, missing, or left over while off /
 * notApplicable: not generated for this tool and absent from the file / error: target parse or build failed
 */
export type McpToolState = SyncState | 'notApplicable'

/** One library MCP server */
export interface McpServerView {
  name: string
  transport?: string
  /** URL without query and userinfo */
  url?: string
  command?: string
  /** Args that look like secrets are masked */
  args?: string[]
  /** Key names only, no values */
  headerKeys: string[]
  envKeys: string[]
  /** Environment variable names */
  bearerEnv?: string
  /** Bearer token is in the keychain (no value) */
  bearerToken?: boolean
  tools: Partial<Record<ToolId, McpToolState>>
  /** Why a tool is in error: a reason code (configUnreadable) or the generator's message */
  reasons?: Partial<Record<ToolId, string>>
}

export interface McpData {
  /** Library mcps directory (display ~/...) */
  dir?: string
  servers: McpServerView[]
  toggles: Record<string, ToolToggles>
  error?: string
  /** false when ~/.grok/config.toml turns off Grok's reading of Claude Code MCP servers (compat.claude.mcps = false) */
  grokReadsClaude?: boolean
}

/** Per-tool state of one hook: its config entry and script copies */
export type HookToolState = SyncState | 'notApplicable'

/** One library hook */
export interface HookView {
  name: string
  description: string
  when: HookTiming
  action: HookAction
  options: Record<string, HookOptionValue>
  /** Hook tools in use on this device */
  tools: Partial<Record<ToolId, HookToolState>>
  /** Hook tools in use that can't run this hook, and why */
  unsupported?: Partial<Record<ToolId, HookSupport>>
  /** Why a tool is in error: a reason code (configUnreadable) or the generator's message */
  reasons?: Partial<Record<ToolId, string>>
  /** Script copies edited in a tool since the last sync: tool → file */
  edited?: Partial<Record<ToolId, string>>
}

export interface HooksData {
  /** Library hooks directory (display ~/...) */
  dir?: string
  hooks: HookView[]
  toggles: Record<string, ToolToggles>
  error?: string
  /** false when Grok doesn't run Claude Code hooks (config.grokReadsClaude off or compat.claude.hooks = false) */
  grokReadsClaude?: boolean
}

/** One library script and the hooks that run it */
export interface ScriptView {
  name: string
  description: string
  content: string
  users: string[]
}

export interface ScriptsData {
  /** Library scripts directory (display ~/...) */
  dir: string
  scripts: ScriptView[]
  error?: string
}

/** How a tool gets the permission rules: its own file (sync state), through Claude Code's settings (Grok), or not at all */
export type PermissionToolState = SyncState | 'notApplicable' | 'viaClaude'

/** The permissions menu */
export interface PermissionsData {
  /** permissions.json (display ~/...) */
  file: string
  rules: PermissionRules
  /** Claude Code-only raw rules kept in permissions.json (claudeOnly), shown as a count */
  claudeOnly: number
  /** Per tool in use */
  tools: Partial<Record<ToolId, PermissionToolState>>
  reasons?: Partial<Record<ToolId, string>>
  /** Hooks that block commands too (the guard action) */
  guards: { name: string; patterns: string[] }[]
  error?: string
}

/** HOOK.md, its scripts and what each tool runs, for the detail sheet */
export interface HookEditView {
  name: string
  doc: HookDoc
  /** Script action: script file → content */
  scripts: Record<string, string>
  /** Each tool that can run the hook: its trigger and the generated script (or the Claude Code prompt) */
  runs: Partial<
    Record<HookTool, { trigger: HookTrigger; file?: string; content?: string; prompt?: string }>
  >
}

export type { CommandRule, PermissionDecision, PermissionRules } from '../engine'
export type {
  HookAction,
  HookDoc,
  HookOptionValue,
  HookSupport,
  HookTiming,
  HookTool,
  HookToolSettings,
  HookTrigger,
  NewHookInput
}

// ---------------------------------------------------------------- write channel types

/** App config view. Paths are for display (~) */
/** Tools in use on this device (config.toolsInUse). Tools not in use get no writes at all */
export interface ToolsInUseView {
  /** Effective list (the default tools while unset) */
  inUse: ToolId[]
  /** false = config.toolsInUse not set yet (users from before the setting, or first run) */
  configured: boolean
  /** Tools turned off whose app copies are still to be removed (config.toolsRetiring) */
  retiring: ToolId[]
  /** What looks installed on this device (config folder or executable on PATH) */
  detected: ToolDetection[]
}

export interface ConfigView {
  path: string
  exists: boolean
  error?: string
  config: AppConfig
  /** Current effective library root (~ form) */
  libraryRoot: string
  libraryExists: boolean
  /** HOME used by main (~ form; real path for fixtures) */
  home: string
  /** Whether running in fixture mode via ILLITHID_HOME */
  fixture: boolean
  /** Library is writable (exists and is not the legacy ~/.agents) */
  libraryReady: boolean
  /** libraryRoot points at the legacy ~/.agents */
  libraryLegacy: boolean
  /** Library exists but has no entries */
  libraryEmpty: boolean
  /** Tools in use on this device (config.toolsInUse, or the default tools while unset) */
  inUse: ToolId[]
  /**
   * Automatic library creation at app start did not happen.
   * renamePending: old-name paths remain, so not created (detail = those paths) · initFailed: creation failed (detail = reason)
   */
  libraryStartError?: { code: 'renamePending' | 'initFailed' | 'migrateFailed'; detail: string }
}

// ---- workspaces (engine workspace.ts)
export interface WorkspaceView {
  id: string
  name: string
  active: boolean
}

/** Menu bar item state, pushed by the renderer */
export interface TrayState {
  pending: number
  failed: number
  workspaces: WorkspaceView[]
}

/** Menu bar item clicks the renderer handles (main shows the window first) */
export type TrayAction =
  { kind: 'settings' } | { kind: 'update' } | { kind: 'workspace'; id: string }

/** Recent session in the menu bar popover */
export interface TraySession {
  title: string
  tool: ToolId
  updatedAt?: string
  resumeCommand: string
}

/** Menu bar popover buttons */
export type TrayCommand =
  { kind: 'open' | 'settings' | 'update' | 'quit' } | { kind: 'workspace'; id: string }

/** A newer release than the running app */
export interface UpdateView {
  version: string
  current: string
  /** Release notes (markdown) */
  notes: string
  /** Release page */
  url: string
  /** Installed through Homebrew (update with `command`) or from the DMG (download from `url`) */
  install: 'brew' | 'dmg'
  command: string | null
}

export interface WorkspaceExportResult {
  /** Saved file (~ form) */
  path: string
  files: number
  /** Skipped entries (symlinks etc.) */
  skipped: string[]
}

export interface WorkspaceImportView {
  id: string
  name: string
  files: number
  /** Secret accounts with no keychain value (`<server>/<headers|env>/<KEY>`) */
  missingSecrets: string[]
}

/** Write refusal reason */
export type RefusedReason =
  'allowRealApplyOff' | 'configError' | 'invalid' | 'libraryNotReady' | 'notAvailable'

export interface Refused {
  refused: RefusedReason
  message: string
}

export interface WriteOk<T = undefined> {
  ok: true
  value: T
  /** Result of the auto sync after a library write, if one ran */
  sync?: SyncStatusView
}
export interface WriteErr {
  ok: false
  /** LibraryError.code · ManifestError etc. */
  code: string
  message: string
}
export type WriteResult<T = undefined> = WriteOk<T> | WriteErr

/** MCP server definition for editing. headers/env values that look secret are sent as MASK */
export interface McpEditView {
  name: string
  def: McpServer
  /** Masked keys (headers.X / env.X) */
  masked: string[]
}

/** Sync state of one target file (no raw content) */
export interface SyncTargetView {
  id: TargetId
  label: string
  status: 'written' | 'unchanged' | 'skipped' | 'planned' | 'error'
  reason?: string
  detail?: string
}

/**
 * Last sync. Kept in memory by main.
 * refused: libraryMissing (no library) · realHomeNotAllowed (allowRealApply off) → plan only
 */
export interface SyncStatusView {
  /** Last run time (ISO). undefined if never run */
  at?: string
  /** Whether it actually wrote */
  wrote: boolean
  refused?: 'libraryMissing' | 'realHomeNotAllowed' | 'planChanged'
  targets: SyncTargetView[]
  rules: RuleSyncResult[]
  skills: SkillSyncResult[]
  agents: AgentSyncResult[]
  /** Planning errors and exceptions */
  errors: string[]
  /** Count needing sync (unwritten changes) · error count */
  needsSync: number
  errorCount: number
  /** Delete candidates (approval flow) */
  deleteCandidates: DeleteCandidateRequest[]
  /** Files the tool creates on its first run that are still missing while the library has content for them (not an error) */
  notInitialized: NotInitializedView[]
}

/**
 * A tool file skipped because the tool has not created it yet (FileChange.skip = toolNotInitialized), COPILOT_HOME/GROK_HOME points
 * elsewhere, or the opencode.jsonc in use is not plain JSON
 */
export interface NotInitializedView {
  tool: ToolId
  /** Display path (~) */
  label: string
  /** Why the file is left alone instead of the tool's first run: COPILOT_HOME/GROK_HOME points elsewhere, or the file has JSONC syntax */
  reason?: 'copilotHomeOverride' | 'grokHomeOverride' | 'jsoncUnsupported'
}

export interface DeleteCandidateRequest {
  kind: 'skill' | 'rule' | 'agent'
  tool?: ToolId
  name: string
  /** path from the plan (returned as the absolute path, not a display path) */
  path: string
  currentHash?: string
  currentLink?: string
}

export interface DeleteCandidateResult {
  kind: 'skill' | 'rule' | 'agent' | 'hook'
  name: string
  status: 'deleted' | 'refused' | 'failed'
  reason?: string
  backupPath?: string
}

export interface ImportPlanView extends ImportPlan {
  /** Server definitions in candidate MCP variants have headers/env values masked with MASK */
  masked: true
  sourceId: string
}

export interface LibraryInitResult {
  root: string
  created: string[]
  /** Imported item count per kind when called with importLegacy=true */
  imported?: Record<string, number>
  importErrors?: string[]
}

export type PreviewKind = 'md' | 'text' | 'html' | 'image' | 'binary'

export interface ArtifactPreview {
  id: string
  kind: PreviewKind
  size: number
  /** md·text·html source (max 200KB) */
  text?: string
  /** image data URL (max 5MB) */
  dataUrl?: string
  /** html for the rendered view: images next to the file inlined as data URLs (the sandbox loads nothing from outside) */
  rendered?: string
  truncated: boolean
  error?: string
}

// ---- backup (engine backup.ts). Auto-backup switch is config.json `autoBackup`
export interface BackupStatusView extends BackupStatus {
  autoBackup: boolean
  /** Error while reading status (empty repo etc.). If set, some fields are estimates */
  error?: string
}

// ---- tool auto memory (engine toolMemory). Codex is read-only
export interface ToolMemoryView {
  claude: ClaudeMemoryScan
  codex: CodexMemoryEntry[]
}

// ---- session content search (engine sessionIndex)
import type {
  DocKind,
  DocSearchResponse,
  IndexStatus,
  SearchAllResponse,
  SessionSearchResponse
} from '../engine'
export type { SessionSearchHit, SessionSearchResponse, SessionSearchResult } from '../engine'
export type { DocKind, DocSearchResponse, DocSearchResult, SearchAllResponse } from '../engine'

export interface DocSearchFilters {
  kind?: DocKind
  tool?: ArtifactTool
}

export interface SessionSearchFilters {
  tool?: ToolId
  project?: string
  role?: 'user' | 'assistant'
}

/** Index status. When running, progress counts sessions to reindex in this run */
export interface SearchIndexView extends IndexStatus {
  running: boolean
  progress?: { done: number; total: number }
  error?: string
}

// ---- backup cleanup (engine backupRetention). Paths are for display (~)
export interface BackupCleanupPreview {
  count: number
  bytes: number
}

export interface BackupCleanupView {
  moved: number
  bytes: number
  failed: { path: string; reason: string }[]
}

// ---- session transcript (engine readSessionTranscript)
export interface TranscriptView extends SessionTranscript {
  available: boolean
  error?: string
}

// ---- marketplace
export interface MarketSearchView {
  skills?: MarketSkillItem[]
  mcp?: MarketMcpItem[]
  rules?: MarketRuleItem[]
  hooks?: MarketHookPack[]
  /** MCP registry paging */
  nextCursor?: string
  /** `<kind>:<source id>` → library name, for items installed from the marketplace */
  installed: Record<string, string>
}

export type MarketDetailView =
  | {
      kind: 'skill'
      id: string
      source: string
      skillId: string
      name: string
      description?: string
      skillMd: string
      files: { rel: string; size: number }[]
      skipped: string[]
      audit: Record<string, AuditPartner> | null
      /** Commit the detail showed — pass back on install */
      ref: string
      installedAs?: string
    }
  | {
      kind: 'mcp'
      id: string
      title?: string
      description: string
      version: string
      repo?: string
      website?: string
      choices: MarketInstallChoice[]
      name: string
      ref: string
      installedAs?: string
    }
  | {
      kind: 'rule'
      id: string
      title: string
      description: string
      applyTo?: string
      body: string
      name: string
      url: string
      ref: string
      installedAs?: string
    }
  | {
      kind: 'hook'
      id: string
      title: string
      description: string
      tags: string[]
      readme: string
      url: string
      /** Library hooks the pack becomes; entries with a problem are skipped */
      hooks: {
        name: string
        when: HookTiming
        event: string
        content: string
        problem?: HookEntryProblem
      }[]
      /** Pack folder tree SHA */
      ref: string
      installedAs?: string
    }

export interface MarketInstallOptions {
  /** Library name (rules: with or without .md) */
  name: string
  /** MCP install option id */
  choice?: string
  /** MCP form values by InputSpec.key */
  values?: Record<string, string>
  /** MarketDetailView.ref — install is refused if the source changed since */
  ref?: string
}

/** Skill / MCP usage from local session logs */
export type { UsageKind, UsageStats, UsageSummary } from '../engine'

/** Model usage from local session logs */
export type { Dist, ModelDetail, ModelKey, ModelSummary, SessionRef } from '../engine'

/** Day range for model stats: last N days, or an inclusive YYYY-MM-DD range (wins over days). Neither = everything */
export interface ModelRangeArg {
  days?: number
  from?: string
  to?: string
}

export interface SessionModelShare {
  tool: string
  model: string
  effort: string
  turns: number
  share: number
}

export interface MarketBulkResult {
  installed: { id: string; name: string }[]
  /** reason: installed · exists · needsInput · unsupported · rateLimited · MarketError code */
  skipped: { id: string; reason: string }[]
}

export interface Api {
  // ---- reads
  status(): Promise<StatusReport>
  rules(): Promise<RulesData>
  skills(): Promise<SkillsData>
  agents(): Promise<AgentsData>
  mcp(): Promise<McpData>
  hooks(): Promise<HooksData>
  permissions(): Promise<PermissionsData>
  scripts(): Promise<ScriptsData>
  artifacts(): Promise<Artifact[]>
  artifactPreview(id: string): Promise<ArtifactPreview>
  /** Image or HTML thumbnail (data URL, about 256px; null if there is none) */
  artifactThumb(id: string): Promise<string | null>
  /** Open with the default app (ids from the last scan only) */
  artifactOpen(id: string): Promise<WriteResult>
  /** Reveal in Finder (ids from the last scan only) */
  artifactReveal(id: string): Promise<WriteResult>
  sessions(): Promise<SessionScanResult>
  sessionTranscript(tool: ToolId, id: string, opts?: TranscriptOptions): Promise<TranscriptView>
  /** Search conversation content (FTS for 3+ chars, LIKE for 1–2) */
  sessionSearch(q: string, filters?: SessionSearchFilters): Promise<SessionSearchResponse>
  sessionIndexStatus(): Promise<SearchIndexView>
  /** Search artifact and library document content (FTS for 3+ chars, LIKE for 1–2) */
  docSearch(q: string, filters?: DocSearchFilters): Promise<DocSearchResponse>
  /** Sessions + documents grouped by kind */
  searchAll(q: string): Promise<SearchAllResponse>
  /** Index progress/done events. Returns an unsubscribe function */
  onSearchIndexEvent(cb: (s: SearchIndexView) => void): () => void
  // ---- marketplace (network in main only; refused with code 'disabled' when marketEnabled is false)
  marketSearch(kind: MarketKind, q: string, cursor?: string): Promise<WriteResult<MarketSearchView>>
  marketDetail(kind: MarketKind, id: string): Promise<WriteResult<MarketDetailView>>
  marketInstall(
    kind: MarketKind,
    id: string,
    opts: MarketInstallOptions
  ): Promise<WriteResult<{ name: string; warnings?: string[] }> | Refused>
  /** Skill or MCP call counts from local session logs, by model, tool and day. null = not indexed yet (an index run starts) */
  usage(kind: UsageKind, name: string): Promise<UsageStats | null>
  /** Last 30 days for many skills or MCP servers at once (lists). null until the usage index exists */
  usageSummary(kind: UsageKind, names: string[]): Promise<Record<string, UsageSummary> | null>
  /** Models used in the range with counts, tokens and request medians. null = not indexed yet (an index run starts) */
  models(range?: ModelRangeArg): Promise<ModelSummary[] | null>
  /** One model: daily trend, distributions, tools, skills, MCP, projects, sessions, Codex limits. null = not indexed yet */
  modelDetail(key: ModelKey, range?: ModelRangeArg): Promise<ModelDetail | null>
  /** Models used in one session (subagents included) by share of turns. null = not indexed yet */
  sessionModels(tool: ToolId, id: string): Promise<SessionModelShare[] | null>
  /** Install several items with default names/options; one sync at the end */
  marketInstallMany(
    kind: MarketKind,
    ids: string[]
  ): Promise<WriteResult<MarketBulkResult> | Refused>
  marketUpdates(): Promise<WriteResult<{ updates: MarketUpdate[]; failed: string[] }>>
  marketUpdate(kind: MarketKind, name: string): Promise<WriteResult<{ name: string }> | Refused>
  // ---- config·library setup
  configGet(): Promise<ConfigView>
  configSet(patch: Partial<AppConfig>): Promise<WriteResult<ConfigView>>
  /** config.json `ui` read synchronously by preload before the first render (language, color scheme, view modes) */
  uiPrefsInitial: UiPrefs
  /** Merge into config.json `ui` (null removes a key, views merge per screen); every window gets onUiPrefsEvent */
  uiPrefsSet(patch: UiPrefsPatch): Promise<WriteResult<UiPrefs>>
  onUiPrefsEvent(cb: (p: UiPrefs) => void): () => void
  /** Tools in use + detection (read-only) */
  toolsInUseGet(): Promise<ToolsInUseView>
  /** Save the tools in use (null = unset, all tools). Writes config only — applying to a newly enabled tool is a separate sync */
  toolsInUseSet(tools: ToolId[] | null, retiring?: ToolId[]): Promise<WriteResult<ToolsInUseView>>
  /** Installed-tool detection only (read-only) */
  detectTools(): Promise<ToolDetection[]>
  pickDirectory(current?: string): Promise<string | null>
  libraryInit(path?: string, importLegacy?: boolean): Promise<WriteResult<LibraryInitResult>>
  // ---- workspaces
  workspaces(): Promise<WorkspaceView[]>
  workspaceCreate(name: string, from?: 'empty' | 'current'): Promise<WriteResult<WorkspaceView>>
  /** Rename only (id and folder unchanged) */
  workspaceRename(id: string, name: string): Promise<WriteResult<WorkspaceView>>
  /** Move to the backup folder (refuses active or last one). value = backup path (~ form) */
  workspaceDelete(id: string): Promise<WriteResult<string>>
  /** Switch → reconnect watcher → sync */
  workspaceSwitch(id: string, apply?: boolean): Promise<WriteResult<SyncStatusView>>
  /** Items that would be removed from tools on switch (read-only) */
  workspaceSwitchPreview(id: string): Promise<WriteResult<SwitchLossItem[]>>
  /** Active workspace → save dialog. value null if cancelled */
  workspaceExport(): Promise<WriteResult<WorkspaceExportResult | null>>
  /** Open dialog → add as a new workspace (no switch). value null if cancelled */
  workspaceImport(): Promise<WriteResult<WorkspaceImportView | null>>
  /** Status sent by main after library watch and auto sync. Returns an unsubscribe function */
  onSyncEvent(cb: (s: SyncStatusView) => void): () => void
  /** Menu bar item state (macOS) */
  traySet(state: TrayState): Promise<void>
  /** Menu bar item clicks. Returns an unsubscribe function */
  onTrayAction(cb: (a: TrayAction) => void): () => void
  /** Menu bar popover: last read recent sessions (fresh ones follow through onTraySessions) */
  traySessions(): Promise<TraySession[]>
  /** Menu bar popover buttons */
  trayCommand(c: TrayCommand): Promise<void>
  /** Menu bar popover: recent sessions re-read. Returns an unsubscribe function */
  onTraySessions(cb: (s: TraySession[]) => void): () => void
  /** Running app version */
  appVersion(): Promise<string>
  /** Newer release found by the last check (null = none) */
  updateStatus(): Promise<UpdateView | null>
  /** Check now (Settings) */
  updateCheckNow(): Promise<UpdateView | null>
  /** Homebrew installs: open Terminal running the upgrade command */
  updateOpenTerminal(): Promise<WriteResult<null>>
  /** Don't ask about this version again */
  updateSkip(version: string): Promise<WriteResult<null>>
  /** A check found (or dropped) a newer release. Returns an unsubscribe function */
  onUpdateEvent(cb: (v: UpdateView | null) => void): () => void
  // ---- library writes (library required. Auto sync after save when allowRealApply)
  toggle(
    kind: ManifestKind,
    name: string,
    tool: ToolId,
    on: boolean
  ): Promise<WriteResult<Manifest> | Refused>
  ruleRead(name: string): Promise<WriteResult<string>>
  ruleSave(name: string, content: string): Promise<WriteResult | Refused>
  ruleCreate(name: string, content: string): Promise<WriteResult | Refused>
  ruleDelete(name: string): Promise<WriteResult<TrashResult> | Refused>
  ruleRename(from: string, to: string): Promise<WriteResult<{ name: string }> | Refused>
  skillFiles(name: string): Promise<WriteResult<string[]>>
  skillFileRead(name: string, rel: string): Promise<WriteResult<string>>
  skillFileSave(name: string, rel: string, content: string): Promise<WriteResult | Refused>
  skillCreate(name: string, description: string): Promise<WriteResult | Refused>
  skillDelete(name: string): Promise<WriteResult<TrashResult> | Refused>
  /** SKILL.md → description·body (other frontmatter keys are preserved) */
  skillDoc(name: string): Promise<WriteResult<SkillDoc>>
  skillDocSave(name: string, doc: SkillDocInput): Promise<WriteResult | Refused>
  /** Rename. Returns the new name on success */
  skillRename(from: string, to: string): Promise<WriteResult<{ name: string }> | Refused>
  agentCreate(name: string, description: string): Promise<WriteResult | Refused>
  agentDelete(name: string): Promise<WriteResult<TrashResult> | Refused>
  /** agents/<name>.md → description·per-tool model/effort·instructions */
  agentDoc(name: string): Promise<WriteResult<AgentDoc>>
  agentDocSave(name: string, doc: AgentDocInput): Promise<WriteResult | Refused>
  agentRename(from: string, to: string): Promise<WriteResult<{ name: string }> | Refused>
  mcpRead(name: string): Promise<WriteResult<McpEditView>>
  mcpSave(name: string, def: McpServer): Promise<WriteResult<McpUpsertResult> | Refused>
  mcpDelete(name: string): Promise<WriteResult<TrashResult> | Refused>
  hookRead(name: string): Promise<WriteResult<HookEditView>>
  hookCreate(name: string, input: NewHookInput): Promise<WriteResult<{ name: string }> | Refused>
  hookSave(name: string, doc: HookDoc): Promise<WriteResult<{ name: string }> | Refused>
  permissionsSave(rules: PermissionRules): Promise<WriteResult<{ path: string }> | Refused>
  scriptCreate(name: string, content?: string): Promise<WriteResult<{ name: string }> | Refused>
  scriptSave(name: string, content: string): Promise<WriteResult<{ name: string }> | Refused>
  /** Hooks using it get their own copy first */
  scriptDelete(name: string): Promise<WriteResult<TrashResult> | Refused>
  /** With script: save what the tool runs as a new library script and use it; without: as the hook's own run.sh */
  hookConvert(
    name: string,
    tool: HookTool,
    script?: string
  ): Promise<WriteResult<{ name: string }> | Refused>
  hookDelete(name: string): Promise<WriteResult<TrashResult> | Refused>
  hookScriptSave(
    name: string,
    file: string,
    content: string
  ): Promise<WriteResult<{ file: string }> | Refused>
  hookToolScriptCreate(
    name: string,
    tool: HookTool
  ): Promise<WriteResult<{ file: string }> | Refused>
  hookToolScriptDrop(name: string, tool: HookTool): Promise<WriteResult<TrashResult> | Refused>
  hookKeepCopy(
    name: string,
    tool: HookTool,
    file: string
  ): Promise<WriteResult<{ file: string }> | Refused>
  memoryFiles(): Promise<WriteResult<string[]>>
  memoryRead(rel: string): Promise<WriteResult<string>>
  memorySave(rel: string, content: string): Promise<WriteResult | Refused>
  memoryDelete(rel: string): Promise<WriteResult<TrashResult> | Refused>
  // ---- tool auto memory (writes gated by allowRealApply; promote also needs the library)
  toolMemoryScan(): Promise<ToolMemoryView>
  toolMemoryRead(slug: string, file: string): Promise<WriteResult<string>>
  /** Codex memory (read-only). rel is relative to ~/.codex/memories */
  codexMemoryRead(rel: string, offset?: number): Promise<WriteResult<CodexMemoryChunk>>
  codexRollouts(): Promise<WriteResult<CodexRolloutSummary[]>>
  /** Path → Claude project slug */
  toolMemorySlug(path: string): Promise<string>
  toolMemoryPromote(
    slug: string,
    file: string,
    type: MemoryType
  ): Promise<WriteResult<ToolMemoryMoveResult> | Refused>
  toolMemoryMove(
    slug: string,
    file: string,
    toSlug: string
  ): Promise<WriteResult<ToolMemoryMoveResult> | Refused>
  toolMemoryTrash(slug: string, file: string): Promise<WriteResult<ToolMemoryMoveResult> | Refused>
  importSources(): Promise<ImportSource[]>
  importPlan(sourceId: string): Promise<WriteResult<ImportPlanView>>
  importApply(
    sourceId: string,
    selections: ImportSelection[]
  ): Promise<WriteResult<ImportResult[]> | Refused>
  // ---- sync (source → tools. Plan only when allowRealApply is off)
  syncStatus(): Promise<SyncStatusView>
  syncNow(): Promise<SyncStatusView>
  /** Pending count (read-only plan) + last sync failure count */
  syncPending(): Promise<SyncPendingView>
  /** Apply once now (ignores allowRealApply — the user click is the approval) */
  /** fingerprint = ApplyPreviewView.fingerprint the user reviewed; if the plan changed since, nothing is written (refused planChanged) */
  syncApplyOnce(fingerprint: string): Promise<SyncStatusView>
  /** What an apply would change, per tool (read-only plan) */
  syncPreview(): Promise<ApplyPreviewView>
  /** Keep an imported original that changed since import and stop replacing it */
  importedKeep(item: ImportedKeepRequest): Promise<WriteResult | Refused>
  /** Save a rule's tool-side version into the library (it then reaches every tool) */
  editedRuleKeep(tool: ToolId, name: string): Promise<WriteResult | Refused>
  deleteCandidates(
    items: DeleteCandidateRequest[]
  ): Promise<WriteResult<DeleteCandidateResult[]> | Refused>
  modelSet(tool: ToolId, key: string, value: string): Promise<WriteResult<SetModelResult> | Refused>
  // ---- backup (available=false / notAvailable until the engine is ready)
  backupStatus(): Promise<BackupStatusView>
  backupConnect(remoteUrl: string): Promise<WriteResult<BackupStatusView> | Refused>
  /** snapshotFirst: snapshot first when dirty */
  backupSnapshot(message?: string): Promise<WriteResult<Snapshot | null> | Refused>
  backupHistory(): Promise<WriteResult<Snapshot[]> | Refused>
  backupRestore(
    hash: string,
    snapshotFirst?: boolean
  ): Promise<WriteResult<SyncStatusView> | Refused>
  backupDisconnect(): Promise<WriteResult<BackupStatusView> | Refused>
  backupSetDevice(name: string): Promise<WriteResult<BackupStatusView> | Refused>
  backupSetAuto(on: boolean): Promise<WriteResult<BackupStatusView> | Refused>
  // ---- backup cleanup (moves old backups to the Trash)
  backupCleanupPreview(): Promise<WriteResult<BackupCleanupPreview>>
  /** Run now with the current settings (also when auto cleanup is off) */
  backupCleanupRun(): Promise<WriteResult<BackupCleanupView>>
  /** Failed automatic cleanups (start, settings change). Returns an unsubscribe function */
  onBackupCleanupEvent(cb: (r: BackupCleanupView) => void): () => void
}

export interface SyncPendingView {
  pending: number
  failed: number
}

// ---- apply preview (sync plan summarized per tool, read-only)
/** replace = imported original backed up and replaced by the app copy · retire = imported original moved to the backup */
export type ApplyPreviewAction = 'add' | 'update' | 'replace' | 'retire' | 'remove'

export interface ApplyPreviewItem {
  tool: ToolId
  kind: 'rule' | 'skill' | 'agent' | 'config' | 'mcp' | 'hook' | 'hookScript'
  action: ApplyPreviewAction
  /** Item name (config: the file) */
  name: string
  /** Display path (~) */
  path: string
  /** Detail of a config file row (its path): a rule entering or leaving opencode.json, an MCP server in a tool config — not counted separately */
  parent?: string
  /** A Codex hook entry that is new or changed: Codex runs it only after it is trusted again in /hooks */
  codexTrust?: boolean
}

/** Changed library item a tool reads straight from the library (OpenCode rules and skills) — nothing to write for it */
export interface LibraryDirectItem {
  tool: ToolId
  kind: 'rule' | 'skill'
  name: string
}

/** Imported original edited after import — sync leaves it in place */
export interface ImportedChangedItem {
  kind: RetireKind
  tool: ToolId
  name: string
  /** Display path (~) */
  path: string
}

export type ImportedKeepRequest = Pick<ImportedChangedItem, 'kind' | 'tool' | 'path'>

/** A rule edited in a tool (its copy, or its section of the Codex/Gemini block) — Apply restores the library's version */
export interface EditedRuleItem {
  tool: ToolId
  name: string
  /** Display path (~) */
  path: string
  where: 'copy' | 'block'
}

export interface ApplyPreviewView {
  items: ApplyPreviewItem[]
  importedChanged: ImportedChangedItem[]
  errors: string[]
  notInitialized: NotInitializedView[]
  libraryDirect: LibraryDirectItem[]
  /** Rules edited on the tool side */
  edited: EditedRuleItem[]
  libraryMissing?: boolean
  /** Tools in use (effective) */
  inUse: ToolId[]
  /** planFingerprint of the plan shown — passed back to syncApplyOnce */
  fingerprint?: string
}

export const CHANNELS = [
  'status',
  'rules',
  'skills',
  'agents',
  'mcp',
  'hooks',
  'permissions',
  'scripts',
  'artifacts',
  'artifactPreview',
  'artifactThumb',
  'artifactOpen',
  'artifactReveal',
  'sessions',
  'sessionTranscript',
  'sessionSearch',
  'sessionIndexStatus',
  'docSearch',
  'searchAll',
  'marketSearch',
  'marketDetail',
  'marketInstall',
  'usage',
  'usageSummary',
  'models',
  'modelDetail',
  'sessionModels',
  'marketInstallMany',
  'marketUpdates',
  'marketUpdate',
  'configGet',
  'configSet',
  'uiPrefsSet',
  'toolsInUseGet',
  'toolsInUseSet',
  'detectTools',
  'pickDirectory',
  'libraryInit',
  'workspaces',
  'workspaceCreate',
  'workspaceSwitch',
  'workspaceSwitchPreview',
  'workspaceRename',
  'workspaceDelete',
  'workspaceExport',
  'workspaceImport',
  'toggle',
  'ruleRead',
  'ruleSave',
  'ruleCreate',
  'ruleDelete',
  'ruleRename',
  'skillFiles',
  'skillFileRead',
  'skillFileSave',
  'skillCreate',
  'skillDelete',
  'skillDoc',
  'skillDocSave',
  'skillRename',
  'agentCreate',
  'agentDelete',
  'agentDoc',
  'agentDocSave',
  'agentRename',
  'mcpRead',
  'mcpSave',
  'mcpDelete',
  'hookRead',
  'hookCreate',
  'hookSave',
  'permissionsSave',
  'scriptCreate',
  'scriptSave',
  'scriptDelete',
  'hookConvert',
  'hookDelete',
  'hookScriptSave',
  'hookToolScriptCreate',
  'hookToolScriptDrop',
  'hookKeepCopy',
  'memoryFiles',
  'memoryRead',
  'memorySave',
  'memoryDelete',
  'toolMemoryScan',
  'toolMemoryRead',
  'codexMemoryRead',
  'codexRollouts',
  'toolMemorySlug',
  'toolMemoryPromote',
  'toolMemoryMove',
  'toolMemoryTrash',
  'importSources',
  'importPlan',
  'importApply',
  'syncStatus',
  'syncNow',
  'syncPending',
  'syncApplyOnce',
  'syncPreview',
  'importedKeep',
  'editedRuleKeep',
  'deleteCandidates',
  'modelSet',
  'backupStatus',
  'backupConnect',
  'backupSnapshot',
  'backupHistory',
  'backupRestore',
  'backupDisconnect',
  'backupSetDevice',
  'backupSetAuto',
  'backupCleanupPreview',
  'backupCleanupRun',
  'traySet',
  'traySessions',
  'trayCommand',
  'appVersion',
  'updateStatus',
  'updateCheckNow',
  'updateSkip',
  'updateOpenTerminal'
] as const satisfies readonly Exclude<
  keyof Api,
  | 'onSyncEvent'
  | 'onSearchIndexEvent'
  | 'onBackupCleanupEvent'
  | 'onTrayAction'
  | 'onUpdateEvent'
  | 'onTraySessions'
  | 'onUiPrefsEvent'
  | 'uiPrefsInitial'
>[]

export type Channel = (typeof CHANNELS)[number]
