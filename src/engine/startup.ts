/**
 * Prepares the library at app startup.
 * 1. If a previous-name path from the workspace era (`~/.harnesssync` etc.) remains, move it first (after a snapshot, no deletion).
 *    If blocked or failed, do not create a new skeleton; return migrateFailed.
 * 2. If other previous-name paths (agent-console) remain (and the new path is missing or an empty skeleton), create nothing — the CLI rename migration must run first.
 * 3. If a root-layout library (`~/.illithid/rules` …) exists, move it to `workspaces/default/` (after a snapshot, no deletion).
 * 4. If there is no active workspace, create an empty skeleton (idempotent, no import).
 */
import { initLibrary } from './init'
import { applyRename, autoRenamePending, renamePendingPaths } from './rename'
import { libraryExists } from './sources'
import { migrateToWorkspaces } from './workspace'

export type EnsureLibraryResult =
  | { status: 'exists'; migrated?: string[]; renamed?: string[] }
  | { status: 'created'; root: string; renamed?: string[] }
  | { status: 'renamePending'; paths: string[] }
  | { status: 'migrateFailed'; reason: string }
  | { status: 'failed'; reason: string }

export function ensureLibrary(home: string): EnsureLibraryResult {
  let renamed: string[] | undefined
  if (autoRenamePending(home)) {
    try {
      const r = applyRename(home)
      if (!r.ok) return { status: 'migrateFailed', reason: r.reason ?? 'unknown' }
      if (r.moved.length) renamed = r.moved.map((m) => m.to)
    } catch (e) {
      return { status: 'migrateFailed', reason: (e as Error).message }
    }
  }
  const pending = renamePendingPaths(home)
  if (pending.length) return { status: 'renamePending', paths: pending }
  let migrated: string[] | undefined
  try {
    const m = migrateToWorkspaces(home)
    if (!m.ok) return { status: 'migrateFailed', reason: m.reason ?? 'unknown' }
    if (m.moved.length) migrated = m.moved
  } catch (e) {
    return { status: 'migrateFailed', reason: (e as Error).message }
  }
  if (libraryExists(home))
    return { status: 'exists', ...(migrated ? { migrated } : {}), ...(renamed ? { renamed } : {}) }
  try {
    return { status: 'created', root: initLibrary(home).root, ...(renamed ? { renamed } : {}) }
  } catch (e) {
    return { status: 'failed', reason: (e as Error).message }
  }
}
