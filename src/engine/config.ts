import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { toolConfigFound } from './detect'
import { DEFAULT_TOOLS_IN_USE, TOOL_IDS, type ToolId } from './toolIds'
import { atomicWrite } from './write'

/** Artifact source setting (config.json format). root is an absolute path or starts with `~/` */
export interface ArtifactSourceConfig {
  label?: string
  root: string
  mode?: 'dir' | 'plans-under'
  depth?: number
  project?: 'first-segment'
}

/** Automatic cleanup of old backups (backupRetention.ts) */
export interface BackupRetention {
  enabled: boolean
  /** Age limit for timestamp folders in backups/{deleted,workspaces} (backups/imported is kept) */
  days: number
  /** rollback/*.tar files to keep (newest first) */
  keepRollback: number
}

export const DEFAULT_BACKUP_RETENTION: BackupRetention = { enabled: true, days: 30, keepRollback: 3 }
export const RETENTION_DAYS_MAX = 3650
export const RETENTION_KEEP_MAX = 100

/** `<home>/.config/illithid/config.json` */
export interface AppConfig {
  version: 1
  /** @deprecated Retired (workspace switch). Ignored when read and removed during workspace migration */
  libraryPath?: string
  /** Active workspace id (`~/.illithid/workspaces/<id>`). default if absent */
  activeWorkspace?: string
  /** Artifact sources. defaultArtifactSources if absent */
  artifactSources?: ArtifactSourceConfig[]
  /** Allow applying to the real HOME (default false — enabled at G1 approval) */
  allowRealApply?: boolean
  /** Device name recorded in backup snapshots. os.hostname() if absent */
  deviceName?: string
  /** Backup cleanup. DEFAULT_BACKUP_RETENTION if absent */
  backupRetention?: BackupRetention
  /**
   * Tools this device uses. Tools not listed get no writes at all (no files, no folders).
   * If absent: the default tools that look installed (toolsInUse) — later tools (Gemini, Copilot) stay off
   */
  toolsInUse?: ToolId[]
  /** Marketplace (skills.sh · MCP registry · awesome-copilot). Default on; off = no menu and no network calls */
  marketEnabled?: boolean
  /** New version check against the latest GitHub release. Default on; off = no update requests */
  updateCheck?: boolean
  /**
   * Grok CLI also reads Claude Code's skills and MCP servers. Default (absent/true) leaves Grok as is; false writes
   * `[compat.claude] skills = false, mcps = false` to ~/.grok/config.toml (grokCompat target)
   */
  grokReadsClaude?: boolean
  /** Version the user chose to skip in the update notice (asked again only for a newer one) */
  updateSkip?: string
  /**
   * Tools just turned off whose app copies are still in their folders. The next approved sync removes them (same as turning every
   * item off for that tool); a tool leaves this list once nothing of the app is left there, or when it is turned back on
   */
  toolsRetiring?: ToolId[]
}

/** Tools that toolsInUse accepts (= TOOL_IDS, in tool order) */
export const CONFIG_TOOL_IDS: readonly ToolId[] = TOOL_IDS

function isToolList(v: unknown): v is ToolId[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && (CONFIG_TOOL_IDS as readonly string[]).includes(x))
}

export interface ConfigRead {
  path: string
  exists: boolean
  config: AppConfig
  /** File exists but failed to read or validate. config is the default in that case */
  error?: string
}

export class ConfigError extends Error {}

/** Default app library directory (M7d). `~/.agents` is an import source, not the source of truth */
export const DEFAULT_LIBRARY_DIR = '.illithid'
/** Workspaces folder (`~/.illithid/workspaces/<id>/`) */
export const WORKSPACES_DIR = 'workspaces'
export const DEFAULT_WORKSPACE = 'default'
/** Workspace id format (folder name) */
export const WORKSPACE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
/** Library of the previous system (sync.mjs) — import source `legacy` */
export const LEGACY_LIBRARY_DIR = '.agents'
/** App config directory (config.json, state.json, backups/) */
export const APP_CONFIG_DIR = '.config/illithid'

/**
 * Previous app-name generations (newest first). Used only for rename migration (rename.ts) and legacy detection.
 * - harnesssync: library root has the current layout (workspaces) — the whole root is moved
 * - agent-console: the library itself is the root — moved into the default workspace
 */
export const LEGACY_APP_GENERATIONS = [
  { name: 'harnesssync', libraryDir: '.harnesssync', configDir: '.config/harnesssync', layout: 'root' },
  { name: 'agent-console', libraryDir: '.agent-console', configDir: '.config/agent-console', layout: 'library' }
] as const
export type LegacyAppGeneration = (typeof LEGACY_APP_GENERATIONS)[number]
export const LEGACY_APP_LIBRARY_DIRS: readonly string[] = LEGACY_APP_GENERATIONS.map((g) => g.libraryDir)
export const LEGACY_APP_CONFIG_DIRS: readonly string[] = LEGACY_APP_GENERATIONS.map((g) => g.configDir)

