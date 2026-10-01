/**
 * Pending retirements of imported originals (HAR-12).
 *
 * Import only writes to the library and records here which tool-side originals the app copy will replace
 * (state.json pendingRetire). The move happens at sync apply time, next to writing the app copy, so the tool never
 * goes without the item (no gap) and never loads it twice for longer than that one step:
 * - rule         `~/.claude/rules/<name>` → moved once the app copy `~/.claude/rules/illithid/<name>` is in place (ruleSync retireImported)
 * - skill/agent  original at the app copy location → backed up and replaced in one step (replaceImported);
 *                original elsewhere (e.g. `~/.config/opencode/skills/<name>`, `~/.config/opencode/agent/<name>.md`) → moved (retireImported)
 * - instruction  opencode.json instructions entry pointing at the original rule file → removed by the opencodeRules target
 *                (the referenced file itself is never touched)
 * An original is moved only if its current hash still equals the recorded one; otherwise it is left alone and reported (importedChanged).
 * Moves go to backups/imported/<ts>/<tool>/<folder>/<name> — never deleted permanently, and backup retention never cleans that folder.
 * Records belong to the workspace that was active at import: sync only acts on (and plans) the active workspace's records, so
 * switching to a workspace with a same-name item never swaps an original for the wrong copy. Other workspaces' records are kept.
 */
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { agentToolPath } from './agentRender'
import type { ToolId } from './agents'
import { activeWorkspaceId, appConfigDir, DEFAULT_WORKSPACE } from './config'
import { LibraryError } from './libpath'
import { setToggle, type ManifestKind } from './manifest'
import { dirContentHash } from './skills'
import { readState, writeState, type AppState } from './state'
import { sha256 } from './text'

export type RetireKind = 'rule' | 'skill' | 'agent' | 'instruction'

export interface PendingRetire {
  kind: RetireKind
  tool: ToolId
  /** Library name (rule file name, skill folder name, agent name without extension) */
  name: string
  /** Absolute path of the original (instruction: the file the entry points at) */
  path: string
  /** retireHash of the original at import time */
  hash: string
  /** ISO timestamp of the import */
  at: string
  /** Workspace active at import. Absent in records from before this field = default */
  workspace?: string
}

/** Workspace a record belongs to */
export const pendingWorkspace = (p: Pick<PendingRetire, 'workspace'>): string =>
  p.workspace ?? DEFAULT_WORKSPACE

/** Records of the active workspace only */
export function activePending(
  home: string,
  list: readonly PendingRetire[] | undefined
): PendingRetire[] {
  if (!list?.length) return []
  const ws = activeWorkspaceId(home)
  return list.filter((p) => pendingWorkspace(p) === ws)
}

/** Backup root that imported originals are moved into (<home>/.config/illithid/backups/imported) */
export function importedBackupRoot(home: string): string {
  return join(appConfigDir(home), 'backups/imported')
}

export const importStamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

/** retireHash of an original that exists but can't be read (permissions etc.) — never matches a record, never moved */
export const UNREADABLE_HASH = 'unreadable'

/**
 * Content hash of an original: symlink = `link:<target>`, directory = dirContentHash, file = sha256 of its text.
 * null only if it is gone (ENOENT/ENOTDIR); UNREADABLE_HASH if it exists but can't be read
 */
export function retireHash(path: string): string | null {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink()) return 'link:' + readlinkSync(path)
    if (st.isDirectory()) return dirContentHash(path)
    if (st.isFile()) return sha256(readFileSync(path, 'utf8'))
    return UNREADABLE_HASH
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : UNREADABLE_HASH
  }
}

/** Skip reason for an original that no longer matches its record */
export const retireSkipReason = (
  hash: string | null | undefined
): 'importedChanged' | 'unreadable' => (hash === UNREADABLE_HASH ? 'unreadable' : 'importedChanged')

