/**
 * Import (M7d): scans one user-selected source and turns what the library lacks into candidates.
 *
 * Source kinds
 * - legacyLibrary   `~/.agents` (previous sync.mjs setup: rules/ skills/ sync/mcp.json sync/allowlist.json memory/)
 * - tool            Claude Code · Codex · OpenCode · Gemini CLI · GitHub Copilot config and skill directories
 * - managerLibrary  skill libraries of other manager apps (~/.skills-manager/skills, ~/.cc-switch/skills)
 *
 * - planImport is read-only. Candidate data never holds raw secret values — literals are replaced with ${KEY}
 *   and reported only as `replaceable: [{key, looksSecret}]`. applyImport's `replace` picks the keys to actually substitute.
 * - applyImport writes only to the library (+ its on/off manifest and state.json). Source-side files are never touched at import:
 *   originals that the app copy will replace are recorded as pendingRetire and switched over by the next approved sync
 *   (moved to backups/imported right when the app copy lands — pendingRetire.ts). Items imported from a tool start enabled
 *   for that tool only.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import matter from 'gray-matter'
import { parse as parseToml } from 'smol-toml'
import { agentNameOfFile, agentToolDir, agentToolPath } from './agentRender'
import { adoptAgentFiles } from './agentSync'
import { adoptSkillCopies } from './skillSync'
import { renderAgent } from './agentRender'
import { TOOL_IDS, tilde, tools, type ToolId } from './agents'
import { toolConfigFound } from './detect'
import { activeWorkspaceId, LEGACY_LIBRARY_DIR, libraryRoot } from './config'
import {
  agentLibraryText,
  agentNormalizedText,
  deleteAgent,
  deleteHook,
  saveHookDoc,
  writeNewHook,
  importScriptFolder,
  listAgents,
  readAgentDoc,
  writeNewAgentText,
  type AgentToolSettings,
  copySkillIntoLibrary,
  createRule,
  deleteSkill,
  isSecretPair,
  LibraryError,
  listMemoryFiles,
  looksLikeSecret,
  NAME_RE,
  readMemoryFile,
  readPermissions,
  readMcpOrderList,
  readMcpServer,
  readRule,
  trashLibraryPath,
  upsertMcpServer,
  writeMcpOrder,
  writeMemoryFile,
  writePermissions
} from './library'
import { secretRefsOf, type SecretBackend } from './secrets'
import { MCP_TOOL_NAME_RE, type McpDecision } from './mcpPermissions'
import { secretAccountsInWorkspaces } from './workspace'
import { canonicalSkills, dirContentHash } from './skills'
import { MANIFEST_TOOLS, setToggle, type ManifestKind } from './manifest'
import {
  applyHookCandidate,
  hookImportCandidates,
  type HookImportCandidate,
  type HookImportVariant
} from './hookImport'
import {
  addPending,
  importedBackupRoot,
  retireHash,
  UNREADABLE_HASH,
  type PendingRetire
} from './pendingRetire'
import { readState, writeState } from './state'
import { libraryPaths, readMcp } from './sources'
import { LEGACY_MD_MARKERS, MD_MARKERS } from './targets/codexAgents'
import { LEGACY_RULES_MARKERS, RULES_MARKERS } from './targets/codexRules'
import { mcpEntries, outsideBlockMulti, sha256, stripJsonComments } from './text'
import { LEGACY_TOML_MCP_MARKERS, TOML_MCP_MARKERS } from './targets/codexMcp'
import { GROK_MEMORY_RULE_FILE } from './ruleSync'
import type { Allowlist, AllowlistEntry, McpCodexOptions, McpServer, McpSource } from './types'

// ---------------------------------------------------------------- Sources

export type ImportSourceKind = 'legacyLibrary' | 'tool' | 'managerLibrary'
export type ImportKind = 'rule' | 'memory' | 'permissions' | 'skill' | 'mcp' | 'agent' | 'hook'

export interface ImportSource {
  /** legacy | tool:<tool id> | manager:skills-manager | manager:cc-switch */
  id: string
  kind: ImportSourceKind
  label: string
  /** Representative path (absolute) */
  path: string
  /** Whether it can be scanned (path exists) */
  available: boolean
  /** Kinds importable from this source */
  kinds: ImportKind[]
  /** Reason for available=false, etc. */
  note?: string
}

/** @deprecated pre-M7c name — the managerLibrary entries of listImportSources */
export const OTHER_APP_SKILL_DIRS: readonly { id: string; rel: string }[] = [
  { id: 'skills-manager', rel: '.skills-manager/skills' },
  { id: 'cc-switch', rel: '.cc-switch/skills' }
]

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return resolve(a) === resolve(b)
  }
}

/** Import source list. Read-only */
export function listImportSources(home: string): ImportSource[] {
  const lib = libraryRoot(home)
  const legacy = join(home, LEGACY_LIBRARY_DIR)
  const legacyIsLibrary = isDir(legacy) && sameDir(legacy, lib)
  const legacyHas = ['rules', 'skills', 'sync', 'memory'].some((d) => existsSync(join(legacy, d)))
  const toolSources: Record<
    ToolId,
    Pick<ImportSource, 'label' | 'path' | 'available' | 'kinds'>
  > = {
    claude: {
      label: 'Claude Code (~/.claude, ~/.claude.json)',
      path: join(home, '.claude'),
      available: toolConfigFound(home, 'claude'),
      kinds: ['rule', 'permissions', 'mcp', 'skill', 'agent', 'hook']
    },
    codex: {
      label: 'Codex (~/.codex)',
      path: join(home, '.codex'),
      available: toolConfigFound(home, 'codex'),
      kinds: ['rule', 'permissions', 'mcp', 'skill', 'agent', 'hook']
    },
    opencode: {
      label: 'OpenCode (~/.config/opencode)',
      path: join(home, '.config/opencode'),
      available: toolConfigFound(home, 'opencode'),
      kinds: ['rule', 'mcp', 'skill', 'agent']
    },
    gemini: {
      label: 'Gemini CLI (~/.gemini)',
      path: join(home, '.gemini'),
      available: toolConfigFound(home, 'gemini'),
      kinds: ['rule', 'mcp', 'skill', 'agent', 'hook']
    },
    copilot: {
      label: 'GitHub Copilot (~/.copilot)',
      path: join(home, '.copilot'),
      available: toolConfigFound(home, 'copilot'),
      kinds: ['rule', 'mcp', 'skill', 'agent', 'hook']
    },
    grok: {
      label: 'Grok CLI (~/.grok)',
      path: join(home, '.grok'),
      available: toolConfigFound(home, 'grok'),
      kinds: ['rule', 'mcp', 'skill', 'agent', 'hook']
    }
  }
  const out: ImportSource[] = [
    {
      id: 'legacy',
      kind: 'legacyLibrary',
      label: 'Previous library (~/.agents)',
      path: legacy,
      available: isDir(legacy) && legacyHas && !legacyIsLibrary,
      kinds: ['rule', 'memory', 'permissions', 'mcp', 'skill'],
      ...(legacyIsLibrary ? { note: 'Same path as the current library, so not a source' } : {})
    },
    ...TOOL_IDS.map((tool): ImportSource => ({
      id: `tool:${tool}`,
      kind: 'tool',
      ...toolSources[tool]
    }))
  ]
  for (const { id, rel } of OTHER_APP_SKILL_DIRS) {
    const p = join(home, rel)
    out.push({
      id: `manager:${id}`,
      kind: 'managerLibrary',
      label: `${id} skill library (~/${rel})`,
      path: p,
      available: isDir(p),
      kinds: ['skill']
    })
  }
  return out
}

// ---------------------------------------------------------------- Tool detection

export {
  detectTools,
  TOOL_EXECUTABLES,
  type DetectToolsOptions,
  type ToolDetection
} from './detect'

// ---------------------------------------------------------------- Candidate types

export interface ImportSourceRef {
  /** legacy = previous library, tool = tool config/skill directory, otherApp = another manager app's library */
  origin: 'legacy' | 'tool' | 'otherApp'
  /** Source id (listImportSources) */
  sourceId: string
  /** Display label (e.g. claude, codex, opencode, otherApp:skills-manager, legacy) */
  label: string
  /** Where it was found (absolute) */
  path: string
  /** Real path the link pointed to, if it was a symlink */
  linkTarget?: string
}

/**
 * conflict
 * - existsInLibrary  the library has the same name with different content (needs overwrite — existing goes to .trash)
 * - sourcesDiffer    the same name differs across sources (needs a variant choice)
 * - invalidName      violates library naming rules (cannot be imported)
 */
export type ImportConflict = 'existsInLibrary' | 'sourcesDiffer' | 'invalidName'

/**
 * Portability verdict — whether it can move into the library and be distributed to other tools.
 * - ok        safe to move as is
 * - warn      movable but may break on other machines/tools (selectable)
 * - toolOnly  bound to its original tool — import refused (library-first sync could overwrite the original tool definition)
 */
export type Portability = 'ok' | 'warn' | 'toolOnly'

/**
 * Verdict reasons
 * toolOnly
 * - relativeCommand   MCP command is a relative path (relative to the tool's working directory)
 * - appBundle         MCP command is inside an app bundle (.app)
 * - toolConfigDir     MCP command is inside a tool config directory
 * - pluginManaged     managed by a tool plugin (MCP named like a Codex [plugins.*] entry, command under a plugin path)
 * - projectScoped     project-only (project MCP, project instructions)
 * - hiddenDir         skill in a hidden directory (.system, etc.)
 * - toolInternalDir   tool-internal folder (synced, .trash)
 * - pluginSkill       plugin skill (plugin path, `:` in name)
 * - toolInstructions  tool-specific instructions (text outside Codex AGENTS.md markers, CLAUDE.md, AGENTS.md in a tool config dir)
 * - toolMemory        tool auto memory (~/.claude/projects/<p>/memory, ~/.codex/memories)
 * - primaryAgent      a primary agent, not a subagent (OpenCode mode: primary)
 * - builtinAgent      tool built-in agent settings (OpenCode build·plan·general·explore inline overrides)
 * - restrictedAgent   agent limited to certain tools or its own MCP servers (Gemini tools·mcpServers) — the library can't carry the
 *                     limit, so importing it would widen what the agent may do
 * - nameMismatch      agent's own name differs from its file name (Gemini registers the frontmatter name)
 * warn
 * - toolNotes         tool instructions/notes text (outside the app markers in ~/.gemini/GEMINI.md) — review before sharing
 * - localPath         command/args contain an absolute path specific to this machine
 * - toolSpecificTools SKILL.md or agent instructions assume tools specific to one tool
 * - toolSpecificKeys  agent's tool-specific settings (tools, permissions, hooks, temperature, etc.) have no library equivalent and are dropped
 */
export type PortabilityReason =
  | 'relativeCommand'
  | 'appBundle'
  | 'toolConfigDir'
  | 'pluginManaged'
  | 'projectScoped'
  | 'hiddenDir'
  | 'toolInternalDir'
  | 'pluginSkill'
  | 'toolInstructions'
  | 'toolMemory'
  | 'primaryAgent'
  | 'builtinAgent'
  | 'restrictedAgent'
  | 'nameMismatch'
  | 'localPath'
  | 'toolNotes'
  | 'toolSpecificTools'
  | 'toolSpecificKeys'

export interface PortabilityInfo {
  portability: Portability
  /** Deduplicated, in rule order */
  reasons: PortabilityReason[]
}

export interface FileVariant extends PortabilityInfo {
  /** First 12 chars of content sha256 — variant id for selection */
  id: string
  path: string
  bytes: number
  sources: ImportSourceRef[]
}

/** portability·reasons: based on the most portable variant (toolOnly only if all are). reasons is the union across variants */
export interface RuleImportCandidate extends PortabilityInfo {
  kind: 'rule'
  name: string
  status: 'new' | 'conflict'
  conflicts: ImportConflict[]
  variants: FileVariant[]
}

/** portability·reasons: based on the most portable variant (toolOnly only if all are). reasons is the union across variants */
export interface MemoryImportCandidate extends PortabilityInfo {
  kind: 'memory'
  /** Path relative to memory/ (e.g. MEMORY.md, feedback/x.md) */
  name: string
  status: 'new' | 'conflict'
  conflicts: ImportConflict[]
  variants: FileVariant[]
}

export interface PermissionsVariant extends PortabilityInfo {
  id: string
  /** Converted to allowlist format (commands/patterns only — no secrets) */
  allowlist: Allowlist
  counts: {
    bash: number
    allow: number
    deny: number
    ask: number
    bashAsk?: number
    bashDeny?: number
  }
  sources: ImportSourceRef[]
  warnings: string[]
}

/** portability·reasons: based on the most portable variant (toolOnly only if all are). reasons is the union across variants */
export interface PermissionsImportCandidate extends PortabilityInfo {
  kind: 'permissions'
  name: 'permissions'
  status: 'new' | 'conflict'
  conflicts: ImportConflict[]
  variants: PermissionsVariant[]
}

export interface SkillVariant extends PortabilityInfo {
  /** dirContentHash — variant id for selection */
  id: string
  /** Actual directory to copy */
  resolvedPath: string
  sources: ImportSourceRef[]
}

/** portability·reasons: based on the most portable variant (toolOnly only if all are). reasons is the union across variants */
export interface AgentVariant extends PortabilityInfo {
  /** First 12 chars of sha256 of the library-format source — variant id for selection */
  id: string
  /** Tool it was found in (model·effort go only under this tool's key) */
  tools: ToolId[]
  description: string
  model?: string
  effort?: string
  /** Library-format source (written as is to agents/<name>.md) */
  text: string
  /** Names of dropped tool-specific keys (no values) */
  warnings: string[]
  sources: ImportSourceRef[]
}

/** portability·reasons: based on the most portable variant (toolOnly only if all are). reasons is the union across variants */
export interface AgentImportCandidate extends PortabilityInfo {
  kind: 'agent'
  name: string
  status: 'new' | 'conflict'
  conflicts: ImportConflict[]
  variants: AgentVariant[]
}

