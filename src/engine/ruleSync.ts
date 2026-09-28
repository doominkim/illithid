import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { canonicalPaths, copilotHomeOverride, grokHomeOverride, tilde } from './agents'
import { syncTools } from './config'
import { dropPending, importStamp, pendingOf, retireHash, retireOriginal, retireSkipReason } from './pendingRetire'
import { libraryPaths } from './sources'
import { isEnabled, MANIFEST_FILE, readPlanManifest } from './manifest'
import { readState, writeState, type AppState } from './state'
import { sha256 } from './text'
import type { Env } from './types'
import { deliveredShape, deliverFile, shapeMatches } from './deliver'
import {
  backup,
  BACKUP_SUFFIX,
  ConcurrentChangeError,
  isAppTmpName,
  LEGACY_BACKUP_SUFFIXES
} from './write'

/** Claude rules copy target directory name (`~/.claude/rules/<name>/`) */
export const CLAUDE_RULES_DIR = 'illithid'
/** Copy folders from previous app names (`~/.claude/rules/harnesssync/`, `agent-console/`, newest first). Moved to the new folder if app-owned */
export const LEGACY_CLAUDE_RULES_DIRS = ['harnesssync', 'agent-console'] as const
/** Claude rules path name from the symlink era (`~/.claude/rules/shared` → library rules) */
export const LEGACY_CLAUDE_RULES_LINK = 'shared'

/**
 * Name of the Claude memory index copy (`~/.claude/rules/illithid/MEMORY.md`).
 * Source = active workspace memory/MEMORY.md; relative links `](x/y.md)` are rewritten to absolute paths.
 * A library rule with the same name wins (memory is not copied).
 */
export const CLAUDE_MEMORY_RULE = 'MEMORY.md'

/** Memory index content → Claude copy content (relative links → absolute paths under memoryDir) */
export function claudeMemoryContent(text: string, memoryDir: string): string {
  return text.replace(/\]\(([^)\s]+)\)/g, (m, target: string) => {
    if (/^([a-z][a-z0-9+.-]*:|\/|#|~)/i.test(target)) return m
    return `](${resolve(memoryDir, target)})`
  })
}

/** Rule source content (converted content for the memory index) */
function sourceContent(home: string, name: string, source: string): string {
  const text = readFileSync(source, 'utf8')
  const lp = libraryPaths(home)
  return name === CLAUDE_MEMORY_RULE && resolve(source) === lp.memoryIndex
    ? claudeMemoryContent(text, lp.memoryDir)
    : text
}

export function claudeRulesPaths(home: string): {
  dir: string
  legacyLink: string
  /** Old-name folders (LEGACY_CLAUDE_RULES_DIRS order) */
  legacyDirs: string[]
} {
  const base = join(home, '.claude/rules')
  return {
    dir: join(base, CLAUDE_RULES_DIR),
    legacyLink: join(base, LEGACY_CLAUDE_RULES_LINK),
    legacyDirs: LEGACY_CLAUDE_RULES_DIRS.map((n) => join(base, n))
  }
}

/**
 * Claude rules copy plan
 * - copy            missing from the target directory → copy
 * - update          app-written file differs from the source. drift=true means it was edited tool-side — the source wins, so
 *                   it is backed up (.illithid.bak) and overwritten (M7d: never skipped)
 * - inSync          app-written file matches the source (only the record is refreshed if stateStale)
 * - skip            file the app never wrote (user-owned, reason=userOwned) → left alone
 * - deleteCandidate app copy whose source is gone or disabled for claude (reason=disabled) → shown only
 * - replaceLink     symlink `~/.claude/rules/shared` still exists → pending link removal.
 *                   Not executed before the approval gate (G1/G2) (requiresApproval)
 * - migrateLegacyDir for each old-name folder (`~/.claude/rules/harnesssync/`, `agent-console/`) whose files are all app-owned (state.rules)
 *                   → move into the new folder and delete the old one (runs before other items, newest generation first). If non-app-owned entries
 *                   are mixed in, it becomes skip (reason=legacyDirUserFiles) and is left alone.
 *                   When present, other items are planned against post-move content (the old folder if missing from the new one).
 * - retireImported  imported original `~/.claude/rules/<name>` (state.pendingRetire) still matching its import hash → moved to
 *                   backups/imported once the app copy is in place, so Claude doesn't read the rule twice. If the original changed
 *                   since import it becomes skip (reason=importedChanged) and is left alone.
 * Empty plan when Claude is not in use (config.toolsInUse).
 */
