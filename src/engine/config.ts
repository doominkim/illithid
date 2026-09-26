import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
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
  /** Age limit for timestamp folders in backups/{deleted,imported,workspaces} */
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
  const errs = validateConfig(raw)
  if (errs.length) return { path, exists: true, config: defaultConfig(), error: errs.join('; ') }
  return { path, exists: true, config: raw as AppConfig }
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
