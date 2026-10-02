import type { ToolId } from './agents'
import type { LibraryHook } from './hooks'
import type { Manifest } from './manifest'
import type { PendingRetire } from './pendingRetire'
import type { SecretBackend } from './secrets'

/** Environment variable lookup. Defaults to process.env; fixture checks pass an arbitrary object. */
export type Env = Record<string, string | undefined>

/**
 * A command rule entry is either an argv array or an {argv, claudeExact, description} object. claudeExact: match the whole command,
 * not just its start (the name predates the other tools)
 */
export type AllowlistEntry =
  | string[]
  | {
      argv: string[]
      claudeExact?: boolean
      description?: string
      /** Older name of description, still read */
      note?: string
      /** Name of the rule's group (permissions.ts) */
      group?: string
      /** Tools the rule is turned off for (ToolId) */
      off?: string[]
    }

/** permissions.json. bash is the allow list (as before); ask and deny rules were added beside it so older versions still read it */
export interface Allowlist {
  bash: AllowlistEntry[]
  bashAsk?: AllowlistEntry[]
  bashDeny?: AllowlistEntry[]
  /** Rule groups in menu order (permissions.ts RuleGroup); decision missing in a hand-written file */
  groups?: { name: string; description?: string; decision?: 'deny' | 'ask' | 'allow' }[]
  claudeOnly: {
    allow: string[]
    deny: string[]
    ask?: string[]
  }
  [key: string]: unknown
}

export type ToolApprovalMode = 'auto' | 'prompt' | 'approve' | string

export interface McpCodexOptions {
  defaultToolsApprovalMode?: string
  enabledTools?: string[]
  toolApprovals?: Record<string, ToolApprovalMode>
  [key: string]: unknown
}

export interface McpServer {
  transport: 'stdio' | 'http' | string
  command?: string
  args?: string[]
  env?: Record<string, string>
  timeoutMs?: number
  url?: string
  headers?: Record<string, string>
  bearerEnv?: string
  /** Bearer token secret reference (`secret:<server>/headers/Authorization`). The value is the bare token; `Bearer ` is prepended on render */
  bearerToken?: string
  codex?: McpCodexOptions
  [key: string]: unknown
}

export interface McpSource {
  servers: Record<string, McpServer>
  [key: string]: unknown
}

export interface RuleFile {
  name: string
  text: string
}

export interface Sources {
  /** Library root = config.libraryPath ?? `~/.illithid` (field name kept for compatibility) */
  agentsDir: string
  /** Whether the library root exists. If false, everything else is empty (first run) */
  libraryExists: boolean
  rules: RuleFile[]
  /** null if memory/MEMORY.md is missing */
  memoryIndex: string | null
  /** permissions.json. Empty allowlist if missing (hasPermissions=false — permission targets are left alone) */
  allowlist: Allowlist
  hasPermissions: boolean
  /** Merged mcps/*.json (excluding `_` meta) */
  mcp: McpSource
  /** Library illithid.json (on/off). Everything is on if missing */
  manifest?: Manifest
  /** hooks/<name>/ (hook.json + scripts). Absent = no hooks */
  hooks?: LibraryHook[]
}

/** The 6 base targets */
export type LegacyTargetId =
  'codexAgents' | 'codexRules' | 'claudePermissions' | 'claudeMcp' | 'codexMcp' | 'opencodeMcp'

/** Targets added in M7 */
export type ExtraTargetId =
  | 'opencodeRules'
  | 'opencodeSkills'
  | 'claudeSkillOverrides'
  | 'codexSkillConfig'
  | 'opencodeSkillPermissions'
  | 'geminiRules'
  | 'geminiMcp'
  | 'copilotMcp'
  | 'grokMcp'
  | 'grokCompat'
  | 'claudeHooks'
  | 'codexHooks'
  | 'codexHooksJson'
  | 'geminiHooks'
  | 'copilotHooks'
  | 'grokHooks'
  | 'geminiPolicy'

export type TargetId = LegacyTargetId | ExtraTargetId