export interface SkillImportCandidate extends PortabilityInfo {
  kind: 'skill'
  name: string
  status: 'new' | 'conflict'
  conflicts: ImportConflict[]
  variants: SkillVariant[]
}

/** Substitution candidate (no raw value) */
export interface Replaceable {
  /** KEY of ${KEY} — used in applyImport's replace list */
  key: string
  /** Location (env.X · headers.X · args[i] · url?q) */
  at: string
  /** Default verdict: true if the key name or value shape looks secret, false if it looks like a path/URL */
  looksSecret: boolean
}

export interface McpVariant extends PortabilityInfo {
  /** First 12 chars of sha256 of the definition core — variant id for selection */
  id: string
  tools: ToolId[]
  /** Library-format definition. Every substitutable literal is already ${KEY} (no raw values) */
  server: McpServer
  /** @deprecated replaced by replaceable. Locations assuming everything is substituted */
  replaced: { at: string; placeholder: string }[]
  replaceable: Replaceable[]
  warnings: string[]
  sources: ImportSourceRef[]
}

/** portability·reasons: based on the most portable variant (toolOnly only if all are). reasons is the union across variants */
export interface McpImportCandidate extends PortabilityInfo {
  kind: 'mcp'
  name: string
  status: 'new' | 'conflict'
  conflicts: ImportConflict[]
  variants: McpVariant[]
}

export type ImportCandidate =
  | RuleImportCandidate
  | MemoryImportCandidate
  | PermissionsImportCandidate
  | SkillImportCandidate
  | McpImportCandidate
  | AgentImportCandidate
  | HookImportCandidate

export interface ImportPlan {
  /** Scanned sources */
  sources: ImportSource[]
  rules: RuleImportCandidate[]
  memory: MemoryImportCandidate[]
  /** 0 or 1 */
  permissions: PermissionsImportCandidate[]
  skills: SkillImportCandidate[]
  mcp: McpImportCandidate[]
  agents: AgentImportCandidate[]
  /** Hooks a tool runs (user-level config) */
  hooks: HookImportCandidate[]
  /** Unreadable sources, etc. (no raw content) */
  notes: string[]
}

export interface ImportSelection {
  kind: ImportKind
  name: string
  /** Choice among multiple variants. May be omitted if there is only one */
  variant?: string
  /** Overwrite an existsInLibrary conflict (existing goes to .trash) */
  overwrite?: boolean
  /**
   * mcp: keys to substitute with ${KEY}. Omitted = all keys with looksSecret=true. [] = no substitution (raw values stored).
   */
  replace?: string[]
}

export interface ImportResult {
  kind: ImportKind
  name: string
  status: 'imported' | 'refused' | 'failed'
  reason?: string
  /** On overwrite, where the existing library item was moved */
  trashPath?: string
  /** Save warnings */
  warnings?: string[]
  /** mcp: keys actually substituted */
  replaced?: string[]
  /** agent: tools whose same-name file matched the rendered output and was adopted as app-owned */
  adopted?: ToolId[]
  /** agent: tools whose same-name file differed from the rendered output and was left as a user file (sync skips it) */
  userOwned?: ToolId[]
  /** rule·skill·agent: tools whose imported original is switched to app-owned — the next approved sync backs it up to backups/imported and writes the app copy */
  converted?: ToolId[]
  /** agent: the opencode.json inline definition stays, so OpenCode ends up with two definitions of the same name */
  inlineRemains?: boolean
}

export type { HookImportCandidate, HookImportVariant, HookImportWarning } from './hookImport'

// ---------------------------------------------------------------- Internal (scan results holding raw values)

type Json = Record<string, unknown>

function isObj(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

interface Slot extends Replaceable {
  /** Raw value (never exported in the plan) */
  raw: string
  /** Prefix such as `Bearer ` in headers */
  prefix?: string
}

interface McpFound {
  tool?: ToolId
  ref: ImportSourceRef
  /** Template (substitution slots are ${KEY}) */
  server: McpServer
  slots: Slot[]
  warnings: string[]
  info: PortabilityInfo
}

interface McpVariantInternal extends McpVariant {
  slots: Slot[]
}

interface Found {
  rules: Map<string, Map<string, FileVariant>>
  memory: Map<string, Map<string, FileVariant>>
  permissions: PermissionsVariant[]
  skills: Map<string, Map<string, SkillVariant>>
  mcp: Map<string, McpFound[]>
  agents: Map<string, Map<string, AgentVariant>>
  notes: string[]
  ctx: PortabilityContext
}

function newFound(ctx: PortabilityContext): Found {
  return {
    ctx,
    rules: new Map(),
    memory: new Map(),
    permissions: [],
    skills: new Map(),
    mcp: new Map(),
    agents: new Map(),
    notes: []
  }
}

function short(hash: string): string {
  return hash.slice(0, 12)
}

function within(root: string, p: string): boolean {
  const r = relative(root, p)
  return r === '' || (!!r && !r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r))
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

function readJsonSafe(path: string): Json | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/** Match the target's alternate-path selection; import JSONC without rewriting the user's comments. */
function opencodeConfigPath(home: string): string {
  const plain = join(home, '.config/opencode/opencode.json')
  return existsSync(plain) ? plain : join(home, '.config/opencode/opencode.jsonc')
}

function readOpencodeSettings(path: string): Json | null {
  try {
    const text = stripJsonComments(readFileSync(path, 'utf8'))
    let normalized = ''
    let inString = false
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        normalized += ch
        if (ch === '\\') normalized += text[++i] ?? ''
        else if (ch === '"') inString = false
      } else if (ch === '"') {
        inString = true
        normalized += ch
      } else if (ch === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) {
        // JSONC allows a trailing comma in objects and arrays, but string contents stay literal.
        normalized += ' '
      } else normalized += ch
    }
    const value: unknown = JSON.parse(normalized)
    return isObj(value) ? value : null
  } catch {
    return null
  }
}

function addFile(
  map: Map<string, Map<string, FileVariant>>,
  name: string,
  path: string,
  ref: ImportSourceRef,
  info: PortabilityInfo = OK
): void {
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    return
  }
  const id = short(createHash('sha256').update(buf).digest('hex'))
  const byId = map.get(name) ?? new Map<string, FileVariant>()
  const existing = byId.get(id)
  const v = existing ?? { id, path, bytes: buf.length, sources: [], ...structuredClone(info) }
  if (existing) mergeInto(v, info)
  if (!v.sources.some((s) => s.path === ref.path)) v.sources.push(ref)
  byId.set(id, v)
  map.set(name, byId)
}

// ---------------------------------------------------------------- Portability verdict

const TOOL_ONLY_REASONS: ReadonlySet<PortabilityReason> = new Set<PortabilityReason>([
  'relativeCommand',
  'appBundle',
  'toolConfigDir',
  'pluginManaged',
  'projectScoped',
  'hiddenDir',
  'toolInternalDir',
  'pluginSkill',
  'toolInstructions',
  'toolMemory',
  'primaryAgent',
  'builtinAgent',
  'restrictedAgent',
  'nameMismatch'
])
const REASON_ORDER: readonly PortabilityReason[] = [
  ...TOOL_ONLY_REASONS,
  'localPath',
  'toolNotes',
  'toolSpecificTools',
  'toolSpecificKeys'
]

function judge(reasons: Iterable<PortabilityReason>): PortabilityInfo {
  const set = new Set(reasons)
  const list = REASON_ORDER.filter((r) => set.has(r))
  const portability: Portability = list.some((r) => TOOL_ONLY_REASONS.has(r))
    ? 'toolOnly'
    : list.length
      ? 'warn'
      : 'ok'
  return { portability, reasons: list }
}

const OK: PortabilityInfo = { portability: 'ok', reasons: [] }
const RANK: Record<Portability, number> = { ok: 0, warn: 1, toolOnly: 2 }

/** Candidate verdict: based on the most portable variant, reasons are the union */
function aggregate(variants: PortabilityInfo[]): PortabilityInfo {
  if (!variants.length) return OK
  const best = variants.reduce(
    (a, v) => (RANK[v.portability] < RANK[a] ? v.portability : a),
    'toolOnly' as Portability
  )
  const all = judge(variants.flatMap((v) => v.reasons))
  return { portability: best, reasons: all.reasons }
}

/** Merge per-source verdicts folded into the same variant (the worse one wins) */
function mergeInto(target: PortabilityInfo, add: PortabilityInfo): void {
  const j = judge([...target.reasons, ...add.reasons])
  target.portability = j.portability
  target.reasons = j.reasons
}

/** Tool config directories (relative to HOME) */
const TOOL_DIRS = [
  '.codex',
  '.claude',
  '.config/opencode',
  '.local/share/opencode',
  '.gemini',
  '.copilot'
] as const
/** Tool plugin paths */
const TOOL_PLUGIN_DIRS = [
  '.codex/plugins',
  '.claude/plugins',
  '.config/opencode/plugin',
  '.config/opencode/plugins',
  '.gemini/extensions'
]

function expandHome(home: string, p: string): string {
  return p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p
}

function inAny(home: string, rels: readonly string[], abs: string): boolean {
  return rels.some((r) => within(join(home, r), abs))
}

