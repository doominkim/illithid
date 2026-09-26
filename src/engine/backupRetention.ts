/**
 * Backup retention — computes which old backups under `<home>/.config/illithid` can be cleaned up.
 * - backups/{deleted,imported,workspaces}/<ts>: timestamp folders older than `days`
 * - backups/skills/<tool>/<name>/<ts>: per skill, timestamp entries beyond the newest SKILL_BACKUP_KEEP
 *   (the current layout keeps a single copy directly in <name>/, which is never a target)
 * - rollback/*.tar: beyond the newest `keepRollback` (by mtime)
 * The engine only lists targets. Moving them (to the macOS Trash) is done by the caller-provided mover;
 * nothing here deletes permanently. Every target is re-validated to be inside the backup roots before moving.
 */
import { existsSync, lstatSync, readdirSync, type Stats } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { appConfigDir, DEFAULT_BACKUP_RETENTION, readConfig, type AppConfig, type BackupRetention } from './config'

/** Backup entries kept per skill in backups/skills/<tool>/<name> */
export const SKILL_BACKUP_KEEP = 3

/** Folders under backups/ cleaned up by age */
export const AGED_BACKUP_DIRS = ['deleted', 'imported', 'workspaces'] as const

export type CleanupKind = (typeof AGED_BACKUP_DIRS)[number] | 'skills' | 'rollback'

export interface CleanupItem {
  kind: CleanupKind
  path: string
  /** Bytes (recursive, symlinks not followed) */
  size: number
  /** Timestamp the entry was judged by (ISO 8601) */
  at: string
}

export interface CleanupPlan {
  items: CleanupItem[]
  count: number
  bytes: number
}

export interface CleanupResult {
  moved: number
  bytes: number
  failed: { path: string; reason: string }[]
}

/** Moves one path out of the backup folders (main: shell.trashItem; fixtures: move into a temp folder) */
export type CleanupMover = (path: string) => void | Promise<void>

/** Effective retention settings (defaults filled in) */
export function backupRetention(config: AppConfig): BackupRetention {
  return { ...DEFAULT_BACKUP_RETENTION, ...(config.backupRetention ?? {}) }
}

export function backupRetentionOf(home: string): BackupRetention {
  return backupRetention(readConfig(home).config)
}

/**
 * Timestamp in a backup entry name. Accepts the ISO form used by backups (`2026-09-23T16-34-04-135Z`)
 * and the compact local form used by rollback snapshots (`20260923-154856`). undefined if the name is not a timestamp
 */
export function parseBackupStamp(name: string): number | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z$/.exec(name)
  if (iso) {
    const [, y, mo, d, h, mi, s, ms] = iso
    const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +(ms ?? 0))
    return Number.isNaN(t) ? undefined : t
  }
  const compact = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name)
  if (compact) {
    const [, y, mo, d, h, mi, s] = compact
    const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime()
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** Real directory (not a symlink) */
function isDir(p: string): boolean {
  const st = lstatOrNull(p)
  return !!st && st.isDirectory() && !st.isSymbolicLink()
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n !== '.DS_Store')
  } catch {
    return []
  }
}

/** Recursive size without following symlinks */
function sizeOf(p: string): number {
  const st = lstatOrNull(p)
  if (!st) return 0
  if (!st.isDirectory() || st.isSymbolicLink()) return st.size
  let n = 0
  for (const c of list(p)) n += sizeOf(join(p, c))
  return n
}

const inside = (root: string, p: string): boolean => {
  const r = resolve(root)
  const q = resolve(p)
  return q !== r && q.startsWith(r + sep)
}

/** Backup roots are only scanned if they are real directories (a symlinked root could point anywhere) */
function rootsOk(home: string, ...rels: string[]): boolean {
  let p = appConfigDir(home)
  if (!isDir(p)) return false
  for (const r of rels) {
    p = join(p, r)
    if (!isDir(p)) return false
  }
  return true
}

