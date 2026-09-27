/**
 * main ↔ renderer IPC contract. Read channels + library/tool write channels.
 * Engine types are type-only imports, so no engine code ends up in the renderer bundle.
 * Raw target files and secrets are never sent to the renderer (owned-region excerpts + masked values).
 */
import type {
  AgentDoc,
  AgentDocInput,
  AgentSyncResult,
  AppConfig,
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
  syncError?: string
  toggles: Record<string, ToolToggles>
  /** SKILL.md frontmatter description */
  descriptions: Record<string, string>
}

/** Library agent (agents/<name>.md) */
export interface AgentsData {
  /** Library agents directory (display ~/...) */
  dir: string
  names: string[]
  /** Per-agent tool sync state */
  state: Record<string, Partial<Record<ToolId, SyncState>>>
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
}

export interface McpData {
  servers: McpServerView[]
  toggles: Record<string, ToolToggles>
  error?: string
}

// ---------------------------------------------------------------- write channel types

/** App config view. Paths are for display (~) */
/** Tools in use on this device (config.toolsInUse). Tools not in use get no writes at all */
export interface ToolsInUseView {
  /** Effective list (the default tools while unset) */
  inUse: ToolId[]
  /** false = config.toolsInUse not set yet (users from before the setting, or first run) */
  configured: boolean
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
export type RefusedReason = 'allowRealApplyOff' | 'configError' | 'invalid' | 'libraryNotReady' | 'notAvailable'

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
  refused?: 'libraryMissing' | 'realHomeNotAllowed'
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

/** A tool file skipped because the tool has not created it yet (FileChange.skip = toolNotInitialized) or COPILOT_HOME points elsewhere */
export interface NotInitializedView {
  tool: ToolId
  /** Display path (~) */
  label: string
  /** Why the file is left alone instead of the tool's first run: COPILOT_HOME points somewhere other than ~/.copilot */
  reason?: 'copilotHomeOverride'
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
  kind: 'skill' | 'rule' | 'agent'
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
import type { DocKind, DocSearchResponse, IndexStatus, SearchAllResponse, SessionSearchResponse } from '../engine'
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

export interface Api {
  // ---- reads
  status(): Promise<StatusReport>
  rules(): Promise<RulesData>
  skills(): Promise<SkillsData>
  agents(): Promise<AgentsData>
  mcp(): Promise<McpData>
  artifacts(): Promise<Artifact[]>
  artifactPreview(id: string): Promise<ArtifactPreview>
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
  // ---- config·library setup
  configGet(): Promise<ConfigView>
  configSet(patch: Partial<AppConfig>): Promise<WriteResult<ConfigView>>
  /** Tools in use + detection (read-only) */
  toolsInUseGet(): Promise<ToolsInUseView>
  /** Save the tools in use (null = unset, all tools). Writes config only — applying to a newly enabled tool is a separate sync */
  toolsInUseSet(tools: ToolId[] | null): Promise<WriteResult<ToolsInUseView>>
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
  // ---- library writes (library required. Auto sync after save when allowRealApply)
  toggle(kind: ManifestKind, name: string, tool: ToolId, on: boolean): Promise<WriteResult<Manifest> | Refused>
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
  toolMemoryPromote(slug: string, file: string, type: MemoryType): Promise<WriteResult<ToolMemoryMoveResult> | Refused>
  toolMemoryMove(slug: string, file: string, toSlug: string): Promise<WriteResult<ToolMemoryMoveResult> | Refused>
  toolMemoryTrash(slug: string, file: string): Promise<WriteResult<ToolMemoryMoveResult> | Refused>
  importSources(): Promise<ImportSource[]>
  importPlan(sourceId: string): Promise<WriteResult<ImportPlanView>>
  importApply(sourceId: string, selections: ImportSelection[]): Promise<WriteResult<ImportResult[]> | Refused>
  // ---- sync (source → tools. Plan only when allowRealApply is off)
  syncStatus(): Promise<SyncStatusView>
  syncNow(): Promise<SyncStatusView>
  /** Pending count (read-only plan) + last sync failure count */
  syncPending(): Promise<SyncPendingView>
  /** Apply once now (ignores allowRealApply — the user click is the approval) */
  syncApplyOnce(): Promise<SyncStatusView>
  /** What an apply would change, per tool (read-only plan) */
  syncPreview(): Promise<ApplyPreviewView>
  /** Keep an imported original that changed since import and stop replacing it */
  importedKeep(item: ImportedKeepRequest): Promise<WriteResult | Refused>
  deleteCandidates(items: DeleteCandidateRequest[]): Promise<WriteResult<DeleteCandidateResult[]> | Refused>
  modelSet(tool: ToolId, key: string, value: string): Promise<WriteResult<SetModelResult> | Refused>
  // ---- backup (available=false / notAvailable until the engine is ready)
  backupStatus(): Promise<BackupStatusView>
  backupConnect(remoteUrl: string): Promise<WriteResult<BackupStatusView> | Refused>
  /** snapshotFirst: snapshot first when dirty */
  backupSnapshot(message?: string): Promise<WriteResult<Snapshot | null> | Refused>
  backupHistory(): Promise<WriteResult<Snapshot[]> | Refused>
  backupRestore(hash: string, snapshotFirst?: boolean): Promise<WriteResult<SyncStatusView> | Refused>
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
  kind: 'rule' | 'skill' | 'agent' | 'config'
  action: ApplyPreviewAction
  /** Item name (config: the file) */
  name: string
  /** Display path (~) */
  path: string
  /** Detail of a config file row (its path): e.g. a rule entering or leaving opencode.json — not counted separately */
  parent?: string
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

export interface ApplyPreviewView {
  items: ApplyPreviewItem[]
  importedChanged: ImportedChangedItem[]
  errors: string[]
  notInitialized: NotInitializedView[]
  libraryDirect: LibraryDirectItem[]
  libraryMissing?: boolean
  /** Tools in use (effective) */
  inUse: ToolId[]
}

export const CHANNELS = [
  'status',
  'rules',
  'skills',
  'agents',
  'mcp',
  'artifacts',
  'artifactPreview',
  'artifactOpen',
  'artifactReveal',
  'sessions',
  'sessionTranscript',
  'sessionSearch',
  'sessionIndexStatus',
  'docSearch',
  'searchAll',
  'configGet',
  'configSet',
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
  'backupCleanupRun'
] as const satisfies readonly Exclude<keyof Api, 'onSyncEvent' | 'onSearchIndexEvent' | 'onBackupCleanupEvent'>[]

export type Channel = (typeof CHANNELS)[number]