/** Machine-specific absolute paths (user home, local install paths) */
const LOCAL_PATH_RE =
  /(?:^|[\s"'=:,])(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|\/opt\/homebrew\/|\/usr\/local\/|\/opt\/local\/)/

function isLocalPath(home: string, v: string): boolean {
  return LOCAL_PATH_RE.test(v) || (home.length > 1 && v.includes(home + '/'))
}

export interface PortabilityContext {
  home: string
  /** name of Codex config.toml [plugins."<name>@<marketplace>"] */
  codexPlugins: Set<string>
}

function codexPluginNames(home: string): Set<string> {
  const out = new Set<string>()
  const tp = join(home, '.codex/config.toml')
  if (!existsSync(tp)) return out
  try {
    const o = parseToml(readFileSync(tp, 'utf8')) as Json
    if (isObj(o.plugins)) for (const k of Object.keys(o.plugins)) out.add(k.split('@')[0])
  } catch {
    // scanTool reports parse failures in notes
  }
  return out
}

/** MCP definition verdict. tool is the tool it was found in (absent for legacy) */
export function mcpPortability(
  ctx: PortabilityContext,
  name: string,
  server: McpServer,
  tool?: ToolId,
  /** Substitution slots — judged by the raw values in args (the verdict never contains raw values) */
  slots: readonly Slot[] = []
): PortabilityInfo {
  const { home } = ctx
  const args = (server.args ?? []).map(
    (a, i) => slots.find((s) => s.at === `args[${i}]`)?.raw ?? String(a)
  )
  const r: PortabilityReason[] = []
  if (tool === 'codex' && ctx.codexPlugins.has(name)) r.push('pluginManaged')
  if (server.transport === 'stdio' && typeof server.command === 'string') {
    const cmd = server.command.trim()
    const abs = expandHome(home, cmd)
    if (!isAbsolute(abs)) {
      // A name without a slash is a PATH command — portable
      if (abs.includes('/')) r.push('relativeCommand')
    } else {
      if (
        /^\/Applications\/[^/]+\.app\//.test(abs) ||
        (within(join(home, 'Applications'), abs) && /\.app\//.test(abs)) ||
        /\.app\/Contents\//.test(abs)
      )
        r.push('appBundle')
      if (inAny(home, TOOL_PLUGIN_DIRS, abs)) r.push('pluginManaged')
      else if (inAny(home, TOOL_DIRS, abs)) r.push('toolConfigDir')
    }
    if (isLocalPath(home, cmd) || args.some((a) => isLocalPath(home, a))) r.push('localPath')
  }
  return judge(r)
}

/** Tool-specific tools a skill body assumes (simple pattern list) */
const TOOL_SPECIFIC_TOOL_RE = new RegExp(
  [
    // Claude Code-only MCP and tools
    'mcp__claude-in-chrome__',
    'mcp__Claude_Browser__',
    'mcp__remote-devices__',
    'mcp__computer-use__',
    '\\bAskUserQuestion\\b',
    '\\bExitPlanMode\\b',
    '\\bEnterPlanMode\\b',
    // Codex-only tools
    'mcp__node_repl__',
    '\\bnode_repl\\b',
    '\\bspawn_agent\\b',
    '\\bupdate_plan\\b',
    '\\brequest_user_input\\b'
  ].join('|')
)

const SKILL_INTERNAL_DIRS = new Set(['synced', '.trash', '.system'])

/** Skill verdict. path = where found, resolved = real directory */
export function skillPortability(
  ctx: PortabilityContext,
  name: string,
  path: string,
  resolved: string
): PortabilityInfo {
  const { home } = ctx
  const r: PortabilityReason[] = []
  const segs = (p: string): string[] => relative(home, p).split(sep)
  const allSegs = [...segs(path), ...segs(resolved)]
  if (name.startsWith('.')) r.push('hiddenDir')
  if (allSegs.some((x) => SKILL_INTERNAL_DIRS.has(x))) r.push('toolInternalDir')
  if (
    name.includes(':') ||
    inAny(home, TOOL_PLUGIN_DIRS, path) ||
    inAny(home, TOOL_PLUGIN_DIRS, resolved)
  )
    r.push('pluginSkill')
  try {
    if (TOOL_SPECIFIC_TOOL_RE.test(readFileSync(join(resolved, 'SKILL.md'), 'utf8')))
      r.push('toolSpecificTools')
  } catch {
    // Don't judge what can't be read
  }
  return judge(r)
}

const INSTRUCTION_FILES = new Set(['CLAUDE.md', 'AGENTS.md', 'AGENT.md', 'GEMINI.md'])

/** Rule candidate for the text outside the app markers in ~/.gemini/GEMINI.md (copied, never moved) */
export const GEMINI_MD_RULE = 'gemini-md.md'
/** Rule candidate for ~/.copilot/copilot-instructions.md (copied, never moved) */
export const COPILOT_MD_RULE = 'copilot-instructions.md'
/** Tool notes files imported as rules: copied only, all tools start off */
const TOOL_NOTES_RULES: ReadonlySet<string> = new Set([GEMINI_MD_RULE, COPILOT_MD_RULE])

/** Rule file verdict. name is the candidate name, path is the source file */
export function rulePortability(
  ctx: PortabilityContext,
  name: string,
  path: string
): PortabilityInfo {
  const { home } = ctx
  const r: PortabilityReason[] = []
  const base = path.split('/').pop() ?? ''
  if (name === 'codex-agents.md' && path === join(home, '.codex/AGENTS.md'))
    r.push('toolInstructions')
  // GEMINI.md outside the markers: global instructions and Gemini memory-tool notes — importable, but review before sharing
  else if (name === GEMINI_MD_RULE && path === join(home, '.gemini/GEMINI.md')) r.push('toolNotes')
  else if (name === COPILOT_MD_RULE && path === join(home, '.copilot/copilot-instructions.md'))
    r.push('toolNotes')
  else if (INSTRUCTION_FILES.has(base)) {
    // Global instructions in a tool config dir are tool-only; instructions elsewhere (repos, etc.) are project-scoped
    if (inAny(home, TOOL_DIRS, path)) r.push('toolInstructions')
    else r.push('projectScoped')
  }
  return judge(r)
}

/** Memory file verdict */
export function memoryPortability(ctx: PortabilityContext, path: string): PortabilityInfo {
  const { home } = ctx
  const rel = relative(home, path).split(sep)
  if (
    (rel[0] === '.claude' && rel[1] === 'projects' && rel[3] === 'memory') ||
    within(join(home, '.codex/memories'), path)
  )
    return judge(['toolMemory'])
  return OK
}

// ---------------------------------------------------------------- Skill scan

function scanSkillDir(
  found: Found,
  home: string,
  dir: string,
  ref: Omit<ImportSourceRef, 'path'>
): void {
  if (!existsSync(dir)) return
  const libReal = realOrNull(libraryPaths(home).skillsDir)
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch (e) {
    found.notes.push(
      `${tilde(home, dir)} read failed (${(e as NodeJS.ErrnoException).code ?? 'unknown'})`
    )
    return
  }
  for (const name of names) {
    // Hidden directories are candidates too if they have SKILL.md — the verdict blocks them as toolOnly
    const path = join(dir, name)
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(path)
    } catch {
      continue
    }
    const r: ImportSourceRef = { ...ref, path }
    let resolved: string | null = path
    if (st.isSymbolicLink()) {
      resolved = realOrNull(path)
      r.linkTarget = resolve(dirname(path), readlinkSync(path))
      if (!resolved) continue // broken link
    } else if (!st.isDirectory()) continue
    // Entries already pointing into the library have nothing to import
    if (libReal && within(libReal, resolved)) continue
    if (!existsSync(join(resolved, 'SKILL.md'))) continue
    let id: string
    try {
      id = dirContentHash(resolved)
    } catch {
      found.notes.push(`${tilde(home, path)} content hash failed`)
      continue
    }
    const info = skillPortability(found.ctx, name, path, resolved)
    const byId = found.skills.get(name) ?? new Map<string, SkillVariant>()
    const existing = byId.get(id)
    const v = existing ?? { id, resolvedPath: resolved, sources: [], ...info }
    if (existing) mergeInto(v, info)
    if (!v.sources.some((s) => s.path === r.path)) v.sources.push(r)
    byId.set(id, v)
    found.skills.set(name, byId)
  }
}

// ---------------------------------------------------------------- Agent scan

const noEvalAgent = (): never => {
  throw new Error('js front matter is not supported')
}
const AGENT_MATTER = { engines: { js: noEvalAgent, javascript: noEvalAgent } }

/** Keys carried into library format (per tool agent file). Other keys are dropped (toolSpecificKeys) */
const AGENT_KEPT: Readonly<Record<ToolId, ReadonlySet<string>>> = {
  claude: new Set(['name', 'description', 'model', 'effort']),
  codex: new Set([
    'name',
    'description',
    'model',
    'model_reasoning_effort',
    'developer_instructions'
  ]),
  opencode: new Set(['name', 'description', 'mode', 'model', 'reasoningEffort']),
  gemini: new Set(['name', 'description', 'model', 'kind']),
  copilot: new Set(['name', 'description', 'model', 'reasoning-effort']),
  grok: new Set(['name', 'description', 'model'])
}
/** Keys carried over from OpenCode opencode.json `agent` inline definitions */
const OPENCODE_INLINE_KEPT: ReadonlySet<string> = new Set([
  'description',
  'mode',
  'model',
  'reasoningEffort',
  'prompt'
])
/** OpenCode built-in agent names (opencode.json agent.<name> is an override) */
const OPENCODE_BUILTIN_AGENTS = new Set(['build', 'plan', 'general', 'explore'])

const strOf = (v: unknown): string | undefined =>
  typeof v === 'string'
    ? v.trim()
      ? v.trim()
      : undefined
    : typeof v === 'number'
      ? String(v)
      : undefined

interface AgentRaw {
  description: string
  model?: string
  effort?: string
  body: string
  dropped: string[]
  reasons: PortabilityReason[]
}

function addAgent(
  found: Found,
  tool: ToolId,
  name: string,
  raw: AgentRaw,
  ref: ImportSourceRef
): void {
  const settings: AgentToolSettings = {
    ...(raw.model ? { model: raw.model } : {}),
    ...(raw.effort ? { effort: raw.effort } : {})
  }
  let text: string
  try {
    text = agentLibraryText(name, {
      description: raw.description,
      body: raw.body,
      tools: Object.keys(settings).length ? { [tool]: settings } : {}
    })
  } catch {
    // Naming rule violations etc. — surface as invalidName without raw content for display
    text = ''
  }
  const r = [...raw.reasons]
  if (raw.dropped.length) r.push('toolSpecificKeys')
  if (TOOL_SPECIFIC_TOOL_RE.test(raw.body)) r.push('toolSpecificTools')
  const info = judge(r)
  const id = short(sha256(text || `${tool}:${ref.path}`))
  const byId = found.agents.get(name) ?? new Map<string, AgentVariant>()
  const existing = byId.get(id)
  const v: AgentVariant = existing ?? {
    id,
    tools: [tool],
    description: raw.description,
    ...settings,
    text,
    warnings: [...raw.dropped],
    sources: [],
    ...info
  }
  if (existing) {
    mergeInto(v, info)
    if (!v.tools.includes(tool)) v.tools.push(tool)
    for (const k of raw.dropped) if (!v.warnings.includes(k)) v.warnings.push(k)
  }
  if (!v.sources.some((s) => s.path === ref.path)) v.sources.push(ref)
  byId.set(id, v)
  found.agents.set(name, byId)
}

/** Body: strip leading blank lines, end with one newline */
function agentBody(s: string): string {
  const t = s.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '')
  return t ? t + '\n' : ''
}

function droppedKeys(data: Json, kept: ReadonlySet<string>): string[] {
  return Object.keys(data)
    .filter((k) => !kept.has(k))
    .sort()
}

/** One tool agent file → library fields. Throws on parse failure */
function agentRaw(
  tool: ToolId,
  name: string,
  text: string,
  reasons: PortabilityReason[]
): AgentRaw {
  switch (tool) {
    case 'codex': {
      const d = parseToml(text) as Json
      return {
        description: strOf(d.description) ?? '',
        model: strOf(d.model),
        effort: strOf(d.model_reasoning_effort),
        body: agentBody(
          typeof d.developer_instructions === 'string' ? d.developer_instructions : ''
        ),
        dropped: droppedKeys(d, AGENT_KEPT.codex),
        reasons
      }
    }
    case 'gemini': {
      const m = matter(text, AGENT_MATTER)
      const d = structuredClone(m.data) as Json
      // Remote (A2A) agents have no local instructions to carry over
      if (strOf(d.kind) === 'remote') reasons.push('builtinAgent')
      if (d.tools !== undefined || d.mcpServers !== undefined) reasons.push('restrictedAgent')
      const own = strOf(d.name)
      if (own !== undefined && own !== name) reasons.push('nameMismatch')
      const model = strOf(d.model)
      return {
        description: strOf(d.description) ?? '',
        // inherit = Gemini's default (the session model)
        model: model === 'inherit' ? undefined : model,
        body: agentBody(m.content),
        dropped: droppedKeys(d, AGENT_KEPT.gemini),
        reasons
      }
    }
    case 'copilot': {
      const m = matter(text, AGENT_MATTER)
      const d = structuredClone(m.data) as Json
      // Tool and MCP limits can't be carried by the library — importing would widen what the agent may do
      if (d.tools !== undefined || d['mcp-servers'] !== undefined || d.mcpServers !== undefined)
        reasons.push('restrictedAgent')
      const own = strOf(d.name)
      if (own !== undefined && own !== name) reasons.push('nameMismatch')
      return {
        description: strOf(d.description) ?? '',
        model: strOf(d.model),
        effort: strOf(d['reasoning-effort']),
        body: agentBody(m.content),
        dropped: droppedKeys(d, AGENT_KEPT.copilot),
        reasons
      }
    }
    case 'claude':
    case 'grok':
    case 'opencode': {
      const m = matter(text, AGENT_MATTER)
      const d = structuredClone(m.data) as Json
      if (tool === 'opencode' && strOf(d.mode) === 'primary') reasons.push('primaryAgent')
      return {
        description: strOf(d.description) ?? '',
        model: strOf(d.model),
        effort: strOf(tool === 'claude' ? d.effort : d.reasoningEffort),
        body: agentBody(m.content),
        dropped: droppedKeys(d, AGENT_KEPT[tool]),
        reasons
      }
    }
    default: {
      const never: never = tool
      throw new Error(`unknown tool ${String(never)}`)
    }
  }
}

/**
 * Scan one tool agent folder. Skips copies the app wrote (agents/<name> recorded in state.agents).
 * format: md (Claude·OpenCode) or toml (Codex)
 */
function scanAgentDir(
  found: Found,
  home: string,
  tool: ToolId,
  dir: string,
  ref: Omit<ImportSourceRef, 'path'>,
  managed: Record<string, unknown>
): void {
  if (!isDir(dir)) return
  let files: string[]
  try {
    files = readdirSync(dir).sort()
  } catch (e) {
    found.notes.push(
      `${tilde(home, dir)} read failed (${(e as NodeJS.ErrnoException).code ?? 'unknown'})`
    )
    return
  }
  const libReal = realOrNull(libraryPaths(home).agentsDir)
  for (const f of files) {
    const name = agentNameOfFile(tool, f)
    if (name === null) continue
    const path = join(dir, f)
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(path)
    } catch {
      continue
    }
    const r: ImportSourceRef = { ...ref, path }
    let resolved = path
    if (st.isSymbolicLink()) {
      const real = realOrNull(path)
      if (!real) continue
      r.linkTarget = resolve(dirname(path), readlinkSync(path))
      resolved = real
    } else if (!st.isFile()) continue
    if (libReal && within(libReal, resolved)) continue
    // Copies the app wrote (including pending deletion) are not import material
    if (managed[name] && path === agentToolPath(home, tool, name)) continue
    const reasons: PortabilityReason[] = []
    if (inAny(home, TOOL_PLUGIN_DIRS, resolved)) reasons.push('pluginManaged')
    let text: string
    try {
      text = readFileSync(resolved, 'utf8')
    } catch {
      found.notes.push(`${tilde(home, path)} read failed`)
      continue
    }
    try {
      addAgent(found, tool, name, agentRaw(tool, name, text, reasons), r)
    } catch {
      found.notes.push(`${tilde(home, path)} parse failed`)
    }
  }
}

/** OpenCode prompt `{file:./x.txt}` → file content relative to the config file. null if unreadable */
function opencodePrompt(
  home: string,
  configPath: string,
  v: unknown
): { body: string; unresolved: boolean } {
  if (typeof v !== 'string') return { body: '', unresolved: false }
  const m = /^\{file:(.+)\}$/.exec(v.trim())
  if (!m) return { body: agentBody(v), unresolved: false }
  const p = expandHome(home, m[1].trim())
  const abs = isAbsolute(p) ? p : resolve(dirname(configPath), p)
  try {
    return { body: agentBody(readFileSync(abs, 'utf8')), unresolved: false }
  } catch {
    return { body: agentBody(v), unresolved: true }
  }
}

function scanAgentsOfTool(found: Found, home: string, tool: ToolId, sourceId: string): void {
  const managed = (readState(home).state.agents ?? {})[tool] ?? {}
  const base = { origin: 'tool' as const, sourceId, label: tool }
  // Only the folder the app writes holds app copies (managed); other source folders are all user files
  const slot = agentToolDir(home, tool).dir
  for (const dir of agentSourceDirs(home, tool))
    scanAgentDir(found, home, tool, dir, base, dir === slot ? managed : {})
  if (tool === 'opencode') {
    const cp = opencodeConfigPath(home)
    if (!existsSync(cp)) return
    const o = readOpencodeSettings(cp)
    if (!o || !isObj(o.agent)) return
    for (const [name, def] of Object.entries(o.agent)) {
      if (!isObj(def)) continue
      const reasons: PortabilityReason[] = []
      if (strOf(def.mode) === 'primary') reasons.push('primaryAgent')
      if (OPENCODE_BUILTIN_AGENTS.has(name)) reasons.push('builtinAgent')
      const pr = opencodePrompt(home, cp, def.prompt)
      const dropped = droppedKeys(def, OPENCODE_INLINE_KEPT)
      if (pr.unresolved) dropped.push('prompt{file:}')
      addAgent(
        found,
        tool,
        name,
        {
          description: strOf(def.description) ?? '',
          model: strOf(def.model),
          effort: strOf(def.reasoningEffort),
          body: pr.body,
          dropped,
          reasons
        },
        { ...base, path: `${cp}#agent.${name}` }
      )
    }
  }
}

export { importedBackupRoot }

/** Per-tool agent source folders (originals there are switched to app-owned on the next sync) */
function agentSourceDirs(home: string, tool: ToolId): string[] {
  return tools(home).find((t) => t.id === tool)!.roster.dirs
}