/** Cleanup targets under the current settings (read-only). opts override the config values */
export function planBackupCleanup(
  home: string,
  opts: Partial<Pick<BackupRetention, 'days' | 'keepRollback'>> & { now?: number } = {}
): CleanupPlan {
  const cfg = backupRetentionOf(home)
  const days = opts.days ?? cfg.days
  const keepRollback = opts.keepRollback ?? cfg.keepRollback
  const now = opts.now ?? Date.now()
  const cutoff = now - days * 86_400_000
  const base = appConfigDir(home)
  const items: CleanupItem[] = []

  for (const kind of AGED_BACKUP_DIRS) {
    if (!rootsOk(home, 'backups', kind)) continue
    const root = join(base, 'backups', kind)
    for (const name of list(root)) {
      const t = parseBackupStamp(name)
      if (t === undefined || t >= cutoff) continue
      const p = join(root, name)
      items.push({ kind, path: p, size: sizeOf(p), at: new Date(t).toISOString() })
    }
  }

  if (rootsOk(home, 'backups', 'skills')) {
    const root = join(base, 'backups', 'skills')
    for (const tool of list(root)) {
      if (!isDir(join(root, tool))) continue
      for (const name of list(join(root, tool))) {
        const dir = join(root, tool, name)
        if (!isDir(dir)) continue
        const stamped = list(dir)
          .map((n) => ({ n, t: parseBackupStamp(n) }))
          .filter((x): x is { n: string; t: number } => x.t !== undefined)
          .sort((a, b) => b.t - a.t)
        for (const { n, t } of stamped.slice(SKILL_BACKUP_KEEP)) {
          const p = join(dir, n)
          items.push({ kind: 'skills', path: p, size: sizeOf(p), at: new Date(t).toISOString() })
        }
      }
    }
  }

  if (rootsOk(home, 'rollback')) {
    const root = join(base, 'rollback')
    const tars = list(root)
      .filter((n) => n.endsWith('.tar'))
      .map((n) => ({ p: join(root, n), st: lstatOrNull(join(root, n)) }))
      .filter((x) => x.st?.isFile())
      .sort((a, b) => b.st!.mtimeMs - a.st!.mtimeMs)
    for (const { p, st } of tars.slice(keepRollback))
      items.push({ kind: 'rollback', path: p, size: st!.size, at: new Date(st!.mtimeMs).toISOString() })
  }

  return { items, count: items.length, bytes: items.reduce((n, i) => n + i.size, 0) }
}

/** A path is a valid cleanup target only in the exact shapes planBackupCleanup produces */
export function isCleanupTarget(home: string, kind: CleanupKind, path: string): boolean {
  const base = appConfigDir(home)
  const p = resolve(path)
  if (!inside(base, p)) return false
  const rel = relative(base, p).split(sep)
  const name = basename(p)
  switch (kind) {
    case 'deleted':
    case 'imported':
    case 'workspaces':
      return rel.length === 3 && rel[0] === 'backups' && rel[1] === kind && parseBackupStamp(name) !== undefined && rootsOk(home, 'backups', kind)
    case 'skills':
      return (
        rel.length === 5 &&
        rel[0] === 'backups' &&
        rel[1] === 'skills' &&
        parseBackupStamp(name) !== undefined &&
        rootsOk(home, 'backups', 'skills', rel[2], rel[3])
      )
    case 'rollback':
      return rel.length === 2 && rel[0] === 'rollback' && name.endsWith('.tar') && rootsOk(home, 'rollback')
  }
}

/**
 * Move plan items with mover (one at a time). Items that fail validation, no longer exist, or are still present after
 * the move are reported in failed. Never deletes anything itself
 */
export async function applyBackupCleanup(home: string, plan: CleanupPlan, mover: CleanupMover): Promise<CleanupResult> {
  const out: CleanupResult = { moved: 0, bytes: 0, failed: [] }
  for (const it of plan.items) {
    if (!isCleanupTarget(home, it.kind, it.path)) {
      out.failed.push({ path: it.path, reason: 'outsideBackups' })
      continue
    }
    if (!lstatOrNull(it.path)) {
      out.failed.push({ path: it.path, reason: 'missing' })
      continue
    }
    try {
      await mover(it.path)
    } catch (e) {
      out.failed.push({ path: it.path, reason: (e as NodeJS.ErrnoException).code ?? (e as Error).message ?? 'moveFailed' })
      continue
    }
    if (existsSync(it.path) || lstatOrNull(it.path)) {
      out.failed.push({ path: it.path, reason: 'stillPresent' })
      continue
    }
    out.moved++
    out.bytes += it.size
  }
  return out
}
