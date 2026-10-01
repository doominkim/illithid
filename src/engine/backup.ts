/**
 * Backup = the library (~/.illithid) as a Git repo. Skills Manager-style "snapshot → push to remote" model.
 *
 * - Scope: the whole library (rules/ skills/ mcps/ memory/ permissions.json illithid.json). .trash/ and OS files are
 *   excluded via .gitignore. ~/.config/illithid (device settings, state) is outside the library and not backed up.
 *   Secrets never live in the library (${VAR} references) — literals trigger a warning on save (validateMcpServer).
 * - Never destroy history: no reset --hard or force push. Restore is a **new commit** that reverts to that snapshot.
 * - If the remote is ahead, ff-only pull and retry; if diverged, stop with {ok:false, reason:'diverged'} (no merge attempt).
 * - Failures are returned as { ok:false, reason } instead of thrown.
 */
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'
import { APP_CONFIG_DIR, libraryRoot, readConfig } from './config'
import { MANIFEST_FILE } from './manifest'
import type { GitResult } from './git'
import { libraryExists } from './sources'
import { atomicWrite, LEGACY_TMP_TAGS, TMP_TAG } from './write'

/** Library entries included in the backup (relative to root) */
export const BACKUP_INCLUDES = [
  'rules',
  'skills',
  'agents',
  'mcps',
  'memory',
  'permissions.json',
  MANIFEST_FILE
] as const
/** Entries excluded via .gitignore */
export const BACKUP_EXCLUDES = [
  '.trash/',
  'artifacts/',
  '.DS_Store',
  'Thumbs.db',
  `*${TMP_TAG}*.tmp`,
  // tmp files from previous app names
  ...LEGACY_TMP_TAGS.map((t) => `*${t}*.tmp`)
] as const
/** Outside the library, so not backed up (for display) */
export const BACKUP_NOT_INCLUDED = [
  `~/${APP_CONFIG_DIR} (config.json · state.json · backups/)`
] as const

export const BACKUP_REMOTE = 'origin'
export const BACKUP_DEFAULT_BRANCH = 'main'
const DEVICE_TRAILER = 'Device'

export interface Snapshot {
  hash: string
  message: string
  /** ISO timestamp (author date) */
  at: string
  /** Device that made the snapshot (Device trailer, '?' if absent) */
  device: string
}

export interface BackupStatus {
  /** Whether the library is a git repo */
  initialized: boolean
  remoteUrl?: string
  branch?: string
  lastSnapshot?: Snapshot
  /** Whether there are uncommitted changes */
  dirty: boolean
  ahead: number
  behind: number
  deviceName: string
  /** Library root (absolute) */
  root: string
  /** false if the library is missing (initialized is false too) */
  libraryExists: boolean
}

export type SnapshotResult = GitResult<{
  hash: string
  /** Whether a new commit was made (false if nothing changed) */
  committed: boolean
  /** Whether it was pushed (false if no remote) */
  pushed: boolean
  message: string
}>

export type RestoreResult = GitResult<{
  /** Restore commit (HEAD unchanged with committed=false if nothing changed) */
  hash: string
  committed: boolean
  /** Number of changed files */
  changed: number
}>

export type PullResult = GitResult<{ summary: string; skipped?: 'noRemote' | 'notInitialized' }>

function git(dir: string): SimpleGit {
  return simpleGit({ baseDir: dir })
}

function reasonOf(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).trim()
}

/** Device name: config.deviceName ?? os.hostname() */
export function deviceName(home: string): string {
  const c = readConfig(home).config.deviceName?.trim()
  return c || hostname()
}

function isRepo(root: string): boolean {
  return existsSync(join(root, '.git'))
}

/** Remote URL formats: https(s)://, ssh://, git@host:path, absolute path (local or fixture bare repo) */
export function validateRemoteUrl(url: string): string | null {
  const u = url.trim()
  if (!u) return 'Remote URL is empty'
  if (/\s/.test(u)) return 'Remote URL contains whitespace'
  if (/^https?:\/\/[^/]+\/.+/.test(u)) return null
  if (/^ssh:\/\/[^/]+\/.+/.test(u)) return null
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+/.test(u)) return null
  if (/^file:\/\/\/.+/.test(u) || isAbsolute(u)) return null
  return 'Remote URL must be https://, ssh://, or git@host:path'
}

