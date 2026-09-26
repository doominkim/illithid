/**
 * App rename migration. Moves the single most recent generation (LEGACY_APP_GENERATIONS, newest first) whose old paths remain.
 *
 * harnesssync generation (HarnessSync → Illithid, library root already uses the workspace layout):
 * - `~/.harnesssync`         → `~/.illithid` (whole tree, including workspaces and artifacts)
 * - `~/.config/harnesssync`  → `~/.config/illithid` (config.json · state.json · backups/ · rollback/ · search.sqlite)
 * - Before moving, snapshot to `~/.config/harnesssync/rollback/pre-illithid-<ts>.tar` (both folders, excluding search.sqlite* and rollback/ — ends up in the new config folder after the move)
 * agent-console generation (agent-console → HarnessSync, the library itself is the root):
 * - `~/.agent-console`        → `~/.illithid/workspaces/default`
 * - `~/.config/agent-console` → `~/.config/illithid`
 * Common:
 * - config.libraryPath is retired — removed if present
 * - Library on/off file old names (harnesssync.json, agent-console.json) → illithid.json (per workspace)
 * - Rewrites app-owned path strings in state.json (owned, skills.previousLink) to the new library path
 *
 * Tool-side config (marker blocks, Claude rules folder, OpenCode paths) is updated by the next sync via legacy detection.
 * If a target path already exists (other than an empty skeleton), nothing is moved. With nothing to do, it does nothing (idempotent).
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  appConfigDir,
  appDataRoot,
  DEFAULT_WORKSPACE,
  LEGACY_APP_GENERATIONS,
  rootFormLibraryEntries,
  validateConfig,
  WORKSPACE_ID_RE,
  WORKSPACES_DIR,
  workspaceRoot,
  writeConfig,
  type AppConfig,
  type LegacyAppGeneration
} from './config'
import { GITIGNORE, LEGACY_GITIGNORES, LIBRARY_DIRS, WORKSPACE_FILE } from './init'
import { LEGACY_MANIFEST_FILES, MANIFEST_FILE } from './manifest'
import { claudeRulesPaths } from './ruleSync'
import { atomicWrite } from './write'

export interface RenameMove {
  what: 'library' | 'config'
  from: string
  to: string
  /** An empty library skeleton occupies the target and is cleared first */
  replaceEmptySkeleton?: boolean
}

export interface RenamePlan {
  /** Old-name generation to move this time (most recent one with old paths left). undefined if none */
  generation?: LegacyAppGeneration['name']
  /** Directories to move (only those whose old path exists) */
  moves: RenameMove[]
  /** Reasons blocking progress (target already exists, etc.). If any, applyRename does nothing */
  blocked: string[]
  /** config.libraryPath is still present and will be removed */
  dropLibraryPath: boolean
  /** Library on/off file renames (paths after the move) */
  manifests: { from: string; to: string }[]
  /** Number of path strings to rewrite in state.json */
  stateRewrites: number
  /** Snapshot tar to create before moving (harnesssync generation) */
  snapshot?: string
  /** Left for the next sync (informational) */
  followUps: string[]
  /** Whether there is anything to do */
  needed: boolean
}

export interface RenameResult {
  ok: boolean
  plan: RenamePlan
  /** Reason when ok=false */
  reason?: string
  moved: RenameMove[]
  /** Snapshot tar that was created */
  snapshot?: string
  configUpdated: boolean
  manifestsRenamed: number
  stateRewrites: number
}

function exists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/**
 * Whether this is an empty skeleton just made by initLibrary (empty rules/ skills/ mcps/ memory/ + default .gitignore, .DS_Store allowed).
 * If an empty library was created under the new name before the rename, only that is cleared before moving.
 */
export function isEmptyLibrarySkeleton(dir: string): boolean {
  const st = lstatOrNull(dir)
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false
  const dirs = new Set<string>(LIBRARY_DIRS)
  const gitignores = new Set<string>([GITIGNORE, ...LEGACY_GITIGNORES])
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = lstatSync(p)
    if (name === '.DS_Store' && s.isFile()) continue
    if (name === WORKSPACE_FILE && s.isFile()) continue
    if (name === '.gitignore' && s.isFile()) {
      if (!gitignores.has(readFileSync(p, 'utf8'))) return false
      continue
    }
    if (!dirs.has(name) || s.isSymbolicLink() || !s.isDirectory()) return false
    if (readdirSync(p).some((x) => x !== '.DS_Store')) return false
  }
  return true
}