/** `<home>/.config/illithid` */
export function appConfigDir(home: string): string {
  return join(home, APP_CONFIG_DIR)
}

export function configPath(home: string): string {
  return join(appConfigDir(home), 'config.json')
}

export function defaultConfig(): AppConfig {
  return { version: 1 }
}

/** Expand `~` / `~/x` against home. Relative paths are rejected (null) */
export function expandHome(home: string, p: string): string | null {
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return isAbsolute(p) ? resolve(p) : null
}

/** Shape validation. Returns error messages (values are never included) */
export function validateConfig(v: unknown): string[] {
  const errs: string[] = []
  const o = v as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['Top level is not an object']
  if (o.version !== 1) errs.push('version must be 1')
  if (o.libraryPath !== undefined) {
    if (typeof o.libraryPath !== 'string' || !o.libraryPath) errs.push('libraryPath must be a string')
    else if (!o.libraryPath.startsWith('~') && !isAbsolute(o.libraryPath))
      errs.push('libraryPath must be an absolute or ~/ path')
  }
  if (
    o.activeWorkspace !== undefined &&
    (typeof o.activeWorkspace !== 'string' || !WORKSPACE_ID_RE.test(o.activeWorkspace))
  )
    errs.push('activeWorkspace must be a workspace id (lowercase letters, digits, -)')
  if (o.allowRealApply !== undefined && typeof o.allowRealApply !== 'boolean')
    errs.push('allowRealApply must be a boolean')
  if (o.toolsRetiring !== undefined && !isToolList(o.toolsRetiring)) errs.push(`toolsRetiring must be an array of ${CONFIG_TOOL_IDS.join(' | ')}`)
  if (o.marketEnabled !== undefined && typeof o.marketEnabled !== 'boolean')
    errs.push('marketEnabled must be a boolean')
  if (o.updateCheck !== undefined && typeof o.updateCheck !== 'boolean') errs.push('updateCheck must be a boolean')
  if (o.grokReadsClaude !== undefined && typeof o.grokReadsClaude !== 'boolean')
    errs.push('grokReadsClaude must be a boolean')
  if (o.updateSkip !== undefined && (typeof o.updateSkip !== 'string' || !/^\d+\.\d+\.\d+/.test(o.updateSkip)))
    errs.push('updateSkip must be a version')
  if (o.deviceName !== undefined && (typeof o.deviceName !== 'string' || !o.deviceName.trim()))
    errs.push('deviceName must be a non-empty string')
  if (o.backupRetention !== undefined) {
    const r = o.backupRetention as Record<string, unknown> | null
    if (!r || typeof r !== 'object' || Array.isArray(r)) errs.push('backupRetention must be an object')
    else {
      if (typeof r.enabled !== 'boolean') errs.push('backupRetention.enabled must be a boolean')
      const int = (x: unknown, max: number): boolean => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= max
      if (!int(r.days, RETENTION_DAYS_MAX)) errs.push(`backupRetention.days must be an integer 1-${RETENTION_DAYS_MAX}`)
      if (!int(r.keepRollback, RETENTION_KEEP_MAX))
        errs.push(`backupRetention.keepRollback must be an integer 1-${RETENTION_KEEP_MAX}`)
    }
  }
  if (o.toolsInUse !== undefined && !isToolList(o.toolsInUse))
    errs.push(`toolsInUse must be an array of ${CONFIG_TOOL_IDS.join(' | ')}`)
  if (o.artifactSources !== undefined) {
    if (!Array.isArray(o.artifactSources)) errs.push('artifactSources must be an array')
    else
      o.artifactSources.forEach((s, i) => {
        const x = s as Record<string, unknown> | null
        if (!x || typeof x !== 'object') return errs.push(`artifactSources[${i}] is not an object`)
        if (typeof x.root !== 'string' || (!x.root.startsWith('~') && !isAbsolute(x.root)))
          errs.push(`artifactSources[${i}].root must be an absolute or ~/ path`)
        if (x.mode !== undefined && x.mode !== 'dir' && x.mode !== 'plans-under')
          errs.push(`artifactSources[${i}].mode must be dir | plans-under`)
        if (x.depth !== undefined && (typeof x.depth !== 'number' || x.depth < 1))
          errs.push(`artifactSources[${i}].depth must be a number >= 1`)
        if (x.label !== undefined && typeof x.label !== 'string')
          errs.push(`artifactSources[${i}].label must be a string`)
        if (x.project !== undefined && x.project !== 'first-segment')
          errs.push(`artifactSources[${i}].project must be first-segment`)
        return undefined
      })
  }
  return errs
}

