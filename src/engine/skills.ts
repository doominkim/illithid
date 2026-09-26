import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { canonicalPaths, tools, type ToolId } from './agents'
import { readState } from './state'
import type { Env } from './types'

/**
 * linked      symlink to the canonical copy (library skills/<name>)
 * otherSource symlink elsewhere (~/.skills-manager, ~/.cc-switch, etc.)
 * copy        real directory. sameContent tells whether it matches the canonical copy
 * missing     in the canonical set but missing from the tool
 * extra       only in the tool (includes hidden entries and tool-owned dirs like synced — left alone)
 * autoScan    visible because the tool scans the canonical directory directly (OpenCode)
 */
export type SkillState = 'linked' | 'otherSource' | 'copy' | 'missing' | 'extra' | 'autoScan'

export const SKILL_STATES: readonly SkillState[] = [
  'linked',
  'autoScan',
  'otherSource',
  'copy',
  'missing',
  'extra'
]

export interface SkillEntry {
  tool: ToolId
  name: string
  state: SkillState
  /** Tool-side path. The canonical path for missing/autoScan */
  path: string
  /** Whether the canonical set has the same name */
  inCanonical: boolean
  kind?: 'symlink' | 'dir' | 'file'
  /** Symlink target (absolute path) */
  target?: string
  /** Symlink target is missing */
  broken?: boolean
  /** For copy: whether the content hash matches the canonical copy */
  sameContent?: boolean
  /** For copy: whether the app placed it (per state.json skills). false means user-owned */
  managed?: boolean
  /** Entry starting with `.` */
  hidden?: boolean
  /** OpenCode: scan root through which this entry is seen */
  via?: string
  /** OpenCode: number of SKILL.md files loaded under this entry (for extra directories) */
  skillFiles?: number
}

export interface ToolSkills {
  tool: ToolId
  mode: 'symlinkDir' | 'autoScan'
  /** Directory for symlinkDir */
  dir?: string
  /** Actual scan roots for autoScan (roots disabled via env vars are excluded) */
  roots?: string[]
  entries: SkillEntry[]
  counts: Record<SkillState, number>
  notes: string[]
  error?: string
}

export interface SkillsReport {
  canonicalDir: string
  canonical: string[]
  tools: ToolSkills[]
}

export interface LinkAction {
  tool: ToolId
  name: string
  action: 'create' | 'relink' | 'skip'
  /** Link location */
  from: string
  /** Canonical copy the link should point to */
  to: string
  /** Current target before relink */
  current?: string
  reason?: string
}

function isDirFollow(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function sameFile(a: string, b: string): boolean {
  if (a === b) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/** Canonical skill names (excluding hidden, directories or directory symlinks only) */
export function canonicalSkills(home: string): string[] {
  const dir = canonicalPaths(home).skills
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => !n.startsWith('.') && isDirFollow(join(dir, n)))
    .sort()
}

/** Names excluded from the content hash (Finder metadata — avoids false drift) */
const HASH_IGNORE = new Set(['.DS_Store'])

/** Directory content hash: relative path + file bytes (link string for inner symlinks). Deterministic order */
export function dirContentHash(root: string): string {
  const h = createHash('sha256')
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (HASH_IGNORE.has(name)) continue
      const p = join(dir, name)
      const r = rel ? `${rel}/${name}` : name
      const st = lstatSync(p)
      if (st.isSymbolicLink()) h.update(`L\0${r}\0${readlinkSync(p)}\0`)
      else if (st.isDirectory()) {
        h.update(`D\0${r}\0`)
        walk(p, r)
      } else if (st.isFile()) {
        h.update(`F\0${r}\0`)
        h.update(readFileSync(p))
        h.update('\0')
      }
    }
  }
  walk(root, '')
  return h.digest('hex')
}