function pendingEntry(
  home: string,
  kind: PendingRetire['kind'],
  tool: ToolId,
  name: string,
  path: string
): PendingRetire | null {
  const hash = retireHash(path)
  return hash === null || hash === UNREADABLE_HASH
    ? null
    : {
        kind,
        tool,
        name,
        path,
        hash,
        at: new Date().toISOString(),
        workspace: activeWorkspaceId(home)
      }
}

/**
 * Imported agent: source tool files that the app file will replace (pendingRetire — moved to backups/imported by the next approved sync,
 * never permanently deleted). Files already byte-identical to the rendered output at the sync location are adopted instead (adoptAgentFiles).
 * opencode.json inline definitions are left alone.
 */
function agentRetirements(
  home: string,
  name: string,
  v: AgentVariant
): { pending: PendingRetire[]; converted: ToolId[]; inline: boolean } {
  const out = { pending: [] as PendingRetire[], converted: [] as ToolId[], inline: false }
  const doc = readAgentDoc(home, name)
  for (const src of v.sources) {
    if (src.path.includes('#agent.')) {
      out.inline = true
      continue
    }
    const tool = src.label as ToolId
    if (!TOOL_IDS.includes(tool)) continue
    const dir = dirname(src.path)
    if (
      !agentSourceDirs(home, tool).includes(dir) ||
      agentNameOfFile(tool, basename(src.path)) !== name
    )
      continue
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(src.path)
    } catch {
      continue
    }
    if (!st.isFile() && !st.isSymbolicLink()) continue
    // If the file at the sync location already matches the rendered output, it is adopted instead (adoptAgentFiles)
    if (
      src.path === agentToolPath(home, tool, name) &&
      st.isFile() &&
      sha256(readFileSync(src.path, 'utf8')) === sha256(renderAgent(tool, doc))
    )
      continue
    const e = pendingEntry(home, 'agent', tool, name, src.path)
    if (!e) continue
    out.pending.push(e)
    if (!out.converted.includes(tool)) out.converted.push(tool)
  }
  return out
}

/**
 * Imported rule: `~/.claude/rules/<name>` is replaced by the app copy (`~/.claude/rules/illithid/<name>`) on the next approved sync —
 * leaving both makes Claude read the same rule twice. Files referenced by opencode.json instructions are user paths and never moved;
 * only that instructions entry is removed by the opencodeRules target (sync adds the library path instead).
 */
/** Record ~/.grok/rules/<name> as the app's copy when it matches the library rule byte for byte (Grok copies rules as they are) */
function adoptGrokRule(home: string, name: string, path: string): void {
  try {
    const bytes = readFileSync(path, 'utf8')
    if (sha256(bytes) !== sha256(readRule(home, name))) return
    const st = readState(home)
    if (st.error) return
    const state = { ...st.state, toolRules: { ...(st.state.toolRules ?? {}) } }
    state.toolRules.grok = {
      ...(state.toolRules.grok ?? {}),
      [name]: { contentHash: sha256(bytes), at: new Date().toISOString() }
    }
    writeState(home, state)
  } catch {
    // not adopted: the next sync reports it as the user's file
  }
}

function ruleRetirements(
  home: string,
  name: string,
  v: FileVariant
): { pending: PendingRetire[]; converted: ToolId[] } {
  const out = { pending: [] as PendingRetire[], converted: [] as ToolId[] }
  const claudeRule = join(home, '.claude/rules', name)
  for (const src of v.sources) {
    if (src.origin !== 'tool') continue
    let e: PendingRetire | null = null
    if (src.label === 'opencode') e = pendingEntry(home, 'instruction', 'opencode', name, src.path)
    else if (
      src.label === 'copilot' &&
      src.path.endsWith('.instructions.md') &&
      within(join(home, '.copilot/instructions'), src.path)
    ) {
      try {
        if (!lstatSync(src.path).isFile()) continue
      } catch {
        continue
      }
      e = pendingEntry(home, 'rule', 'copilot', name, src.path)
    } else if (src.label === 'grok' && src.path === join(home, '.grok/rules', name)) {
      // The original already sits where the app copy goes (~/.grok/rules/<name>): nothing to retire — adopt it when the bytes match
      adoptGrokRule(home, name, src.path)
      continue
    } else if (src.label === 'claude' && src.path === claudeRule) {
      try {
        if (!lstatSync(src.path).isFile()) continue
      } catch {
        continue
      }
      e = pendingEntry(home, 'rule', 'claude', name, src.path)
    }
    if (!e) continue
    out.pending.push(e)
    if (!out.converted.includes(e.tool)) out.converted.push(e.tool)
  }
  return out
}

/** Per-tool skill source folders */
function skillSourceDirs(home: string, tool: ToolId): string[] {
  const t = tools(home).find((x) => x.id === tool)!
  switch (t.skills.kind) {
    case 'symlinkDir':
      return [t.skills.dir]
    case 'autoScan':
      // The tool's own folders (the other roots belong to other tools or the library)
      return [join(home, '.config/opencode/skill'), join(home, '.config/opencode/skills')]
    default: {
      const never: never = t.skills
      throw new Error(`unknown skills kind ${String(never)}`)
    }
  }
}

/** Tools the app copies library skills into (the rest read the library directly) */
function copiesSkills(home: string, tool: ToolId): boolean {
  return tools(home).find((x) => x.id === tool)!.skills.kind === 'symlinkDir'
}

/**
 * Imported skill: source tool folders the app copy replaces on the next approved sync. Claude·Codex get app copies;
 * OpenCode reads the library via skills.paths, so its own copy is retired. Real directories at the Claude·Codex locations with the
 * same content as the library copy are adopted instead (adoptSkillCopies); symlinks there are replaced by sync (replaceLink — the
 * link target is untouched), so they need no record.
 */
function skillRetirements(
  home: string,
  name: string,
  v: SkillVariant
): { pending: PendingRetire[]; converted: ToolId[] } {
  const out = { pending: [] as PendingRetire[], converted: [] as ToolId[] }
  let libHash: string | null = null
  try {
    libHash = dirContentHash(join(libraryPaths(home).skillsDir, name))
  } catch {
    libHash = null
  }
  for (const src of v.sources) {
    if (src.origin !== 'tool') continue
    const tool = src.label as ToolId
    if (!TOOL_IDS.includes(tool)) continue
    const dir = dirname(src.path)
    if (!skillSourceDirs(home, tool).includes(dir) || basename(src.path) !== name) continue
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(src.path)
    } catch {
      continue
    }
    if (!st.isDirectory() && !st.isSymbolicLink()) continue
    if (copiesSkills(home, tool)) {
      if (st.isSymbolicLink()) {
        if (!out.converted.includes(tool)) out.converted.push(tool)
        continue
      }
      let h: string | null = null
      try {
        h = dirContentHash(src.path)
      } catch {
        h = null
      }
      if (libHash !== null && h === libHash) continue
    }
    const e = pendingEntry(home, 'skill', tool, name, src.path)
    if (!e) continue
    out.pending.push(e)
    if (!out.converted.includes(tool)) out.converted.push(tool)
  }
  return out
}

/** enableOnlySourceTools that never fails the import (false = toggles could not be saved, the item stays on for all tools) */
function sourceToggles(
  home: string,
  kind: ManifestKind,
  name: string,
  sources: ImportSourceRef[]
): boolean {
  try {
    enableOnlySourceTools(home, kind, name, sources)
    return true
  } catch {
    return false
  }
}

/**
 * Tool notes (GEMINI.md outside the markers, copilot-instructions.md) stay where they are (copied, not moved) and are the tool's own
 * text, so the imported rule starts off for every tool — the user turns on only the tools that should get it (on for the source
 * tool it would also be read twice)
 */
function toolNotesToggles(home: string, name: string, sources: ImportSourceRef[]): boolean {
  if (!sources.some((s) => s.origin === 'tool')) return sourceToggles(home, 'rules', name, sources)
  try {
    for (const tool of MANIFEST_TOOLS.rules) setToggle(home, 'rules', name, tool, false)
    return true
  } catch {
    return false
  }
}

/** Record pending retirements in state.json (the next approved sync executes them) */
function recordRetirements(home: string, pending: PendingRetire[]): void {
  if (!pending.length) return
  const st = readState(home)
  if (st.error) throw new LibraryError('configError', `state.json: ${st.error}`)
  const state = { ...st.state }
  addPending(state, pending)
  writeState(home, state)
}

/**
 * Newly imported items start enabled only for the tool(s) they came from (tool sources only; library·manager sources keep the
 * all-on default). Tools the kind can't toggle (MANIFEST_TOOLS) are left alone. OpenCode skills keep their default too:
 * OpenCode already found them in ~/.claude/skills or ~/.agents/skills, so an import must not start hiding them
 */
function enableOnlySourceTools(
  home: string,
  kind: ManifestKind,
  name: string,
  sources: ImportSourceRef[]
): void {
  const from = new Set(sources.filter((s) => s.origin === 'tool').map((s) => s.label))
  if (!from.size) return
  for (const tool of MANIFEST_TOOLS[kind]) {
    if (kind === 'skills' && tool === 'opencode') continue
    setToggle(home, kind, name, tool, from.has(tool))
  }
}

// ---------------------------------------------------------------- MCP conversion

const PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g
const ENV_KEY_SAFE = (s: string): string =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/^([0-9])/, '_$1')

/** Treat as a reference value if it contains a ${VAR} reference and nothing else looks secret */
function isRefValue(v: string): boolean {
  return v.includes('${') && !v.replace(PLACEHOLDER, '').includes('$') && !looksLikeSecret(v)
}

class Converter {
  slots: Slot[] = []
  warnings: string[] = []
  constructor(private server: string) {}

  private slot(at: string, key: string, raw: string, secretHint: string, prefix?: string): string {
    // Number keys that collide within the same server
    let k = key
    for (let i = 2; this.slots.some((s) => s.key === k); i++) k = `${key}_${i}`
    this.slots.push({
      key: k,
      at,
      raw,
      looksSecret: isSecretPair(secretHint, raw),
      ...(prefix ? { prefix } : {})
    })
    return `\${${k}}`
  }

  /** env value: references kept as is, literals become ${KEY} slots */
  envValue(key: string, v: unknown): string {
    const s = typeof v === 'string' ? v : String(v)
    if (isRefValue(s)) return s
    return this.slot(`env.${key}`, ENV_KEY_SAFE(key), s, key)
  }

  /** Header value: references kept as is, `Bearer <literal>` keeps its prefix, other literals become ${SERVER_HEADER} */
  headerValue(header: string, v: unknown): string {
    const s = typeof v === 'string' ? v : String(v)
    if (isRefValue(s)) return s
    const m = /^(Bearer|Token|Basic)\s+/i.exec(s)
    const raw = m ? s.slice(m[0].length) : s
    const key = ENV_KEY_SAFE(`${this.server}_${m ? 'token' : header}`)
    const ph = this.slot(`headers.${header}`, key, raw, m ? 'TOKEN' : header, m ? m[0] : undefined)
    return m ? `${m[0]}${ph}` : ph
  }

  args(list: unknown): string[] {
    if (!Array.isArray(list)) return []
    return list.map((a, i) => {
      const s = String(a)
      if (!looksLikeSecret(s)) return s
      this.warnings.push(
        `args[${i}] looks like a secret — listed as a substitution candidate (args don't expand env vars; check manually)`
      )
      return this.slot(`args[${i}]`, ENV_KEY_SAFE(`${this.server}_arg${i}`), s, 'SECRET')
    })
  }

  url(u: unknown): string {
    const s = String(u ?? '')
    try {
      const url = new URL(s)
      let touched = false
      for (const [k, v] of [...url.searchParams]) {
        if (looksLikeSecret(v)) {
          const ph = this.slot(`url?${k}`, ENV_KEY_SAFE(`${this.server}_${k}`), v, k)
          url.searchParams.set(k, ph)
          touched = true
        }
      }
      if (url.username || url.password) {
        url.username = ''
        url.password = ''
        this.warnings.push('dropped user info from url')
        touched = true
      }
      return touched ? decodePlaceholders(url.toString()) : s
    } catch {
      return s
    }
  }
}

function decodePlaceholders(s: string): string {
  return s.replace(/%24%7B([A-Za-z0-9_]+)%7D/g, '${$1}')
}

/** opencode {env:VAR} → ${VAR} */
function fromOpencodeRef(v: unknown): unknown {
  return typeof v === 'string' ? v.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}') : v
}

type Conv = { server: McpServer; c: Converter } | null

function convertClaude(name: string, s: Json): Conv {
  const c = new Converter(name)
  const type = s.type ?? (s.command ? 'stdio' : s.url ? 'http' : undefined)
  if (type === 'stdio') {
    const server: McpServer = { transport: 'stdio', command: String(s.command ?? '') }
    server.args = c.args(s.args)
    if (isObj(s.env) && Object.keys(s.env).length)
      server.env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, c.envValue(k, v)]))
    return { server, c }
  }
  if (type === 'http' || type === 'sse') {
    if (type === 'sse')
      c.warnings.push(
        'moved sse transport to http — check that the server supports streamable http'
      )
    const server: McpServer = { transport: 'http', url: c.url(s.url) }
    if (isObj(s.headers) && Object.keys(s.headers).length)
      server.headers = Object.fromEntries(
        Object.entries(s.headers).map(([k, v]) => [k, c.headerValue(k, v)])
      )
    return { server, c }
  }
  return null
}

function convertOpencode(name: string, s: Json): Conv {
  const c = new Converter(name)
  if (s.type === 'local') {
    const cmd = Array.isArray(s.command) ? s.command.map(String) : []
    if (!cmd.length) return null
    const server: McpServer = { transport: 'stdio', command: cmd[0] }
    server.args = c.args(cmd.slice(1))
    if (isObj(s.environment) && Object.keys(s.environment).length)
      server.env = Object.fromEntries(
        Object.entries(s.environment).map(([k, v]) => [k, c.envValue(k, fromOpencodeRef(v))])
      )
    if (typeof s.timeout === 'number') server.timeoutMs = s.timeout
    if (s.enabled === false) c.warnings.push('was disabled in opencode (enabled=false)')
    return { server, c }
  }
  if (s.type === 'remote') {
    const server: McpServer = { transport: 'http', url: c.url(s.url) }
    if (isObj(s.headers) && Object.keys(s.headers).length)
      server.headers = Object.fromEntries(
        Object.entries(s.headers).map(([k, v]) => [k, c.headerValue(k, fromOpencodeRef(v))])
      )
    if (s.enabled === false) c.warnings.push('was disabled in opencode (enabled=false)')
    return { server, c }
  }
  return null
}

