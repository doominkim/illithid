import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { canonicalPaths, copilotHomeOverride, tools, type ToolId } from './agents'
import { appConfigDir, toolInUse, toolsInUse } from './config'
import {
  activePending,
  dropPending,
  importedBackupDest,
  importStamp,
  moveToImportedBackup,
  pendingOf,
  retireHash,
  retireSkipReason,
  retireOriginal
} from './pendingRetire'
import { plan } from './plan'
import { deliverDir, deliveredShape, shapeMatches } from './deliver'
import { isEnabled, MANIFEST_FILE, readManifest } from './manifest'
import { canonicalSkills, dirContentHash } from './skills'
import { readState, writeState, type AppState, type SkillCopyEntry } from './state'
import type { Env } from './types'
import { isAppTmpName } from './write'

/**
 * Skill copy plan (Claude and Codex. OpenCode auto-scans the canonical dir, so it is out of scope)
 * - copy            missing tool-side → copy the canonical dir
 * - replaceLink     tool side is a symlink → remove the link and replace with a real copy (link string recorded)
 * - update          app-written copy differs from the canonical dir. drift=true means it was edited tool-side — the source wins, so
 *                   it is backed up (skillBackupPath) and overwritten (M7d: never skipped)
 * - skip            real directory (user-owned) or file the app never wrote → shown, left alone
 * - inSync          app-written copy matches the canonical dir
 * - deleteCandidate app copy whose source is gone or disabled for that tool (reason=disabled), or a disabled skill's
 *                   symlink to the canonical dir (currentLink) → shown as a delete candidate only (not executed)
 * - replaceImported real directory the app never wrote that is an imported original (state.pendingRetire) still matching its import hash
 *                   → moved to backups/imported and replaced by the app copy in one step (changed since import: skip, reason=importedChanged)
 * - retireImported  imported OpenCode original (`~/.config/opencode/{skill,skills}/<name>`) → moved to backups/imported once
 *                   opencode.json skills.paths points at the library (OpenCode reads the library copy from then on)
 * Hidden entries, and entries absent from the canonical set that the app never wrote, are left out of the plan.
 * Tools not in use (config.toolsInUse) are left out entirely.
 */
export type SkillSyncAction =
  'copy' | 'replaceLink' | 'update' | 'skip' | 'inSync' | 'deleteCandidate' | 'replaceImported' | 'retireImported'

export interface SkillSyncItem {
  tool: ToolId
  name: string
  action: SkillSyncAction
  /** Tool-side path */
  path: string
  /** Canonical path (for deleteCandidate, where it used to be) */
  source: string
  /** Canonical dirContentHash */
  sourceHash?: string
  /** dirContentHash of the tool-side real directory */
  currentHash?: string
  /** update where the tool-side copy changed since the last sync (informational — backed up, then restored from source on sync) */
  drift?: boolean
  /** Current link string for replaceLink */
  currentLink?: string
  /** inSync but the recorded state hash differs → apply only refreshes the record */
  stateStale?: boolean
  /** skip reason: userOwned | notDirectory | sourceUnreadable */
  reason?: string
  /** For skip(userOwned): whether content matches the canonical dir (informational) */
  sameContent?: boolean
}

export interface SkillSyncResult {
  tool: ToolId
  name: string
  action: SkillSyncAction
  /**
   * done         executed (copy, replace, record refresh)
   * unchanged    inSync
   * skipped      skip item (user-owned, not a directory, canonical read failed)
   * pendingApproval  deleteCandidate — deletion goes through a separate approval flow
   * refused      validation failed (outOfScope, changedSinceCheck, stateError)
   * failed       I/O failure (after attempting to restore)
   */
  status: 'done' | 'unchanged' | 'skipped' | 'pendingApproval' | 'refused' | 'failed'
  reason?: string
  path: string
  /** Link string removed by replaceLink (for rollback) */
  previousLink?: string
  /** Where update moved the previous copy */
  backupPath?: string
}

export interface SkillSyncOptions {
  /** @deprecated Source always wins since M7d (accepted for compatibility only) */
  force?: boolean
}

/** Tool skill directories the app copies into (Claude, Codex) — tools in use only */
function symlinkDirs(home: string, env?: Env): Map<ToolId, string> {
  const m = new Map<ToolId, string>()
  const inUse = toolsInUse(home)
  for (const t of tools(home)) if (t.skills.kind === 'symlinkDir' && inUse.includes(t.id)) m.set(t.id, t.skills.dir)
  // With env given: no Copilot copies while COPILOT_HOME points elsewhere (copilotHomeOverride)
  if (env && copilotHomeOverride(home, env)) m.delete('copilot')
  return m
}

