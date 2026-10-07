/**
 * Hook script copies: `<tool home>/hooks/illithid/<hook>/<file>`, executable, one per tool that runs the hook.
 * The folder is the app's namespace, so a file found there without a record is treated as an app copy (not the user's).
 *
 * - copy            missing on the tool side → write the library script (0755)
 * - update          the copy differs from the library script or lost its executable bit. drift=true means it was edited on the
 *                   tool side — it is backed up first
 * - inSync          the copy matches (if stateStale, only the record is updated)
 * - skip            not a regular file (notRegularFile)
 * - deleteCandidate a recorded copy whose hook was removed, turned off or no longer runs this file → moved to backups/deleted
 */
import { hooksSupported } from './platform'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  type Stats
} from 'node:fs'
import { dirname, join } from 'node:path'
import { toolHomeOverride } from './agents'
import { appConfigDir, syncTools } from './config'
import { deliverDir, deliverFile } from './deliver'
import { HOOK_TOOLS, isHookTool, type HookTool } from './hookEvents'
import {
  hookCopyPath,
  hookCopyRoot,
  hooksForTool,
  PERMISSION_HOOK,
  SCRIPT_COPY_DIR,
  scriptCopyDir
} from './hookRender'
import { HOOK_FILE, hooksDir, readHooks, SHARED_SCRIPT, usedScript } from './hooks'
import { toolScript } from './hookScripts'
import { LibraryError } from './libpath'
import { convertHookToScript, replaceScriptFolder, saveHookScript, saveScript } from './library'
import { scriptDirPath, scriptPath } from './scripts'
import { dirContentHash } from './skills'
import { MANIFEST_FILE, readPlanManifest } from './manifest'
import { readState, writeState, type AppState } from './state'
import { sha256 } from './text'
import { libraryPaths, readPermissionsFile } from './sources'
import type { Allowlist, Env } from './types'
import { ConcurrentChangeError, fileHash } from './write'

export const HOOK_SCRIPT_MODE = 0o755

export type HookSyncAction = 'copy' | 'update' | 'inSync' | 'skip' | 'deleteCandidate'

export interface HookSyncItem {
  tool: HookTool
  /** `<hook>/<file>` */
  name: string
  hook: string
  file: string
  action: HookSyncAction
  /** Tool-side copy */
  path: string
  /** Library script */
  source: string
  sourceHash?: string
  currentHash?: string
  drift?: boolean
  stateStale?: boolean
  reason?: string
  /** A folder library script's shared copy (`_scripts/<script>`): its entry, and the hooks in this tool that run it */
  folder?: { entry: string; users: string[] }
}

export interface HookSyncResult {
  tool: HookTool
  name: string
  action: HookSyncAction
  status: 'done' | 'unchanged' | 'skipped' | 'pendingApproval' | 'refused' | 'failed'
  reason?: string
  path: string
  backupPath?: string
}

/** Where a copy edited on the tool side goes before it is overwritten (last one per tool and file) */
export function hookBackupPath(home: string, tool: HookTool, name: string): string {
  return join(appConfigDir(home), 'backups/hooks', tool, name)
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** permissions.json, or null when absent or unreadable (the permission targets report a broken file) */
function permissionsOrNull(home: string): Allowlist | null {
  try {
    return readPermissionsFile(home)
  } catch {
    return null
  }
}

const executable = (st: Stats): boolean => (st.mode & 0o111) === 0o111

const isDirCopy = (st: Stats | null): boolean => !!st && st.isDirectory() && !st.isSymbolicLink()

/** Move a directory (rename, or copy and remove across file systems) */
function moveDir(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    cpSync(from, to, { recursive: true, verbatimSymlinks: true })
    rmSync(from, { recursive: true, force: true })
  }
}

/** Whether a folder copy's entry can run */
function entryRuns(dir: string, entry: string): boolean {
  try {
    return executable(statSync(join(dir, entry)))
  } catch {
    return false
  }
}

