export { plan, planAll, regionHash, buildContext } from './plan'
export {
  readSources,
  agentsPaths,
  libraryPaths,
  libraryExists,
  readPermissionsFile,
  emptyAllowlist,
  mcpServerNamesInDir,
  readMcpOrder,
  MCP_ORDER_FILE
} from './sources'
export type { LibraryPaths } from './sources'
export { initLibrary, initLibraryAt, LIBRARY_DIRS, WORKSPACE_FILE } from './init'
export type { InitLibraryOptions, InitLibraryResult } from './init'
export {
  syncAll,
  planSyncAll,
  planFingerprint,
  pendingSyncCount,
  summarizeSync,
  realApplyAllowed,
  previewSwitch,
  importedChangedOf
} from './sync'
export { keepImportedOriginal } from './pendingRetire'
export type {
  SyncAllOptions,
  SyncAllResult,
  SyncPlan,
  SyncResults,
  SwitchLossItem,
  SwitchLossKind
} from './sync'
export { mcpEntries, sha256 } from './text'
export { geminiDisabledSkillsOf } from './targets/geminiMcp'
export {
  TARGETS,
  EXTRA_TARGETS,
  ALL_TARGETS,
  ALL_TARGET_IDS,
  MCP_TARGET_OF,
  MCP_TARGET_TOOL,
  parseServerTable
} from './targets'
export {
  skillOverrideHits,
  SKILL_OVERRIDE_TARGET_OF,
  librarySkillNames
} from './targets/skillOverrides'
export { tools, tool, tilde, canonicalPaths, TOOL_IDS } from './agents'
export { skillsReport, linkPlan, canonicalSkills, dirContentHash, SKILL_STATES } from './skills'
export { readModels, setModel, MODEL_KEYS, SetModelError } from './models'
export { apply } from './apply'
export { planSkillSync, applySkillSync, skillBackupPath, leftoverSkillTmps } from './skillSync'
export { planAgentSync, applyAgentSync, agentBackupPath, adoptAgentFiles } from './agentSync'
export type { AgentSyncAction, AgentSyncItem, AgentSyncResult } from './agentSync'
export { renderAgent, agentToolDir, agentToolPath } from './agentRender'
export { deleteSyncCandidates, deletedBackupRoot } from './deleteCopies'
export type { DeleteRequest, DeleteResult } from './deleteCopies'
export type { SkillSyncAction, SkillSyncItem, SkillSyncResult, SkillSyncOptions } from './skillSync'
export { atomicWrite, backup, BACKUP_SUFFIX } from './write'
export { readRoster, rosterPairing } from './roster'
export { readState, writeState, statePath, emptyState } from './state'
export { status, statusReport, RESOURCES } from './status'
export type {
  Env,
  Allowlist,
  AllowlistEntry,
  FileChange,
  ServerChange,
  Sources,
  TargetId,
  LegacyTargetId,
  ExtraTargetId,
  McpServer,
  McpSource
} from './types'
export type { ToolId, ToolInfo, RulesInjection, SkillsInjection } from './agents'
export type { ToolDetection, DetectToolsOptions } from './importer'
export type { PendingRetire, RetireKind, KeepImportedResult } from './pendingRetire'
export type { ImportedChange } from './sync'
export type { SkillState, SkillEntry, ToolSkills, SkillsReport, LinkAction } from './skills'
export type { ToolModels, ModelValue, SetModelResult } from './models'
export type { ApplyResult, ApplyOptions, ApplySkipReason } from './apply'
export type { Roster, RosterRow, RosterEntry, RosterToolSummary } from './roster'
export type { AppState, AppliedEntry, StateRead, SkillCopyEntry } from './state'
export { CELL_STATE_MAP, normalizeCellState } from './status'
export type {
  Resource,
  CellState,
  LegacyCellState,
  StatusCell,
  StatusReport,
  ChangeSummary
} from './status'
export {
  scanArtifacts,
  defaultArtifactSources,
  newManifestCache,
  toolOfLocation,
  toolOfManifestString
} from './scan/artifacts'
export type {
  Artifact,
  ArtifactKind,
  ArtifactSource,
  ArtifactTool,
  ManifestCache
} from './scan/artifacts'
export { scanSessions, readSessionTranscript, cleanUserText, titleText } from './scan/sessions'
export {
  indexSessions,
  indexStatus,
  searchSessions,
  searchIndexPath,
  makeSnippet,
  sessionTitles
} from './search/sessionIndex'
export {
  indexDocs,
  indexAllDocs,
  artifactDocs,
  libraryDocs,
  htmlToText,
  mcpDocText,
  docCount,
  searchDocs,
  searchAll,
  DOC_KINDS,
  DOC_SIZE_LIMIT
} from './search/docIndex'
export type {
  DocKind,
  DocSource,
  DocIndexResult,
  DocSearchOptions,
  DocSearchResult,
  DocSearchResponse,
  SearchAllResponse
} from './search/docIndex'
export type {
  IndexResult,
  IndexStatus,
  SearchOptions,
  SessionSearchHit,
  SessionSearchResponse,
  SessionSearchResult
} from './search/sessionIndex'
export type {
  Session,
  SessionScanResult,
  SessionTool,
  SessionTranscript,
  TranscriptMessage,
  TranscriptPrompt,
  TranscriptOptions,
  TranscriptTool
} from './scan/sessions'
export {
  backupStatus,
  connectBackup,
  snapshot,
  history,
  restore,
  pullOnStart,
  disconnect,
  deviceName,
  validateRemoteUrl,
  BACKUP_INCLUDES,
  BACKUP_EXCLUDES,
  BACKUP_NOT_INCLUDED
} from './backup'
export type { BackupStatus, Snapshot, SnapshotResult, RestoreResult, PullResult } from './backup'
export { deliverFile, deliverDir, deliveredShape, shapeMatches, DELIVER_STRATEGY } from './deliver'
export type { DeliverStrategy, DeliveredShape } from './deliver'
export { watchLibrary, isIgnoredLibraryPath } from './watch'
export type { LibraryChange, WatchLibraryOptions, Unsubscribe } from './watch'
export { gitStatus, gitFetch, gitLog, gitDiff, gitPull, gitCommit, gitPush } from './git'
export type { GitStatus, GitFileStatus, GitCommitInfo, GitResult } from './git'
export {
  readConfig,
  writeConfig,
  libraryRoot,
  configPath,
  defaultConfig,
  validateConfig,
  expandHome,
  ConfigError,
  DEFAULT_LIBRARY_DIR,
  LEGACY_LIBRARY_DIR,
  APP_CONFIG_DIR,
  appConfigDir,
  LEGACY_APP_GENERATIONS,
  LEGACY_APP_LIBRARY_DIRS,
  LEGACY_APP_CONFIG_DIRS,
  appDataRoot,
  workspacesRoot,
  workspaceRoot,
  workspaceIds,
  activeWorkspaceId,
  rootFormLibraryEntries,
  WORKSPACES_DIR,
  DEFAULT_WORKSPACE,
  toolsInUse,
  toolInUse,
  setToolsInUse,
  CONFIG_TOOL_IDS
} from './config'
export {
  listWorkspaces,
  createWorkspace,
  switchWorkspace,
  renameWorkspace,
  deleteWorkspace,
  deletedWorkspacesRoot,
  workspaceName,
  workspaceSlug,
  planMigrateToWorkspaces,
  migrateToWorkspaces,
  secretAccountsInWorkspaces,
  exportWorkspace,
  planImportWorkspace,
  importWorkspace,
  WorkspaceError,
  WORKSPACE_ZIP_EXT,
  LEGACY_WORKSPACE_ZIP_EXTS,
  WORKSPACE_ZIP_MAX_BYTES,
  WORKSPACE_ZIP_MAX_FILES
} from './workspace'
export type {
  WorkspaceInfo,
  WorkspaceMigrationPlan,
  WorkspaceMigrationResult,
  WorkspaceExport,
  WorkspaceImportPlan,
  WorkspaceImportResult
} from './workspace'
export {
  planRename,
  applyRename,
  renamePendingPaths,
  autoRenamePending,
  isEmptyLibrarySkeleton,
  isEmptyDataRootSkeleton
} from './rename'
export { ensureLibrary } from './startup'
export type { EnsureLibraryResult } from './startup'
export type { RenamePlan, RenameResult, RenameMove } from './rename'
export type { AppConfig, ConfigRead, ArtifactSourceConfig } from './config'
export type { UiPrefs, UiPrefsPatch } from './uiPrefs'
export { artifactSources } from './scan/artifacts'
export {
  readManifest,
  setToggle,
  renameManifestEntry,
  isEnabled,
  manifestPath,
  emptyManifest,
  ManifestError,
  MANIFEST_FILE,
  LEGACY_MANIFEST_FILES,
  MANIFEST_KINDS,
  MANIFEST_TOOLS
} from './manifest'
export type { Manifest, ManifestKind, ManifestRead, ToolToggles } from './manifest'
export {
  planRuleSync,
  applyRuleSync,
  restoreLegacyRulesLink,
  claudeRulesPaths,
  CLAUDE_RULES_DIR,
  LEGACY_CLAUDE_RULES_DIRS,
  LEGACY_CLAUDE_RULES_LINK
} from './ruleSync'
export type { RuleSyncAction, RuleSyncItem, RuleSyncResult, RuleSyncOptions } from './ruleSync'
export {
  listRules,
  readRule,
  writeRule,
  createRule,
  deleteRule,
  listSkillFiles,
  readSkillFile,
  writeSkillFile,
  createSkill,
  deleteSkill,
  readSkillDoc,
  writeSkillDoc,
  renameSkill,
  renameRule,
  listAgents,
  readAgentDoc,
  writeAgentDoc,
  createAgent,
  deleteAgent,
  renameAgent,
  parseAgentText,
  agentLibraryText,
  AGENT_TOOLS,
  listMemoryFiles,
  readMemoryFile,
  writeMemoryFile,
  deleteMemoryFile,
  listMcpServers,
  readMcpServer,
  readMcpOrderList,
  writeMcpOrder,
  upsertMcpServer,
  deleteMcpServer,
  validateMcpServer,
  readPermissions,
  writePermissions,
  validatePermissions,
  savePermissionRules,
  looksLikeSecret,
  isSecretPair,
  LibraryError,
  TRASH_DIR
} from './library'
export type {
  LibraryErrorCode,
  TrashResult,
  McpUpsertResult,
  SkillDoc,
  SkillDocInput,
  AgentDoc,
  AgentDocInput,
  AgentTool,
  AgentToolSettings
} from './library'
export {
  planImport,
  applyImport,
  listImportSources,
  importAllFromLegacy,
  importedBackupRoot,
  detectTools,
  TOOL_EXECUTABLES,
  OTHER_APP_SKILL_DIRS
} from './importer'
export type {
  ImportPlan,
  ImportCandidate,
  ImportKind,
  ImportSource,
  ImportSourceKind,
  RuleImportCandidate,
  MemoryImportCandidate,
  PermissionsImportCandidate,
  PermissionsVariant,
  FileVariant,
  Replaceable,
  SkillImportCandidate,
  McpImportCandidate,
  AgentImportCandidate,
  AgentVariant,
  SkillVariant,
  McpVariant,
  ImportSourceRef,
  ImportConflict,
  ImportSelection,
  ImportResult,
  ImportAllOptions,
  ImportAllResult,
  Portability,
  PortabilityReason,
  PortabilityInfo
} from './importer'
export type { RuleCopyEntry } from './state'
export type { ApplyImportOptions } from './importer'
export type { McpWriteOptions } from './library'
export {
  SECRET_SERVICE,
  LEGACY_SECRET_SERVICES,
  withLegacySecrets,
  SECRET_PREFIX,
  SecretError,
  MissingSecretError,
  secretAccount,
  secretRef,
  isSecretRef,
  parseSecretRef,
  secretRefsOf,
  memorySecretBackend,
  fileSecretBackend,
  macKeychainBackend,
  defaultSecretBackend
} from './secrets'
export type { SecretBackend, SecretRef, SecretTable } from './secrets'
export {
  scanClaudeMemory,
  scanCodexMemory,
  readCodexMemoryFile,
  listCodexRolloutSummaries,
  CODEX_MEMORY_ORDER,
  CODEX_ROLLOUT_DIR,
  CODEX_READ_CHUNK,
  readClaudeMemoryFile,
  promoteClaudeMemory,
  moveClaudeMemory,
  trashClaudeMemory,
  claudeProjectSlug,
  INDEX_MAX_LINES,
  INDEX_MAX_BYTES,
  MEMORY_TYPES
} from './toolMemory'
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
} from './toolMemory'
export {
  planBackupCleanup,
  applyBackupCleanup,
  isCleanupTarget,
  parseBackupStamp,
  backupRetention,
  backupRetentionOf,
  SKILL_BACKUP_KEEP
} from './backupRetention'
export type {
  CleanupItem,
  CleanupKind,
  CleanupMover,
  CleanupPlan,
  CleanupResult
} from './backupRetention'
export { DEFAULT_BACKUP_RETENTION } from './config'
export type { BackupRetention } from './config'
export { marketEnabled } from './config'
export {
  checkUpdates as marketCheckUpdates,
  commitMcp as marketCommitMcp,
  commitMcpUpdate as marketCommitMcpUpdate,
  commitRule as marketCommitRule,
  commitSkill as marketCommitSkill,
  installChoices as marketInstallChoices,
  installedIndex as marketInstalledIndex,
  listInstructions as marketListRules,
  prepareRule as marketPrepareRule,
  prepareSkill as marketPrepareSkill,
  searchServers as marketSearchServers,
  searchSkills as marketSearchSkills,
  findSkills as marketFindSkills,
  popularSkills as marketPopularSkills,
  popularServers as marketPopularServers,
  rankServers as marketRankServers,
  serverDetail as marketServerDetail,
  skillAudit as marketSkillAudit,
  suggestMcpName as marketSuggestMcpName,
  AWESOME_COPILOT_REPO,
  MarketError,
  liveOrigins as marketLiveOrigins,
  readOrigins
} from './market'
export type {
  AuditPartner,
  FetchFn,
  InputSpec as MarketInputSpec,
  InstallChoice as MarketInstallChoice,
  MarketKind,
  MarketMcpItem,
  MarketRuleItem,
  MarketSkillItem,
  MarketUpdate,
  PreparedRule,
  PreparedSkill,
  RepoTrees,
  RegistryServer,
  McpRunKind
} from './market'
export { usageOf, usageSummaries } from './search/usage'
export type { UsageKind, UsageStats, UsageSummary } from './search/usage'
export {
  modelDetail,
  modelList,
  sessionModels,
  MIN_REQUESTS,
  MIN_TOOL_CALLS
} from './search/modelStats'
export type {
  Dist,
  ModelDetail,
  ModelKey,
  ModelRange,
  ModelSummary,
  SessionRef
} from './search/modelStats'
export { seedNewToolToggles } from './manifest'
export {
  HOOK_TOOLS,
  HOOK_TIMINGS,
  HOOK_CATALOG,
  HOOK_CHECKED,
  isHookTool,
  hookEventsFor,
  defaultHookEvent,
  hookEventInfo
} from './hookEvents'
export type { HookTool, HookTiming, HookEventInfo, HookToolInfo } from './hookEvents'
export {
  readHooks,
  readHook,
  hookNames,
  hooksDir,
  validateHookDoc,
  parseHookDoc,
  renderHookDoc,
  hookTriggers,
  hookOptions,
  hookScriptFiles,
  scriptForTool,
  HOOKS_DIR,
  HOOK_FILE,
  SHARED_SCRIPT
} from './hooks'
export type { HookDoc, HookTrigger, HookToolSettings, HookOptionValue, LibraryHook } from './hooks'
export {
  HOOK_ACTIONS,
  HOOK_ACTION_INFO,
  hookSupport,
  isHookAction,
  actionMatcher,
  DEFAULT_GUARD_PATTERNS
} from './hookActions'
export type { HookAction, HookActionInfo, HookSupport } from './hookActions'
export { renderActionScript, renderAskPrompt, toolScript } from './hookScripts'
export {
  createHook,
  saveHookDoc,
  convertHookToScript,
  HOOK_SCRIPT_TEMPLATE,
  saveHookScript,
  createHookToolScript,
  dropHookToolScript,
  deleteHook,
  writeNewHook
} from './library'
export type { NewHookInput } from './library'
export { HOOK_TARGETS, HOOK_TARGET_OF, hookTable, appHookName } from './targets/hooks'
export { planHookSync, applyHookSync, hookBackupPath, keepHookCopy } from './hookSync'
export type { HookSyncItem, HookSyncResult, HookSyncAction } from './hookSync'
export {
  hookCopyPath,
  hookCopyRoot,
  hookCommand,
  grokReadsClaudeHooks,
  hooksForTool
} from './hookRender'
export {
  PERMISSION_DECISIONS,
  parseCommand,
  permissionRules,
  ruleProblems,
  withPermissionRules
} from './permissions'
export type { CommandRule, McpRule, PermissionDecision, PermissionRules } from './permissions'