/** Classify one entry (shared by symlinkDir mode) */
function classify(
  tool: ToolId,
  dir: string,
  name: string,
  canonDir: string,
  canonSet: Set<string>
): SkillEntry {
  const path = join(dir, name)
  const inCanonical = canonSet.has(name)
  const canonPath = join(canonDir, name)
  const hidden = name.startsWith('.')
  const st = lstatSync(path)

  if (st.isSymbolicLink()) {
    const target = resolve(dirname(path), readlinkSync(path))
    const broken = !existsSync(target)
    const base: Omit<SkillEntry, 'state'> = {
      tool,
      name,
      path,
      inCanonical,
      kind: 'symlink',
      target
    }
    if (broken) base.broken = true
    if (hidden) return { ...base, state: 'extra', hidden }
    if (inCanonical && sameFile(target, canonPath)) return { ...base, state: 'linked' }
    // A link pointing outside the canonical dir is "another source" regardless of whether the canonical copy exists
    return { ...base, state: 'otherSource' }
  }

  const kind = st.isDirectory() ? 'dir' : 'file'
  if (hidden || !inCanonical || kind === 'file') {
    return { tool, name, path, inCanonical, kind, state: 'extra', ...(hidden ? { hidden } : {}) }
  }
  let sameContent = false
  try {
    sameContent = dirContentHash(path) === dirContentHash(canonPath)
  } catch {
    sameContent = false
  }
  return { tool, name, path, inCanonical, kind, state: 'copy', sameContent }
}

function emptyCounts(): Record<SkillState, number> {
  return Object.fromEntries(SKILL_STATES.map((s) => [s, 0])) as Record<SkillState, number>
}

function withCounts(t: Omit<ToolSkills, 'counts'>): ToolSkills {
  const counts = emptyCounts()
  for (const e of t.entries) counts[e.state]++
  return { ...t, counts }
}

function symlinkDirSkills(
  tool: ToolId,
  dir: string,
  canonDir: string,
  canon: string[]
): ToolSkills {
  const canonSet = new Set(canon)
  const base = { tool, mode: 'symlinkDir' as const, dir, notes: [] as string[] }
  if (!existsSync(dir)) {
    const entries = canon.map<SkillEntry>((name) => ({
      tool,
      name,
      state: 'missing',
      path: join(canonDir, name),
      inCanonical: true
    }))
    return withCounts({ ...base, entries, notes: ['No skills directory'] })
  }
  try {
    const names = readdirSync(dir).sort()
    const entries = names.map((n) => classify(tool, dir, n, canonDir, canonSet))
    const present = new Set(names)
    for (const name of canon) {
      if (!present.has(name)) {
        entries.push({
          tool,
          name,
          state: 'missing',
          path: join(canonDir, name),
          inCanonical: true
        })
      }
    }
    return withCounts({ ...base, entries })
  } catch (e) {
    return withCounts({
      ...base,
      entries: [],
      error: `Failed to read skills directory: ${(e as NodeJS.ErrnoException).code ?? 'unknown'}`
    })
  }
}

/** Number of SKILL.md files under root (following symlinks). Cycles are broken via realpath */
function countSkillFiles(root: string, maxDepth = 8): number {
  const seen = new Set<string>()
  let n = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      return
    }
    if (seen.has(real)) return
    seen.add(real)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const p = join(dir, name)
      if (name === 'SKILL.md') n++
      else if (isDirFollow(p)) walk(p, depth + 1)
    }
  }
  walk(root, 0)
  return n
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

/**
 * OpenCode: scans several roots directly instead of using symlinks.
 * Only global roots are considered (project .opencode/.claude/.agents are out of scope).
 */
