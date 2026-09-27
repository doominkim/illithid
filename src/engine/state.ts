import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOOL_IDS, type ToolId } from './toolIds'
import { appConfigDir } from './config'
import type { PendingRetire } from './pendingRetire'
import type { TargetId } from './types'
import { atomicWrite } from './write'

export interface AppliedEntry {
  /** sha256 of the owned region at the last sync */
  regionHash: string
  /** ISO timestamp */
  at: string
}

/** A skill the app copied into a tool skill directory */
export interface SkillCopyEntry {
  /** dirContentHash of the last written copy */
  contentHash: string
  /** ISO timestamp */
  at: string
  /** Symlink target that was there before being replaced by the copy (for rollback) */
  previousLink?: string
}

/** A rule file the app copied into the Claude rules directory */
export interface RuleCopyEntry {
  /** sha256 of the last written content */
  contentHash: string
  /** ISO timestamp */
  at: string
}

export interface AppState {
  version: 1
  applied: Partial<Record<TargetId, AppliedEntry>>
  /** App-owned skill copies per tool. Real directories not listed here are user-owned */
  skills?: Partial<Record<ToolId, Record<string, SkillCopyEntry>>>
  /**
   * App-owned entries per target at the last sync (MCP server names, opencode instructions entries).
   * Used to decide whether disabled entries should be removed from tool config. Entries not listed here are treated as the user's.
   */
  owned?: Partial<Record<TargetId, string[]>>
  /** App-owned Claude rule copies (file name -> record). Files not listed here are user-owned */
  rules?: Record<string, RuleCopyEntry>
  /** App-owned agent files per tool (library name -> record, hash = render output). Files not listed here are user-owned */
  agents?: Partial<Record<ToolId, Record<string, RuleCopyEntry>>>
  /** Imported tool-side originals the next approved sync replaces with the app copy (pendingRetire.ts) */
  pendingRetire?: PendingRetire[]
}

export interface StateRead {
  path: string
  exists: boolean
  state: AppState
  /** File exists but failed to read or validate. state is empty in that case */
  error?: string
}

export function statePath(home: string): string {
  return join(appConfigDir(home), 'state.json')
}

export function emptyState(): AppState {
  return { version: 1, applied: {} }
}

function isApplied(v: unknown): v is AppliedEntry {
  const o = v as Record<string, unknown> | null
  return !!o && typeof o.regionHash === 'string' && typeof o.at === 'string'
}

/** Reads state.json. Empty state if missing */
export function readState(home: string): StateRead {
  const path = statePath(home)
  if (!existsSync(path)) return { path, exists: false, state: emptyState() }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { path, exists: true, state: emptyState(), error: 'JSON parse failed' }
  }
  const o = raw as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || o.version !== 1) {
    return { path, exists: true, state: emptyState(), error: 'unsupported version' }
  }
  const applied: AppState['applied'] = {}
  const src = (o.applied ?? {}) as Record<string, unknown>
  for (const [id, v] of Object.entries(src)) {
    if (isApplied(v)) applied[id as TargetId] = { regionHash: v.regionHash, at: v.at }
  }
  const skills: NonNullable<AppState['skills']> = {}
  const srcSkills = (o.skills ?? {}) as Record<string, unknown>
  for (const [tool, byName] of Object.entries(srcSkills)) {
    if (!byName || typeof byName !== 'object') continue
    const m: Record<string, SkillCopyEntry> = {}
    for (const [name, v] of Object.entries(byName as Record<string, unknown>)) {
      const e = v as Record<string, unknown> | null
      if (!e || typeof e.contentHash !== 'string' || typeof e.at !== 'string') continue
      m[name] = {
        contentHash: e.contentHash,
        at: e.at,
        ...(typeof e.previousLink === 'string' ? { previousLink: e.previousLink } : {})
      }
    }
    skills[tool as ToolId] = m
  }
  const owned: NonNullable<AppState['owned']> = {}
  for (const [id, v] of Object.entries((o.owned ?? {}) as Record<string, unknown>)) {
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) owned[id as TargetId] = v
  }
  const rules: NonNullable<AppState['rules']> = {}
  for (const [name, v] of Object.entries((o.rules ?? {}) as Record<string, unknown>)) {
    const e = v as Record<string, unknown> | null
    if (e && typeof e.contentHash === 'string' && typeof e.at === 'string')
      rules[name] = { contentHash: e.contentHash, at: e.at }
  }
  const agents: NonNullable<AppState['agents']> = {}
  for (const [tool, byName] of Object.entries((o.agents ?? {}) as Record<string, unknown>)) {
    if (!byName || typeof byName !== 'object') continue
    const m: Record<string, RuleCopyEntry> = {}
    for (const [name, v] of Object.entries(byName as Record<string, unknown>)) {
      const e = v as Record<string, unknown> | null
      if (e && typeof e.contentHash === 'string' && typeof e.at === 'string')
        m[name] = { contentHash: e.contentHash, at: e.at }
    }
    agents[tool as ToolId] = m
  }
  const pendingRetire: PendingRetire[] = []
  if (Array.isArray(o.pendingRetire)) {
    for (const v of o.pendingRetire as unknown[]) {
      const e = v as Record<string, unknown> | null
      if (
        e &&
        ['rule', 'skill', 'agent', 'instruction'].includes(e.kind as string) &&
        (TOOL_IDS as readonly unknown[]).includes(e.tool) &&
        typeof e.name === 'string' &&
        typeof e.path === 'string' &&
        typeof e.hash === 'string' &&
        typeof e.at === 'string'
      )
        pendingRetire.push({
          kind: e.kind,
          tool: e.tool,
          name: e.name,
          path: e.path,
          hash: e.hash,
          at: e.at,
          ...(typeof e.workspace === 'string' ? { workspace: e.workspace } : {})
        } as PendingRetire)
    }
  }
  return {
    path,
    exists: true,
    state: {
      version: 1,
      applied,
      ...(Object.keys(skills).length ? { skills } : {}),
      ...(Object.keys(owned).length ? { owned } : {}),
      ...(Object.keys(rules).length ? { rules } : {}),
      ...(Object.keys(agents).length ? { agents } : {}),
      ...(pendingRetire.length ? { pendingRetire } : {})
    }
  }
}

/** Atomic write of state.json (creates directory 0700, file 0600) */
export function writeState(home: string, state: AppState): void {
  atomicWrite(statePath(home), JSON.stringify(state, null, 2) + '\n')
}
