import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { sha256 } from './text'

/** Backup file suffix. Only the latest one is kept per target */
export const BACKUP_SUFFIX = '.illithid.bak'
/** Backup suffixes from previous app names (most recent first; for rename migration and legacy detection) */
export const LEGACY_BACKUP_SUFFIXES = ['.harnesssync.bak', '.agent-console.bak'] as const

/** Tag in tmp names the app creates (`.<name>.illithid-<pid>-<rand>.tmp`) */
export const TMP_TAG = '.illithid-'
/** tmp tags from previous app names */
export const LEGACY_TMP_TAGS = ['.harnesssync-', '.agent-console-'] as const

/** Whether a tmp name was created by the app (current or previous name) */
export function isAppTmpName(name: string): boolean {
  return name.endsWith('.tmp') && [TMP_TAG, ...LEGACY_TMP_TAGS].some((t) => name.includes(t))
}

/** tmp name `.<base>.illithid-<pid>-<suffix>.tmp` */
export function appTmpName(base: string, suffix: string): string {
  return `.${base}${TMP_TAG}${process.pid}-${suffix}.tmp`
}

/** Default mode for new files (config files may contain tokens) */
const NEW_FILE_MODE = 0o600
/** Default mode for new directories */
const NEW_DIR_MODE = 0o700

/** Thrown when the re-check right before writing fails. Callers handle it as changedSinceCheck */
export class ConcurrentChangeError extends Error {}

/** Real file path if a symlink (so rename doesn't overwrite the link itself) */
export function resolveWritePath(path: string): string {
  try {
    if (lstatSync(path).isSymbolicLink()) return realpathSync(path)
  } catch {
    // File does not exist
  }
  return path
}

function fsyncDir(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, constants.O_RDONLY)
    fsyncSync(fd)
  } catch {
    // Some filesystems don't support directory fsync — the data fsync is already done
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function tmpPathFor(path: string): string {
  return join(dirname(path), appTmpName(basename(path), randomBytes(4).toString('hex')))
}

/** sha256 of the current file content. null if missing */
export function fileHash(path: string): string | null {
  return existsSync(path) ? sha256(readFileSync(path, 'utf8')) : null
}

export interface AtomicWriteOptions {
  /** Defaults to the existing file mode, or 0600 if none */
  mode?: number
  /**
   * Expected sha256 of existing content, checked right before rename (null = file must not exist).
   * On mismatch, removes the tmp and throws ConcurrentChangeError. undefined skips the check.
   */
  expectHash?: string | null
  /** For tests: called after the tmp write, right before the re-check */
  beforeCommit?: () => void
}

/**
 * Writes to a tmp file in the same directory, fsync → rename. Preserves the file mode.
 * For a symlink, writes to the real file it points to. Returns the real path written.
 */
export function atomicWrite(path: string, content: string, opts: AtomicWriteOptions = {}): string {
  const real = resolveWritePath(path)
  const dir = dirname(real)
  mkdirSync(dir, { recursive: true, mode: NEW_DIR_MODE })
  const mode = opts.mode ?? (existsSync(real) ? statSync(real).mode & 0o7777 : NEW_FILE_MODE)
  const tmp = tmpPathFor(real)
  let fd: number | undefined
  let committed = false
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode)
    const buf = Buffer.from(content, 'utf8')
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
    fchmodSync(fd, mode) // cancel umask effect
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    opts.beforeCommit?.()
    if (opts.expectHash !== undefined && fileHash(real) !== opts.expectHash) {
      throw new ConcurrentChangeError('file changed at the re-check right before writing')
    }
    renameWithRetry(tmp, real)
    committed = true
    fsyncDir(dir)
    return real
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (!committed && existsSync(tmp)) unlinkSync(tmp)
  }
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** Synchronous pause (the writers are synchronous) */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * rename, retried a few times when the target is briefly locked — Windows refuses to replace a file another process (an editor,
 * antivirus, the CLI itself) has open, with EPERM/EBUSY/EACCES. Other errors and a lock that outlasts the retries are rethrown
 */
export function renameWithRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => void = renameSync,
  wait: (ms: number) => void = pause
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (!code || !RETRY_CODES.has(code) || attempt >= 6) throw e
      wait(20 * 2 ** attempt)
    }
  }
}

/**
 * Copies current content to `<file>.illithid.bak` (only the latest one kept, same mode as the original).
 * null if the original doesn't exist.
 */
export function backup(path: string): string | null {
  const real = resolveWritePath(path)
  if (!existsSync(real)) return null
  const bak = real + BACKUP_SUFFIX
  const mode = statSync(real).mode & 0o7777
  const tmp = tmpPathFor(bak)
  try {
    copyFileSync(real, tmp, constants.COPYFILE_EXCL)
    const fd = openSync(tmp, constants.O_RDWR)
    try {
      fchmodSync(fd, mode)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameWithRetry(tmp, bak)
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
  fsyncDir(dirname(bak))
  return bak
}