function autoScanSkills(home: string, env: Env, canonDir: string, canon: string[]): ToolSkills {
  const t = tools(home).find((x) => x.id === 'opencode')!
  if (t.skills.kind !== 'autoScan') throw new Error('opencode skills must be autoScan')
  const [claudeRoot, agentsRoot, ...configRoots] = t.skills.roots
  const disableExternal = truthy(env.OPENCODE_DISABLE_EXTERNAL_SKILLS)
  const disableClaude =
    disableExternal ||
    truthy(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS) ||
    truthy(env.OPENCODE_DISABLE_CLAUDE_CODE)
  const roots = [
    ...(disableClaude ? [] : [claudeRoot]),
    ...(disableExternal ? [] : [agentsRoot]),
    ...configRoots
  ].filter((r) => existsSync(r))
  const notes = [
    'Scan paths extracted from the skill discovery code in the opencode 1.18.27 binary — recheck when the version changes',
    'Finds **/SKILL.md in subdirectories and follows hidden directories and symlinks'
  ]
  if (disableExternal) {
    notes.push(
      'OPENCODE_DISABLE_EXTERNAL_SKILLS is set — ~/.claude/skills and ~/.agents/skills are not scanned (per this process env)'
    )
  } else if (disableClaude) {
    notes.push(
      'OPENCODE_DISABLE_CLAUDE_CODE(_SKILLS) is set — ~/.claude/skills is not scanned (per this process env)'
    )
  }
  const canonSet = new Set(canon)
  const entries: SkillEntry[] = []

  for (const name of canon) {
    entries.push(
      disableExternal
        ? {
            tool: 'opencode',
            name,
            state: 'missing',
            path: join(canonDir, name),
            inCanonical: true
          }
        : {
            tool: 'opencode',
            name,
            state: 'autoScan',
            path: join(canonDir, name),
            inCanonical: true,
            via: agentsRoot
          }
    )
  }

  // ~/.claude/skills is scanned before the canonical dir, and same names are overridden by it → only entries absent from the canonical set matter.
  // The config root is scanned after the canonical dir, so same names override it.
  for (const root of roots) {
    if (root === agentsRoot) continue
    const overrides = root !== claudeRoot
    let names: string[]
    try {
      names = readdirSync(root).sort()
    } catch {
      continue
    }
    for (const name of names) {
      if (canonSet.has(name) && !overrides && !disableExternal) continue
      const e = classify('opencode', root, name, canonDir, canonSet)
      e.via = root
      if (e.state === 'extra' && e.kind !== 'file') {
        const n = countSkillFiles(e.path)
        if (n) e.skillFiles = n
      }
      if (e.state === 'linked' && overrides) e.state = 'autoScan'
      entries.push(e)
    }
  }
  const loadedExtras = entries.filter((e) => e.state === 'extra' && e.skillFiles)
  if (loadedExtras.length) {
    const total = loadedExtras.reduce((a, e) => a + (e.skillFiles ?? 0), 0)
    notes.push(
      `${total} SKILL.md file(s) outside the canonical dir may also be loaded (${loadedExtras.map((e) => e.name).join(', ')})`
    )
  }
  return withCounts({ tool: 'opencode', mode: 'autoScan', roots, entries, notes })
}

/** Per-tool skill status against the canonical set. Read-only */
export function skillsReport(home: string, env: Env = process.env): SkillsReport {
  const canonDir = canonicalPaths(home).skills
  const canon = canonicalSkills(home)
  const managed = readState(home).state.skills ?? {}
  const out: ToolSkills[] = []
  for (const t of tools(home)) {
    if (t.skills.kind === 'symlinkDir') {
      const ts = symlinkDirSkills(t.id, t.skills.dir, canonDir, canon)
      for (const e of ts.entries) {
        if (e.state === 'copy') e.managed = !!managed[t.id]?.[e.name]
      }
      out.push(ts)
    } else out.push(autoScanSkills(home, env, canonDir, canon))
  }
  return { canonicalDir: canonDir, canonical: canon, tools: out }
}

/**
 * @deprecated Skill sync switched to copying (planSkillSync, applySkillSync). There is no executor.
 * Kept only for M3 screen compatibility.
 * Actions needed for every canonical skill to be linked in Claude and Codex. Computed only, never executed.
 * Real directories (copy) and entries absent from the canonical set stay as skip (never auto-replaced or deleted).
 */
export function linkPlan(home: string, env: Env = process.env): LinkAction[] {
  const report = skillsReport(home, env)
  const actions: LinkAction[] = []
  for (const t of report.tools) {
    if (t.mode !== 'symlinkDir' || !t.dir) continue
    for (const e of t.entries) {
      const from = join(t.dir, e.name)
      const to = join(report.canonicalDir, e.name)
      if (!e.inCanonical) {
        if (e.state === 'otherSource') {
          actions.push({
            tool: t.tool,
            name: e.name,
            action: 'skip',
            from,
            to: e.target ?? '',
            current: e.target,
            reason: 'Not in the canonical set — move it there first'
          })
        }
        continue
      }
      if (e.state === 'linked')
        actions.push({ tool: t.tool, name: e.name, action: 'skip', from, to })
      else if (e.state === 'missing')
        actions.push({ tool: t.tool, name: e.name, action: 'create', from, to })
      else if (e.state === 'otherSource') {
        actions.push({ tool: t.tool, name: e.name, action: 'relink', from, to, current: e.target })
      } else if (e.state === 'copy') {
        actions.push({
          tool: t.tool,
          name: e.name,
          action: 'skip',
          from,
          to,
          reason: `Real directory (${e.sameContent ? 'same as canonical' : 'differs from canonical'}) — not auto-replaced`
        })
      }
    }
  }
  return actions
}