/** Gemini `$VAR` → `${VAR}` (Gemini expands both in settings.json strings) */
function fromGeminiRef(v: unknown): unknown {
  return typeof v === 'string'
    ? v.replace(/\$([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_{])/g, '${$1}')
    : v
}

/**
 * Gemini CLI mcpServers entry. httpUrl = streamable HTTP, url = SSE (moved to http with a warning).
 * trust, cwd and tool filters have no library equivalent and are dropped with a warning
 */
function convertGemini(name: string, s: Json): Conv {
  const c = new Converter(name)
  let server: McpServer
  if (typeof s.command === 'string') {
    server = { transport: 'stdio', command: s.command, args: c.args(s.args) }
    if (isObj(s.env) && Object.keys(s.env).length)
      server.env = Object.fromEntries(
        Object.entries(s.env).map(([k, v]) => [k, c.envValue(k, fromGeminiRef(v))])
      )
  } else if (typeof s.httpUrl === 'string' || typeof s.url === 'string') {
    if (typeof s.httpUrl !== 'string')
      c.warnings.push(
        'moved sse transport (url) to http — check that the server supports streamable http'
      )
    server = { transport: 'http', url: c.url(s.httpUrl ?? s.url) }
    if (isObj(s.headers) && Object.keys(s.headers).length)
      server.headers = Object.fromEntries(
        Object.entries(s.headers).map(([k, v]) => [k, c.headerValue(k, fromGeminiRef(v))])
      )
  } else return null
  if (typeof s.timeout === 'number') server.timeoutMs = s.timeout
  for (const k of ['trust', 'cwd', 'includeTools', 'excludeTools', 'authProviderType', 'oauth'])
    if (s[k] !== undefined) c.warnings.push(`dropped ${k} (no library equivalent)`)
  return { server, c }
}

/**
 * Copilot mcp-config.json entry. type local/stdio → stdio, http/sse → http (sse warned). Copilot-only keys (tool filters, OAuth,
 * timeouts) have no library equivalent and are dropped with a warning — sync keeps them on the same-name entry
 */
function convertCopilot(name: string, s: Json): Conv {
  const c = new Converter(name)
  let server: McpServer
  const type = s.type ?? (typeof s.command === 'string' ? 'stdio' : 'http')
  if ((type === 'stdio' || type === 'local') && typeof s.command === 'string') {
    server = { transport: 'stdio', command: s.command, args: c.args(s.args) }
    if (isObj(s.env) && Object.keys(s.env).length)
      server.env = Object.fromEntries(
        Object.entries(s.env).map(([k, v]) => [k, c.envValue(k, fromGeminiRef(v))])
      )
  } else if ((type === 'http' || type === 'sse') && typeof s.url === 'string') {
    if (type === 'sse')
      c.warnings.push(
        'moved sse transport to http — check that the server supports streamable http'
      )
    server = { transport: 'http', url: c.url(s.url) }
    if (isObj(s.headers) && Object.keys(s.headers).length)
      server.headers = Object.fromEntries(
        Object.entries(s.headers).map(([k, v]) => [k, c.headerValue(k, fromGeminiRef(v))])
      )
  } else return null
  for (const k of [
    'cwd',
    'tools',
    'deferTools',
    'oauthClientId',
    'oauthClientSecret',
    'auth',
    'timeout',
    'taskSupport',
    'slowConnectionThresholdMs'
  ])
    if (s[k] !== undefined) c.warnings.push(`dropped ${k} (no library equivalent)`)
  return { server, c }
}

/** Gemini settings.json (comments allowed, as Gemini reads it) → object. null if unreadable */
function readGeminiSettings(path: string): Json | null {
  try {
    const v = JSON.parse(stripJsonComments(readFileSync(path, 'utf8'))) as unknown
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

function convertCodex(name: string, s: Json): Conv {
  const c = new Converter(name)
  let server: McpServer
  if (typeof s.command === 'string') {
    server = { transport: 'stdio', command: s.command, args: c.args(s.args) }
    // Codex stdio env values are literals → all are substitution candidates
    if (isObj(s.env) && Object.keys(s.env).length)
      server.env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, c.envValue(k, v)]))
    if (typeof s.startup_timeout_sec === 'number') server.timeoutMs = s.startup_timeout_sec * 1000
  } else if (typeof s.url === 'string') {
    server = { transport: 'http', url: c.url(s.url) }
    if (typeof s.bearer_token_env_var === 'string') server.bearerEnv = s.bearer_token_env_var
    const headers: Record<string, string> = {}
    if (isObj(s.env_http_headers))
      for (const [k, v] of Object.entries(s.env_http_headers)) headers[k] = `\${${String(v)}}`
    if (isObj(s.http_headers))
      for (const [k, v] of Object.entries(s.http_headers)) headers[k] = c.headerValue(k, v)
    if (Object.keys(headers).length) server.headers = headers
  } else return null
  const cx: McpCodexOptions = {}
  if (typeof s.default_tools_approval_mode === 'string')
    cx.defaultToolsApprovalMode = s.default_tools_approval_mode
  if (Array.isArray(s.enabled_tools)) cx.enabledTools = s.enabled_tools.map(String)
  if (Array.isArray(s.disabled_tools)) {
    const denied: Record<string, McpDecision> = Object.create(null)
    for (const tool of s.disabled_tools) {
      if (typeof tool === 'string' && MCP_TOOL_NAME_RE.test(tool)) denied[tool] = 'deny'
      else c.warnings.push('dropped an invalid disabled_tools entry (no library equivalent)')
    }
    if (Object.keys(denied).length) server.permissions = { tools: denied }
  }
  if (isObj(s.tools)) {
    const ta: Record<string, string> = Object.create(null)
    for (const [t, o] of Object.entries(s.tools))
      if (isObj(o) && typeof o.approval_mode === 'string') ta[t] = o.approval_mode
    if (Object.keys(ta).length) cx.toolApprovals = ta
  }
  if (Object.keys(cx).length) server.codex = cx
  if (s.enabled === false) c.warnings.push('was disabled in codex (enabled=false)')
  const supported = new Set([
    'command',
    'args',
    'env',
    'startup_timeout_sec',
    'url',
    'bearer_token_env_var',
    'env_http_headers',
    'http_headers',
    'default_tools_approval_mode',
    'enabled_tools',
    'disabled_tools',
    'tools',
    'enabled'
  ])
  for (const key of Object.keys(s))
    if (!supported.has(key)) c.warnings.push(`dropped ${key} (no library equivalent)`)
  return { server, c }
}

const TOML_ALL_MARKERS = [TOML_MCP_MARKERS, ...LEGACY_TOML_MCP_MARKERS]

/** Grok CLI config.toml [mcp_servers.<name>]: command/args/env or url/headers (Grok expands ${VAR} itself) */
function convertGrok(name: string, s: Json): Conv {
  const c = new Converter(name)
  let server: McpServer
  if (typeof s.command === 'string') {
    server = { transport: 'stdio', command: s.command, args: c.args(s.args) }
    if (isObj(s.env) && Object.keys(s.env).length)
      server.env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, c.envValue(k, v)]))
    if (typeof s.startup_timeout_sec === 'number') server.timeoutMs = s.startup_timeout_sec * 1000
  } else if (typeof s.url === 'string') {
    server = { transport: 'http', url: c.url(s.url) }
    if (isObj(s.headers) && Object.keys(s.headers).length)
      server.headers = Object.fromEntries(
        Object.entries(s.headers).map(([k, v]) => [k, c.headerValue(k, v)])
      )
  } else return null
  if (s.enabled === false) c.warnings.push('was disabled in grok (enabled=false)')
  return { server, c }
}

/** Previous library (mcp.json) definitions: already library format — only literal values become substitution candidates (copied as is by default) */
function convertLibraryFormat(name: string, s: Json): Conv {
  const c = new Converter(name)
  const server = structuredClone(s) as McpServer
  if (isObj(s.env))
    server.env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, c.envValue(k, v)]))
  if (isObj(s.headers))
    server.headers = Object.fromEntries(
      Object.entries(s.headers).map(([k, v]) => [k, c.headerValue(k, v)])
    )
  if (Array.isArray(s.args)) server.args = c.args(s.args)
  if (typeof s.url === 'string') server.url = c.url(s.url)
  return { server, c }
}

/** Core fields for comparison (excluding env values, codex options, meta). bearerEnv is treated as the Authorization header */
function core(s: McpServer): string {
  const headers = new Set(Object.keys(s.headers ?? {}))
  if (s.bearerEnv) headers.add('Authorization')
  return JSON.stringify({
    transport: s.transport,
    command: s.command ?? null,
    args: s.args ?? [],
    url: s.url ?? null,
    env: Object.keys(s.env ?? {}).sort(),
    headers: [...headers].sort()
  })
}

/** Move an Authorization: `Bearer ${VAR}` header to bearerEnv (tool-source conversion only) */
function liftBearer(server: McpServer): void {
  const h = server.headers
  if (!h) return
  const key = Object.keys(h).find((k) => k.toLowerCase() === 'authorization')
  const m = key ? /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(h[key]) : null
  if (!key || !m) return
  server.bearerEnv = m[1]
  delete h[key]
  if (!Object.keys(h).length) delete server.headers
}

/**
 * In the template (all ${KEY}), slots not in replace are restored to raw values.
 * An unsubstituted Authorization also reverts the bearerEnv promotion.
 */
/**
 * Server definition with slots filled. Slots in replace stay as ${KEY}.
 * In secretsMode, headers·env slots get raw values regardless of substitution — upsert moves them to the secret backend and keeps only references.
 */
function materialize(
  v: McpVariantInternal,
  replace: Set<string>,
  secretsMode = false
): { server: McpServer; replaced: string[] } {
  const server = structuredClone(v.server)
  const replaced: string[] = []
  let url: URL | null = null
  for (const s of v.slots) {
    const table = s.at.startsWith('env.') || s.at.startsWith('headers.')
    if (replace.has(s.key)) {
      replaced.push(s.key)
      if (!(secretsMode && table)) continue
    }
    if (s.at.startsWith('env.')) {
      server.env = { ...(server.env ?? {}), [s.at.slice(4)]: s.raw }
    } else if (s.at.startsWith('headers.')) {
      const h = s.at.slice(8)
      const value = `${s.prefix ?? ''}${s.raw}`
      if (h.toLowerCase() === 'authorization' && server.bearerEnv === s.key) delete server.bearerEnv
      server.headers = { ...(server.headers ?? {}), [h]: value }
    } else if (s.at.startsWith('args[')) {
      const i = Number(s.at.slice(5, -1))
      if (server.args && i < server.args.length) server.args[i] = s.raw
    } else if (s.at.startsWith('url?')) {
      try {
        url = url ?? new URL(server.url ?? '')
        url.searchParams.set(s.at.slice(4), s.raw)
      } catch {
        // Leave a broken url as is
      }
    }
  }
  if (url) server.url = decodePlaceholders(url.toString())
  return { server, replaced }
}

// ---------------------------------------------------------------- Permission conversion

/** Command rules gathered from a tool, before they become permissions.json */
interface RuleLists {
  bash: AllowlistEntry[]
  bashAsk: AllowlistEntry[]
  bashDeny: AllowlistEntry[]
}

const emptyRuleLists = (): RuleLists => ({ bash: [], bashAsk: [], bashDeny: [] })
type Decision = 'allow' | 'ask' | 'deny'
const LIST_OF: Record<Decision, 'bash' | 'bashAsk' | 'bashDeny'> = {
  allow: 'bash',
  ask: 'bashAsk',
  deny: 'bashDeny'
}

/** Rules → permissions.json shape (empty optional lists left out) */
function rulesAllowlist(l: RuleLists, claudeOnly: Allowlist['claudeOnly']): Allowlist {
  return {
    bash: l.bash,
    ...(l.bashAsk.length ? { bashAsk: l.bashAsk } : {}),
    ...(l.bashDeny.length ? { bashDeny: l.bashDeny } : {}),
    claudeOnly
  }
}

const hasRules = (a: Allowlist): boolean =>
  !!(
    a.bash.length ||
    a.bashAsk?.length ||
    a.bashDeny?.length ||
    a.claudeOnly.allow.length ||
    a.claudeOnly.deny.length ||
    a.claudeOnly.ask?.length
  )

/**
 * The inside of `Bash(...)`: `git push:*` and `git push *` match commands starting with `git push`; no wildcard = that exact
 * command. Other wildcards can't be expressed as a command rule (null)
 */
function bashPattern(inner: string): AllowlistEntry | null {
  const prefix = inner.endsWith(':*')
    ? inner.slice(0, -2)
    : inner.endsWith(' *')
      ? inner.slice(0, -2)
      : null
  const words = (prefix ?? inner).split(' ').filter(Boolean)
  if (!words.length || words.some((w) => w.includes('*'))) return null
  return prefix !== null ? words : { argv: words, claudeExact: true }
}

