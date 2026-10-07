import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deletedBackupRoot } from './deleteCopies'
import { buildContext, plan, planTarget } from './plan'
import { readPlanSources } from './sources'
import { HOOK_RETIRE_TOOL } from './targets/hooks'
import { ALL_TARGETS, MCP_TARGET_TOOL, toolServerDefs } from './targets'
import { activeWorkspaceId } from './config'
import { dropPending } from './pendingRetire'
import { readState, writeState, type AppState } from './state'
import { blockBody, sha256 } from './text'
import { MD_BEGIN, MD_END } from './targets/codexAgents'
import { blockEdited } from './targets/geminiRules'
import type { SecretBackend } from './secrets'
import type { Env, FileChange, TargetId } from './types'
import {
  atomicWrite,
  backup,
  BACKUP_SUFFIX,
  ConcurrentChangeError,
  resolveWritePath
} from './write'

/**
 * Skip reasons
 * - error              plan result has an error (missing file, parse failure, change outside owned scope, etc.)
 * - changedSinceCheck  file changed after check or right before writing (race guard — re-check, then apply)
 * - stateError         could not read state.json (abort everything so state is not overwritten)
 * - writeFailed        I/O failure during backup/write
 * - drift              (not produced since M7d — kept for compatibility. The source always wins; tool-side changes are backed up and overwritten)
 * - nothingToWrite / toolNotInitialized / jsoncUnsupported  (status unchanged, not a failure) the file is left alone — FileChange.skip
 */
export type ApplySkipReason =
  | 'error'
  | 'changedSinceCheck'
  | 'drift'
  | 'stateError'
  | 'writeFailed'
  | 'nothingToWrite'
  | 'toolNotInitialized'
  | 'copilotHomeOverride'
  | 'grokHomeOverride'
  | 'qwenHomeOverride'
  | 'jsoncUnsupported'

export interface ApplyResult {
  id: TargetId
  label: string
  status: 'written' | 'skipped' | 'unchanged'
  reason?: ApplySkipReason
  /** Human-readable detail (no raw content or tokens) */
  detail?: string
  backupPath?: string
  /** The owned region had changed on the tool side since the last apply (info — backed up and restored from source) */
  restored?: boolean
  /** Per-server errors (e.g. missing secret — only that server keeps its previous content; no values) */
  serverErrors?: Record<string, string>
  /** MCP targets: files holding the pre-removal definitions of servers removed from tool config (backups/deleted/<ts>/mcp/<tool>/<server>.json) */
  removedServerBackups?: string[]
  /** geminiRules: where the tool-side edited block was saved before it was replaced */
  blockBackup?: string
}

export interface ApplyOptions {
  /** @deprecated Meaningless since M7d because the source always wins (accepted only for compatibility) */
  force?: boolean
  /**
   * before sha256 at the time the user checked. For listed targets, a mismatch with current content gives changedSinceCheck.
   * Passed when applying after showing the diff in the UI.
   */
  expectedBefore?: Partial<Record<TargetId, string>>
  /** For tests: called per target after the tmp write, before the pre-rename re-check */
  beforeCommit?: (id: TargetId) => void
  /** Backend that resolves `secret:` references (default = macOS Keychain) */
  secrets?: SecretBackend
}

/**
 * For MCP targets, saves the pre-removal definition of each server this write removes (in tool syntax — secrets may be rendered)
 * to backups/deleted/<ts>/mcp/<tool>/<server>.json (files 0600, folders 0700). Returns the saved paths
 */
function backupRemovedServers(home: string, c: FileChange): string[] {
  const tool = MCP_TARGET_TOOL[c.id]
  if (!tool) return []
  const before = toolServerDefs(c.id, c.before)
  const after = toolServerDefs(c.id, c.after)
  const gone = Object.keys(before).filter((n) => !(n in after))
  if (!gone.length) return []
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const out: string[] = []
  for (const n of gone) {
    const safe = n.replace(/[^A-Za-z0-9._@-]/g, '_')
    const p = join(deletedBackupRoot(home), ts, 'mcp', tool, `${safe}.json`)
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
    writeFileSync(p, JSON.stringify({ [n]: before[n] }, null, 2) + '\n', { mode: 0o600 })
    chmodSync(p, 0o600)
    out.push(p)
  }
  return out
}

/**
 * geminiRules whose block was edited on the tool side (Gemini writes GEMINI.md itself): the previous block goes to
 * backups/deleted/<ts>/gemini/GEMINI.block.md (0600) before it is replaced. null if nothing to keep
 */
function backupEditedBlock(
  home: string,
  c: FileChange,
  applied: string | undefined
): string | null {
  if (c.id !== 'geminiRules' || !blockEdited(c.before, applied)) return null
  const body = blockBody(c.before, MD_BEGIN, MD_END)!
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const p = join(deletedBackupRoot(home), ts, 'gemini', 'GEMINI.block.md')
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
  writeFileSync(p, body.replace(/^\n/, ''), { mode: 0o600 })
  chmodSync(p, 0o600)
  return p
}

/** Targets re-checked once more right before writing (files the runtime writes often) */
const RECHECK_BEFORE_RENAME: ReadonlySet<TargetId> = new Set(['claudeMcp'])

function currentHash(path: string): string | null {
  return existsSync(path) ? sha256(readFileSync(path, 'utf8')) : null
}

