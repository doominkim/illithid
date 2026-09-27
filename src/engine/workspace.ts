/**
 * Workspace = a whole library (`~/.illithid/workspaces/<id>/`). Active id is config.activeWorkspace.
 *
 * - list·create (empty / clone current)·switch
 * - root layout (`~/.illithid/rules` …) → `workspaces/default/` migration (no deletes, idempotent, snapshot tar first)
 * - zip export·import (fflate). Import only adds a new workspace and never switches automatically
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { unzipSync, zipSync, type Zippable } from 'fflate'
import {
  activeWorkspaceId,
  appConfigDir,
  appDataRoot,
  ConfigError,
  DEFAULT_WORKSPACE,
  readConfig,
  rootFormLibraryEntries,
  validateConfig,
  WORKSPACE_ID_RE,
  workspaceIds,
  workspaceRoot,
  workspacesRoot,
  writeConfig,
  type AppConfig
} from './config'
import { initLibraryAt, WORKSPACE_FILE } from './init'
import { LEGACY_MANIFEST_FILES, MANIFEST_FILE } from './manifest'
import { rewriteStatePaths } from './rename'
import { secretRefsOf, type SecretBackend } from './secrets'
import { atomicWrite } from './write'

export class WorkspaceError extends Error {
  constructor(
    public code:
      | 'invalidName'
      | 'nameExists'
      | 'notFound'
      | 'invalidZip'
      | 'unsafeEntry'
      | 'tooLarge'
      | 'libraryMissing'
      | 'activeWorkspace'
      | 'defaultWorkspace'
      | 'lastWorkspace',
    message: string
  ) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

export interface WorkspaceInfo {
  id: string
  name: string
  active: boolean
}

function readJsonObj(p: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** name from workspace.json (id if missing) */
export function workspaceName(home: string, id: string): string {
  const o = readJsonObj(join(workspaceRoot(home, id), WORKSPACE_FILE))
  const n = typeof o?.name === 'string' ? o.name.trim() : ''
  return n || id
}

export function listWorkspaces(home: string): WorkspaceInfo[] {
  const active = activeWorkspaceId(home)
  return workspaceIds(home).map((id) => ({ id, name: workspaceName(home, id), active: id === active }))
}

/** name → id slug (lowercase·digits·-). 'workspace' if no ASCII letters or digits */
export function workspaceSlug(name: string): string {
  const s = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return s || 'workspace'
}