/** Read config.json. Defaults if absent */
export function readConfig(home: string): ConfigRead {
  const path = configPath(home)
  if (!existsSync(path)) return { path, exists: false, config: defaultConfig() }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { path, exists: true, config: defaultConfig(), error: 'JSON parse failed' }
  }
  // A malformed toolsInUse never resets the whole config: unknown ids are dropped (a newer app's tool, a typo); if nothing known
  // is left of a non-empty list, or it isn't a list, the field alone is ignored (= DEFAULT_TOOLS_IN_USE)
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'toolsInUse' in raw && !isToolList((raw as Record<string, unknown>).toolsInUse)) {
    const { toolsInUse: bad, ...rest } = raw as Record<string, unknown>
    const known = Array.isArray(bad) ? CONFIG_TOOL_IDS.filter((t) => bad.includes(t)) : []
    raw = known.length ? { ...rest, toolsInUse: known } : rest
  }
  // Same for toolsRetiring: unknown ids (a newer app's tool) are dropped instead of resetting the config
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'toolsRetiring' in raw && !isToolList((raw as Record<string, unknown>).toolsRetiring)) {
    const { toolsRetiring: bad, ...rest } = raw as Record<string, unknown>
    const known = Array.isArray(bad) ? CONFIG_TOOL_IDS.filter((t) => bad.includes(t)) : []
    raw = known.length ? { ...rest, toolsRetiring: known } : rest
  }
  const errs = validateConfig(raw)
  if (errs.length) return { path, exists: true, config: defaultConfig(), error: errs.join('; ') }
  return { path, exists: true, config: raw as AppConfig }
}

/**
 * Tools in use on this device: config.toolsInUse (deduplicated in tool order), or while unset the default tools whose config
 * folder exists (DEFAULT_TOOLS_IN_USE ∩ toolConfigFound). Folders only, never PATH: every caller (sync, status, adopt, setModel,
 * tool memory) then agrees without needing the user's environment, and a tool that is installed but has never run gets no partial
 * writes. PATH detection only feeds the onboarding/Settings "detected" hint; saving there makes the list explicit.
 * Settings shows this same list and saves it as-is on the first change
 */
export function toolsInUse(home: string): ToolId[] {
  const v = readConfig(home).config.toolsInUse
  if (v !== undefined) return CONFIG_TOOL_IDS.filter((t) => v.includes(t))
  return DEFAULT_TOOLS_IN_USE.filter((t) => toolConfigFound(home, t))
}

export function toolInUse(home: string, tool: ToolId): boolean {
  return toolsInUse(home).includes(tool)
}

/** Tools turned off whose app copies are still to be removed (never a tool in use) */
export function toolsRetiring(home: string): ToolId[] {
  const v = readConfig(home).config.toolsRetiring ?? []
  const inUse = toolsInUse(home)
  return CONFIG_TOOL_IDS.filter((t) => v.includes(t) && !inUse.includes(t))
}

/** Tools the sync plans for: in use, plus retiring ones (planned with every item off, which removes the app's copies) */
export function syncTools(home: string): ToolId[] {
  const s = new Set([...toolsInUse(home), ...toolsRetiring(home)])
  return CONFIG_TOOL_IDS.filter((t) => s.has(t))
}

/** Retiring tools done: drop them from the list (no-op when absent) */
export function clearToolsRetiring(home: string, tools: ToolId[]): void {
  const cur = readConfig(home)
  if (cur.error || !cur.config.toolsRetiring?.length) return
  const left = cur.config.toolsRetiring.filter((t) => !tools.includes(t))
  const { toolsRetiring: _old, ...rest } = cur.config
  void _old
  writeConfig(home, left.length ? { ...rest, toolsRetiring: left } : rest)
}

/**
 * Save toolsInUse (undefined removes the key = DEFAULT_TOOLS_IN_USE). Other settings are kept. Returns the saved list.
 * Tools that go off start retiring (their app copies are removed on the next apply): tools of an explicitly saved list, or while
 * the list is unset only `wrote` (tools the app has written to — computed defaults alone never retire). `retiring` sets the list
 * exactly instead (undoing a change whose preview was cancelled)
 */
