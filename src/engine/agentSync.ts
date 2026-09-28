import { copyFileSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { TOOL_IDS, toolHomeOverride, type ToolId } from './agents'
import { agentExts, agentNameOk, agentToolDir, agentToolPath, renderAgent } from './agentRender'
import { appConfigDir, syncTools } from './config'
import { dropPending, importedBackupDest, importStamp, moveToImportedBackup, pendingOf, retireHash, retireOriginal, retireSkipReason } from './pendingRetire'
import { deliverFile } from './deliver'
import { listAgents, readAgentDoc } from './library'
import { isEnabled, MANIFEST_FILE, readPlanManifest } from './manifest'
import { libraryPaths } from './sources'
import { readState, writeState, type AppState } from './state'
import { sha256 } from './text'
import type { Env } from './types'
import { ConcurrentChangeError } from './write'

/**
 * Agent sync plan (tool x name, per file). Hash is the sha256 of the per-tool render output.
 * - copy            missing on the tool side -> write the render output (creating the folder if needed)
 * - update          app-written file differs from the render output. drift=true means it was edited on the tool side — back up (outside the agent folder), then overwrite
 * - inSync          app-written file matches the render output (if stateStale, only the record is updated)
 * - skip            same-name file the app never wrote (userOwned), not a regular file (notRegularFile), source unreadable (sourceUnreadable),
 *                   or a name the tool rejects (invalidName — Gemini CLI allows only [a-z0-9_-])
 * - deleteCandidate app file removed from the library (removedFromLibrary) or disabled for that tool (disabled) -> display only (approval flow)
 * - replaceImported file (or link) the app never wrote that is an imported original (state.pendingRetire) still matching its import hash
 *                   -> moved to backups/imported, then the render output is written (changed since import: skip, reason=importedChanged)
 * - retireImported  imported original outside the agent folder the app writes (e.g. `~/.config/opencode/agent/<name>.md`)
 *                   -> moved to backups/imported once the app file is in place
 * Tools not in use (config.toolsInUse) are left out entirely.
 */
export type AgentSyncAction = 'copy' | 'update' | 'inSync' | 'skip' | 'deleteCandidate' | 'replaceImported' | 'retireImported'

export interface AgentSyncItem {
  tool: ToolId
  /** Library name (no extension) */
  name: string
  action: AgentSyncAction
  /** Tool-side file */
  path: string
  /** Library source file */
  source: string
  /** sha256 of the render output */
  sourceHash?: string
  currentHash?: string
  drift?: boolean
  stateStale?: boolean
  reason?: string
  sameContent?: boolean
}

export interface AgentSyncResult {
  tool: ToolId
  name: string
  action: AgentSyncAction
  status: 'done' | 'unchanged' | 'skipped' | 'pendingApproval' | 'refused' | 'failed'
  reason?: string
  path: string
  backupPath?: string
}

/** Where the previous file pushed out by update(drift) goes (last one per tool and file). Inside the agent folder the tool would read it as an agent */
export function agentBackupPath(home: string, tool: ToolId, file: string): string {
  return join(appConfigDir(home), 'backups/agents', tool, file)
}

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

const fileHash = (p: string): string => sha256(readFileSync(p, 'utf8'))

/** Library name -> per-tool render output (null if reading failed) */
function renderAll(home: string, names: string[]): Map<string, Map<ToolId, string> | null> {
  const out = new Map<string, Map<ToolId, string> | null>()
  for (const name of names) {
    try {
      const doc = readAgentDoc(home, name)
      // Names a tool can't accept (agentNameOk) are left out of that tool's map
      out.set(name, new Map(TOOL_IDS.filter((t) => agentNameOk(t, name)).map((t) => [t, renderAgent(t, doc)])))
    } catch {
      out.set(name, null)
    }
  }
  return out
}

/** Plan. Read-only */
export function planAgentSync(home: string, _env: Env = process.env): AgentSyncItem[] {
  const mf = readPlanManifest(home)
  if (mf.error) throw new Error(`${MANIFEST_FILE}: ${mf.error}`)
  const agentsDir = libraryPaths(home).agentsDir
  const names = listAgents(home)
  const nameSet = new Set(names)
  const rendered = renderAll(home, names)
  const appState = readState(home).state
  const managedAll = appState.agents ?? {}
  const items: AgentSyncItem[] = []

  // No Copilot / Grok files while COPILOT_HOME / GROK_HOME points elsewhere
  for (const tool of syncTools(home)) {
    if (toolHomeOverride(home, tool, _env)) continue
    const managed = managedAll[tool] ?? {}
    for (const name of names) {
      const path = agentToolPath(home, tool, name)
      const source = join(agentsDir, `${name}.md`)
      const base = { tool, name, path, source }
      const st = lstatOrNull(path)
      const regular = !!st && st.isFile() && !st.isSymbolicLink()
      const pending = isEnabled(mf.manifest, 'agents', name, tool) ? pendingOf(home, appState, 'agent', tool, name) : []
      // Imported originals elsewhere (listed before the slot item; run once the app file is in place)
      for (const p of pending) {
        if (p.path === path) continue
        const currentHash = retireHash(p.path)
        if (currentHash === null) continue
        items.push({
          ...base,
          action: currentHash === p.hash ? 'retireImported' : 'skip',
          path: p.path,
          currentHash,
          ...(currentHash === p.hash ? {} : { reason: retireSkipReason(currentHash) })
        })
      }
      if (!isEnabled(mf.manifest, 'agents', name, tool)) {
        if (regular && managed[name])
          items.push({
            ...base,
            action: 'deleteCandidate',
            reason: 'disabled',
            currentHash: fileHash(path)
          })
        continue
      }
      if (!agentNameOk(tool, name)) {
        items.push({ ...base, action: 'skip', reason: 'invalidName' })
        continue
      }
      const content = rendered.get(name)?.get(tool)
      if (content === undefined) {
        items.push({ ...base, action: 'skip', reason: 'sourceUnreadable' })
        continue
      }
      // A user file the tool also loads under this name (Copilot `<name>.md`) — writing ours would load the agent twice.
      // An imported original awaiting retirement doesn't count (it moves once the app file is in place)
      const twin = agentExts(tool)
        .slice(1)
        .map((e) => join(dirname(path), name + e))
        .find((p) => lstatOrNull(p) && !pending.some((x) => x.path === p && retireHash(p) === x.hash))
      if (twin) {
        if (regular && managed[name]) items.push({ ...base, action: 'deleteCandidate', reason: 'userFileSameName', currentHash: fileHash(path) })
        else items.push({ ...base, action: 'skip', reason: 'userOwned', path: twin })
        continue
      }
      const sourceHash = sha256(content)
      if (!st) {
        items.push({ ...base, action: 'copy', sourceHash })
        continue
      }
      const imported = managed[name] ? undefined : pending.find((p) => p.path === path)
      if (imported) {
        const currentHash = retireHash(path)
        items.push({
          ...base,
          action: currentHash === imported.hash ? 'replaceImported' : 'skip',
          sourceHash,
          ...(currentHash !== null ? { currentHash } : {}),
          ...(currentHash === imported.hash ? {} : { reason: retireSkipReason(currentHash) })
        })
        continue
      }
      if (!regular) {
        items.push({ ...base, action: 'skip', sourceHash, reason: 'notRegularFile' })
        continue
      }
      const currentHash = fileHash(path)
      const rec = managed[name]
      if (!rec)
        items.push({
          ...base,
          action: 'skip',
          sourceHash,
          currentHash,
          reason: 'userOwned',
          sameContent: currentHash === sourceHash
        })
      else if (currentHash === sourceHash)
        items.push({
          ...base,
          action: 'inSync',
          sourceHash,
          currentHash,
          ...(rec.contentHash !== currentHash ? { stateStale: true } : {})
        })
      else
        items.push({
          ...base,
          action: 'update',
          sourceHash,
          currentHash,
          ...(rec.contentHash !== currentHash ? { drift: true } : {})
        })
    }
    // App files removed from the library
    for (const name of Object.keys(managed).sort()) {
      if (nameSet.has(name)) continue
      const path = agentToolPath(home, tool, name)
      const st = lstatOrNull(path)
      if (st?.isFile() && !st.isSymbolicLink())
        items.push({
          tool,
          name,
          action: 'deleteCandidate',
          path,
          source: join(agentsDir, `${name}.md`),
          currentHash: fileHash(path),
          reason: 'removedFromLibrary'
        })
    }
  }
  return items
}

/**
 * Runs copy and update, refreshes the record for inSync(stateStale), and only displays deleteCandidate.
 * Each item runs only if the current plan has it with the same action and hash.
 */
export function applyAgentSync(home: string, env: Env, items: AgentSyncItem[]): AgentSyncResult[] {
  const st = readState(home)
  const results: AgentSyncResult[] = []
  const out = (
    it: AgentSyncItem,
    status: AgentSyncResult['status'],
    extra: Partial<AgentSyncResult> = {}
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
  const state: AppState = { ...st.state, agents: { ...(st.state.agents ?? {}) } }
  const record = (tool: ToolId, name: string, contentHash: string): void => {
    state.agents![tool] = {
      ...(state.agents![tool] ?? {}),
      [name]: { contentHash, at: new Date().toISOString() }
    }
    writeState(home, state)
  }
  const agentsDir = libraryPaths(home).agentsDir
  const fresh = planAgentSync(home, env)
  const ts = importStamp()

  for (const it of items) {
    if (it.action === 'retireImported') continue
    if (it.action === 'skip') {
      out(it, 'skipped', { reason: it.reason ?? 'skip' })
      continue
    }
    if (it.action === 'deleteCandidate') {
      out(it, 'pendingApproval', { reason: 'deletion uses a separate approval flow' })
      continue
    }
    if (!TOOL_IDS.includes(it.tool)) {
      out(it, 'refused', { reason: 'outOfScope' })
      continue
    }
    const { dir, ext } = agentToolDir(home, it.tool)
    if (
      !it.name ||
      it.name.startsWith('.') ||
      it.name.includes('/') ||
      resolve(it.path) !== join(dir, it.name + ext) ||
      resolve(it.source) !== join(agentsDir, `${it.name}.md`)
    ) {
      out(it, 'refused', { reason: 'outOfScope' })
      continue
    }
    const f = fresh.find((x) => x.tool === it.tool && x.name === it.name && x.path === it.path)
    if (
      !f ||
      f.action !== it.action ||
      (it.sourceHash !== undefined && f.sourceHash !== it.sourceHash) ||
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
    try {
      const content = renderAgent(f.tool, readAgentDoc(home, f.name))
      if (sha256(content) !== f.sourceHash) {
        out(it, 'refused', { reason: 'changedSinceCheck' })
        continue
      }
      let backupPath: string | undefined
      if (f.action === 'update' && f.drift) {
        backupPath = agentBackupPath(home, f.tool, basename(f.path))
        mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 })
        copyFileSync(f.path, backupPath)
      }
      if (f.action === 'replaceImported') {
        // Imported original: move to backups/imported, then write (put back if writing fails)
        const p = pendingOf(home, state, 'agent', f.tool, f.name).find((x) => x.path === f.path)
        if (!p || p.hash !== f.currentHash || retireHash(f.path) !== p.hash) {
          out(it, 'refused', { reason: 'changedSinceCheck' })
          continue
        }
        backupPath = importedBackupDest(home, ts, p)
        moveToImportedBackup(f.path, backupPath)
        try {
          deliverFile(f.source, f.path, content, { mode: 0o644, expectHash: null })
        } catch (e) {
          if (!lstatOrNull(f.path)) moveToImportedBackup(backupPath, f.path)
          throw e
        }
        dropPending(state, [p])
        record(f.tool, f.name, f.sourceHash!)
        out(it, 'done', { backupPath })
        continue
      }
      mkdirSync(dir, { recursive: true, mode: 0o755 })
      deliverFile(f.source, f.path, content, {
        mode: 0o644,
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
  // Imported originals outside the app's agent folder: moved only once the app file is in place and recorded
  for (const it of items) {
    if (it.action !== 'retireImported') continue
    const p = pendingOf(home, state, 'agent', it.tool, it.name).find((x) => x.path === it.path)
    if (!p || p.hash !== it.currentHash) {
      out(it, 'refused', { reason: 'changedSinceCheck' })
      continue
    }
    const slot = agentToolPath(home, it.tool, it.name)
    const rec = state.agents![it.tool]?.[it.name]
    const slotSt = lstatOrNull(slot)
    if (!rec || !slotSt?.isFile() || slotSt.isSymbolicLink() || fileHash(slot) !== rec.contentHash) {
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
  return results
}

/**
 * Right after import: if a same-name tool-side file exists without an app record and is byte-identical to the render output, adopt it as app-owned (recorded in state).
 * Otherwise leave it (skipped as userOwned on the next sync) and report userOwned. Disabled tools, tools with a record, tools not in use
 * and imported originals awaiting replacement (pendingRetire) are not touched.
 */
export function adoptAgentFiles(home: string, name: string): { adopted: ToolId[]; userOwned: ToolId[] } {
  const out = { adopted: [] as ToolId[], userOwned: [] as ToolId[] }
  const st = readState(home)
  if (st.error) return out
  const mf = readPlanManifest(home)
  if (mf.error) return out
  const doc = readAgentDoc(home, name)
  const state: AppState = { ...st.state, agents: { ...(st.state.agents ?? {}) } }
  for (const tool of syncTools(home)) {
    if (!isEnabled(mf.manifest, 'agents', name, tool) || !agentNameOk(tool, name)) continue
    if (state.agents![tool]?.[name]) continue
    const path = agentToolPath(home, tool, name)
    if (pendingOf(home, state, 'agent', tool, name).some((p) => p.path === path)) continue
    const cur = lstatOrNull(path)
    if (!cur || !cur.isFile() || cur.isSymbolicLink()) continue
    const hash = sha256(renderAgent(tool, doc))
    if (fileHash(path) === hash) {
      state.agents![tool] = { ...(state.agents![tool] ?? {}), [name]: { contentHash: hash, at: new Date().toISOString() } }
      out.adopted.push(tool)
    } else out.userOwned.push(tool)
  }
  if (out.adopted.length) writeState(home, state)
  return out
}
