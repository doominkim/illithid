/**
 * Sync deletion (M7e: runs during sync without waiting for approval).
 * Recomputes the plan and acts only when the same item (path, hash/link) is present, and only inside tool skill directories,
 * the Claude rule copy directory, and tool agent directories. Nothing is permanently deleted — directories and files are moved
 * to <home>/.config/illithid/backups/deleted/<ts>/… (original bytes preserved); skill symlinks pointing at the source only
 * have the link removed. On success the app-ownership record in state is cleared.
 * The plan only makes delete candidates of app-owned copies (or source symlinks) recorded in state — user files never become candidates.
 */
import { cpSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { tools, type ToolId } from './agents'
import { agentToolDir } from './agentRender'
import { planAgentSync } from './agentSync'
import { isHookTool } from './hookEvents'
import { hookCopyRoot } from './hookRender'
import { planHookSync } from './hookSync'
import { appConfigDir } from './config'
import { claudeRulesPaths, copyRuleFile, copyRulesDir, planRuleSync } from './ruleSync'
import { dirContentHash } from './skills'
import { planSkillSync } from './skillSync'
import { readState, writeState } from './state'
import type { Env } from './types'
import { fileHash } from './write'

export interface DeleteRequest {
  kind: 'skill' | 'rule' | 'agent' | 'hook'
  tool?: ToolId
  name: string
  /** Absolute path from the plan */
  path: string
  currentHash?: string
  currentLink?: string
}

export interface DeleteResult {
  kind: 'skill' | 'rule' | 'agent' | 'hook'
  tool?: ToolId
  name: string
  status: 'deleted' | 'refused' | 'failed'
  reason?: string
  /** Destination (absolute). Absent when only a link was removed */
  backupPath?: string
}

/** Deletion backup root (<home>/.config/illithid/backups/deleted) */
export function deletedBackupRoot(home: string): string {
  return join(appConfigDir(home), 'backups/deleted')
}

function inside(root: string, p: string): boolean {
  const r = resolve(root)
  const q = resolve(p)
  return q === r || q.startsWith(r + sep)
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** rename; across filesystems, copy then delete */
function moveDir(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
  try {
    renameSync(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
    rmSync(from, { recursive: true, force: true })
  }
}

/**
 * Executes delete candidates. Recomputes the plan and acts only when the same item (path, hash/link) is present,
 * and only inside tool skill directories, the Claude rule copy directory, and tool agent directories. Directories and files
 * are moved to <home>/.config/illithid/backups/deleted/<ts>/…; symlinks only have the link removed.
 * On success the app-ownership record in state is cleared.
 */
export function deleteSyncCandidates(
  home: string,
  env: Env,
  reqs: DeleteRequest[]
): DeleteResult[] {
  const results: DeleteResult[] = []
  const st = readState(home)
  if (st.error) {
    return reqs.map((r) => ({
      kind: r.kind,
      name: r.name,
      status: 'refused',
      reason: `state.json: ${st.error}`
    }))
  }
  const state = st.state
  const ts = stamp()
  const backupRoot = join(deletedBackupRoot(home), ts)
  let skillPlan: ReturnType<typeof planSkillSync> | null = null
  let rulePlan: ReturnType<typeof planRuleSync> | null = null
  let agentPlan: ReturnType<typeof planAgentSync> | null = null
  let hookPlan: ReturnType<typeof planHookSync> | null = null
  let stateDirty = false

  for (const req of Array.isArray(reqs) ? reqs : []) {
    const base = { kind: req.kind, ...(req.tool ? { tool: req.tool } : {}), name: req.name }
    const refuse = (reason: string): void => {
      results.push({ ...base, status: 'refused', reason })
    }
    try {
      if (req.kind === 'skill') {
        if (!req.tool) {
          refuse('toolMissing')
          continue
        }
        skillPlan ??= planSkillSync(home, env)
        const it = skillPlan.find(
          (x) =>
            x.action === 'deleteCandidate' &&
            x.tool === req.tool &&
            x.name === req.name &&
            x.path === req.path
        )
        if (!it) {
          refuse('notACandidate')
          continue
        }
        const roots = tools(home).flatMap((t) =>
          t.skills.kind === 'symlinkDir' ? [t.skills.dir] : []
        )
        if (!roots.some((r) => inside(r, it.path)) || basename(it.path) !== it.name) {
          refuse('outOfScope')
          continue
        }
        const cur = lstatSync(it.path, { throwIfNoEntry: false })
        if (!cur) {
          refuse('missing')
          continue
        }
        if (it.currentLink !== undefined) {
          if (
            !cur.isSymbolicLink() ||
            readlinkSync(it.path) !== it.currentLink ||
            req.currentLink !== it.currentLink
          ) {
            refuse('changedSinceCheck')
            continue
          }
          unlinkSync(it.path)
          results.push({ ...base, status: 'deleted' })
        } else {
          if (
            cur.isSymbolicLink() ||
            !cur.isDirectory() ||
            dirContentHash(it.path) !== it.currentHash ||
            req.currentHash !== it.currentHash
          ) {
            refuse('changedSinceCheck')
            continue
          }
          const backup = join(backupRoot, 'skills', req.tool, it.name)
          moveDir(it.path, backup)
          results.push({ ...base, status: 'deleted', backupPath: backup })
        }
        if (state.skills?.[req.tool]?.[it.name]) {
          delete state.skills[req.tool]![it.name]
          stateDirty = true
        }
      } else if (req.kind === 'agent') {
        if (!req.tool) {
          refuse('toolMissing')
          continue
        }
        agentPlan ??= planAgentSync(home, env)
        const it = agentPlan.find(
          (x) =>
            x.action === 'deleteCandidate' &&
            x.tool === req.tool &&
            x.name === req.name &&
            x.path === req.path
        )
        if (!it) {
          refuse('notACandidate')
          continue
        }
        const { dir, ext } = agentToolDir(home, req.tool)
        if (!inside(dir, it.path) || resolve(it.path) !== join(dir, it.name + ext)) {
          refuse('outOfScope')
          continue
        }
        const cur = lstatSync(it.path, { throwIfNoEntry: false })
        if (
          !cur ||
          cur.isSymbolicLink() ||
          !cur.isFile() ||
          fileHash(it.path) !== it.currentHash ||
          req.currentHash !== it.currentHash
        ) {
          refuse('changedSinceCheck')
          continue
        }
        const backup = join(backupRoot, 'agents', req.tool, basename(it.path))
        moveDir(it.path, backup)
        results.push({ ...base, status: 'deleted', backupPath: backup })
        if (state.agents?.[req.tool]?.[it.name]) {
          delete state.agents[req.tool]![it.name]
          stateDirty = true
        }
      } else if (req.kind === 'hook') {
        if (!req.tool || !isHookTool(req.tool)) {
          refuse('toolMissing')
          continue
        }
        hookPlan ??= planHookSync(home, env)
        const it = hookPlan.find(
          (x) =>
            x.action === 'deleteCandidate' &&
            x.tool === req.tool &&
            x.name === req.name &&
            x.path === req.path
        )
        if (!it) {
          refuse('notACandidate')
          continue
        }
        const root = hookCopyRoot(home, it.tool)
        if (!inside(root, it.path) || resolve(it.path) !== join(root, it.hook, it.file)) {
          refuse('outOfScope')
          continue
        }
        const cur = lstatSync(it.path, { throwIfNoEntry: false })
        if (
          !cur ||
          cur.isSymbolicLink() ||
          !cur.isFile() ||
          fileHash(it.path) !== it.currentHash ||
          req.currentHash !== it.currentHash
        ) {
          refuse('changedSinceCheck')
          continue
        }
        const backup = join(backupRoot, 'hooks', it.tool, it.hook, it.file)
        moveDir(it.path, backup)
        results.push({ ...base, status: 'deleted', backupPath: backup })
        if (state.hookScripts?.[it.tool]?.[it.name]) {
          delete state.hookScripts[it.tool]![it.name]
          stateDirty = true
        }
      } else if (req.kind === 'rule') {
        rulePlan ??= planRuleSync(home, env)
        const it = rulePlan.find(
          (x) =>
            x.action === 'deleteCandidate' &&
            x.tool === req.tool &&
            x.name === req.name &&
            x.path === req.path
        )
        if (!it) {
          refuse('notACandidate')
          continue
        }
        const dir = it.tool ? copyRulesDir(home, it.tool) : claudeRulesPaths(home).dir
        const file = it.tool ? copyRuleFile(it.tool, it.name) : it.name
        if (!inside(dir, it.path) || basename(it.path) !== file) {
          refuse('outOfScope')
          continue
        }
        const cur = lstatSync(it.path, { throwIfNoEntry: false })
        if (
          !cur ||
          cur.isSymbolicLink() ||
          !cur.isFile() ||
          fileHash(it.path) !== it.currentHash ||
          req.currentHash !== it.currentHash
        ) {
          refuse('changedSinceCheck')
          continue
        }
        const backup = it.tool
          ? join(backupRoot, 'rules', it.tool, file)
          : join(backupRoot, 'rules', it.name)
        moveDir(it.path, backup)
        results.push({ ...base, status: 'deleted', backupPath: backup })
        const records = it.tool ? state.toolRules?.[it.tool] : state.rules
        if (records?.[it.name]) {
          delete records[it.name]
          stateDirty = true
        }
      } else {
        refuse('unknownKind')
      }
    } catch (e) {
      results.push({
        ...base,
        status: 'failed',
        reason: (e as NodeJS.ErrnoException).code ?? (e as Error).message
      })
    }
  }
  if (stateDirty) writeState(home, state)
  return results
}