function parseClaudePermissions(perms: Json): { allowlist: Allowlist; warnings: string[] } {
  const warnings: string[] = []
  const lists = emptyRuleLists()
  const only: Record<Decision, string[]> = { allow: [], ask: [], deny: [] }
  const list = (k: string): string[] =>
    Array.isArray(perms[k])
      ? (perms[k] as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
  for (const d of ['allow', 'deny', 'ask'] as const)
    for (const e of list(d)) {
      const bash = /^Bash\((.+)\)$/.exec(e)
      const entry = bash ? bashPattern(bash[1]) : null
      if (entry) {
        lists[LIST_OF[d]].push(entry)
        continue
      }
      only[d].push(e)
    }
  if (list('ask').some((x) => x.startsWith('mcp__')))
    warnings.push(
      'mcp__ entries in ask can also be generated from server definitions (codex.toolApprovals) — Illithid writes each one once'
    )
  const allowlist = rulesAllowlist(lists, {
    allow: only.allow,
    deny: only.deny,
    ...(only.ask.length ? { ask: only.ask } : {})
  })
  return { allowlist, warnings }
}

/** prefix_rule(...) lines outside default.rules markers → rules (allow, prompt = ask, forbidden = deny) */
function parseCodexRules(text: string): RuleLists {
  const out = emptyRuleLists()
  const decision: Record<string, Decision> = { allow: 'allow', prompt: 'ask', forbidden: 'deny' }
  for (const line of text.split('\n')) {
    const m = /^\s*prefix_rule\(pattern=\[(.*)\],\s*decision="(allow|prompt|forbidden)"\)\s*$/.exec(
      line
    )
    if (!m) continue
    try {
      const argv = JSON.parse(`[${m[1]}]`) as unknown
      if (Array.isArray(argv) && argv.length && argv.every((a) => typeof a === 'string'))
        out[LIST_OF[decision[m[2]]]].push(argv)
    } catch {
      // Skip lines that can't be parsed
    }
  }
  return out
}

/** ~/.gemini/policies/*.toml (except the file Illithid writes) → command rules. Regex, argument and other-tool rules can't be carried over */
function parseGeminiPolicies(dir: string, notes: string[]): { lists: RuleLists; files: string[] } {
  const lists = emptyRuleLists()
  const files: string[] = []
  const decision: Record<string, Decision> = { allow: 'allow', ask_user: 'ask', deny: 'deny' }
  let skipped = 0
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f)
    if (!f.endsWith('.toml') || f === 'illithid.toml' || !lstatSync(p).isFile()) continue
    let doc: Json
    try {
      doc = parseToml(readFileSync(p, 'utf8')) as Json
    } catch {
      notes.push(`${f}: policy file parse failed`)
      continue
    }
    files.push(p)
    for (const r of Array.isArray(doc.rule) ? doc.rule : []) {
      const d = isObj(r) && typeof r.decision === 'string' ? decision[r.decision] : undefined
      if (!isObj(r) || !d) {
        skipped++
        continue
      }
      if (r.toolName === 'run_shell_command' && typeof r.commandPrefix === 'string') {
        const argv = r.commandPrefix.split(/\s+/).filter(Boolean)
        if (argv.length) lists[LIST_OF[d]].push(argv)
        else skipped++
      } else skipped++
    }
  }
  if (skipped)
    notes.push(
      `Gemini CLI policies: ${skipped} rules can't be carried over (regex, arguments or other tools)`
    )
  return { lists, files }
}

/** ~/.grok/config.toml [permission] (deny/ask/allow strings and bash rules) → command rules */
function parseGrokPermission(perm: Json, notes: string[]): RuleLists {
  const lists = emptyRuleLists()
  let skipped = 0
  const add = (d: Decision, e: string): void => {
    const bash = /^Bash\((.+)\)$/.exec(e)
    const entry = bash ? bashPattern(bash[1]) : null
    if (entry) lists[LIST_OF[d]].push(entry)
    else skipped++
  }
  for (const d of ['allow', 'ask', 'deny'] as const)
    for (const e of Array.isArray(perm[d]) ? perm[d] : []) if (typeof e === 'string') add(d, e)
  for (const r of Array.isArray(perm.rules) ? perm.rules : []) {
    if (!isObj(r) || !['allow', 'ask', 'deny'].includes(String(r.action))) {
      skipped++
      continue
    }
    const d = r.action as Decision
    if (r.tool === 'bash' && typeof r.pattern === 'string') add(d, `Bash(${r.pattern})`)
    else skipped++
  }
  if (skipped)
    notes.push(
      `Grok CLI [permission]: ${skipped} rules can't be carried over (other tools or patterns)`
    )
  return lists
}

function permissionsVariant(
  allowlist: Allowlist,
  ref: ImportSourceRef,
  warnings: string[]
): PermissionsVariant {
  return {
    id: short(sha256(JSON.stringify(allowlist))),
    allowlist,
    counts: {
      bash: allowlist.bash.length,
      allow: allowlist.claudeOnly.allow.length,
      deny: allowlist.claudeOnly.deny.length,
      ask: allowlist.claudeOnly.ask?.length ?? 0,
      bashAsk: allowlist.bashAsk?.length ?? 0,
      bashDeny: allowlist.bashDeny?.length ?? 0
    },
    sources: [ref],
    warnings,
    ...OK
  }
}

// ---------------------------------------------------------------- Per-source scan

const MD_ALL = [MD_MARKERS, ...LEGACY_MD_MARKERS]
const RULES_ALL = [RULES_MARKERS, ...LEGACY_RULES_MARKERS]

function scanLegacy(found: Found, home: string, src: ImportSource): void {
  const root = src.path
  const ref = (path: string): ImportSourceRef => ({
    origin: 'legacy',
    sourceId: src.id,
    label: 'legacy',
    path
  })
  const rulesDir = join(root, 'rules')
  if (isDir(rulesDir))
    for (const f of readdirSync(rulesDir).sort())
      if (f.endsWith('.md') && !f.startsWith('.') && statSync(join(rulesDir, f)).isFile())
        addFile(
          found.rules,
          f,
          join(rulesDir, f),
          ref(join(rulesDir, f)),
          rulePortability(found.ctx, f, join(rulesDir, f))
        )
  const memDir = join(root, 'memory')
  if (isDir(memDir)) {
    const walk = (d: string, r: string): void => {
      for (const n of readdirSync(d).sort()) {
        if (n.startsWith('.')) continue
        const p = join(d, n)
        const rp = r ? `${r}/${n}` : n
        const st = lstatSync(p)
        if (st.isDirectory()) walk(p, rp)
        else if (st.isFile() && n.endsWith('.md'))
          addFile(found.memory, rp, p, ref(p), memoryPortability(found.ctx, p))
      }
    }
    walk(memDir, '')
  }
  const allowPath = join(root, 'sync/allowlist.json')
  if (existsSync(allowPath)) {
    const o = readJsonSafe(allowPath)
    if (!o) found.notes.push(`${tilde(home, allowPath)} parse failed`)
    else {
      const { _, _scope, _exact, ...rest } = o as Json & {
        _?: unknown
        _scope?: unknown
        _exact?: unknown
      }
      void _
      void _scope
      void _exact
      const cleaned = rest as unknown as Allowlist
      if (isObj(cleaned.claudeOnly)) {
        const { _: c_, ...co } = cleaned.claudeOnly as Json & { _?: unknown }
        void c_
        cleaned.claudeOnly = co as Allowlist['claudeOnly']
      }
      found.permissions.push(
        permissionsVariant(cleaned, ref(allowPath), [
          '`_` meta keys in allowlist.json are not carried over'
        ])
      )
    }
  }
  const mcpPath = join(root, 'sync/mcp.json')
  if (existsSync(mcpPath)) {
    const o = readJsonSafe(mcpPath)
    if (!o || !isObj(o.servers))
      found.notes.push(`${tilde(home, mcpPath)} parse failed or has no servers`)
    else {
      const meta = Object.keys(o).filter((k) => k.startsWith('_')).length
      if (meta)
        found.notes.push(`${meta} top-level meta keys (_ …) in mcp.json are not carried over`)
      for (const [n, s] of mcpEntries(o as unknown as McpSource)) {
        const r = convertLibraryFormat(n, s as unknown as Json)
        if (!r) continue
        const list = found.mcp.get(n) ?? []
        list.push({
          ref: ref(mcpPath),
          server: r.server,
          slots: r.c.slots,
          warnings: r.c.warnings,
          info: mcpPortability(found.ctx, n, r.server, undefined, r.c.slots)
        })
        found.mcp.set(n, list)
      }
    }
  }
  scanSkillDir(found, home, join(root, 'skills'), {
    origin: 'legacy',
    sourceId: src.id,
    label: 'legacy'
  })
}

function scanTool(found: Found, home: string, src: ImportSource): void {
  const tool = src.id.slice('tool:'.length) as ToolId
  scanAgentsOfTool(found, home, tool, src.id)
  const ref = (path: string): ImportSourceRef => ({
    origin: 'tool',
    sourceId: src.id,
    label: tool,
    path
  })
  const lib = libraryRoot(home)
  const legacy = join(home, LEGACY_LIBRARY_DIR)
  const addMcp = (name: string, r: Conv, path: string): void => {
    if (!r || name.startsWith('_')) return
    liftBearer(r.server)
    const list = found.mcp.get(name) ?? []
    list.push({
      tool,
      ref: ref(path),
      server: r.server,
      slots: r.c.slots,
      warnings: r.c.warnings,
      info: mcpPortability(found.ctx, name, r.server, tool, r.c.slots)
    })
    found.mcp.set(name, list)
  }

  switch (tool) {
    case 'claude': {
      const rulesDir = join(home, '.claude/rules')
      if (isDir(rulesDir))
        for (const f of readdirSync(rulesDir).sort()) {
          const p = join(rulesDir, f)
          if (f.endsWith('.md') && !f.startsWith('.') && lstatSync(p).isFile())
            addFile(found.rules, f, p, ref(p), rulePortability(found.ctx, f, p))
        }
      const sp = join(home, '.claude/settings.json')
      if (existsSync(sp)) {
        const o = readJsonSafe(sp)
        if (!o) found.notes.push(`${tilde(home, sp)} parse failed`)
        else if (isObj(o.permissions)) {
          const { allowlist, warnings } = parseClaudePermissions(o.permissions)
          if (hasRules(allowlist))
            found.permissions.push(permissionsVariant(allowlist, ref(sp), warnings))
        }
      }
      const cp = join(home, '.claude.json')
      if (existsSync(cp)) {
        const o = readJsonSafe(cp)
        if (!o) found.notes.push('~/.claude.json parse failed')
        else if (isObj(o.mcpServers))
          for (const [n, s] of Object.entries(o.mcpServers))
            if (isObj(s)) addMcp(n, convertClaude(n, s), cp)
      }
      scanSkillDir(found, home, join(home, '.claude/skills'), {
        origin: 'tool',
        sourceId: src.id,
        label: tool
      })
      break
    }
    case 'codex': {
      const ap = join(home, '.codex/AGENTS.md')
      if (existsSync(ap)) {
        const outside = outsideBlockMulti(readFileSync(ap, 'utf8'), MD_ALL).trim()
        if (outside) {
          const name = 'codex-agents.md'
          const id = short(sha256(outside))
          const byId = found.rules.get(name) ?? new Map<string, FileVariant>()
          byId.set(id, {
            id,
            path: ap,
            bytes: Buffer.byteLength(outside),
            sources: [ref(ap)],
            ...rulePortability(found.ctx, name, ap)
          })
          found.rules.set(name, byId)
          found.notes.push(
            'codex-agents.md is the text outside the markers in ~/.codex/AGENTS.md (may be Codex-only text)'
          )
        }
      }
      const rp = join(home, '.codex/rules/default.rules')
      if (existsSync(rp)) {
        const lists = parseCodexRules(outsideBlockMulti(readFileSync(rp, 'utf8'), RULES_ALL))
        const allowlist = rulesAllowlist(lists, { allow: [], deny: [] })
        if (hasRules(allowlist))
          found.permissions.push(
            permissionsVariant(allowlist, ref(rp), [
              'only prefix_rule lines outside default.rules markers — no Claude-only entries'
            ])
          )
      }
      const tp = join(home, '.codex/config.toml')
      if (existsSync(tp)) {
        try {
          const o = parseToml(readFileSync(tp, 'utf8')) as Json
          if (isObj(o.mcp_servers))
            for (const [n, s] of Object.entries(o.mcp_servers))
              if (isObj(s)) addMcp(n, convertCodex(n, s), tp)
        } catch {
          found.notes.push('~/.codex/config.toml parse failed')
        }
      }
      scanSkillDir(found, home, join(home, '.codex/skills'), {
        origin: 'tool',
        sourceId: src.id,
        label: tool
      })
      break
    }
    case 'opencode': {
      const op = opencodeConfigPath(home)
      if (existsSync(op)) {
        const o = readOpencodeSettings(op)
        if (!o) found.notes.push(`~/.config/opencode/${basename(op)} parse failed`)
        else {
          if (isObj(o.mcp))
            for (const [n, s] of Object.entries(o.mcp))
              if (isObj(s)) addMcp(n, convertOpencode(n, s), op)
          if (Array.isArray(o.instructions)) {
            let globs = 0
            for (const x of o.instructions) {
              if (typeof x !== 'string') continue
              const abs = x.startsWith('~/') ? join(home, x.slice(2)) : x
              if (abs.includes('*')) {
                globs++
                continue
              }
              if (
                !isAbsolute(abs) ||
                !abs.endsWith('.md') ||
                !existsSync(abs) ||
                !statSync(abs).isFile()
              )
                continue
              if (within(lib, abs) || within(legacy, abs)) continue
              const n = abs.split('/').pop()!
              addFile(found.rules, n, abs, ref(abs), rulePortability(found.ctx, n, abs))
            }
            if (globs)
              found.notes.push(
                `${globs} glob entries in opencode instructions are not turned into candidates`
              )
          }
        }
      }
      scanSkillDir(found, home, join(home, '.config/opencode/skill'), {
        origin: 'tool',
        sourceId: src.id,
        label: tool
      })
      scanSkillDir(found, home, join(home, '.config/opencode/skills'), {
        origin: 'tool',
        sourceId: src.id,
        label: tool
      })
      break
    }
    case 'gemini': {
      const gp = join(home, '.gemini/GEMINI.md')
      if (existsSync(gp)) {
        const outside = outsideBlockMulti(readFileSync(gp, 'utf8'), MD_ALL).trim()
        if (outside) {
          const id = short(sha256(outside))
          const byId = found.rules.get(GEMINI_MD_RULE) ?? new Map<string, FileVariant>()
          byId.set(id, {
            id,
            path: gp,
            bytes: Buffer.byteLength(outside),
            sources: [ref(gp)],
            ...rulePortability(found.ctx, GEMINI_MD_RULE, gp)
          })
          found.rules.set(GEMINI_MD_RULE, byId)
          found.notes.push(
            `${GEMINI_MD_RULE} is the text outside the markers in ~/.gemini/GEMINI.md (may include Gemini memory-tool notes) — copied, the original stays`
          )
        }
      }
      const pd = join(home, '.gemini/policies')
      if (isDir(pd)) {
        const { lists, files } = parseGeminiPolicies(pd, found.notes)
        const allowlist = rulesAllowlist(lists, { allow: [], deny: [] })
        if (hasRules(allowlist) && files.length)
          found.permissions.push(
            permissionsVariant(allowlist, ref(files[0]), [
              'Gemini CLI policy priorities are not kept — Illithid orders block, ask, allow'
            ])
          )
      }
      const sp = join(home, '.gemini/settings.json')
      if (existsSync(sp)) {
        const o = readGeminiSettings(sp)
        if (!o) found.notes.push('~/.gemini/settings.json parse failed')
        else if (isObj(o.mcpServers))
          for (const [n, s] of Object.entries(o.mcpServers))
            if (isObj(s)) addMcp(n, convertGemini(n, s), sp)
      }
      scanSkillDir(found, home, join(home, '.gemini/skills'), {
        origin: 'tool',
        sourceId: src.id,
        label: tool
      })
      break
    }
    case 'copilot': {
      // instructions/**/*.instructions.md outside the app folder → rules (<name>.md); an applyTo other than all files is scoped
      const ir = join(home, '.copilot/instructions')
      const walk = (d: string): void => {
        let names: string[]
        try {
          names = readdirSync(d).sort()
        } catch {
          return
        }
        for (const n of names) {
          const p = join(d, n)
          if (n.startsWith('.') || p === join(ir, 'illithid')) continue
          const st = lstatSync(p)
          if (st.isDirectory()) walk(p)
          else if (st.isFile() && n.endsWith('.instructions.md')) {
            const name = n.slice(0, -'.instructions.md'.length) + '.md'
            let scoped = false
            try {
              const at = (matter(readFileSync(p, 'utf8'), AGENT_MATTER).data as Json).applyTo
              scoped =
                at !== undefined && !(typeof at === 'string' && ['**', '**/*'].includes(at.trim()))
            } catch {
              scoped = true
            }
            const info = rulePortability(found.ctx, name, p)
            addFile(
              found.rules,
              name,
              p,
              ref(p),
              scoped ? judge([...info.reasons, 'projectScoped']) : info
            )
          }
        }
      }
      walk(ir)
      const cp = join(home, '.copilot/copilot-instructions.md')
      if (existsSync(cp) && lstatSync(cp).isFile()) {
        addFile(
          found.rules,
          COPILOT_MD_RULE,
          cp,
          ref(cp),
          rulePortability(found.ctx, COPILOT_MD_RULE, cp)
        )
        found.notes.push(
          `${COPILOT_MD_RULE} is ~/.copilot/copilot-instructions.md — copied, the original stays`
        )
      }
      const mp = join(home, '.copilot/mcp-config.json')
      if (existsSync(mp)) {
        const o = readGeminiSettings(mp)
        if (!o) found.notes.push('~/.copilot/mcp-config.json parse failed')
        else if (isObj(o.mcpServers))
          for (const [n, s] of Object.entries(o.mcpServers))
            if (isObj(s)) addMcp(n, convertCopilot(n, s), mp)
      }
      scanSkillDir(found, home, join(home, '.copilot/skills'), {
        origin: 'tool',
        sourceId: src.id,
        label: tool
      })
      break
    }
    case 'grok': {
      // ~/.grok/rules/*.md except the copies the app wrote there (tracked in state.toolRules.grok)
      const rd = join(home, '.grok/rules')
      const owned = readState(home).state.toolRules?.grok ?? {}
      if (isDir(rd))
        for (const f of readdirSync(rd).sort()) {
          const p = join(rd, f)
          if (
            f.endsWith('.md') &&
            !f.startsWith('.') &&
            !owned[f] &&
            f !== GROK_MEMORY_RULE_FILE &&
            lstatSync(p).isFile()
          )
            addFile(found.rules, f, p, ref(p), rulePortability(found.ctx, f, p))
        }
      const tp = join(home, '.grok/config.toml')
      if (existsSync(tp)) {
        try {
          const o = parseToml(outsideBlockMulti(readFileSync(tp, 'utf8'), TOML_ALL_MARKERS)) as Json
          if (isObj(o.mcp_servers))
            for (const [n, s] of Object.entries(o.mcp_servers))
              if (isObj(s)) addMcp(n, convertGrok(n, s), tp)
          if (isObj(o.permission)) {
            const allowlist = rulesAllowlist(parseGrokPermission(o.permission, found.notes), {
              allow: [],
              deny: []
            })
            if (hasRules(allowlist))
              found.permissions.push(permissionsVariant(allowlist, ref(tp), []))
          }
        } catch {
          found.notes.push('~/.grok/config.toml parse failed')
        }
      }
      scanSkillDir(found, home, join(home, '.grok/skills'), {
        origin: 'tool',
        sourceId: src.id,
        label: tool
      })
      break
    }
    default: {
      const never: never = tool
      throw new Error(`unknown tool ${String(never)}`)
    }
  }
}