export type RuleSyncAction =
  'copy' | 'update' | 'inSync' | 'skip' | 'deleteCandidate' | 'replaceLink' | 'migrateLegacyDir' | 'retireImported'

export interface RuleSyncItem {
  /** Tool whose rule copy this is. Absent = Claude (`~/.claude/rules/illithid/`); copilot = `~/.copilot/instructions/illithid/` */
  tool?: CopyRuleTool
  /** Library rule name (MEMORY.md for the memory index) */
  name: string
  action: RuleSyncAction
  /** Tool-side path */
  path: string
  /** Source path (for replaceLink, the link target) */
  source: string
  sourceHash?: string
  currentHash?: string
  drift?: boolean
  stateStale?: boolean
  /** Reason for skip / deleteCandidate */
  reason?: string
  sameContent?: boolean
  /** Current link string for replaceLink */
  currentLink?: string
  /** Requires user approval before running (replaceLink) */
  requiresApproval?: boolean
  /** migrateLegacyDir: old folder entry names at plan time (sorted). Moved only if unchanged right before running */
  entries?: string[]
}

export interface RuleSyncResult {
  tool?: CopyRuleTool
  name: string
  action: RuleSyncAction
  status: 'done' | 'unchanged' | 'skipped' | 'pendingApproval' | 'refused' | 'failed'
  reason?: string
  path: string
  /** Removed link string (for rollback) */
  previousLink?: string
  /** Backup of the previous tool-side content when restoring drift (`<file>.illithid.bak`) */
  backupPath?: string
}

export interface RuleSyncOptions {
  /** @deprecated Source always wins since M7d (accepted for compatibility only) */
  force?: boolean
  /**
   * Allow running replaceLink (removing the shared symlink). Pass true only after the G1/G2 approval gate.
   * Only the link is removed; its target (the library) is untouched.
   */
  allowLinkRemoval?: boolean
}

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

const fileHash = (p: string): string => sha256(readFileSync(p, 'utf8'))

/** Handling of one old-folder entry: name to move into the new folder (move) or discard (drop). null if not app-owned */
type LegacyEntryPlan = { name: string; move?: string } | null

function classifyLegacyEntry(
  legacyDir: string,
  name: string,
  managed: Record<string, unknown>
): LegacyEntryPlan {
  const st = lstatOrNull(join(legacyDir, name))
  if (!st || st.isSymbolicLink() || !st.isFile()) return null
  if (name === '.DS_Store' || isAppTmpName(name)) return { name }
  for (const suffix of [...LEGACY_BACKUP_SUFFIXES, BACKUP_SUFFIX]) {
    if (name.endsWith(suffix)) {
      const base = name.slice(0, -suffix.length)
      return managed[base] ? { name, move: base + BACKUP_SUFFIX } : null
    }
  }
  return name.endsWith('.md') && !name.startsWith('.') && managed[name]
    ? { name, move: name }
    : null
}

/**
 * Migration plan for one old-name folder. null if the folder is missing.
 * ok=false means non-app-owned entries are mixed in (the old folder is left alone).
 */
function planLegacyDir(
  legacyDir: string,
  managed: Record<string, unknown>
): { ok: boolean; entries: string[]; plans: NonNullable<LegacyEntryPlan>[] } | null {
  const st = lstatOrNull(legacyDir)
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return null
  const entries = readdirSync(legacyDir).sort()
  const plans: NonNullable<LegacyEntryPlan>[] = []
  for (const name of entries) {
    const p = classifyLegacyEntry(legacyDir, name, managed)
    if (!p) return { ok: false, entries, plans: [] }
    plans.push(p)
  }
  return { ok: true, entries, plans }
}