/** OpenCode's own skill folders (imported originals there are retired, not replaced) */
function opencodeSkillDirs(home: string): string[] {
  return [join(home, '.config/opencode/skill'), join(home, '.config/opencode/skills')]
}

/**
 * Location for the previous copy moved aside by update (most recent one per tool and skill).
 * Kept outside the tool skills directory, since Claude and OpenCode would read a backup there as another skill.
 */
export function skillBackupPath(home: string, tool: ToolId, name: string): string {
  return join(appConfigDir(home), 'backups/skills', tool, name)
}

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** Copy plan. Read-only */
export function planSkillSync(home: string, _env: Env = process.env): SkillSyncItem[] {
  const canonDir = canonicalPaths(home).skills
  const canon = canonicalSkills(home)
  const canonSet = new Set(canon)
  const appState = readState(home).state
  const managedAll = appState.skills ?? {}
  const mf = readManifest(home)
  if (mf.error) throw new Error(`${MANIFEST_FILE}: ${mf.error}`)
  const items: SkillSyncItem[] = []

  for (const [tool, dir] of symlinkDirs(home, _env)) {
    const managed = managedAll[tool] ?? {}
    for (const name of canon) {
      const path = join(dir, name)
      const source = join(canonDir, name)
      const base = { tool, name, path, source }
      if (!isEnabled(mf.manifest, 'skills', name, tool)) {
        // Disabled skill: only app copies or symlinks to the canonical dir are delete candidates. User-owned entries are left alone
        const st = lstatOrNull(path)
        if (st?.isDirectory() && !st.isSymbolicLink() && managed[name]) {
          items.push({
            ...base,
            action: 'deleteCandidate',
            reason: 'disabled',
            currentHash: dirContentHash(path)
          })
        } else if (st?.isSymbolicLink()) {
          const link = readlinkSync(path)
          if (resolve(dirname(path), link) === resolve(source)) {
            items.push({
              ...base,
              action: 'deleteCandidate',
              reason: 'disabled',
              currentLink: link
            })
          }
        }
        continue
      }
      // Imported originals elsewhere in this tool's skills folder (e.g. the old name after a library rename) — retired once the copy is in place
      for (const p of pendingOf(home, appState, 'skill', tool, name)) {
        if (p.path === path) continue
        const currentHash = retireHash(p.path)
        if (currentHash === null) continue
        items.push({
          ...base,
          path: p.path,
          action: currentHash === p.hash ? 'retireImported' : 'skip',
          currentHash,
          ...(currentHash === p.hash ? {} : { reason: retireSkipReason(currentHash) })
        })
      }
      let sourceHash: string
      try {
        sourceHash = dirContentHash(source)
      } catch {
        items.push({ ...base, action: 'skip', reason: 'sourceUnreadable' })
        continue
      }
      const shape = deliveredShape(path, source)
      if (shape.kind === 'absent') {
        items.push({ ...base, action: 'copy', sourceHash })
      } else if (shape.kind === 'symlink') {
        // Under the current strategy (copy) symlinks get replaced. With a symlink strategy, links with toSource would be inSync
        items.push({ ...base, action: 'replaceLink', sourceHash, currentLink: shape.target })
      } else if (!shapeMatches(shape) || (shape.kind === 'copy' && !shape.isDir)) {
        items.push({ ...base, action: 'skip', sourceHash, reason: 'notDirectory' })
      } else {
        const currentHash = dirContentHash(path)
        const rec = managed[name]
        const imported = rec ? undefined : pendingOf(home, appState, 'skill', tool, name).find((p) => p.path === path)
        if (imported) {
          items.push({
            ...base,
            action: imported.hash === currentHash ? 'replaceImported' : 'skip',
            sourceHash,
            currentHash,
            ...(imported.hash === currentHash ? {} : { reason: retireSkipReason(currentHash) })
          })
        } else if (!rec) {
          items.push({
            ...base,
            action: 'skip',
            sourceHash,
            currentHash,
            reason: 'userOwned',
            sameContent: currentHash === sourceHash
          })
        } else if (currentHash === sourceHash) {
          items.push({
            ...base,
            action: 'inSync',
            sourceHash,
            currentHash,
            ...(rec.contentHash !== currentHash ? { stateStale: true } : {})
          })
        } else {
          items.push({
            ...base,
            action: 'update',
            sourceHash,
            currentHash,
            ...(currentHash !== rec.contentHash ? { drift: true } : {})
          })
        }
      }
    }
    // App-written copies whose canonical dir is gone
    for (const name of Object.keys(managed).sort()) {
      if (canonSet.has(name) || name.startsWith('.')) continue
      const path = join(dir, name)
      const st = lstatOrNull(path)
      if (st?.isDirectory() && !st.isSymbolicLink()) {
        items.push({
          tool,
          name,
          action: 'deleteCandidate',
          path,
          source: join(canonDir, name),
          currentHash: dirContentHash(path)
        })
      }
    }
  }
  // Imported OpenCode originals (OpenCode reads library skills through skills.paths)
  if (toolInUse(home, 'opencode')) {
    for (const p of activePending(home, appState.pendingRetire)) {
      if (p.kind !== 'skill' || p.tool !== 'opencode' || !canonSet.has(p.name)) continue
      const currentHash = retireHash(p.path)
      if (currentHash === null) continue
      items.push({
        tool: 'opencode',
        name: p.name,
        action: currentHash === p.hash ? 'retireImported' : 'skip',
        path: p.path,
        source: join(canonDir, p.name),
        currentHash,
        ...(currentHash === p.hash ? {} : { reason: retireSkipReason(currentHash) })
      })
    }
  }
  return items
}