export interface FileChange {
  id: TargetId
  /** Absolute path */
  path: string
  /** Display path (~/...) */
  label: string
  /** Current file content. '' if the file does not exist */
  before: string
  /** Generated result. Equals before if generation itself fails (parse error, missing env var) */
  after: string
  changed: boolean
  notes: string[]
  /** Change outside the owned scope, read/parse failure, missing env var, etc. If set, the change is not applied */
  error?: string
  /** sha256 of the owned region in before. null if the region is absent (no marker/key) or parsing fails */
  beforeRegionHash: string | null
  /** sha256 of the owned region in after. Same as before when generation failed (after === before) */
  afterRegionHash: string | null
  /**
   * Item names the app owns after applying (MCP server names, instructions entries).
   * apply records them in state.owned so the next plan can remove "previously owned items that are now off".
   */
  owned?: string[]
  /**
   * Per-server errors (server name → message, no values). E.g. a missing secret.
   * The file is still applied, but that server's entry keeps its previous content
   */
  serverErrors?: Record<string, string>
  /** Imported originals (pendingRetire paths) this change no longer references — apply clears their records */
  retired?: string[]
  /**
   * The file does not exist and is left alone (changed=false, no error):
   * - nothingToWrite      the library has nothing for this target — not an error, nothing to show
   * - toolNotInitialized  there is content, but the file is one the tool creates itself on first run (~/.claude.json) — run the tool once
   * - copilotHomeOverride COPILOT_HOME points elsewhere, so Copilot wouldn't read ~/.copilot — no Copilot file is written
   * - jsoncUnsupported    (the file exists) the alternate being used (opencode.jsonc) is not plain JSON — left untouched to keep its comments
   */
  skip?:
    | 'nothingToWrite'
    | 'toolNotInitialized'
    | 'copilotHomeOverride'
    | 'grokHomeOverride'
    | 'jsoncUnsupported'
  /** Imported originals kept in place because they changed since import (opencodeRules: instructions entries) */
  importedChanged?: PendingRetire[]
  /** MCP targets: servers this change adds, updates or removes (names only) */
  servers?: ServerChange[]
  /** Hook targets: hooks this change adds, updates or removes (names only) */
  hooks?: ServerChange[]
}

/** One MCP server entering, changing in or leaving a tool config file */
export interface ServerChange {
  name: string
  action: 'add' | 'update' | 'remove'
}

/** Thrown by a generator to report an unrecoverable state. plan() moves it into the change's error. */
export class TargetError extends Error {}

export interface BuildContext {
  sources: Sources
  env: Env
  /** Target root (HOME). Used to compute display paths (~/…) */
  home?: string
  /** Previously owned items per target, as recorded in state.json */
  owned?: Partial<Record<TargetId, string[]>>
  /** Backend that resolves `secret:` references. Without it, servers with references go to serverErrors */
  secrets?: SecretBackend
  /** Imported originals awaiting retirement (state.pendingRetire) */
  pendingRetire?: PendingRetire[]
  /** Owned-region hash each target last wrote (state.applied) — tells tool-side edits from library changes */
  applied?: Partial<Record<TargetId, string>>
  /** The target's tool is turned off (retiring): only removals are planned — no memory index, permissions or new files */
  retiring?: boolean
}

export interface BuildResult {
  after: string
  notes: string[]
  /** Generated but must not be applied (e.g. keys outside the owned scope changed) */
  error?: string
  /** Items owned by the app after applying (FileChange.owned) */
  owned?: string[]
  /** Per-server errors (FileChange.serverErrors) */
  serverErrors?: Record<string, string>
  /** FileChange.retired */
  retired?: string[]
  /** FileChange.importedChanged */
  importedChanged?: PendingRetire[]
}

export interface TargetDef {
  id: TargetId
  /** Tool whose file this target writes (targets of tools not in use are skipped — config.toolsInUse) */
  tool: ToolId
  /** Path relative to home */
  rel: string
  /**
   * Whether a missing file may be created. If false and the library has content for it, planning reports skip=toolNotInitialized.
   * Either way a missing file with nothing to write is left alone (skip=nothingToWrite)
   */
  optional: boolean
  /** Text a missing file is built from (JSON targets: '{}\n'). '' if absent */
  seed?: string
  /**
   * optional=false but a missing file may still be created when the tool is explicitly listed in config.toolsInUse
   * (users who never chose their tools keep the old behavior: an absent file is never created — skip=toolNotInitialized)
   */
  createIfInUse?: boolean
  /**
   * Other files (relative to home) the tool reads instead. If the main file is missing and one exists, that file is read and
   * written in its place (never a second file) — as long as it is plain JSON (otherwise skip=jsoncUnsupported)
   */
  alternates?: string[]
  build(before: string, ctx: BuildContext): BuildResult
  /**
   * Normalized string of the app-owned region. Used for state.applied and UI excerpts (not used for skip decisions since M7d).
   * - Marker targets: the marker block body
   * - claudePermissions: only allow/deny/ask under permissions
   * - claudeMcp/opencodeMcp: only entries named by SSOT (mcp.json) servers (sorted by name)
   * null if the region is absent or parsing fails. Independent of generating after (build).
   */
  region(text: string, sources: Sources, ctx?: BuildContext): string | null
}