/** Plan (Claude copies, then Copilot and Grok copies). Read-only */
export function planRuleSync(home: string, env: Env = process.env): RuleSyncItem[] {
  return [...planClaudeRules(home, env), ...planCopyRules(home, 'copilot', env), ...planCopyRules(home, 'grok', env)]
}

function planClaudeRules(home: string, _env: Env = process.env): RuleSyncItem[] {
  void _env
  if (!syncTools(home).includes('claude')) return []
  const rulesDir = canonicalPaths(home).rules
  const { dir, legacyLink, legacyDirs } = claudeRulesPaths(home)
  const mf = readPlanManifest(home)
  if (mf.error) throw new Error(`${MANIFEST_FILE}: ${mf.error}`)
  const appState = readState(home).state
  const managed = appState.rules ?? {}
  const items: RuleSyncItem[] = []

  // Old-name folders: a migration item (runs first) if all app-owned, otherwise skip. Not while Claude is off (nothing moves in)
  const movable: string[] = []
  const claudeOff = !!mf.manifest.offTools?.includes('claude')
  legacyDirs.forEach((legacyDir, i) => {
    if (claudeOff) return
    const legacy = planLegacyDir(legacyDir, managed)
    if (!legacy) return
    if (legacy.ok) movable.push(legacyDir)
    items.push({
      name: LEGACY_CLAUDE_RULES_DIRS[i],
      action: legacy.ok ? 'migrateLegacyDir' : 'skip',
      path: legacyDir,
      source: dir,
      entries: legacy.entries,
      ...(legacy.ok ? {} : { reason: 'legacyDirUserFiles' })
    })
  })
  // Current file location after migration: the old folder file to be moved in, if missing from the new folder
  const current = (name: string): string => {
    const p = join(dir, name)
    if (lstatOrNull(p)) return p
    for (const legacyDir of movable) {
      const old = join(legacyDir, name)
      if (lstatOrNull(old)) return old
    }
    return p
  }

  const names = existsSync(rulesDir)
    ? readdirSync(rulesDir)
        .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
        .sort()
    : []
  const enabled = new Set(names.filter((n) => isEnabled(mf.manifest, 'rules', n, 'claude')))
  const sources = new Map<string, string>()
  for (const n of enabled) sources.set(n, join(rulesDir, n))
  // Memory index → MEMORY.md (when no rule has the same name)
  const memIndex = libraryPaths(home).memoryIndex
  const memSt = lstatOrNull(memIndex)
  if (!names.includes(CLAUDE_MEMORY_RULE) && memSt?.isFile() && !mf.manifest.offTools?.includes('claude')) {
    enabled.add(CLAUDE_MEMORY_RULE)
    sources.set(CLAUDE_MEMORY_RULE, memIndex)
  }

  for (const name of [...sources.keys()].sort()) {
    const path = join(dir, name)
    const source = sources.get(name)!
    // Imported original awaiting retirement (listed before the copy item; runs once the copy is in place)
    for (const p of pendingOf(home, appState, 'rule', 'claude', name)) {
      const currentHash = retireHash(p.path)
      if (currentHash === null) continue
      items.push({
        name,
        action: currentHash === p.hash ? 'retireImported' : 'skip',
        path: p.path,
        source: path,
        currentHash,
        ...(currentHash === p.hash ? {} : { reason: retireSkipReason(currentHash) })
      })
    }
    const sourceHash = sha256(sourceContent(home, name, source))
    const base = { name, path, source, sourceHash }
    const cur = current(name)
    const shape = deliveredShape(cur, source)
    if (shape.kind === 'absent') items.push({ ...base, action: 'copy' })
    else if (!shapeMatches(shape) || (shape.kind === 'copy' && shape.isDir))
      items.push({ ...base, action: 'skip', reason: 'notRegularFile' })
    else {
      const currentHash = fileHash(cur)
      const rec = managed[name]
      if (!rec)
        items.push({
          ...base,
          action: 'skip',
          currentHash,
          reason: 'userOwned',
          sameContent: currentHash === sourceHash
        })
      else if (currentHash === sourceHash)
        items.push({
          ...base,
          action: 'inSync',
          currentHash,
          ...(rec.contentHash !== currentHash ? { stateStale: true } : {})
        })
      else
        items.push({
          ...base,
          action: 'update',
          currentHash,
          ...(rec.contentHash !== currentHash ? { drift: true } : {})
        })
    }
  }
  // App copies whose source is gone or disabled
  for (const name of Object.keys(managed).sort()) {
    if (enabled.has(name)) continue
    const path = join(dir, name)
    const cur = current(name)
    const st = lstatOrNull(cur)
    if (st?.isFile() && !st.isSymbolicLink()) {
      items.push({
        name,
        action: 'deleteCandidate',
        path,
        source: join(rulesDir, name),
        currentHash: fileHash(cur),
        reason: names.includes(name) ? 'disabled' : 'removedFromLibrary'
      })
    }
  }
  const link = lstatOrNull(legacyLink)
  if (link?.isSymbolicLink()) {
    const currentLink = readlinkSync(legacyLink)
    items.push({
      name: LEGACY_CLAUDE_RULES_LINK,
      action: 'replaceLink',
      path: legacyLink,
      source: resolve(dirname(legacyLink), currentLink),
      currentLink,
      requiresApproval: true
    })
  }
  return items
}