/** Move src (file, directory, link) to dest (never permanently deleted; copy then remove across devices) */
export function moveToImportedBackup(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
  try {
    renameSync(src, dest)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    cpSync(src, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
    rmSync(src, { recursive: true, force: true })
  }
}

/** backups/imported/<ts>/<tool>/<parent folder>/<entry> */
export function importedBackupDest(
  home: string,
  ts: string,
  p: Pick<PendingRetire, 'tool' | 'path'>
): string {
  return join(importedBackupRoot(home), ts, p.tool, basename(dirname(p.path)), basename(p.path))
}

export type RetireOutcome =
  | { status: 'moved'; backupPath: string }
  /** The original is gone (the user removed it) — nothing to do, the record can be dropped */
  | { status: 'gone' }
  /** The original changed since import — left in place */
  | { status: 'changed' }
  /** The original exists but can't be read — left in place, record kept */
  | { status: 'unreadable' }

/** Move one original to backups/imported if it still matches the recorded hash */
export function retireOriginal(
  home: string,
  p: PendingRetire,
  ts: string = importStamp()
): RetireOutcome {
  const cur = retireHash(p.path)
  if (cur === null) return { status: 'gone' }
  if (cur === UNREADABLE_HASH) return { status: 'unreadable' }
  if (cur !== p.hash) return { status: 'changed' }
  const dest = importedBackupDest(home, ts, p)
  moveToImportedBackup(p.path, dest)
  return { status: 'moved', backupPath: dest }
}

type PendingKey = Pick<PendingRetire, 'kind' | 'tool' | 'path' | 'workspace'>

export const samePending = (a: PendingKey, b: PendingKey): boolean =>
  a.kind === b.kind &&
  a.tool === b.tool &&
  a.path === b.path &&
  pendingWorkspace(a) === pendingWorkspace(b)

/** Active-workspace pending entries of one kind/tool/name */
export function pendingOf(
  home: string,
  state: AppState,
  kind: RetireKind,
  tool: ToolId,
  name: string
): PendingRetire[] {
  return activePending(home, state.pendingRetire).filter(
    (p) => p.kind === kind && p.tool === tool && p.name === name
  )
}

/** Remove entries from state (in place). Returns true if something was removed */
export function dropPending(state: AppState, gone: PendingKey[]): boolean {
  const cur = state.pendingRetire ?? []
  const next = cur.filter((p) => !gone.some((g) => samePending(p, g)))
  if (next.length === cur.length) return false
  if (next.length) state.pendingRetire = next
  else delete state.pendingRetire
  return true
}

/** Add or replace entries (same kind/tool/path/workspace) in state (in place) */
export function addPending(state: AppState, add: PendingRetire[]): void {
  if (!add.length) return
  const rest = (state.pendingRetire ?? []).filter((p) => !add.some((a) => samePending(p, a)))
  state.pendingRetire = [...rest, ...add]
}

export interface KeepImportedResult {
  /** Library item name */
  name: string
  /** Toggle switched off so the tool doesn't load the original and the app copy side by side */
  toggledOff?: { kind: ManifestKind; tool: ToolId }
}

/**
 * Keep an imported original instead of letting sync replace it: drop its active-workspace pendingRetire record.
 * - rule (Claude `~/.claude/rules/<name>`), instruction (opencode.json entry), agent outside the app's agent folder: the original
 *   lives beside the app copy, so the library item is switched off for that tool (otherwise the tool loads both)
 * - skill, agent at the app copy location: the original becomes a user file that sync skips (userOwned) — toggles unchanged
 * LibraryError notFound if there is no such record
 */
export function keepImportedOriginal(
  home: string,
  req: Pick<PendingRetire, 'kind' | 'tool' | 'path'>
): KeepImportedResult {
  const st = readState(home)
  if (st.error) throw new LibraryError('configError', `state.json: ${st.error}`)
  const records = activePending(home, st.state.pendingRetire).filter(
    (p) => p.kind === req.kind && p.tool === req.tool && p.path === req.path
  )
  if (!records.length)
    throw new LibraryError('notFound', 'not an imported original awaiting replacement')
  const { name, tool, kind } = records[0]
  const state = { ...st.state }
  dropPending(state, records)
  writeState(home, state)
  const off: KeepImportedResult['toggledOff'] =
    kind === 'rule' || kind === 'instruction'
      ? { kind: 'rules', tool }
      : kind === 'agent' && req.path !== agentToolPath(home, tool, name)
        ? { kind: 'agents', tool }
        : undefined
  if (off) setToggle(home, off.kind, name, off.tool, false)
  return { name, ...(off ? { toggledOff: off } : {}) }
}

/**
 * A library item was renamed: the active workspace's records follow it (rule → also its OpenCode instructions entry).
 * Best effort — on failure the record keeps the old name and its original is simply left in place
 */
export function renamePendingRetire(
  home: string,
  kind: 'rule' | 'skill' | 'agent',
  from: string,
  to: string
): void {
  try {
    const st = readState(home)
    if (st.error || !st.state.pendingRetire?.length) return
    const ws = activeWorkspaceId(home)
    const kinds: RetireKind[] = kind === 'rule' ? ['rule', 'instruction'] : [kind]
    let hit = false
    const next = st.state.pendingRetire.map((p) => {
      if (!kinds.includes(p.kind) || p.name !== from || pendingWorkspace(p) !== ws) return p
      hit = true
      return { ...p, name: to }
    })
    if (hit) writeState(home, { ...st.state, pendingRetire: next })
  } catch {
    // Left as is
  }
}