async function remoteUrl(g: SimpleGit): Promise<string | undefined> {
  try {
    const v = (await g.raw(['config', '--get', `remote.${BACKUP_REMOTE}.url`])).trim()
    return v || undefined
  } catch {
    return undefined
  }
}

async function currentBranch(g: SimpleGit): Promise<string | undefined> {
  try {
    const b = (await g.raw(['symbolic-ref', '--short', '-q', 'HEAD'])).trim()
    return b || undefined
  } catch {
    return undefined
  }
}

async function hasHead(g: SimpleGit): Promise<boolean> {
  try {
    await g.raw(['rev-parse', '--verify', '-q', 'HEAD'])
    return true
  } catch {
    return false
  }
}

function parseLog(raw: string): Snapshot[] {
  const out: Snapshot[] = []
  for (const rec of raw.split('\x1e')) {
    const [hash, at, subject, body = ''] = rec.replace(/^\n/, '').split('\x1f')
    if (!hash || !at) continue
    const m = new RegExp(`^${DEVICE_TRAILER}:\\s*(.+)$`, 'm').exec(body)
    const fromSubject = /\bfrom (\S+)$/.exec(subject ?? '')?.[1]
    out.push({ hash, at, message: subject ?? '', device: m?.[1]?.trim() ?? fromSubject ?? '?' })
  }
  return out
}

/** Snapshot list (newest first). [] if there are no commits */
export async function history(home: string, n = 20): Promise<Snapshot[]> {
  const root = libraryRoot(home)
  if (!isRepo(root)) return []
  const g = git(root)
  if (!(await hasHead(g))) return []
  const raw = await g.raw([
    'log',
    `-n${Math.max(1, n)}`,
    '--pretty=format:%H%x1f%aI%x1f%s%x1f%b%x1e'
  ])
  return parseLog(raw)
}

export async function backupStatus(home: string): Promise<BackupStatus> {
  const root = libraryRoot(home)
  const device = deviceName(home)
  const base: BackupStatus = {
    initialized: false,
    dirty: false,
    ahead: 0,
    behind: 0,
    deviceName: device,
    root,
    libraryExists: libraryExists(home)
  }
  if (!base.libraryExists || !isRepo(root)) return base
  const g = git(root)
  const [url, branch, s, last] = await Promise.all([
    remoteUrl(g),
    currentBranch(g),
    g.status(),
    history(home, 1)
  ])
  return {
    ...base,
    initialized: true,
    ...(url ? { remoteUrl: url } : {}),
    ...(branch ? { branch } : {}),
    ...(last[0] ? { lastSnapshot: last[0] } : {}),
    dirty: !s.isClean(),
    ahead: s.ahead,
    behind: s.behind
  }
}

/** Ensure .gitignore has every excluded entry (existing lines stay) */
function ensureGitignore(root: string): void {
  const p = join(root, '.gitignore')
  const cur = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const lines = new Set(cur.split('\n').map((l) => l.trim()))
  const missing = BACKUP_EXCLUDES.filter((x) => !lines.has(x))
  if (!missing.length) return
  const next =
    (cur.trimEnd() ? cur.trimEnd() + '\n' : '# Illithid backup exclusions\n') +
    missing.join('\n') +
    '\n'
  atomicWrite(p, next, existsSync(p) ? {} : { mode: 0o644 })
}

/** Fill in commit identity/signing settings locally in the repo if missing (global config is left alone) */
async function ensureIdentity(g: SimpleGit, device: string): Promise<void> {
  const get = async (k: string): Promise<string> => {
    try {
      return (await g.raw(['config', '--get', k])).trim()
    } catch {
      return ''
    }
  }
  if (!(await get('user.name'))) await g.raw(['config', 'user.name', `illithid@${device}`])
  if (!(await get('user.email'))) await g.raw(['config', 'user.email', `illithid@${device}.local`])
  if (!(await get('commit.gpgsign'))) await g.raw(['config', 'commit.gpgsign', 'false'])
}