/** Run the old-name folder migration. Only if entries match the plan and are all app-owned */
function migrateLegacyDir(
  home: string,
  it: RuleSyncItem,
  managed: Record<string, unknown>
): RuleSyncResult {
  const { dir, legacyDirs } = claudeRulesPaths(home)
  const legacyDir = resolve(it.path)
  const res = (status: RuleSyncResult['status'], reason?: string): RuleSyncResult => ({
    name: it.name,
    action: it.action,
    status,
    path: it.path,
    ...(reason ? { reason } : {})
  })
  if (!legacyDirs.includes(legacyDir)) return res('refused', 'outOfScope')
  const now = planLegacyDir(legacyDir, managed)
  if (!now) return res('unchanged', 'legacyDirGone')
  if (!now.ok) return res('skipped', 'legacyDirUserFiles')
  if (JSON.stringify(now.entries) !== JSON.stringify(it.entries ?? []))
    return res('refused', 'changedSinceCheck')
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    for (const p of now.plans) {
      const from = join(legacyDir, p.name)
      const to = p.move ? join(dir, p.move) : null
      // If already in the new folder, that one is canonical — discard the old copy
      if (to && !lstatOrNull(to)) renameSync(from, to)
      else unlinkSync(from)
    }
    rmdirSync(legacyDir) // only removes an empty folder
    return res('done')
  } catch (e) {
    return res('failed', (e as NodeJS.ErrnoException).code ?? (e as Error).name)
  }
}

/**
 * Runs migrateLegacyDir first (old-name folder → new folder), then recomputes the plan to validate the rest.
 * Executes copy/update; inSync (stateStale) refreshes the record. deleteCandidate is display-only.
 * replaceLink removes the link only with opts.allowLinkRemoval (otherwise pendingApproval).
 * Each item runs only if the current plan has the same action and hash.
 */