/** Plan. Read-only */
export function planHookSync(home: string, env: Env = process.env): HookSyncItem[] {
  if (!hooksSupported()) return []
  const mf = readPlanManifest(home)
  if (mf.error) throw new Error(`${MANIFEST_FILE}: ${mf.error}`)
  const hooks = readHooks(home)
  const perms = permissionsOrNull(home)
  const managedAll = readState(home).state.hookScripts ?? {}
  const items: HookSyncItem[] = []
  for (const tool of syncTools(home).filter(isHookTool)) {
    // No Copilot / Grok copies while COPILOT_HOME / GROK_HOME points elsewhere
    if (toolHomeOverride(home, tool, env)) continue
    const managed = managedAll[tool] ?? {}
    const wanted = new Set<string>()
    // Folder library scripts: one shared copy per tool, whatever the number of hooks running it
    const folders = new Map<string, { entry: string; users: string[] }>()
    for (const th of hooksForTool(home, tool, hooks, mf.manifest, perms)) {
      // Prompt hooks (ask) have no script copy
      if (th.kind !== 'command') continue
      if (th.folder) {
        const f = folders.get(th.folder) ?? { entry: th.file, users: [] }
        f.users.push(th.hook.name)
        folders.set(th.folder, f)
        continue
      }
      const name = `${th.hook.name}/${th.file}`
      wanted.add(name)
      const path = hookCopyPath(home, tool, th.hook.name, th.file)
      // Built-in actions are rendered per tool; the script action copies its own file
      const use = usedScript(th.hook.doc)
      const source =
        th.hook.name === PERMISSION_HOOK
          ? libraryPaths(home).permissions
          : use && th.file === SHARED_SCRIPT
            ? scriptPath(home, use)
            : join(
                hooksDir(home),
                th.hook.name,
                th.hook.doc.action === 'script' ? th.file : HOOK_FILE
              )
      const sourceHash = sha256(th.content)
      const base = { tool, name, hook: th.hook.name, file: th.file, path, source, sourceHash }
      const st = lstatOrNull(path)
      if (!st) {
        items.push({ ...base, action: 'copy' })
        continue
      }
      if (!st.isFile() || st.isSymbolicLink()) {
        items.push({ ...base, action: 'skip', reason: 'notRegularFile' })
        continue
      }
      const currentHash = fileHash(path)!
      const rec = managed[name]
      if (currentHash === sourceHash && executable(st))
        items.push({
          ...base,
          action: 'inSync',
          currentHash,
          ...(rec?.contentHash !== currentHash ? { stateStale: true } : {})
        })
      else
        items.push({
          ...base,
          action: 'update',
          currentHash,
          ...(currentHash !== sourceHash && rec?.contentHash !== currentHash ? { drift: true } : {})
        })
    }
    for (const [script, folder] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
      const name = `${SCRIPT_COPY_DIR}/${script}`
      wanted.add(name)
      const path = scriptCopyDir(home, tool, script)
      const source = scriptDirPath(home, script)
      const sourceHash = dirContentHash(source)
      const base = {
        tool,
        name,
        hook: SCRIPT_COPY_DIR,
        file: script,
        path,
        source,
        sourceHash,
        folder
      }
      const st = lstatOrNull(path)
      if (!st) {
        items.push({ ...base, action: 'copy' })
        continue
      }
      if (!isDirCopy(st)) {
        items.push({ ...base, action: 'skip', reason: 'notDirectory' })
        continue
      }
      const currentHash = dirContentHash(path)
      const rec = managed[name]
      if (currentHash === sourceHash && entryRuns(path, folder.entry))
        items.push({
          ...base,
          action: 'inSync',
          currentHash,
          ...(rec?.contentHash !== currentHash ? { stateStale: true } : {})
        })
      else
        items.push({
          ...base,
          action: 'update',
          currentHash,
          ...(currentHash !== sourceHash && rec?.contentHash !== currentHash ? { drift: true } : {})
        })
    }
    // Recorded copies no longer run by this tool
    for (const name of Object.keys(managed).sort()) {
      if (wanted.has(name)) continue
      const [hook, file] = name.split('/')
      const path = hookCopyPath(home, tool, hook, file)
      const st = lstatOrNull(path)
      if (hook === SCRIPT_COPY_DIR) {
        if (isDirCopy(st))
          items.push({
            tool,
            name,
            hook,
            file,
            action: 'deleteCandidate',
            path,
            source: scriptDirPath(home, file),
            currentHash: dirContentHash(path),
            reason: existsSync(scriptDirPath(home, file)) ? 'disabled' : 'removedFromLibrary'
          })
        continue
      }
      if (st?.isFile() && !st.isSymbolicLink())
        items.push({
          tool,
          name,
          hook,
          file,
          action: 'deleteCandidate',
          path,
          source: join(hooksDir(home), hook, file),
          currentHash: fileHash(path)!,
          reason: hooks.some((h) => h.name === hook) ? 'disabled' : 'removedFromLibrary'
        })
    }
  }
  return items
}