/**
 * Connect remote: git init the library (if needed) + set origin + ensure .gitignore.
 * If origin exists, only its URL changes. Does not talk to the remote (the first push happens in snapshot).
 */
export async function connectBackup(
  home: string,
  remote: string
): Promise<GitResult<{ root: string; initialized: boolean; remoteUrl: string }>> {
  const bad = validateRemoteUrl(remote)
  if (bad) return { ok: false, reason: bad }
  const root = libraryRoot(home)
  if (!libraryExists(home)) return { ok: false, reason: 'Library does not exist (run init first)' }
  const url = remote.trim()
  try {
    let initialized = false
    if (!isRepo(root)) {
      await git(root).raw(['init', '-q', `--initial-branch=${BACKUP_DEFAULT_BRANCH}`])
      initialized = true
    }
    const g = git(root)
    await ensureIdentity(g, deviceName(home))
    ensureGitignore(root)
    const cur = await remoteUrl(g)
    if (cur === undefined) await g.raw(['remote', 'add', BACKUP_REMOTE, url])
    else if (cur !== url) await g.raw(['remote', 'set-url', BACKUP_REMOTE, url])
    return { ok: true, root, initialized, remoteUrl: url }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** push if upstream exists, otherwise -u origin <branch>. Never force */
async function pushCurrent(g: SimpleGit, branch: string): Promise<void> {
  const s = await g.status()
  if (s.tracking) await g.raw(['push', BACKUP_REMOTE, `HEAD:refs/heads/${branch}`])
  else await g.raw(['push', '-u', BACKUP_REMOTE, branch])
}

function looksDiverged(msg: string): boolean {
  return /non-fast-forward|fetch first|rejected|not possible to fast-forward|diverg|Not possible|cannot fast-forward/i.test(
    msg
  )
}

/**
 * Snapshot: add the whole library (-A) + commit + push. The library is app-owned, so adding everything is allowed.
 * With no changes, skip the commit and only push (if ahead). Without a remote, only commit.
 * If push is rejected (remote ahead), ff-only pull and retry once; if it still fails, reason 'diverged'.
 */
export async function snapshot(home: string, message?: string): Promise<SnapshotResult> {
  const root = libraryRoot(home)
  if (!isRepo(root))
    return { ok: false, reason: 'Backup is not connected (run connectBackup first)' }
  const g = git(root)
  const device = deviceName(home)
  try {
    await ensureIdentity(g, device)
    ensureGitignore(root)
    const s0 = await g.status()
    if (s0.conflicted.length)
      return { ok: false, reason: `Conflicted files: ${s0.conflicted.join(', ')}` }
    let branch = await currentBranch(g)
    if (!branch) return { ok: false, reason: 'Will not snapshot on a detached HEAD' }
    await g.raw(['add', '-A', '--', '.'])
    const staged = (await g.raw(['diff', '--cached', '--name-only'])).trim()
    const subject = (message?.trim() || `backup ${stamp()} from ${device}`).split('\n')[0]
    let committed = false
    if (staged || !(await hasHead(g))) {
      if (staged) {
        await g.raw(['commit', '-q', '-m', subject, '-m', `${DEVICE_TRAILER}: ${device}`])
        committed = true
      }
    }
    if (!(await hasHead(g))) return { ok: false, reason: 'Nothing to commit (empty library)' }
    const hash = (await g.revparse(['HEAD'])).trim()
    branch = (await currentBranch(g)) ?? branch
    const url = await remoteUrl(g)
    if (!url) return { ok: true, hash, committed, pushed: false, message: subject }
    try {
      await pushCurrent(g, branch)
    } catch (e) {
      const msg = reasonOf(e)
      if (!looksDiverged(msg)) return { ok: false, reason: msg }
      // Remote is ahead → catch up ff-only, then try once more
      try {
        await g.raw(['fetch', '-q', BACKUP_REMOTE])
        await g.raw(['merge', '--ff-only', '-q', `${BACKUP_REMOTE}/${branch}`])
        await pushCurrent(g, branch)
      } catch {
        return { ok: false, reason: 'diverged' }
      }
    }
    return {
      ok: true,
      hash: (await g.revparse(['HEAD'])).trim(),
      committed,
      pushed: true,
      message: subject
    }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
}

/**
 * Catch up with the remote on startup (ff-only). skipped if there is no remote/upstream. reason 'diverged' if diverged.
 * Uncommitted changes are fine as long as the ff does not touch those files (if git refuses, its reason is returned).
 */
export async function pullOnStart(home: string): Promise<PullResult> {
  const root = libraryRoot(home)
  if (!isRepo(root)) return { ok: true, summary: '', skipped: 'notInitialized' }
  const g = git(root)
  try {
    const url = await remoteUrl(g)
    const branch = await currentBranch(g)
    if (!url || !branch) return { ok: true, summary: '', skipped: 'noRemote' }
    await g.raw(['fetch', '-q', BACKUP_REMOTE])
    let remoteHas = true
    try {
      await g.raw(['rev-parse', '--verify', '-q', `refs/remotes/${BACKUP_REMOTE}/${branch}`])
    } catch {
      remoteHas = false
    }
    if (!remoteHas) return { ok: true, summary: 'Remote has no branch yet', skipped: 'noRemote' }
    if (!(await hasHead(g))) {
      // Empty local repo → take the remote branch as is
      await g.raw(['reset', '-q', `${BACKUP_REMOTE}/${branch}`])
      await g.raw(['checkout', '-q', '--', '.'])
      await g.raw(['branch', '-q', `--set-upstream-to=${BACKUP_REMOTE}/${branch}`])
      return { ok: true, summary: 'Fetched remote snapshot' }
    }
    const out = await g.raw(['merge', '--ff-only', '-q', `${BACKUP_REMOTE}/${branch}`])
    try {
      await g.raw(['branch', '-q', `--set-upstream-to=${BACKUP_REMOTE}/${branch}`])
    } catch {
      // Ignore failure to set upstream
    }
    return { ok: true, summary: out.trim() || 'Up to date' }
  } catch (e) {
    const msg = reasonOf(e)
    return { ok: false, reason: looksDiverged(msg) ? 'diverged' : msg }
  }
}

/**
 * Restore: make a new commit that reverts library files to the hash snapshot (HEAD only moves forward).
 * read-tree --reset -u aligns index and working tree to that tree, then add -A and commit "restore <short>".
 * Ignored files (.trash/) are untouched. Does not push (the next snapshot does).
 */
export async function restore(home: string, hash: string): Promise<RestoreResult> {
  const root = libraryRoot(home)
  if (!isRepo(root)) return { ok: false, reason: 'Backup is not connected' }
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) return { ok: false, reason: 'Not a commit hash' }
  const g = git(root)
  try {
    let full: string
    try {
      full = (await g.raw(['rev-parse', '--verify', '-q', `${hash}^{commit}`])).trim()
    } catch {
      return { ok: false, reason: 'Snapshot not found' }
    }
    const s0 = await g.status()
    if (s0.conflicted.length)
      return { ok: false, reason: `Conflicted files: ${s0.conflicted.join(', ')}` }
    if (!(await currentBranch(g)))
      return { ok: false, reason: 'Will not restore on a detached HEAD' }
    await g.raw(['read-tree', '--reset', '-u', full])
    await g.raw(['add', '-A', '--', '.'])
    const changedFiles = (await g.raw(['diff', '--cached', '--name-only'])).trim()
    const changed = changedFiles ? changedFiles.split('\n').length : 0
    if (!changed)
      return { ok: true, hash: (await g.revparse(['HEAD'])).trim(), committed: false, changed: 0 }
    await g.raw([
      'commit',
      '-q',
      '-m',
      `restore ${full.slice(0, 7)} on ${deviceName(home)}`,
      '-m',
      `${DEVICE_TRAILER}: ${deviceName(home)}\nRestore-Of: ${full}`
    ])
    return { ok: true, hash: (await g.revparse(['HEAD'])).trim(), committed: true, changed }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
}

/** Remove only the remote config. Local repo, files, and remote data stay */
export async function disconnect(home: string): Promise<GitResult> {
  const root = libraryRoot(home)
  if (!isRepo(root)) return { ok: true }
  const g = git(root)
  try {
    if ((await remoteUrl(g)) !== undefined) await g.raw(['remote', 'remove', BACKUP_REMOTE])
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
}