/** First id among base, base-2, base-3 … not on disk */
function uniqueId(home: string, base: string): string {
  const taken = (id: string): boolean => existsSync(workspaceRoot(home, id))
  if (!taken(base)) return base
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`
}

/** First unused name among name, name-2 … */
function uniqueName(home: string, name: string): string {
  const names = new Set(listWorkspaces(home).map((w) => w.name))
  if (!names.has(name)) return name
  for (let i = 2; ; i++) if (!names.has(`${name}-${i}`)) return `${name}-${i}`
}

function checkName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : ''
  // eslint-disable-next-line no-control-regex
  if (!n || n.length > 64 || /[\u0000-\u001f\u007f]/.test(n))
    throw new WorkspaceError('invalidName', 'workspace name must be 1–64 chars with no control characters')
  return n
}

function writeWorkspaceFile(root: string, o: Record<string, unknown>): void {
  atomicWrite(join(root, WORKSPACE_FILE), JSON.stringify(o, null, 2) + '\n', { mode: 0o644 })
}

/** Top-level entries excluded from clone and export */
const CLONE_EXCLUDE_TOP = new Set(['.git', '.trash'])

/**
 * New workspace. from=empty (default) empty skeleton, current = clone of the active workspace (excluding .git·.trash).
 * nameExists if the name is taken. Does not switch
 */
export function createWorkspace(
  home: string,
  name: string,
  opts: { from?: 'empty' | 'current' } = {}
): WorkspaceInfo {
  const n = checkName(name)
  if (listWorkspaces(home).some((w) => w.name === n))
    throw new WorkspaceError('nameExists', 'a workspace with the same name exists')
  const id = uniqueId(home, workspaceSlug(n))
  const root = workspaceRoot(home, id)
  mkdirSync(workspacesRoot(home), { recursive: true, mode: 0o755 })
  if (opts.from === 'current') {
    const src = workspaceRoot(home, activeWorkspaceId(home))
    if (!existsSync(src)) throw new WorkspaceError('libraryMissing', 'current library is missing')
    const tmp = join(workspacesRoot(home), `.create-${randomBytes(4).toString('hex')}`)
    try {
      cpSync(src, tmp, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
        filter: (s) => {
          const rel = s.slice(src.length + 1)
          const top = rel.split(sep)[0]
          return !CLONE_EXCLUDE_TOP.has(top) && !rel.endsWith('.DS_Store')
        }
      })
      renameSync(tmp, root)
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true })
      throw e
    }
  }
  initLibraryAt(root)
  writeWorkspaceFile(root, { name: n })
  return { id, name: n, active: false }
}

/** Switch the active workspace (saves config.activeWorkspace). Caller syncs to apply to tools */
export function switchWorkspace(home: string, id: string): WorkspaceInfo {
  if (typeof id !== 'string' || !WORKSPACE_ID_RE.test(id) || !workspaceIds(home).includes(id))
    throw new WorkspaceError('notFound', 'workspace not found')
  const cfg = readConfig(home)
  if (cfg.error) throw new ConfigError(`config.json: ${cfg.error}`)
  writeConfig(home, { ...cfg.config, activeWorkspace: id })
  return { id, name: workspaceName(home, id), active: true }
}

/** Rename — changes only name in workspace.json (id and folder unchanged). Refuses empty names and names used by another workspace */
export function renameWorkspace(home: string, id: string, name: string): WorkspaceInfo {
  if (typeof id !== 'string' || !WORKSPACE_ID_RE.test(id) || !workspaceIds(home).includes(id))
    throw new WorkspaceError('notFound', 'workspace not found')
  const n = checkName(name)
  if (listWorkspaces(home).some((w) => w.id !== id && w.name === n))
    throw new WorkspaceError('nameExists', 'a workspace with the same name exists')
  const root = workspaceRoot(home, id)
  const cur = readJsonObj(join(root, WORKSPACE_FILE)) ?? {}
  writeWorkspaceFile(root, { ...cur, name: n })
  return { id, name: n, active: id === activeWorkspaceId(home) }
}

/** Deletion backup root `<home>/.config/illithid/backups/workspaces` */
export function deletedWorkspacesRoot(home: string): string {
  return join(appConfigDir(home), 'backups/workspaces')
}

/**
 * Delete — no permanent deletion; moves the folder to `backups/workspaces/<ts>/<id>/` (copy then remove across filesystems).
 * Refuses the active workspace and the last one. Leaves the keychain alone. Returns the moved path
 */
export function deleteWorkspace(home: string, id: string): { id: string; backupPath: string } {
  const ids = workspaceIds(home)
  if (typeof id !== 'string' || !WORKSPACE_ID_RE.test(id) || !ids.includes(id))
    throw new WorkspaceError('notFound', 'workspace not found')
  if (id === DEFAULT_WORKSPACE) throw new WorkspaceError('defaultWorkspace', 'the default workspace cannot be deleted')
  if (id === activeWorkspaceId(home))
    throw new WorkspaceError('activeWorkspace', 'the active workspace cannot be deleted')
  if (ids.length <= 1) throw new WorkspaceError('lastWorkspace', 'the last workspace cannot be deleted')
  const from = workspaceRoot(home, id)
  const to = join(deletedWorkspacesRoot(home), new Date().toISOString().replace(/[:.]/g, '-'), id)
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
  try {
    renameSync(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
    rmSync(from, { recursive: true, force: true })
  }
  return { id, backupPath: to }
}

// ---------------------------------------------------------------- root layout → workspaces/default migration

export interface WorkspaceMigrationPlan {
  needed: boolean
  /** `~/.illithid` */
  from: string
  /** `~/.illithid/workspaces/default` */
  to: string
  /** Names of top-level entries to move */
  entries: string[]
  /** Same name already exists at the target → do not proceed */
  conflicts: string[]
  /** Number of path strings to rewrite in state.json */
  stateRewrites: number
  /** Remove config.libraryPath */
  dropLibraryPath: boolean
}

export interface WorkspaceMigrationResult {
  ok: boolean
  plan: WorkspaceMigrationPlan
  moved: string[]
  /** Pre-migration snapshot tar */
  snapshot?: string
  stateRewrites: number
  reason?: string
}

function exists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** Root-layout path (`<home>/.illithid/x`, `~/.illithid/x`, outside workspaces) → default workspace path */
function toDefaultWorkspacePath(home: string, s: string): string | null {
  const root = appDataRoot(home)
  const ws = workspacesRoot(home)
  const to = workspaceRoot(home, DEFAULT_WORKSPACE)
  const map = (abs: string): string | null => {
    if (abs === ws || abs.startsWith(ws + '/')) return null
    if (abs === root) return to
    if (abs.startsWith(root + '/')) return to + abs.slice(root.length)
    return null
  }
  if (s.startsWith('~/')) {
    const r = map(join(home, s.slice(2)))
    return r === null ? null : '~' + r.slice(home.length)
  }
  return map(s)
}

function stateFile(home: string): string {
  return join(appConfigDir(home), 'state.json')
}

/** Migration plan. Read-only */
export function planMigrateToWorkspaces(home: string): WorkspaceMigrationPlan {
  const from = appDataRoot(home)
  const to = workspaceRoot(home, DEFAULT_WORKSPACE)
  const entries = rootFormLibraryEntries(home)
  const conflicts = entries.filter((e) => exists(join(to, e)))
  const st = entries.length ? readJsonObj(stateFile(home)) : null
  const stateRewrites = st ? rewriteStatePaths(st, (x) => toDefaultWorkspacePath(home, x)) : 0
  const cfg = readJsonObj(join(appConfigDir(home), 'config.json'))
  const dropLibraryPath = !!entries.length && !!cfg && cfg.libraryPath !== undefined
  return { needed: entries.length > 0, from, to, entries, conflicts, stateRewrites, dropLibraryPath }
}

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * Move a root-layout library into `workspaces/default/` (renameSync, no deletes). Nothing to do → ok·moved 0 (idempotent).
 * If a name already exists at the target, moves nothing and ok=false. Before moving, writes `~/.config/illithid/rollback/pre-workspaces-<ts>.tar`
 * (library + config.json·state.json). On failure, moved entries are rolled back.
 */
export function migrateToWorkspaces(home: string): WorkspaceMigrationResult {
  const plan = planMigrateToWorkspaces(home)
  const res: WorkspaceMigrationResult = { ok: true, plan, moved: [], stateRewrites: 0 }
  if (!plan.needed) return res
  if (plan.conflicts.length)
    return { ...res, ok: false, reason: `already exists at target: ${plan.conflicts.join(', ')}` }
  // snapshot
  const rbDir = join(appConfigDir(home), 'rollback')
  const snap = join(rbDir, `pre-workspaces-${stamp()}.tar`)
  try {
    mkdirSync(rbDir, { recursive: true, mode: 0o700 })
    const extra = ['config.json', 'state.json']
      .map((f) => join(appConfigDir(home), f))
      .filter((p) => existsSync(p))
      .map((p) => p.slice(home.length + 1))
    execFileSync(
      'tar',
      ['-cf', snap, '-C', home, appDataRoot(home).slice(home.length + 1), ...extra],
      { stdio: 'ignore' }
    )
    res.snapshot = snap
  } catch (e) {
    return { ...res, ok: false, reason: `snapshot failed (${(e as Error).message})` }
  }
  mkdirSync(plan.to, { recursive: true, mode: 0o755 })
  for (const name of plan.entries) {
    try {
      renameSync(join(plan.from, name), join(plan.to, name))
      res.moved.push(name)
    } catch (e) {
      for (const done of [...res.moved].reverse()) {
        try {
          renameSync(join(plan.to, done), join(plan.from, done))
        } catch {
          // rollback failed — recover from the snapshot
        }
      }
      return {
        ...res,
        ok: false,
        moved: [],
        reason: `${name} move failed (${(e as NodeJS.ErrnoException).code ?? 'unknown'})`
      }
    }
  }
  if (!existsSync(join(plan.to, WORKSPACE_FILE))) writeWorkspaceFile(plan.to, { name: DEFAULT_WORKSPACE })
  if (plan.dropLibraryPath) {
    const cfg = readJsonObj(join(appConfigDir(home), 'config.json'))
    if (cfg) {
      delete cfg.libraryPath
      if (!validateConfig(cfg).length) writeConfig(home, cfg as unknown as AppConfig)
    }
  }
  const st = readJsonObj(stateFile(home))
  if (st) {
    const n = rewriteStatePaths(st, (x) => toDefaultWorkspacePath(home, x))
    if (n) {
      atomicWrite(stateFile(home), JSON.stringify(st, null, 2) + '\n')
      res.stateRewrites = n
    }
  }
  return res
}

// ---------------------------------------------------------------- shared secrets

/** Secret accounts used by mcps/*.json of workspaces other than except */
export function secretAccountsInWorkspaces(home: string, except?: string): Set<string> {
  const out = new Set<string>()
  for (const id of workspaceIds(home)) {
    if (id === except) continue
    const dir = join(workspaceRoot(home, id), 'mcps')
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('.'))
    } catch {
      continue
    }
    for (const f of files) for (const r of secretRefsOf(readJsonObj(join(dir, f)))) out.add(r.account)
  }
  return out
}

// ---------------------------------------------------------------- zip export·import

/** Top-level entries allowed in a zip (directories / files) */
export const WORKSPACE_ZIP_DIRS = ['rules', 'skills', 'agents', 'mcps', 'memory'] as const
export const WORKSPACE_ZIP_FILES = [
  'permissions.json',
  MANIFEST_FILE,
  // on/off files in zips exported under old app names (renamed on import)
  ...LEGACY_MANIFEST_FILES,
  WORKSPACE_FILE,
  'market.json',
  '.gitignore'
] as const
export const WORKSPACE_ZIP_MAX_FILES = 5000
export const WORKSPACE_ZIP_MAX_BYTES = 50 * 1024 * 1024
export const WORKSPACE_ZIP_EXT = '.illithid.zip'
/** Export extensions from old app names (accepted on import) */
export const LEGACY_WORKSPACE_ZIP_EXTS = ['.harnesssync.zip'] as const

export interface WorkspaceExport {
  data: Uint8Array
  name: string
  files: number
  /** Skipped entries such as symlinks (relative to the workspace) */
  skipped: string[]
}

/** Active (or given) workspace → zip. Excludes .git·.trash·.DS_Store·disallowed top-level entries·symlinks */
export function exportWorkspace(
  home: string,
  opts: { id?: string; appVersion?: string } = {}
): WorkspaceExport {
  const id = opts.id ?? activeWorkspaceId(home)
  const root = workspaceRoot(home, id)
  if (!existsSync(root)) throw new WorkspaceError('notFound', 'workspace not found')
  const name = workspaceName(home, id)
  const files: Zippable = {}
  const skipped: string[] = []
  let count = 0
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs).sort()) {
      if (e === '.DS_Store') continue
      const a = join(abs, e)
      const r = rel ? `${rel}/${e}` : e
      const st = lstatSync(a)
      if (st.isSymbolicLink()) skipped.push(r)
      else if (st.isDirectory()) walk(a, r)
      else if (st.isFile()) {
        files[r] = new Uint8Array(readFileSync(a))
        count++
      } else skipped.push(r)
    }
  }
  const dirs = new Set<string>(WORKSPACE_ZIP_DIRS)
  const fileTops = new Set<string>(WORKSPACE_ZIP_FILES)
  for (const e of readdirSync(root).sort()) {
    if (e === WORKSPACE_FILE || e === '.DS_Store') continue
    const a = join(root, e)
    const st = lstatSync(a)
    if (st.isSymbolicLink()) skipped.push(e)
    else if (dirs.has(e) && st.isDirectory()) walk(a, e)
    else if (fileTops.has(e) && st.isFile()) {
      files[e] = new Uint8Array(readFileSync(a))
      count++
    }
  }
  const meta = {
    name,
    exportedAt: new Date().toISOString(),
    ...(opts.appVersion ? { appVersion: opts.appVersion } : {})
  }
  files[WORKSPACE_FILE] = new TextEncoder().encode(JSON.stringify(meta, null, 2) + '\n')
  count++
  return { data: zipSync(files, { level: 6 }), name, files: count, skipped }
}

interface ZipEntryInfo {
  name: string
  size: number
  compressedSize: number
  isDir: boolean
  isSymlink: boolean
}

/** Parse the central directory (name·size·symlink). Rejects zip64 and split zips */
function readZipEntries(data: Uint8Array): ZipEntryInfo[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const len = data.byteLength
  let eocd = -1
  for (let i = len - 22; i >= Math.max(0, len - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new WorkspaceError('invalidZip', 'not a zip file')
  const total = dv.getUint16(eocd + 10, true)
  const cdSize = dv.getUint32(eocd + 12, true)
  const cdOff = dv.getUint32(eocd + 16, true)
  if (total === 0xffff || cdOff === 0xffffffff || cdOff + cdSize > len)
    throw new WorkspaceError('invalidZip', 'unsupported zip (zip64 or corrupt)')
  const out: ZipEntryInfo[] = []
  let p = cdOff
  const dec = new TextDecoder('utf-8', { fatal: false })
  for (let i = 0; i < total; i++) {
    if (p + 46 > len || dv.getUint32(p, true) !== 0x02014b50)
      throw new WorkspaceError('invalidZip', 'corrupt zip central directory')
    const madeBy = dv.getUint16(p + 4, true) >> 8
    const compressedSize = dv.getUint32(p + 20, true)
    const size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const ext = dv.getUint32(p + 38, true)
    const name = dec.decode(data.subarray(p + 46, p + 46 + nameLen))
    // only entries made on unix(3)·macOS(19) carry the file mode in the upper 16 bits
    const mode = madeBy === 3 || madeBy === 19 ? ext >>> 16 : 0
    out.push({
      name,
      size,
      compressedSize,
      isDir: name.endsWith('/'),
      isSymlink: (mode & 0o170000) === 0o120000
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

export interface WorkspaceImportPlan {
  ok: boolean
  /** Refusal reasons (with entry names, no content) */
  errors: string[]
  /** Refusal kind (when ok=false) */
  reason?: 'invalidZip' | 'unsafeEntry' | 'tooLarge'
  /** Name from workspace.json in the zip (null if missing) */
  name: string | null
  files: number
  bytes: number
}

/** Validate an entry name. Returns the reason if invalid */
function entryProblem(name: string, isDir: boolean): string | null {
  if (!name || name.includes('\0')) return 'empty name'
  if (name.includes('\\')) return 'backslash path'
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'absolute path'
  const segs = (isDir ? name.slice(0, -1) : name).split('/')
  if (segs.some((s) => s === '..')) return 'parent path (..)'
  if (segs.some((s) => s === '' || s === '.')) return 'empty path segment'
  const top = segs[0]
  const dirs = new Set<string>(WORKSPACE_ZIP_DIRS)
  const files = new Set<string>(WORKSPACE_ZIP_FILES)
  if (dirs.has(top)) return !isDir && segs.length < 2 ? `${top} must be a directory` : null
  if (files.has(top)) return segs.length === 1 && !isDir ? null : `${top} must be a file`
  return 'disallowed top-level entry'
}

/** Validate an import. Read-only (does not decompress — checks limits using declared sizes) */
export function planImportWorkspace(data: Uint8Array): WorkspaceImportPlan {
  const errors: string[] = []
  let entries: ZipEntryInfo[]
  try {
    entries = readZipEntries(data)
  } catch (e) {
    return { ok: false, reason: 'invalidZip', errors: [(e as Error).message], name: null, files: 0, bytes: 0 }
  }
  const seen = new Set<string>()
  let files = 0
  let bytes = 0
  for (const e of entries) {
    const shown = JSON.stringify(e.name.slice(0, 120))
    if (e.isSymlink) errors.push(`${shown}: symlink`)
    const pr = entryProblem(e.name, e.isDir)
    if (pr) errors.push(`${shown}: ${pr}`)
    if (seen.has(e.name)) errors.push(`${shown}: duplicate entry`)
    seen.add(e.name)
    if (!e.isDir) {
      files++
      bytes += e.size
    }
  }
  const unsafe = errors.length
  if (files > WORKSPACE_ZIP_MAX_FILES)
    errors.push(`${files} files — limit ${WORKSPACE_ZIP_MAX_FILES}`)
  if (bytes > WORKSPACE_ZIP_MAX_BYTES)
    errors.push(`uncompressed size ${bytes} bytes — limit ${WORKSPACE_ZIP_MAX_BYTES} bytes`)
  const reason = unsafe ? ('unsafeEntry' as const) : errors.length ? ('tooLarge' as const) : undefined
  let name: string | null = null
  if (!errors.length && seen.has(WORKSPACE_FILE)) {
    try {
      const u = unzipSync(data, { filter: (f) => f.name === WORKSPACE_FILE })
      const o = JSON.parse(new TextDecoder().decode(u[WORKSPACE_FILE])) as Record<string, unknown>
      if (typeof o?.name === 'string' && o.name.trim()) name = o.name.trim().slice(0, 64)
    } catch {
      name = null
    }
  }
  return { ok: !errors.length, ...(reason ? { reason } : {}), errors, name, files, bytes }
}

export interface WorkspaceImportResult {
  id: string
  name: string
  files: number
  /** Secret accounts with no keychain value (`<server>/<headers|env>/<KEY>`) */
  missingSecrets: string[]
}

/**
 * zip → new workspace (no automatic switch). On validation failure throws WorkspaceError(unsafeEntry·tooLarge·invalidZip) and writes nothing.
 * Appends `-2` … on name clashes. Returns refs missing from the keychain when secrets are used.
 */
export function importWorkspace(
  home: string,
  data: Uint8Array,
  opts: { name?: string; secrets?: SecretBackend } = {}
): WorkspaceImportResult {
  const plan = planImportWorkspace(data)
  if (!plan.ok) {
    throw new WorkspaceError(plan.reason ?? 'invalidZip', plan.errors.slice(0, 10).join('; '))
  }
  let unz: Record<string, Uint8Array>
  try {
    unz = unzipSync(data)
  } catch (e) {
    throw new WorkspaceError('invalidZip', `decompression failed (${(e as Error).message})`)
  }
  // re-check limits against actual sizes, which may differ from declared ones
  let actual = 0
  for (const [n, buf] of Object.entries(unz)) {
    if (entryProblem(n, n.endsWith('/'))) throw new WorkspaceError('unsafeEntry', `${JSON.stringify(n)}: disallowed entry`)
    actual += buf.byteLength
  }
  if (actual > WORKSPACE_ZIP_MAX_BYTES) throw new WorkspaceError('tooLarge', 'uncompressed size limit exceeded')
  const name = uniqueName(home, checkName(opts.name ?? plan.name ?? 'imported'))
  const id = uniqueId(home, workspaceSlug(name))
  mkdirSync(workspacesRoot(home), { recursive: true, mode: 0o755 })
  const tmp = join(workspacesRoot(home), `.import-${randomBytes(4).toString('hex')}`)
  let files = 0
  try {
    mkdirSync(tmp, { mode: 0o755 })
    for (const [n, buf] of Object.entries(unz)) {
      const dst = join(tmp, ...n.split('/').filter(Boolean))
      if (!dst.startsWith(tmp + sep)) throw new WorkspaceError('unsafeEntry', `${JSON.stringify(n)}: outside path`)
      if (n.endsWith('/')) {
        mkdirSync(dst, { recursive: true, mode: 0o755 })
        continue
      }
      mkdirSync(dirname(dst), { recursive: true, mode: 0o755 })
      writeFileSync(dst, buf, { mode: 0o644, flag: 'wx' })
      files++
    }
    // old app-name on/off file → new name (when the new file is absent, most recent generation first)
    const legacyManifest = LEGACY_MANIFEST_FILES.find((f) => existsSync(join(tmp, f)))
    if (legacyManifest && !existsSync(join(tmp, MANIFEST_FILE)))
      renameSync(join(tmp, legacyManifest), join(tmp, MANIFEST_FILE))
    initLibraryAt(tmp)
    writeWorkspaceFile(tmp, { name })
    renameSync(tmp, workspaceRoot(home, id))
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }
  const missingSecrets: string[] = []
  if (opts.secrets) {
    const mine = new Set<string>()
    const dir = join(workspaceRoot(home, id), 'mcps')
    for (const f of existsSync(dir) ? readdirSync(dir) : [])
      if (f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('.'))
        for (const r of secretRefsOf(readJsonObj(join(dir, f)))) mine.add(r.account)
    for (const a of [...mine].sort()) {
      let v: string | null = null
      try {
        v = opts.secrets.get(a)
      } catch {
        v = null
      }
      if (v === null) missingSecrets.push(a)
    }
  }
  return { id, name, files, missingSecrets }
}