function errCode(e: unknown): string {
  return (e as NodeJS.ErrnoException).code ?? (e as Error).name
}

/**
 * Recompute the plan and apply the ids targets. Without ids, the 6 base targets (plan default);
 * extra targets like opencodeRules are passed via ids (ALL_TARGET_IDS).
 * The source always wins: even if the tool changed the owned region, back up (.illithid.bak) and overwrite (restored=true).
 * Targets sharing a file (opencodeMcp, opencodeRules) are recomputed from current content after the earlier one writes.
 * Raw target file content is never included in results. Successful targets are recorded in state.json as afterRegionHash/owned.
 */
export function apply(
  home: string,
  env: Env = process.env,
  ids?: TargetId[],
  opts: ApplyOptions = {}
): ApplyResult[] {
  void opts.force
  const changes = plan(home, env, ids, opts.secrets)
  const st = readState(home)
  if (st.error) {
    return changes.map((c) => ({
      id: c.id,
      label: c.label,
      status: 'skipped',
      reason: 'stateError',
      detail: `state.json: ${st.error}`
    }))
  }
  // Leave other fields such as skills untouched
  const state: AppState = { ...st.state, applied: { ...st.state.applied } }
  const results: ApplyResult[] = []

  const record = (c: FileChange): void => {
    if (c.owned) state.owned = { ...(state.owned ?? {}), [c.id]: c.owned }
    if (c.afterRegionHash !== null) {
      state.applied[c.id] = { regionHash: c.afterRegionHash, at: new Date().toISOString() }
    }
    const dropped = c.retired?.length
      ? dropPending(
          state,
          c.retired.map((path) => ({
            // Imported hook originals in settings.json, or opencode.json instructions entries
            kind: HOOK_RETIRE_TOOL[c.id] ? ('hook' as const) : ('instruction' as const),
            tool: HOOK_RETIRE_TOOL[c.id] ?? ('opencode' as const),
            path,
            workspace: activeWorkspaceId(home)
          }))
        )
      : false
    if (c.owned || c.afterRegionHash !== null || dropped) writeState(home, state)
  }
  /** Files written in this call → sha256 of written content */
  const writtenNow = new Map<string, string>()

  for (const planned of changes) {
    let c = planned
    // If an earlier target just wrote this file, recompute from current content (leaving the earlier target's region alone)
    const ours = writtenNow.get(planned.path)
    if (ours !== undefined && currentHash(planned.path) === ours) {
      const t = ALL_TARGETS.find((x) => x.id === planned.id)!
      c = planTarget(home, t, buildContext(home, readPlanSources(home), env, opts.secrets))
    }
    const base = {
      id: c.id,
      label: c.label,
      ...(c.serverErrors ? { serverErrors: c.serverErrors } : {})
    }
    const skip = (reason: ApplySkipReason, detail?: string): void => {
      results.push({ ...base, status: 'skipped', reason, ...(detail ? { detail } : {}) })
    }
    // Absent file left alone (nothing to write, or a file only the tool itself creates) — not a failure, nothing recorded
    if (c.skip) {
      results.push({
        ...base,
        status: 'unchanged',
        reason: c.skip,
        ...(c.notes[0] ? { detail: c.notes[0] } : {})
      })
      continue
    }
    if (c.error) {
      skip('error', c.error)
      continue
    }
    // Does what plan read match the current file? (race during plan computation)
    const beforeHash = existsSync(c.path) ? sha256(c.before) : null
    if (currentHash(c.path) !== beforeHash) {
      skip('changedSinceCheck', 'file changed after plan was computed')
      continue
    }
    const expected = opts.expectedBefore?.[c.id]
    if (expected !== undefined && expected !== sha256(planned.before)) {
      skip('changedSinceCheck', 'file changed after check — re-check needed')
      continue
    }
    if (!c.changed) {
      // Already matches the source → only update the baseline hash
      record(c)
      results.push({ ...base, status: 'unchanged' })
      continue
    }
    const applied = state.applied[c.id]
    const restored = !!applied && c.beforeRegionHash !== applied.regionHash
    let backupPath: string | null = null
    let removedServerBackups: string[] = []
    let blockBackup: string | null = null
    try {
      removedServerBackups = backupRemovedServers(home, c)
      blockBackup = backupEditedBlock(home, c, applied?.regionHash)
      // If already backed up in this call, don't overwrite the original-content backup
      backupPath = ours !== undefined ? resolveWritePath(c.path) + BACKUP_SUFFIX : backup(c.path)
      atomicWrite(c.path, c.after, {
        ...(RECHECK_BEFORE_RENAME.has(c.id) ? { expectHash: beforeHash } : {}),
        ...(opts.beforeCommit ? { beforeCommit: () => opts.beforeCommit!(c.id) } : {})
      })
    } catch (e) {
      if (e instanceof ConcurrentChangeError) skip('changedSinceCheck', e.message)
      else skip('writeFailed', errCode(e))
      continue
    }
    writtenNow.set(c.path, sha256(c.after))
    record(c)
    results.push({
      ...base,
      status: 'written',
      ...(backupPath ? { backupPath } : {}),
      ...(removedServerBackups.length ? { removedServerBackups } : {}),
      ...(blockBackup ? { blockBackup } : {}),
      ...(restored
        ? { restored: true, detail: 'restored owned region changed on the tool side from source' }
        : {})
    })
  }
  return results
}