/** Whether the app data root is empty: only an empty `workspaces/default/` skeleton (.DS_Store allowed) */
export function isEmptyDataRootSkeleton(root: string): boolean {
  const st = lstatOrNull(root)
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false
  const names = readdirSync(root).filter((n) => n !== '.DS_Store')
  if (names.length !== 1 || names[0] !== WORKSPACES_DIR) return false
  const ws = join(root, WORKSPACES_DIR)
  const wst = lstatSync(ws)
  if (wst.isSymbolicLink() || !wst.isDirectory()) return false
  const ids = readdirSync(ws).filter((n) => n !== '.DS_Store')
  return (
    ids.length === 1 &&
    ids[0] === DEFAULT_WORKSPACE &&
    isEmptyLibrarySkeleton(join(ws, DEFAULT_WORKSPACE))
  )
}

function removeDsStore(dir: string): void {
  if (existsSync(join(dir, '.DS_Store'))) unlinkSync(join(dir, '.DS_Store'))
}

/** Remove an empty skeleton (only after isEmptyLibrarySkeleton). rmdir fails on non-empty directories */
function removeSkeleton(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (lstatSync(p).isDirectory()) {
      removeDsStore(p)
      rmdirSync(p)
    } else unlinkSync(p)
  }
  rmdirSync(dir)
}