/** rename on the same filesystem, otherwise copy then delete */
function moveDir(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
    rmSync(from, { recursive: true, force: true })
  }
}

/**
 * Executes copy/replaceLink/update items from planSkillSync (inSync with stateStale only refreshes the record).
 * Each item runs only if the current plan has the same action and hash. deleteCandidate is display-only.
 * Copies are staged in a tmp dir inside the tool directory, hash-checked, then renamed into place.
 */
export function applySkillSync(
  home: string,
  env: Env,
  items: SkillSyncItem[],
  opts: SkillSyncOptions = {}
): SkillSyncResult[] {
  const canonDir = canonicalPaths(home).skills
  const dirs = symlinkDirs(home, env)
  const st = readState(home)
  const results: SkillSyncResult[] = []
  const out = (
    it: SkillSyncItem,
    status: SkillSyncResult['status'],
    extra: Partial<SkillSyncResult> = {}
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
  const state: AppState = { ...st.state, skills: { ...(st.state.skills ?? {}) } }
  const record = (tool: ToolId, name: string, e: SkillCopyEntry): void => {
    state.skills![tool] = { ...(state.skills![tool] ?? {}), [name]: e }
    writeState(home, state)
  }
  const fresh = planSkillSync(home, env)
  const ts = importStamp()

  for (const it of items) {
    if (it.action === 'retireImported') continue
    if (it.action === 'skip') {
      out(it, 'skipped', { reason: it.reason ?? 'skip' })
      continue
    }
    if (it.action === 'deleteCandidate') {
      out(it, 'pendingApproval', { reason: 'Deletion goes through a separate approval flow' })
      continue
    }
    const dir = dirs.get(it.tool)
    if (
      !dir ||
      !it.name ||
      it.name.startsWith('.') ||
      it.name.includes('/') ||
      resolve(it.path) !== join(dir, it.name) ||
      resolve(it.source) !== join(canonDir, it.name)
    ) {
      out(it, 'refused', { reason: 'outOfScope' })
      continue
    }
    const f = fresh.find((x) => x.tool === it.tool && x.name === it.name && x.path === it.path)
    if (
      !f ||
      f.action !== it.action ||
      (it.sourceHash !== undefined && f.sourceHash !== it.sourceHash) ||
      (it.currentHash !== undefined && f.currentHash !== it.currentHash) ||
      (it.currentLink !== undefined && f.currentLink !== it.currentLink)
    ) {
      out(it, 'refused', { reason: 'changedSinceCheck' })
      continue
    }
    if (f.action === 'inSync') {
      if (f.stateStale) {
        record(f.tool, f.name, { contentHash: f.currentHash!, at: new Date().toISOString() })
        out(it, 'done', { reason: 'stateRefreshed' })
      } else out(it, 'unchanged')
      continue
    }
    void opts.force // M7d: source wins — drift is backed up, then overwritten

    try {
      mkdirSync(dir, { recursive: true, mode: 0o755 })
      if (f.action === 'copy') {
        if (lstatOrNull(f.path)) {
          out(it, 'refused', { reason: 'changedSinceCheck' })
          continue
        }
        const r = deliverDir(f.source, f.path, { expectedHash: f.sourceHash })
        if (!r.ok) {
          out(it, 'failed', { reason: r.reason === 'hashMismatch' ? 'copyHashMismatch' : r.reason })
          continue
        }
        record(f.tool, f.name, { contentHash: f.sourceHash!, at: new Date().toISOString() })
        out(it, 'done')
      } else if (f.action === 'replaceLink') {
        const cur = lstatOrNull(f.path)
        if (!cur?.isSymbolicLink() || readlinkSync(f.path) !== f.currentLink) {
          out(it, 'refused', {
            reason: cur && !cur.isSymbolicLink() ? 'notSymlink' : 'changedSinceCheck'
          })
          continue
        }
        const r = deliverDir(f.source, f.path, {
          expectedHash: f.sourceHash,
          vacate: () => unlinkSync(f.path), // remove only the link — its target is untouched
          restore: () => symlinkSync(f.currentLink!, f.path)
        })
        if (!r.ok) {
          out(it, 'failed', { reason: r.reason === 'hashMismatch' ? 'copyHashMismatch' : r.reason })
          continue
        }
        record(f.tool, f.name, {
          contentHash: f.sourceHash!,
          at: new Date().toISOString(),
          previousLink: f.currentLink!
        })
        out(it, 'done', { previousLink: f.currentLink! })
      } else if (f.action === 'replaceImported') {
        // Imported original: back up to backups/imported and replace in one step (put back if the swap fails)
        const p = pendingOf(home, state, 'skill', f.tool, f.name).find((x) => x.path === f.path)
        const cur = lstatOrNull(f.path)
        if (!p || p.hash !== f.currentHash || !cur?.isDirectory() || cur.isSymbolicLink() || dirContentHash(f.path) !== f.currentHash) {
          out(it, 'refused', { reason: 'changedSinceCheck' })
          continue
        }
        const bak = importedBackupDest(home, ts, p)
        const r = deliverDir(f.source, f.path, {
          expectedHash: f.sourceHash,
          vacate: () => moveToImportedBackup(f.path, bak),
          restore: () => moveDir(bak, f.path)
        })
        if (!r.ok) {
          out(it, 'failed', { reason: r.reason === 'hashMismatch' ? 'copyHashMismatch' : r.reason })
          continue
        }
        dropPending(state, [p])
        record(f.tool, f.name, { contentHash: f.sourceHash!, at: new Date().toISOString() })
        out(it, 'done', { backupPath: bak })
      } else {
        // update: move the app-owned real directory to the backup location and replace it
        const cur = lstatOrNull(f.path)
        if (
          !cur?.isDirectory() ||
          cur.isSymbolicLink() ||
          dirContentHash(f.path) !== f.currentHash
        ) {
          out(it, 'refused', { reason: 'changedSinceCheck' })
          continue
        }
        const bak = skillBackupPath(home, f.tool, f.name)
        mkdirSync(join(bak, '..'), { recursive: true, mode: 0o700 })
        if (existsSync(bak) || lstatOrNull(bak)) rmSync(bak, { recursive: true, force: true })
        const r = deliverDir(f.source, f.path, {
          expectedHash: f.sourceHash,
          vacate: () => moveDir(f.path, bak),
          restore: () => moveDir(bak, f.path)
        })
        if (!r.ok) {
          out(it, 'failed', { reason: r.reason === 'hashMismatch' ? 'copyHashMismatch' : r.reason })
          continue
        }
        record(f.tool, f.name, { contentHash: f.sourceHash!, at: new Date().toISOString() })
        out(it, 'done', { backupPath: bak, ...(f.drift ? { reason: 'restored' } : {}) })
      }
    } catch (e) {
      out(it, 'failed', { reason: (e as NodeJS.ErrnoException).code ?? (e as Error).name })
    }
  }
  // Imported originals outside the app copy location: OpenCode ones once opencode.json skills.paths points at the library,
  // Claude/Codex ones once the app copy is in place and recorded
  const retire = items.filter((it) => it.action === 'retireImported')
  if (retire.length) {
    let libraryVisible = false
    if (retire.some((it) => it.tool === 'opencode')) {
      try {
        const c = plan(home, env, ['opencodeSkills'])[0]
        libraryVisible = !!c && !c.error && !c.changed
      } catch {
        libraryVisible = false
      }
    }
    for (const it of retire) {
      const p = pendingOf(home, state, 'skill', it.tool, it.name).find((x) => x.path === it.path)
      const toolDir = dirs.get(it.tool)
      const allowed = it.tool === 'opencode' ? opencodeSkillDirs(home) : toolDir ? [toolDir] : []
      if (!allowed.includes(dirname(resolve(it.path))) || (toolDir && resolve(it.path) === join(toolDir, it.name))) {
        out(it, 'refused', { reason: 'outOfScope' })
        continue
      }
      if (!p || p.hash !== it.currentHash) {
        out(it, 'refused', { reason: 'changedSinceCheck' })
        continue
      }
      let copyReady = false
      if (it.tool === 'opencode') copyReady = libraryVisible
      else if (toolDir) {
        const rec = state.skills![it.tool]?.[it.name]
        const slot = lstatOrNull(join(toolDir, it.name))
        try {
          copyReady = !!rec && !!slot?.isDirectory() && !slot.isSymbolicLink() && dirContentHash(join(toolDir, it.name)) === rec.contentHash
        } catch {
          copyReady = false
        }
      }
      if (!copyReady || !canonicalSkills(home).includes(it.name)) {
        out(it, 'skipped', { reason: 'noAppCopy' })
        continue
      }
      try {
        const r = retireOriginal(home, p, ts)
        if (r.status === 'changed' || r.status === 'unreadable') {
          out(it, 'skipped', { reason: r.status === 'changed' ? 'importedChanged' : 'unreadable' })
          continue
        }
        dropPending(state, [p])
        writeState(home, state)
        out(it, r.status === 'moved' ? 'done' : 'unchanged', r.status === 'moved' ? { backupPath: r.backupPath } : { reason: 'originalGone' })
      } catch (e) {
        out(it, 'failed', { reason: (e as NodeJS.ErrnoException).code ?? (e as Error).name })
      }
    }
  }
  return results
}

/** Leftover tmp directory names in a tool skills directory (to detect traces of abnormal exits) */
export function leftoverSkillTmps(home: string): string[] {
  const out: string[] = []
  for (const dir of symlinkDirs(home).values()) {
    if (!existsSync(dir)) continue
    for (const n of readdirSync(dir))
      if (isAppTmpName(n)) out.push(n)
  }
  return out
}

/**
 * Right after import: a same-named real directory in a tool skills folder (Claude, Codex) whose content matches the library copy is adopted as app-owned
 * (recorded in state — the next sync sees inSync). If different, it stays user-owned (sync skips it). Enabled tools only; skipped if already recorded.
 */
export function adoptSkillCopies(home: string, name: string): { adopted: ToolId[]; userOwned: ToolId[] } {
  const out = { adopted: [] as ToolId[], userOwned: [] as ToolId[] }
  const st = readState(home)
  if (st.error) return out
  const mf = readManifest(home)
  if (mf.error) return out
  let sourceHash: string
  try {
    sourceHash = dirContentHash(join(canonicalPaths(home).skills, name))
  } catch {
    return out
  }
  const state: AppState = { ...st.state, skills: { ...(st.state.skills ?? {}) } }
  for (const [tool, dir] of symlinkDirs(home)) {
    if (!isEnabled(mf.manifest, 'skills', name, tool)) continue
    if (state.skills![tool]?.[name]) continue
    const path = join(dir, name)
    // Imported original awaiting replacement (pendingRetire) — the next sync swaps it, it is not the user's
    if (pendingOf(home, state, 'skill', tool, name).some((p) => p.path === path)) continue
    const cur = lstatOrNull(path)
    if (!cur || !cur.isDirectory() || cur.isSymbolicLink()) continue
    let hash: string
    try {
      hash = dirContentHash(path)
    } catch {
      continue
    }
    if (hash === sourceHash) {
      const entry: SkillCopyEntry = { contentHash: hash, at: new Date().toISOString() }
      state.skills![tool] = { ...(state.skills![tool] ?? {}), [name]: entry }
      out.adopted.push(tool)
    } else out.userOwned.push(tool)
  }
  if (out.adopted.length) writeState(home, state)
  return out
}