export function setToolsInUse(home: string, list: ToolId[] | undefined, opts: { wrote?: ToolId[]; retiring?: ToolId[] } = {}): ToolId[] {
  if (list !== undefined && !isToolList(list)) throw new ConfigError(`toolsInUse must be an array of ${CONFIG_TOOL_IDS.join(' | ')}`)
  const cur = readConfig(home)
  if (cur.error) throw new ConfigError(`config.json: ${cur.error}`)
  const prev = cur.config.toolsInUse !== undefined ? toolsInUse(home) : toolsInUse(home).filter((t) => opts.wrote?.includes(t))
  const { toolsInUse: _old, toolsRetiring: _ret, ...rest } = cur.config
  void _old
  const chosen = list === undefined ? undefined : CONFIG_TOOL_IDS.filter((t) => list.includes(t))
  const base: AppConfig = chosen === undefined ? rest : { ...rest, toolsInUse: chosen }
  // Tools that just went off start retiring; a tool turned back on stops retiring
  const next = chosen ?? DEFAULT_TOOLS_IN_USE.filter((t) => toolConfigFound(home, t))
  const retiring = opts.retiring
    ? CONFIG_TOOL_IDS.filter((t) => opts.retiring?.includes(t) && !next.includes(t))
    : CONFIG_TOOL_IDS.filter((t) => ((_ret ?? []).includes(t) || prev.includes(t)) && !next.includes(t))
  writeConfig(home, retiring.length ? { ...base, toolsRetiring: retiring } : base)
  return toolsInUse(home)
}

/** Atomically write config.json. ConfigError if the shape is invalid. Returns the written path */
export function writeConfig(home: string, config: AppConfig): string {
  const errs = validateConfig(config)
  if (errs.length) throw new ConfigError(errs.join('; '))
  return atomicWrite(configPath(home), JSON.stringify(config, null, 2) + '\n')
}

/** App data root `<home>/.illithid` (parent of the workspaces) */
export function appDataRoot(home: string): string {
  return join(home, DEFAULT_LIBRARY_DIR)
}

/** `<home>/.illithid/workspaces` */
export function workspacesRoot(home: string): string {
  return join(appDataRoot(home), WORKSPACES_DIR)
}

/** Workspace folder (caller validates the id format) */
export function workspaceRoot(home: string, id: string): string {
  return join(workspacesRoot(home), id)
}

function isDirPath(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Workspace ids on disk (sorted, default first) */
export function workspaceIds(home: string): string[] {
  const root = workspacesRoot(home)
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  return names
    .filter((n) => WORKSPACE_ID_RE.test(n) && isDirPath(join(root, n)))
    .sort((a, b) => (a === DEFAULT_WORKSPACE ? -1 : b === DEFAULT_WORKSPACE ? 1 : a.localeCompare(b)))
}

/** Marker entries of a pre-workspace (root-form) library — if any sits directly under `~/.illithid/`, it needs migration */
export const ROOT_FORM_MARKERS = [
  'rules',
  'skills',
  'agents',
  'mcps',
  'memory',
  'permissions.json',
  'illithid.json',
  'harnesssync.json',
  'agent-console.json',
  '.git',
  '.trash'
] as const

/**
 * Root-form library entries (directly under `~/.illithid/`, excluding workspaces and .DS_Store, sorted by name).
 * Empty array if no marker entry (ROOT_FORM_MARKERS) exists — nothing to migrate.
 */
export function rootFormLibraryEntries(home: string): string[] {
  const root = appDataRoot(home)
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const markers = new Set<string>(ROOT_FORM_MARKERS)
  if (!names.some((n) => markers.has(n))) return []
  return names.filter((n) => n !== WORKSPACES_DIR && n !== '.DS_Store').sort()
}

/** Active workspace override for read-only previews (only inside withActiveWorkspace) */
let activeOverride: string | null = null

/**
 * Treat id as the active workspace while fn runs (config is not written). Only for synchronous read-only computations (switch preview).
 * If the id folder is missing, config is followed as usual
 */
export function withActiveWorkspace<T>(id: string, fn: () => T): T {
  const prev = activeOverride
  activeOverride = WORKSPACE_ID_RE.test(id) ? id : null
  try {
    return fn()
  } finally {
    activeOverride = prev
  }
}

/** Active workspace id. default if unset or its folder is missing */
export function activeWorkspaceId(home: string): string {
  if (activeOverride && isDirPath(workspaceRoot(home, activeOverride))) return activeOverride
  const id = readConfig(home).config.activeWorkspace
  return id && WORKSPACE_ID_RE.test(id) && isDirPath(workspaceRoot(home, id)) ? id : DEFAULT_WORKSPACE
}

/** Library root (absolute path) = active workspace folder. config.libraryPath is ignored */
export function libraryRoot(home: string): string {
  return workspaceRoot(home, activeWorkspaceId(home))
}

/** Marketplace on (default) unless config says false */
export function marketEnabled(home: string): boolean {
  return readConfig(home).config.marketEnabled !== false
}