export function applyRuleSync(
  home: string,
  env: Env,
  items: RuleSyncItem[],
  opts: RuleSyncOptions = {}
): RuleSyncResult[] {
  const { dir, legacyLink } = claudeRulesPaths(home)
  const rulesDir = canonicalPaths(home).rules
  const st = readState(home)
  const results: RuleSyncResult[] = []
  const out = (
    it: RuleSyncItem,
    status: RuleSyncResult['status'],
    extra: Partial<RuleSyncResult> = {}
  ): void => {
    results.push({ ...(it.tool ? { tool: it.tool } : {}), name: it.name, action: it.action, status, path: it.path, ...extra })
  }
  if (st.error) {
    for (const it of items) out(it, 'refused', { reason: 'stateError' })
    return results
  }
  const state: AppState = { ...st.state, rules: { ...(st.state.rules ?? {}) } }
  const record = (name: string, contentHash: string): void => {
    state.rules![name] = { contentHash, at: new Date().toISOString() }
    writeState(home, state)
  }
  const copyItems = items.filter((it) => it.tool !== undefined)
  items = items.filter((it) => it.tool === undefined)
  for (const it of items) {
    if (it.action === 'migrateLegacyDir') results.push(migrateLegacyDir(home, it, state.rules!))
  }
  const fresh = planClaudeRules(home, env)

  for (const it of items) {
    if (it.action === 'migrateLegacyDir' || it.action === 'retireImported') continue
    if (it.action === 'skip') {
      out(it, 'skipped', { reason: it.reason ?? 'skip' })
      continue
    }
    if (it.action === 'deleteCandidate') {
      out(it, 'pendingApproval', { reason: 'Deletion goes through a separate approval flow' })
      continue
    }
    const f = fresh.find((x) => x.name === it.name && x.action === it.action)
    if (it.action === 'replaceLink') {
      if (resolve(it.path) !== legacyLink) {
        out(it, 'refused', { reason: 'outOfScope' })
        continue
      }
      if (!opts.allowLinkRemoval) {
        out(it, 'pendingApproval', { reason: `Approval required — remove link ${tilde(home, legacyLink)}` })
        continue
      }
      const cur = lstatOrNull(legacyLink)
      if (!f || !cur?.isSymbolicLink() || readlinkSync(legacyLink) !== it.currentLink) {
        out(it, 'refused', { reason: 'changedSinceCheck' })
        continue
      }
      try {
        unlinkSync(legacyLink) // remove the link only
        out(it, 'done', { previousLink: it.currentLink! })
      } catch (e) {
        out(it, 'failed', { reason: (e as NodeJS.ErrnoException).code ?? 'unknown' })
      }
      continue
    }
    if (
      !it.name.endsWith('.md') ||
      it.name.includes('/') ||
      it.name.startsWith('.') ||
      resolve(it.path) !== join(dir, it.name) ||
      (resolve(it.source) !== join(rulesDir, it.name) &&
        !(it.name === CLAUDE_MEMORY_RULE && resolve(it.source) === libraryPaths(home).memoryIndex))
    ) {
      out(it, 'refused', { reason: 'outOfScope' })
      continue
    }
    if (
      !f ||
      (it.sourceHash !== undefined && f.sourceHash !== it.sourceHash) ||
      (it.currentHash !== undefined && f.currentHash !== it.currentHash)
    ) {
      out(it, 'refused', { reason: 'changedSinceCheck' })
      continue
    }
    if (f.action === 'inSync') {
      if (f.stateStale) {
        record(f.name, f.currentHash!)
        out(it, 'done', { reason: 'stateRefreshed' })
      } else out(it, 'unchanged')
      continue
    }
    void opts.force // M7d: source wins — drift is backed up, then overwritten
    try {
      const content = sourceContent(home, f.name, f.source)
      if (sha256(content) !== f.sourceHash) {
        out(it, 'refused', { reason: 'changedSinceCheck' })
        continue
      }
      // Quietly back up a copy edited tool-side (most recent one only)
      const backupPath = f.drift ? backup(f.path) : null
      deliverFile(f.source, f.path, content, {
        mode: 0o644,
        expectHash: f.action === 'copy' ? null : f.currentHash!
      })
      record(f.name, f.sourceHash!)
      out(it, 'done', {
        ...(backupPath ? { backupPath } : {}),
        ...(f.drift ? { reason: 'restored' } : {})
      })
    } catch (e) {
      if (e instanceof ConcurrentChangeError) out(it, 'refused', { reason: 'changedSinceCheck' })
      else out(it, 'failed', { reason: (e as NodeJS.ErrnoException).code ?? (e as Error).name })
    }
  }
  // Imported originals: moved only after the app copy is in place and recorded (never a moment without the rule)
  const ts = importStamp()
  for (const it of items) {
    if (it.action !== 'retireImported') continue
    const copy = join(dir, it.name)
    const rec = state.rules![it.name]
    const p = pendingOf(home, state, 'rule', 'claude', it.name).find((x) => resolve(x.path) === resolve(it.path))
    // The original sits directly in ~/.claude/rules (its file name may differ from it.name after a library rename)
    if (dirname(resolve(it.path)) !== join(home, '.claude/rules') || !it.path.endsWith('.md') || !it.name.endsWith('.md') || it.name.includes('/')) {
      out(it, 'refused', { reason: 'outOfScope' })
      continue
    }
    if (!p || p.hash !== it.currentHash) {
      out(it, 'refused', { reason: 'changedSinceCheck' })
      continue
    }
    const copySt = lstatOrNull(copy)
    if (!rec || !copySt?.isFile() || copySt.isSymbolicLink() || fileHash(copy) !== rec.contentHash) {
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
  for (const tool of COPY_RULE_TOOLS) {
    const mine = copyItems.filter((it) => it.tool === tool)
    if (mine.length) results.push(...applyCopyRules(home, env, tool, mine))
  }
  return results
}

/** For rollback: recreate the removed shared link (only if the spot is empty) */
export function restoreLegacyRulesLink(home: string, previousLink: string): boolean {
  const { legacyLink } = claudeRulesPaths(home)
  if (lstatOrNull(legacyLink)) return false
  symlinkSync(previousLink, legacyLink)
  return true
}

// ---------------------------------------------------------------- Rule copies of other tools (Copilot)

/** Tools whose rules are copied file by file. undefined (absent) = Claude, handled above */
export type CopyRuleTool = 'copilot' | 'grok'
export const COPY_RULE_TOOLS: readonly CopyRuleTool[] = ['copilot', 'grok']

/** Grok's copy of the memory index. ~/.grok/rules is shared with the user, so the app's file carries the app name */
export const GROK_MEMORY_RULE_FILE = 'illithid-memory.md'

/** The tool's home override points elsewhere (COPILOT_HOME / GROK_HOME): the app's folder would not be read */
function copyToolOverridden(home: string, tool: CopyRuleTool, env: Env): boolean {
  return tool === 'copilot' ? !!copilotHomeOverride(home, env) : !!grokHomeOverride(home, env)
}

/** App-owned folder the tool reads rules from */
export function copyRulesDir(home: string, tool: CopyRuleTool): string {
  switch (tool) {
    case 'copilot':
      return join(home, '.copilot/instructions', CLAUDE_RULES_DIR)
    // Grok reads only *.md directly under rules/ — the folder is shared with the user (app copies tracked in state)
    case 'grok':
      return join(home, '.grok/rules')
  }
}

/** Library rule name → file name in the tool folder (Copilot reads `*.instructions.md`; no frontmatter = applies everywhere) */
export function copyRuleFile(tool: CopyRuleTool, name: string): string {
  switch (tool) {
    case 'copilot':
      return name.replace(/\.md$/, '') + '.instructions.md'
    case 'grok':
      return name === CLAUDE_MEMORY_RULE ? GROK_MEMORY_RULE_FILE : name
  }
}

/**
 * Copy content for the tool. Copilot applies an *.instructions.md automatically only if its frontmatter has applyTo (or
 * description) — without either it is attach-only — so `applyTo: "**"` is added unless the rule already sets applyTo
 */
export function copyRuleContent(tool: CopyRuleTool, text: string): string {
  switch (tool) {
    case 'copilot': {
      const fm = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)
      if (!fm) return `---\napplyTo: "**"\n---\n\n${text}`
      if (/^applyTo\s*:/m.test(fm[1])) return text
      return text.replace(/^---(\r?\n)/, (m, eol: string) => `${m}applyTo: "**"${eol}`)
    }
    case 'grok':
      return text
  }
}

/**
 * Copy plan for one tool (same actions as Claude's, without the link and old-folder migration). App-owned copies are recorded in
 * state.toolRules[tool]; other files in the folder are user-owned (skip). Empty when the tool is not in use.
 */
function planCopyRules(home: string, tool: CopyRuleTool, env: Env): RuleSyncItem[] {
  if (!syncTools(home).includes(tool) || copyToolOverridden(home, tool, env)) return []
  const rulesDir = canonicalPaths(home).rules
  const dir = copyRulesDir(home, tool)
  const mf = readPlanManifest(home)
  if (mf.error) throw new Error(`${MANIFEST_FILE}: ${mf.error}`)
  const appState = readState(home).state
  const managed = appState.toolRules?.[tool] ?? {}
  const items: RuleSyncItem[] = []
  const names = existsSync(rulesDir)
    ? readdirSync(rulesDir)
        .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
        .sort()
    : []
  const sources = new Map<string, string>()
  for (const n of names) if (isEnabled(mf.manifest, 'rules', n, tool)) sources.set(n, join(rulesDir, n))
  const memIndex = libraryPaths(home).memoryIndex
  if (!names.includes(CLAUDE_MEMORY_RULE) && lstatOrNull(memIndex)?.isFile() && !mf.manifest.offTools?.includes(tool)) sources.set(CLAUDE_MEMORY_RULE, memIndex)

  for (const name of [...sources.keys()].sort()) {
    const path = join(dir, copyRuleFile(tool, name))
    const source = sources.get(name)!
    // A library rule named like Grok's memory copy would collide with it in the shared folder
    if (tool === 'grok' && name === GROK_MEMORY_RULE_FILE) {
      items.push({ tool, name, action: 'skip', path, source, reason: 'reservedName' })
      continue
    }
    for (const p of pendingOf(home, appState, 'rule', tool, name)) {
      const currentHash = retireHash(p.path)
      if (currentHash === null) continue
      items.push({
        tool,
        name,
        action: currentHash === p.hash ? 'retireImported' : 'skip',
        path: p.path,
        source: path,
        currentHash,
        ...(currentHash === p.hash ? {} : { reason: retireSkipReason(currentHash) })
      })
    }
    const sourceHash = sha256(copyRuleContent(tool, sourceContent(home, name, source)))
    const base = { tool, name, path, source, sourceHash }
    const shape = deliveredShape(path, source)
    if (shape.kind === 'absent') items.push({ ...base, action: 'copy' })
    else if (!shapeMatches(shape) || (shape.kind === 'copy' && shape.isDir))
      items.push({ ...base, action: 'skip', reason: 'notRegularFile' })
    else {
      const currentHash = fileHash(path)
      const rec = managed[name]
      if (!rec) items.push({ ...base, action: 'skip', currentHash, reason: 'userOwned', sameContent: currentHash === sourceHash })
      else if (currentHash === sourceHash)
        items.push({ ...base, action: 'inSync', currentHash, ...(rec.contentHash !== currentHash ? { stateStale: true } : {}) })
      else items.push({ ...base, action: 'update', currentHash, ...(rec.contentHash !== currentHash ? { drift: true } : {}) })
    }
  }
  for (const name of Object.keys(managed).sort()) {
    if (sources.has(name)) continue
    const path = join(dir, copyRuleFile(tool, name))
    const st = lstatOrNull(path)
    // ~/.grok/rules is shared with the user: a copy edited there since the app wrote it is left alone
    if (tool === 'grok' && st?.isFile() && !st.isSymbolicLink() && fileHash(path) !== managed[name].contentHash) {
      items.push({ tool, name, action: 'skip', path, source: join(rulesDir, name), currentHash: fileHash(path), reason: 'userEdited' })
      continue
    }
    if (st?.isFile() && !st.isSymbolicLink())
      items.push({
        tool,
        name,
        action: 'deleteCandidate',
        path,
        source: join(rulesDir, name),
        currentHash: fileHash(path),
        reason: names.includes(name) ? 'disabled' : 'removedFromLibrary'
      })
  }
  return items
}

/** Run one tool's copy items (same checks as Claude: each item must match a fresh plan). Imported originals move last */
function applyCopyRules(home: string, env: Env, tool: CopyRuleTool, items: RuleSyncItem[]): RuleSyncResult[] {
  const results: RuleSyncResult[] = []
  const out = (it: RuleSyncItem, status: RuleSyncResult['status'], extra: Partial<RuleSyncResult> = {}): void => {
    results.push({ tool, name: it.name, action: it.action, status, path: it.path, ...extra })
  }
  const st = readState(home)
  if (st.error) {
    for (const it of items) out(it, 'refused', { reason: 'stateError' })
    return results
  }
  const dir = copyRulesDir(home, tool)
  const rulesDir = canonicalPaths(home).rules
  const state: AppState = { ...st.state, toolRules: { ...(st.state.toolRules ?? {}) } }
  const record = (name: string, contentHash: string): void => {
    state.toolRules![tool] = { ...(state.toolRules![tool] ?? {}), [name]: { contentHash, at: new Date().toISOString() } }
    writeState(home, state)
  }
  const fresh = planCopyRules(home, tool, env)
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
    if (
      !['copy', 'update', 'inSync'].includes(it.action) ||
      !it.name.endsWith('.md') ||
      it.name.includes('/') ||
      it.name.startsWith('.') ||
      resolve(it.path) !== join(dir, copyRuleFile(tool, it.name)) ||
      (resolve(it.source) !== join(rulesDir, it.name) &&
        !(it.name === CLAUDE_MEMORY_RULE && resolve(it.source) === libraryPaths(home).memoryIndex))
    ) {
      out(it, 'refused', { reason: 'outOfScope' })
      continue
    }
    const f = fresh.find((x) => x.name === it.name && x.action === it.action && x.path === it.path)
    if (!f || (it.sourceHash !== undefined && f.sourceHash !== it.sourceHash) || (it.currentHash !== undefined && f.currentHash !== it.currentHash)) {
      out(it, 'refused', { reason: 'changedSinceCheck' })
      continue
    }
    if (f.action === 'inSync') {
      if (f.stateStale) {
        record(f.name, f.currentHash!)
        out(it, 'done', { reason: 'stateRefreshed' })
      } else out(it, 'unchanged')
      continue
    }
    try {
      const content = copyRuleContent(tool, sourceContent(home, f.name, f.source))
      if (sha256(content) !== f.sourceHash) {
        out(it, 'refused', { reason: 'changedSinceCheck' })
        continue
      }
      const backupPath = f.drift ? backup(f.path) : null
      mkdirSync(dir, { recursive: true, mode: 0o755 })
      deliverFile(f.source, f.path, content, { mode: 0o644, expectHash: f.action === 'copy' ? null : f.currentHash! })
      record(f.name, f.sourceHash!)
      out(it, 'done', { ...(backupPath ? { backupPath } : {}), ...(f.drift ? { reason: 'restored' } : {}) })
    } catch (e) {
      if (e instanceof ConcurrentChangeError) out(it, 'refused', { reason: 'changedSinceCheck' })
      else out(it, 'failed', { reason: (e as NodeJS.ErrnoException).code ?? (e as Error).name })
    }
  }
  const ts = importStamp()
  for (const it of items) {
    if (it.action !== 'retireImported') continue
    const p = pendingOf(home, state, 'rule', tool, it.name).find((x) => resolve(x.path) === resolve(it.path))
    // Originals live in the tool's instructions folder, outside the app-owned one
    const root = dirname(dir)
    if (!resolve(it.path).startsWith(root + '/') || resolve(it.path).startsWith(dir + '/')) {
      out(it, 'refused', { reason: 'outOfScope' })
      continue
    }
    if (!p || p.hash !== it.currentHash) {
      out(it, 'refused', { reason: 'changedSinceCheck' })
      continue
    }
    const copy = join(dir, copyRuleFile(tool, it.name))
    const rec = state.toolRules![tool]?.[it.name]
    const copySt = lstatOrNull(copy)
    if (!rec || !copySt?.isFile() || copySt.isSymbolicLink() || fileHash(copy) !== rec.contentHash) {
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