/** Remove an empty app data root (only after isEmptyDataRootSkeleton) */
function removeDataRootSkeleton(root: string): void {
  const ws = join(root, WORKSPACES_DIR)
  removeSkeleton(join(ws, DEFAULT_WORKSPACE))
  removeDsStore(ws)
  rmdirSync(ws)
  removeDsStore(root)
  rmdirSync(root)
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

interface GenPaths {
  gen: LegacyAppGeneration
  libFrom: string
  libTo: string
  cfgFrom: string
  cfgTo: string
}

function genPaths(home: string, gen: LegacyAppGeneration): GenPaths {
  return {
    gen,
    libFrom: join(home, gen.libraryDir),
    libTo: gen.layout === 'root' ? appDataRoot(home) : workspaceRoot(home, DEFAULT_WORKSPACE),
    cfgFrom: join(home, gen.configDir),
    cfgTo: appConfigDir(home)
  }
}

/** Whether the target can be treated as empty (missing or an empty skeleton) */
function libTargetFree(g: GenPaths): boolean {
  if (!exists(g.libTo)) return true
  return g.gen.layout === 'root'
    ? isEmptyDataRootSkeleton(g.libTo)
    : isEmptyLibrarySkeleton(g.libTo)
}

/** Most recent generation whose old paths (library or config) remain. null if none */
function pendingGeneration(home: string): GenPaths | null {
  for (const gen of LEGACY_APP_GENERATIONS) {
    const g = genPaths(home, gen)
    if (exists(g.libFrom) || exists(g.cfgFrom)) return g
  }
  return null
}

/** Map an old path string (absolute or `~/`) to the new path. null if no generation in gens matches */
function rewritePath(home: string, gens: GenPaths[], s: string): string | null {
  for (const g of gens) {
    const tildeFrom = '~' + g.libFrom.slice(home.length)
    const tildeTo = '~' + g.libTo.slice(home.length)
    if (s === g.libFrom || s.startsWith(g.libFrom + '/')) return g.libTo + s.slice(g.libFrom.length)
    if (s === tildeFrom || s.startsWith(tildeFrom + '/')) return tildeTo + s.slice(tildeFrom.length)
  }
  return null
}

/**
 * Generations whose state paths get rewritten: the one being moved now, plus those whose old library is already gone
 * (if a run stopped after the move but before rewriting state, the next run finishes it)
 */
function rewriteGens(home: string, active: GenPaths | null, movingLib: boolean): GenPaths[] {
  return LEGACY_APP_GENERATIONS.map((gen) => genPaths(home, gen)).filter(
    (g) => (movingLib && active?.gen.name === g.gen.name) || !exists(g.libFrom)
  )
}

/** Rewrite app-owned path strings (owned, skills.previousLink) in state.json (raw object) via fn (null = keep). Returns the count changed */
export function rewriteStatePaths(
  o: Record<string, unknown>,
  fn: (s: string) => string | null
): number {
  let n = 0
  const owned = o.owned as Record<string, unknown> | undefined
  if (owned && typeof owned === 'object') {
    for (const [id, list] of Object.entries(owned)) {
      if (!Array.isArray(list)) continue
      owned[id] = list.map((x) => {
        const r = typeof x === 'string' ? fn(x) : null
        if (r === null) return x
        n++
        return r
      })
    }
  }
  const skills = o.skills as Record<string, Record<string, Record<string, unknown>>> | undefined
  if (skills && typeof skills === 'object') {
    for (const byName of Object.values(skills)) {
      if (!byName || typeof byName !== 'object') continue
      for (const e of Object.values(byName)) {
        if (!e || typeof e !== 'object' || typeof e.previousLink !== 'string') continue
        const r = fn(e.previousLink)
        if (r !== null) {
          e.previousLink = r
          n++
        }
      }
    }
  }
  return n
}

/** Library folders (current location → location after the move): the app data root itself (root form) + each workspace */
function libraryDirs(nowRoot: string, afterRoot: string): { now: string; after: string }[] {
  const out = [{ now: nowRoot, after: afterRoot }]
  let ids: string[] = []
  try {
    ids = readdirSync(join(nowRoot, WORKSPACES_DIR)).filter((n) => WORKSPACE_ID_RE.test(n))
  } catch {
    ids = []
  }
  for (const id of ids.sort())
    out.push({ now: join(nowRoot, WORKSPACES_DIR, id), after: join(afterRoot, WORKSPACES_DIR, id) })
  return out
}

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Plan. Read-only */
export function planRename(home: string): RenamePlan {
  const g = pendingGeneration(home)
  const moves: RenameMove[] = []
  const blocked: string[] = []
  if (g && g.gen.layout === 'library' && exists(g.libFrom) && rootFormLibraryEntries(home).length)
    blocked.push(`A pre-workspace library already exists: ${appDataRoot(home)}`)
  if (g) {
    for (const m of [
      { what: 'library' as const, from: g.libFrom, to: g.libTo },
      { what: 'config' as const, from: g.cfgFrom, to: g.cfgTo }
    ]) {
      if (!exists(m.from)) continue
      if (!exists(m.to)) moves.push(m)
      else if (m.what === 'library' && libTargetFree(g))
        moves.push({ ...m, replaceEmptySkeleton: true })
      else blocked.push(`Target already exists: ${m.to}`)
    }
  }
  const movingLib = moves.some((m) => m.what === 'library')
  const movingCfg = moves.some((m) => m.what === 'config')
  // Read config at its post-move location (the new location if already moved)
  const cfgDir = g && movingCfg ? g.cfgFrom : appConfigDir(home)
  const cfgFile = join(cfgDir, 'config.json')
  const cfg = existsSync(cfgFile) ? readJson(cfgFile) : null
  if (existsSync(cfgFile) && !cfg) blocked.push(`Could not read config.json: ${cfgFile}`)
  // libraryPath is retired — remove it whatever its value
  const dropLibraryPath = !!cfg && cfg.libraryPath !== undefined

  // on/off files: inspect at the current location, record with the post-move path
  const dirs =
    g && movingLib
      ? g.gen.layout === 'root'
        ? libraryDirs(g.libFrom, g.libTo)
        : [{ now: g.libFrom, after: g.libTo }]
      : libraryDirs(appDataRoot(home), appDataRoot(home))
  const manifests: RenamePlan['manifests'] = []
  for (const d of dirs) {
    const legacy = LEGACY_MANIFEST_FILES.find((f) => existsSync(join(d.now, f)))
    if (!legacy) continue
    if (existsSync(join(d.now, MANIFEST_FILE)))
      blocked.push(`${MANIFEST_FILE} and ${legacy} both exist: ${d.now}`)
    else manifests.push({ from: join(d.after, legacy), to: join(d.after, MANIFEST_FILE) })
  }

  const stateFile = join(cfgDir, 'state.json')
  const state = existsSync(stateFile) ? readJson(stateFile) : null
  if (existsSync(stateFile) && !state) blocked.push(`Could not read state.json: ${stateFile}`)
  const gens = rewriteGens(home, g, movingLib)
  const stateRewrites = state ? rewriteStatePaths(state, (x) => rewritePath(home, gens, x)) : 0

  let snapshot: string | undefined
  if (g && g.gen.layout === 'root' && moves.length) {
    const rb = join(exists(g.cfgFrom) ? g.cfgFrom : appConfigDir(home), 'rollback')
    snapshot = join(rb, `pre-illithid-${stamp()}.tar`)
  }

  const followUps: string[] = []
  const rp = claudeRulesPaths(home)
  for (const legacyDir of rp.legacyDirs)
    if (exists(legacyDir)) followUps.push(`${legacyDir} → moved to ${rp.dir} on sync`)
  const needed = moves.length > 0 || dropLibraryPath || manifests.length > 0 || stateRewrites > 0
  return {
    ...(g ? { generation: g.gen.name } : {}),
    moves,
    blocked,
    dropLibraryPath,
    manifests,
    stateRewrites,
    ...(snapshot ? { snapshot } : {}),
    followUps,
    needed
  }
}

/** Pre-move snapshot (old library and config folders, excluding search.sqlite* and rollback/). Throws on failure */
function writeSnapshot(home: string, g: GenPaths, snap: string): void {
  mkdirSync(dirname(snap), { recursive: true, mode: 0o700 })
  const rel = (p: string): string => p.slice(home.length + 1)
  const items = [g.libFrom, g.cfgFrom].filter((p) => exists(p)).map(rel)
  const cfgRel = rel(g.cfgFrom)
  execFileSync(
    'tar',
    [
      '-cf',
      snap,
      '--exclude',
      `${cfgRel}/search.sqlite*`,
      '--exclude',
      `${cfgRel}/rollback`,
      '-C',
      home,
      ...items
    ],
    { stdio: 'ignore' }
  )
}

/**
 * Execute. Does nothing if blocked is non-empty.
 * Order: (harnesssync generation) snapshot → move library → move config (reverting the library on failure) → config.libraryPath → on/off files → state.
 */
export function applyRename(home: string): RenameResult {
  const plan = planRename(home)
  const result: RenameResult = {
    ok: false,
    plan,
    moved: [],
    configUpdated: false,
    manifestsRenamed: 0,
    stateRewrites: 0
  }
  if (plan.blocked.length) return { ...result, reason: plan.blocked.join('; ') }
  const g = pendingGeneration(home)
  if (g && plan.snapshot) {
    try {
      writeSnapshot(home, g, plan.snapshot)
      result.snapshot = plan.snapshot
    } catch (e) {
      return { ...result, reason: `Snapshot failed (${(e as Error).message})` }
    }
  }
  for (const m of plan.moves) {
    try {
      if (m.replaceEmptySkeleton) {
        if (g?.gen.layout === 'root') {
          if (!isEmptyDataRootSkeleton(m.to))
            throw Object.assign(new Error('notEmpty'), { code: 'ENOTEMPTY' })
          removeDataRootSkeleton(m.to)
        } else {
          if (!isEmptyLibrarySkeleton(m.to))
            throw Object.assign(new Error('notEmpty'), { code: 'ENOTEMPTY' })
          removeSkeleton(m.to)
        }
      }
      mkdirSync(dirname(m.to), { recursive: true, mode: 0o755 })
      renameSync(m.from, m.to)
      result.moved.push(m)
    } catch (e) {
      // Revert what was already moved
      for (const done of [...result.moved].reverse()) {
        try {
          renameSync(done.to, done.from)
        } catch {
          // Revert failed — noted in the reason (recover from the snapshot)
        }
      }
      return {
        ...result,
        moved: [],
        reason: `${m.from} → ${m.to} move failed (${(e as NodeJS.ErrnoException).code ?? 'unknown'})`
      }
    }
  }
  const cfgTo = appConfigDir(home)
  if (plan.dropLibraryPath) {
    const cfg = readJson(join(cfgTo, 'config.json'))
    if (cfg && validateConfig(cfg).length === 0) {
      delete cfg.libraryPath
      writeConfig(home, cfg as unknown as AppConfig)
      result.configUpdated = true
    }
  }
  for (const m of plan.manifests) {
    if (existsSync(m.from) && !existsSync(m.to)) {
      renameSync(m.from, m.to)
      result.manifestsRenamed++
    }
  }
  const stateFile = join(cfgTo, 'state.json')
  const state = existsSync(stateFile) ? readJson(stateFile) : null
  if (state) {
    const gens = rewriteGens(home, null, false)
    const n = rewriteStatePaths(state, (x) => rewritePath(home, gens, x))
    if (n) {
      atomicWrite(stateFile, JSON.stringify(state, null, 2) + '\n')
      result.stateRewrites = n
    }
  }
  return { ...result, ok: true }
}

/**
 * For the startup check: old-name paths still present while the new path does not exist yet (or is an empty skeleton). Empty array if none.
 * Creating an empty library then would hide the existing one, so it is not auto-created.
 */
export function renamePendingPaths(home: string): string[] {
  const out: string[] = []
  for (const gen of LEGACY_APP_GENERATIONS) {
    const g = genPaths(home, gen)
    if (
      exists(g.libFrom) &&
      libTargetFree(g) &&
      (gen.layout === 'root' || !rootFormLibraryEntries(home).length)
    )
      out.push(g.libFrom)
    if (exists(g.cfgFrom) && !exists(g.cfgTo)) out.push(g.cfgFrom)
  }
  return [...new Set(out)]
}

/** Whether old paths remain for a generation auto-migrated on startup (one whose library root uses the workspace layout) */
export function autoRenamePending(home: string): boolean {
  const g = pendingGeneration(home)
  return !!g && g.gen.layout === 'root'
}