/** Runs copy and update, refreshes inSync(stateStale) records, leaves deleteCandidate to deleteCopies */
export function applyHookSync(home: string, env: Env, items: HookSyncItem[]): HookSyncResult[] {
  const st = readState(home)
  const results: HookSyncResult[] = []
  const out = (
    it: HookSyncItem,
    status: HookSyncResult['status'],
    extra: Partial<HookSyncResult> = {}
  ): void => {
    results.push({
      tool: it.tool,
      name: it.name,
      action: it.action,
      status,
      path: it.path,
      ...extra
    })
  }
  if (st.error) {
    for (const it of items) out(it, 'refused', { reason: 'stateError' })
    return results
  }
  const state: AppState = { ...st.state, hookScripts: { ...(st.state.hookScripts ?? {}) } }
  const record = (tool: HookTool, name: string, contentHash: string): void => {
    state.hookScripts![tool] = {
      ...(state.hookScripts![tool] ?? {}),
      [name]: { contentHash, at: new Date().toISOString() }
    }
    writeState(home, state)
  }
  const fresh = planHookSync(home, env)
  const mf = readPlanManifest(home)
  const hooks = readHooks(home)
  const perms = permissionsOrNull(home)
  const contentOf = (tool: HookTool, hook: string, file: string): string | undefined =>
    hooksForTool(home, tool, hooks, mf.manifest, perms).find(
      (x) => x.hook.name === hook && x.kind === 'command' && x.file === file
    )?.content
  for (const it of items) {
    if (it.action === 'skip') {
      out(it, 'skipped', { reason: it.reason ?? 'skip' })
      continue
    }
    if (it.action === 'deleteCandidate') {
      out(it, 'pendingApproval', { reason: 'deletion uses a separate approval flow' })
      continue
    }
    if (
      !(HOOK_TOOLS as readonly string[]).includes(it.tool) ||
      dirname(dirname(it.path)) !== hookCopyRoot(home, it.tool)
    ) {
      out(it, 'refused', { reason: 'outOfScope' })
      continue
    }
    const f = fresh.find((x) => x.tool === it.tool && x.name === it.name && x.path === it.path)
    if (
      !f ||
      f.action !== it.action ||
      f.sourceHash !== it.sourceHash ||
      (it.currentHash !== undefined && f.currentHash !== it.currentHash)
    ) {
      out(it, 'refused', { reason: 'changedSinceCheck' })
      continue
    }
    if (f.action === 'inSync') {
      if (f.stateStale) {
        record(f.tool, f.name, f.currentHash!)
        out(it, 'done', { reason: 'stateRefreshed' })
      } else out(it, 'unchanged')
      continue
    }
    if (f.folder) {
      applyFolderCopy(home, f, it, out, record)
      continue
    }
    try {
      const content = contentOf(f.tool, f.hook, f.file)
      if (content === undefined || sha256(content) !== f.sourceHash) {
        out(it, 'refused', { reason: 'changedSinceCheck' })
        continue
      }
      let backupPath: string | undefined
      if (f.action === 'update' && f.drift) {
        backupPath = hookBackupPath(home, f.tool, f.name)
        mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 })
        copyFileSync(f.path, backupPath)
      }
      mkdirSync(dirname(f.path), { recursive: true, mode: 0o755 })
      deliverFile(f.source, f.path, content, {
        mode: HOOK_SCRIPT_MODE,
        expectHash: f.action === 'copy' ? null : f.currentHash!
      })
      record(f.tool, f.name, f.sourceHash!)
      out(it, 'done', {
        ...(backupPath ? { backupPath } : {}),
        ...(f.drift ? { reason: 'restored' } : {})
      })
    } catch (e) {
      if (e instanceof ConcurrentChangeError) out(it, 'refused', { reason: 'changedSinceCheck' })
      else out(it, 'failed', { reason: (e as NodeJS.ErrnoException).code ?? (e as Error).name })
    }
  }
  return results
}