function scanManager(found: Found, home: string, src: ImportSource): void {
  const id = src.id.slice('manager:'.length)
  scanSkillDir(found, home, src.path, {
    origin: 'otherApp',
    sourceId: src.id,
    label: `otherApp:${id}`
  })
}

// ---------------------------------------------------------------- Candidate assembly

interface InternalPlan extends Omit<ImportPlan, 'mcp'> {
  mcp: (Omit<McpImportCandidate, 'variants'> & { variants: McpVariantInternal[] })[]
}

function fileCandidates<K extends 'rule' | 'memory'>(
  kind: K,
  map: Map<string, Map<string, FileVariant>>,
  libHash: (name: string) => string | null,
  nameOk: (name: string) => boolean
): (K extends 'rule' ? RuleImportCandidate : MemoryImportCandidate)[] {
  const out: (RuleImportCandidate | MemoryImportCandidate)[] = []
  for (const name of [...map.keys()].sort()) {
    let variants = [...map.get(name)!.values()]
    const conflicts: ImportConflict[] = []
    if (!nameOk(name)) conflicts.push('invalidName')
    const lh = libHash(name)
    if (lh !== null) {
      variants = variants.filter((v) => v.id !== lh)
      if (!variants.length) continue
      conflicts.push('existsInLibrary')
    }
    if (variants.length > 1) conflicts.push('sourcesDiffer')
    out.push({
      kind,
      name,
      status: conflicts.length ? 'conflict' : 'new',
      conflicts,
      variants,
      ...aggregate(variants)
    } as RuleImportCandidate | MemoryImportCandidate)
  }
  return out as (K extends 'rule' ? RuleImportCandidate : MemoryImportCandidate)[]
}

const MEMORY_REL_OK = (rel: string): boolean =>
  rel.endsWith('.md') && rel.split('/').every((x) => x && !x.startsWith('.') && x !== '..')

function scan(home: string, sources: ImportSource[]): InternalPlan {
  const found = newFound({ home, codexPlugins: codexPluginNames(home) })
  for (const s of sources) {
    if (!s.available) {
      found.notes.push(`${s.id}: unavailable${s.note ? ` (${s.note})` : ''}`)
      continue
    }
    if (s.kind === 'legacyLibrary') scanLegacy(found, home, s)
    else if (s.kind === 'tool') scanTool(found, home, s)
    else scanManager(found, home, s)
  }
  const paths = libraryPaths(home)
  const fileHash = (p: string): string | null => {
    try {
      return short(createHash('sha256').update(readFileSync(p)).digest('hex'))
    } catch {
      return null
    }
  }

  // Rules·memory
  const rules = fileCandidates(
    'rule',
    found.rules,
    (n) => (existsSync(join(paths.rulesDir, n)) ? fileHash(join(paths.rulesDir, n)) : null),
    (n) => NAME_RE.test(n) && n.endsWith('.md')
  )
  const memory = fileCandidates(
    'memory',
    found.memory,
    (rel) => (existsSync(join(paths.memoryDir, rel)) ? fileHash(join(paths.memoryDir, rel)) : null),
    MEMORY_REL_OK
  )

  // Permissions (one candidate, multiple variants)
  const permissions: PermissionsImportCandidate[] = []
  if (found.permissions.length) {
    let cur: Allowlist | null = null
    let libBroken = false
    try {
      cur = readPermissions(home)
    } catch (e) {
      if (e instanceof LibraryError && e.code === 'libraryMissing') cur = null
      else {
        libBroken = true
        found.notes.push(
          'could not read library permissions.json — building candidates without comparison'
        )
      }
    }
    const byId = new Map<string, PermissionsVariant>()
    for (const v of found.permissions) {
      const e = byId.get(v.id)
      if (e) e.sources.push(...v.sources)
      else byId.set(v.id, v)
    }
    let variants = [...byId.values()]
    const conflicts: ImportConflict[] = []
    if (cur && !libBroken) {
      const curId = short(sha256(JSON.stringify(cur)))
      variants = variants.filter((v) => v.id !== curId)
      if (variants.length) conflicts.push('existsInLibrary')
    }
    if (variants.length > 1) conflicts.push('sourcesDiffer')
    if (variants.length)
      permissions.push({
        kind: 'permissions',
        name: 'permissions',
        status: conflicts.length ? 'conflict' : 'new',
        conflicts,
        variants,
        ...aggregate(variants)
      })
  }

  // Skills
  const libNames = new Set(canonicalSkills(home))
  const skills: SkillImportCandidate[] = []
  for (const name of [...found.skills.keys()].sort()) {
    let variants = [...found.skills.get(name)!.values()]
    const conflicts: ImportConflict[] = []
    if (!NAME_RE.test(name)) conflicts.push('invalidName')
    if (libNames.has(name)) {
      let libHash: string | null = null
      try {
        libHash = dirContentHash(join(paths.skillsDir, name))
      } catch {
        libHash = null
      }
      variants = variants.filter((v) => v.id !== libHash)
      if (!variants.length) continue
      conflicts.push('existsInLibrary')
    }
    if (variants.length > 1) conflicts.push('sourcesDiffer')
    skills.push({
      kind: 'skill',
      name,
      status: conflicts.length ? 'conflict' : 'new',
      conflicts,
      variants,
      ...aggregate(variants)
    })
  }

  // MCP
  let libServers = new Map<string, McpServer>()
  try {
    libServers = new Map(mcpEntries(readMcp(home)))
  } catch {
    found.notes.push('could not read library mcps/ — building candidates without comparison')
  }
  const mcp: InternalPlan['mcp'] = []
  for (const name of [...found.mcp.keys()].sort()) {
    const byCore = new Map<string, McpVariantInternal>()
    for (const f of found.mcp.get(name)!) {
      const k = core(f.server)
      const v = byCore.get(k)
      if (v) {
        if (f.tool && !v.tools.includes(f.tool)) v.tools.push(f.tool)
        if (!v.sources.some((s) => s.path === f.ref.path)) v.sources.push(f.ref)
        // codex options come only from the codex side — merge them
        if (f.server.codex && !v.server.codex) v.server.codex = f.server.codex
        mergeInto(v, f.info)
        continue
      }
      byCore.set(k, {
        id: short(sha256(k)),
        tools: f.tool ? [f.tool] : [],
        server: f.server,
        replaced: f.slots.map((s) => ({ at: s.at, placeholder: `\${${s.key}}` })),
        replaceable: f.slots.map((s) => ({ key: s.key, at: s.at, looksSecret: s.looksSecret })),
        warnings: f.warnings,
        sources: [f.ref],
        slots: f.slots,
        ...structuredClone(f.info)
      })
    }
    let variants = [...byCore.values()]
    const conflicts: ImportConflict[] = []
    if (!NAME_RE.test(name)) conflicts.push('invalidName')
    const existing = libServers.get(name)
    if (existing) {
      variants = variants.filter((v) => core(v.server) !== core(existing))
      if (!variants.length) continue // same as the library
      conflicts.push('existsInLibrary')
    }
    if (variants.length > 1) conflicts.push('sourcesDiffer')
    mcp.push({
      kind: 'mcp',
      name,
      status: conflicts.length ? 'conflict' : 'new',
      conflicts,
      variants,
      ...aggregate(variants)
    })
  }

  // Agents
  const libAgents = new Set(listAgents(home))
  const agents: AgentImportCandidate[] = []
  for (const name of [...found.agents.keys()].sort()) {
    let variants = [...found.agents.get(name)!.values()]
    const conflicts: ImportConflict[] = []
    if (!NAME_RE.test(name) || variants.some((v) => !v.text)) conflicts.push('invalidName')
    if (libAgents.has(name)) {
      const lib = agentNormalizedText(home, name)
      const libId = lib === null ? null : short(sha256(lib))
      variants = variants.filter((v) => v.id !== libId)
      if (!variants.length) continue
      conflicts.push('existsInLibrary')
    }
    if (variants.length > 1) conflicts.push('sourcesDiffer')
    agents.push({
      kind: 'agent',
      name,
      status: conflicts.length ? 'conflict' : 'new',
      conflicts,
      variants,
      ...aggregate(variants)
    })
  }

  // Hooks a tool runs (read straight from its config; nothing to merge across sources)
  const hooks: HookImportCandidate[] = sources
    .filter((s) => s.kind === 'tool' && s.available && s.kinds.includes('hook'))
    .flatMap((s) =>
      hookImportCandidates(home, s.id.slice('tool:'.length) as ToolId, s.id, found.notes)
    )

  return { sources, rules, memory, permissions, skills, mcp, agents, hooks, notes: found.notes }
}

/** Public plan without raw values (slots) */
function toPublic(p: InternalPlan): ImportPlan {
  return {
    ...p,
    mcp: p.mcp.map((c) => ({
      ...c,
      variants: c.variants.map(({ slots, ...v }) => {
        void slots
        return v
      })
    }))
  }
}

function pickSources(home: string, sourceId?: string): ImportSource[] {
  const all = listImportSources(home)
  if (sourceId === undefined) {
    // Compat: no source given scans all tools and manager apps (previous planImport behavior). Legacy only by explicit choice
    return all.filter((s) => s.kind !== 'legacyLibrary')
  }
  const s = all.find((x) => x.id === sourceId)
  if (!s) throw new LibraryError('notFound', `unknown import source: ${sourceId}`)
  return [s]
}

// ---------------------------------------------------------------- Public API

/**
 * Import candidates. Read-only. sourceId is an id from listImportSources.
 * If omitted (compat), scans all tool and manager-app sources — the new UI picks one source and passes it.
 */
export function planImport(home: string, sourceId?: string): ImportPlan {
  return toPublic(scan(home, pickSources(home, sourceId)))
}

/**
 * Add the selected candidates to the library (atomic). Recomputes the plan and runs only if the selection matches the current candidates.
 * Source-side files are never touched here: tool originals the app copy will replace (Claude rule files, differing skill folders,
 * agent files, OpenCode instructions entries) are recorded in state.json pendingRetire, and the next approved sync backs them up to
 * backups/imported right as it writes the app copy. Nothing changes on the tool side until that sync, so there is no gap and no loss
 * even when automatic apply is off. New items imported from a tool are enabled only for that tool (manifest toggles).
 */
export interface ApplyImportOptions {
  /**
   * Secret backend. If given, MCP headers·env literals (including checked substitutions) are stored in the backend and only `secret:` references go to the library.
   * args and url query slots are not reference targets and are substituted with ${KEY} as before
   */
  secrets?: SecretBackend
}

export function applyImport(
  home: string,
  selections: ImportSelection[],
  sourceId?: string,
  opts: ApplyImportOptions = {}
): ImportResult[] {
  const plan = scan(home, pickSources(home, sourceId))
  const results: ImportResult[] = []
  const paths = libraryPaths(home)
  for (const sel of selections) {
    const base = { kind: sel.kind, name: sel.name }
    const refuse = (reason: string): void => {
      results.push({ ...base, status: 'refused', reason })
    }
    const list: ImportCandidate[] | InternalPlan['mcp'] =
      sel.kind === 'rule'
        ? plan.rules
        : sel.kind === 'memory'
          ? plan.memory
          : sel.kind === 'permissions'
            ? plan.permissions
            : sel.kind === 'skill'
              ? plan.skills
              : sel.kind === 'agent'
                ? plan.agents
                : sel.kind === 'hook'
                  ? plan.hooks
                  : plan.mcp
    const cand = (list as { name: string }[]).find((c) => c.name === sel.name) as
      ImportCandidate | InternalPlan['mcp'][number] | undefined
    if (!cand) {
      refuse('notACandidate')
      continue
    }
    if (cand.conflicts.includes('invalidName')) {
      refuse('invalidName')
      continue
    }
    const variants = cand.variants as (PortabilityInfo & { id: string })[]
    const variant =
      sel.variant !== undefined
        ? variants.find((v) => v.id === sel.variant)
        : variants.length === 1
          ? variants[0]
          : undefined
    if (!variant) {
      refuse(sel.variant !== undefined ? 'unknownVariant' : 'variantRequired')
      continue
    }
    // Tool-only items are refused in the engine (covers UI bypass and CLI)
    if (variant.portability === 'toolOnly') {
      refuse('toolOnly')
      continue
    }
    const exists = cand.conflicts.includes('existsInLibrary')
    if (exists && !sel.overwrite) {
      refuse('existsInLibrary')
      continue
    }
    try {
      if (cand.kind === 'rule') {
        const v = variant as FileVariant
        const content =
          cand.name === 'codex-agents.md' || cand.name === GEMINI_MD_RULE
            ? outsideBlockMulti(readFileSync(v.path, 'utf8'), MD_ALL).trim() + '\n'
            : readFileSync(v.path, 'utf8')
        let trashPath: string | undefined
        if (exists) {
          void readRule(home, cand.name)
          trashPath = trashLibraryPath(home, join(paths.rulesDir, cand.name)).trashPath
        }
        createRule(home, cand.name, content)
        const togglesOk =
          exists ||
          (TOOL_NOTES_RULES.has(cand.name) &&
          v.sources.some(
            (x) => x.origin === 'tool' && (x.label === 'gemini' || x.label === 'copilot')
          )
            ? toolNotesToggles(home, cand.name, v.sources)
            : sourceToggles(home, 'rules', cand.name, v.sources))
        const moved = ruleRetirements(home, cand.name, v)
        recordRetirements(home, moved.pending)
        const warnings = togglesOk ? [] : ['togglesNotSet']
        results.push({
          ...base,
          status: 'imported',
          ...(trashPath ? { trashPath } : {}),
          ...(moved.converted.length ? { converted: moved.converted } : {}),
          ...(warnings.length ? { warnings } : {})
        })
      } else if (cand.kind === 'memory') {
        const v = variant as FileVariant
        let trashPath: string | undefined
        if (exists && listMemoryFiles(home).includes(cand.name)) {
          void readMemoryFile(home, cand.name)
          trashPath = trashLibraryPath(home, join(paths.memoryDir, cand.name)).trashPath
        }
        writeMemoryFile(home, cand.name, readFileSync(v.path, 'utf8'))
        results.push({ ...base, status: 'imported', ...(trashPath ? { trashPath } : {}) })
      } else if (cand.kind === 'permissions') {
        const v = variant as PermissionsVariant
        let trashPath: string | undefined
        if (exists && existsSync(paths.permissions))
          trashPath = trashLibraryPath(home, paths.permissions).trashPath
        writePermissions(home, v.allowlist)
        results.push({
          ...base,
          status: 'imported',
          ...(trashPath ? { trashPath } : {}),
          ...(v.warnings.length ? { warnings: v.warnings } : {})
        })
      } else if (cand.kind === 'skill') {
        const v = variant as SkillVariant
        let trashPath: string | undefined
        if (exists) trashPath = deleteSkill(home, cand.name).trashPath
        copySkillIntoLibrary(home, cand.name, v.resolvedPath)
        const togglesOk = exists || sourceToggles(home, 'skills', cand.name, v.sources)
        const moved = skillRetirements(home, cand.name, v)
        recordRetirements(home, moved.pending)
        let own: ReturnType<typeof adoptSkillCopies> = { adopted: [], userOwned: [] }
        try {
          own = adoptSkillCopies(home, cand.name)
        } catch {
          // Adoption failure does not roll back the import — the next sync skips it as userOwned
        }
        results.push({
          ...base,
          status: 'imported',
          ...(trashPath ? { trashPath } : {}),
          ...(togglesOk ? {} : { warnings: ['togglesNotSet'] }),
          ...(moved.converted.length ? { converted: moved.converted } : {}),
          ...(own.adopted.length ? { adopted: own.adopted } : {}),
          ...(own.userOwned.length ? { userOwned: own.userOwned } : {})
        })
      } else if (cand.kind === 'agent') {
        const v = variant as AgentVariant
        let trashPath: string | undefined
        if (exists) trashPath = deleteAgent(home, cand.name).trashPath
        writeNewAgentText(home, cand.name, v.text)
        const togglesOk = exists || sourceToggles(home, 'agents', cand.name, v.sources)
        // Source tool files are switched to app-owned: the next approved sync backs them up and writes the rendered output. Inline definitions stay
        const moved = agentRetirements(home, cand.name, v)
        recordRetirements(home, moved.pending)
        // Other same-name files: adopt as app-owned if they match the rendered output, otherwise leave as user files
        let own: ReturnType<typeof adoptAgentFiles> = { adopted: [], userOwned: [] }
        try {
          own = adoptAgentFiles(home, cand.name)
        } catch {
          // Adoption failure does not roll back the import — the next sync skips it as userOwned
        }
        results.push({
          ...base,
          status: 'imported',
          ...(trashPath ? { trashPath } : {}),
          ...(v.warnings.length || moved.converted.length || !togglesOk
            ? {
                warnings: [
                  ...v.warnings,
                  ...(moved.converted.length ? ['agentRenderDiffers'] : []),
                  ...(togglesOk ? [] : ['togglesNotSet'])
                ]
              }
            : {}),
          ...(moved.converted.length ? { converted: moved.converted } : {}),
          ...(own.adopted.length ? { adopted: own.adopted } : {}),
          ...(own.userOwned.length ? { userOwned: own.userOwned } : {}),
          ...(moved.inline ? { inlineRemains: true } : {})
        })
      } else if (cand.kind === 'hook') {
        const v = variant as unknown as HookImportVariant
        const r = applyHookCandidate(home, cand, v, !!sel.overwrite, {
          createHookFiles: (name, doc, script) => void writeNewHook(home, name, doc, script),
          importFolder: (name, from, entry) => void importScriptFolder(home, name, from, entry),
          saveDoc: (name, doc) => void saveHookDoc(home, name, doc),
          trashHook: (name) => deleteHook(home, name).trashPath
        })
        results.push({
          ...base,
          status: 'imported',
          ...(r.trashPath ? { trashPath: r.trashPath } : {}),
          ...(v.warnings.length ? { warnings: [...v.warnings] } : {})
        })
      } else {
        const v = variant as McpVariantInternal
        const replaceSet = new Set(
          sel.replace ?? v.slots.filter((s) => s.looksSecret).map((s) => s.key)
        )
        const unknown = [...replaceSet].filter((k) => !v.slots.some((s) => s.key === k))
        if (unknown.length) {
          refuse(`unknownReplaceKey: ${unknown.join(',')}`)
          continue
        }
        const { server, replaced } = materialize(v, replaceSet, !!opts.secrets)
        let trashPath: string | undefined
        let prevRefs: string[] = []
        if (exists) {
          if (opts.secrets) {
            try {
              prevRefs = secretRefsOf(readMcpServer(home, cand.name))
                .filter((x) => x.server === cand.name)
                .map((x) => x.account)
            } catch {
              prevRefs = []
            }
          }
          trashPath = trashLibraryPath(home, join(paths.mcpsDir, `${cand.name}.json`)).trashPath
        }
        const r = upsertMcpServer(
          home,
          cand.name,
          server,
          opts.secrets ? { secrets: opts.secrets } : {}
        )
        if (opts.secrets && prevRefs.length) {
          const keep = new Set(secretRefsOf(readMcpServer(home, cand.name)).map((x) => x.account))
          const shared = secretAccountsInWorkspaces(home, activeWorkspaceId(home))
          for (const a of prevRefs) if (!keep.has(a) && !shared.has(a)) opts.secrets.delete(a)
        }
        const togglesOk = exists || sourceToggles(home, 'mcp', cand.name, v.sources)
        const warnings = [...v.warnings, ...r.warnings, ...(togglesOk ? [] : ['togglesNotSet'])]
        results.push({
          ...base,
          status: 'imported',
          replaced,
          ...(trashPath ? { trashPath } : {}),
          ...(warnings.length ? { warnings } : {})
        })
      }
    } catch (e) {
      results.push({
        ...base,
        status: e instanceof LibraryError ? 'refused' : 'failed',
        reason:
          e instanceof LibraryError
            ? `${e.code}: ${e.message}`
            : ((e as NodeJS.ErrnoException).code ?? (e as Error).name)
      })
    }
  }
  return results
}

export interface ImportAllOptions {
  /** If true, substitute looksSecret literals with ${KEY}. Default false — the previous library is moved as is */
  replaceSecrets?: boolean
  /** Overwrite items already in the library (default true — for migrating from the previous setup) */
  overwrite?: boolean
  /** Build the plan only, don't write */
  dryRun?: boolean
  /** Secret backend (same as applyImport). If omitted, literals are moved as is */
  secrets?: SecretBackend
}

export interface ImportAllResult {
  plan: ImportPlan
  selections: ImportSelection[]
  results: ImportResult[]
}

/**
 * Build and run a selection that moves all of `~/.agents` (previous sync.mjs setup) at once.
 * All rule·memory·permission·MCP·skill candidates. If there are several variants, the first one.
 */
export function importAllFromLegacy(home: string, opts: ImportAllOptions = {}): ImportAllResult {
  const plan = planImport(home, 'legacy')
  const overwrite = opts.overwrite ?? true
  const selections: ImportSelection[] = []
  const pick = (c: ImportCandidate): void => {
    if (c.conflicts.includes('invalidName') || c.portability === 'toolOnly') return
    const sel: ImportSelection = { kind: c.kind, name: c.name, overwrite }
    if (c.variants.length > 1)
      sel.variant = (
        (c.variants as (PortabilityInfo & { id: string })[]).find(
          (v) => v.portability !== 'toolOnly'
        ) ?? c.variants[0]
      ).id
    if (c.kind === 'mcp' && !opts.replaceSecrets) sel.replace = []
    selections.push(sel)
  }
  for (const c of [...plan.rules, ...plan.memory, ...plan.permissions, ...plan.skills, ...plan.mcp])
    pick(c)
  const results = opts.dryRun
    ? []
    : applyImport(home, selections, 'legacy', opts.secrets ? { secrets: opts.secrets } : {})
  // Preserve server order: mcp.json key order into mcps/_order.json (new names appended after the existing order)
  if (!opts.dryRun && results.some((r) => r.kind === 'mcp' && r.status === 'imported')) {
    const legacyMcp = readJsonSafe(join(plan.sources[0].path, 'sync/mcp.json'))
    const legacyOrder =
      legacyMcp && isObj(legacyMcp.servers)
        ? Object.keys(legacyMcp.servers).filter((n) => !n.startsWith('_'))
        : []
    const cur = readMcpOrderList(home)
    const next = [...new Set([...cur, ...legacyOrder])]
    if (next.length && JSON.stringify(next) !== JSON.stringify(cur)) writeMcpOrder(home, next)
  }
  return { plan, selections, results }
}