/** Copy or update a folder script's shared copy (an edited one is backed up first) */
function applyFolderCopy(
  home: string,
  f: HookSyncItem,
  it: HookSyncItem,
  out: (
    it: HookSyncItem,
    status: HookSyncResult['status'],
    extra?: Partial<HookSyncResult>
  ) => void,
  record: (tool: HookTool, name: string, contentHash: string) => void
): void {
  try {
    if (dirContentHash(f.source) !== f.sourceHash) {
      out(it, 'refused', { reason: 'changedSinceCheck' })
      return
    }
    if (f.action === 'update') {
      const st = lstatOrNull(f.path)
      if (!isDirCopy(st) || dirContentHash(f.path) !== f.currentHash) {
        out(it, 'refused', { reason: 'changedSinceCheck' })
        return
      }
    }
    let backupPath: string | undefined
    const aside = f.action === 'update' ? hookBackupPath(home, f.tool, f.name) : undefined
    if (aside) {
      mkdirSync(dirname(aside), { recursive: true, mode: 0o700 })
      rmSync(aside, { recursive: true, force: true })
    }
    const r = deliverDir(f.source, f.path, {
      expectedHash: f.sourceHash,
      ...(aside
        ? { vacate: () => moveDir(f.path, aside), restore: () => moveDir(aside, f.path) }
        : {})
    })
    if (!r.ok) {
      out(it, 'failed', { reason: r.reason === 'hashMismatch' ? 'copyHashMismatch' : r.reason })
      return
    }
    // Keep only the backup of an edited copy
    if (aside && f.drift) backupPath = aside
    else if (aside) rmSync(aside, { recursive: true, force: true })
    chmodSync(join(f.path, f.folder!.entry), HOOK_SCRIPT_MODE)
    record(f.tool, f.name, f.sourceHash!)
    out(it, 'done', {
      ...(backupPath ? { backupPath } : {}),
      ...(f.drift ? { reason: 'restored' } : {})
    })
  } catch (e) {
    out(it, 'failed', { reason: (e as NodeJS.ErrnoException).code ?? (e as Error).name })
  }
}

/**
 * Keep a tool's edited script copy as the library version. A script hook gets it as that script; a built-in action hook becomes a
 * script hook running it (the edit is a script now). It reaches the other tools on the next sync.
 * notFound unless the file is the script this tool runs for the hook
 */
export function keepHookCopy(home: string, tool: HookTool, hook: string, file: string): string {
  const h = readHooks(home).find((x) => x.name === hook)
  const runs = h ? toolScript(tool, h) : null
  if (!h || !runs || runs.file !== file)
    throw new LibraryError('notFound', 'not a script this tool runs')
  // A folder script: the whole shared copy goes back into the library
  if (runs.folder) {
    const dir = scriptCopyDir(home, tool, runs.folder)
    if (!isDirCopy(lstatOrNull(dir))) throw new LibraryError('notFound', 'no copy in the tool')
    return replaceScriptFolder(home, runs.folder, dir)
  }
  const path = hookCopyPath(home, tool, hook, file)
  const st = lstatOrNull(path)
  if (!st?.isFile() || st.isSymbolicLink())
    throw new LibraryError('notFound', 'no copy in the tool')
  const content = readFileSync(path, 'utf8')
  // A library script goes back into the library: every hook using it gets the kept version
  const use = usedScript(h.doc)
  if (use && file === SHARED_SCRIPT) return saveScript(home, use, content)
  return h.doc.action === 'script'
    ? saveHookScript(home, hook, file, content)
    : convertHookToScript(home, hook, content)
}
