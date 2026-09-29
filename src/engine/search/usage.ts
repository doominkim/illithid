/**
 * Skill and MCP usage from local session logs, kept next to the session index (search.sqlite).
 * Only names, model ids, local dates and counts are stored — never call arguments or message text.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ToolCall } from '../scan/transcript'
import { metaGet, metaSet, openDbForRead, searchIndexPath, tableExists } from './sessionIndex'

export const USAGE_SCHEMA = '2'

export type UsageKind = 'skill' | 'mcp'
/** `mcpRaw`: OpenCode names MCP tools `<server>_<tool>`; the server is matched by prefix at query time */
type StoredKind = UsageKind | 'mcpRaw'

type Json = Record<string, unknown>

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/
const SKILL_MD_RE = /skills[\\/]+([A-Za-z0-9._-]+)[\\/]+SKILL\.md/g
/** Codex calls that change a SKILL.md rather than use the skill */
const SKILL_EDIT_RE = /\bsed\s+-i\b|\btee\b|\bcp\b|\bmv\b|\brm\b|>\s*\S*SKILL\.md|\*\*\* (?:Update|Add|Delete) File:/
/** OpenCode tools that aren't MCP even though they may contain an underscore */
const OPENCODE_BUILTIN = new Set(['bash', 'read', 'write', 'edit', 'multiedit', 'glob', 'grep', 'list', 'task', 'todowrite', 'todoread', 'webfetch', 'websearch', 'patch', 'lsp_diagnostics', 'lsp_hover', 'skill', 'invalid', 'batch'])

/** Create (or reset on a version change) the usage table. Returns true when it was (re)created */
export function ensureUsage(db: DatabaseSync): boolean {
  if (tableExists(db, 'usage') && metaGet(db, 'usageSchema') === USAGE_SCHEMA) return false
  db.exec(`
    drop table if exists usage;
    create table usage(
      sid integer not null,
      tool text not null,
      kind text not null,
      name text not null,
      model text not null,
      day text not null,
      n integer not null
    );
    create index usage_name on usage(kind, name);
    create index usage_sid on usage(sid);
  `)
  metaSet(db, 'usageSchema', USAGE_SCHEMA)
  return true
}

/** Local calendar day (YYYY-MM-DD) of an ISO time, or of the fallback */
export function dayOf(at: string | undefined, fallback: string | undefined): string {
  const t = Date.parse(at ?? '') || Date.parse(fallback ?? '')
  if (!t) return ''
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && NAME_RE.test(v) ? v : undefined
}

/** Classify one call. Codex skills yield every SKILL.md path in the call */
export function classify(tool: string, call: ToolCall): { kind: StoredKind; name: string }[] {
  const input = call.input as Json | undefined
  switch (tool) {
    case 'claude': {
      if (call.name === 'Skill') {
        const n = str(input?.skill)
        return n ? [{ kind: 'skill', name: n }] : []
      }
      // `/name` typed by the user (only counted when a library skill has that name — queries are by exact name)
      if (call.name === 'SlashCommand') {
        const n = str(input?.command)
        return n ? [{ kind: 'skill', name: n }] : []
      }
      if (call.name.startsWith('mcp__')) {
        const n = str(call.name.split('__')[1])
        return n ? [{ kind: 'mcp', name: n }] : []
      }
      return []
    }
    case 'codex': {
      if (call.namespace?.startsWith('mcp__')) {
        const n = str(call.namespace.slice(5))
        return n ? [{ kind: 'mcp', name: n }] : []
      }
      if (call.name === 'apply_patch') return []
      const text = typeof call.input === 'string' ? call.input : JSON.stringify(call.input ?? '')
      if (!text.includes('SKILL.md') || SKILL_EDIT_RE.test(text)) return []
      const names = new Set<string>()
      for (const m of text.matchAll(SKILL_MD_RE)) if (str(m[1])) names.add(m[1])
      return [...names].map((name) => ({ kind: 'skill', name }))
    }
    case 'opencode': {
      if (call.name === 'skill') {
        const n = str(input?.name)
        return n ? [{ kind: 'skill', name: n }] : []
      }
      if (call.name.includes('_') && !OPENCODE_BUILTIN.has(call.name)) {
        const n = str(call.name)
        return n ? [{ kind: 'mcpRaw', name: n }] : []
      }
      return []
    }
    case 'gemini': {
      if (call.name === 'activate_skill') {
        const n = str(input?.name ?? input?.skill)
        return n ? [{ kind: 'skill', name: n }] : []
      }
      // MCP tools are registered as <server>__<tool>
      if (call.name.includes('__')) {
        const n = str(call.name.split('__')[0])
        return n ? [{ kind: 'mcp', name: n }] : []
      }
      return []
    }
    case 'grok': {
      // MCP tools are reached through use_tool with the qualified catalog key <server>__<tool>
      if (call.name === 'use_tool') {
        const key = typeof input?.tool_name === 'string' ? input.tool_name : ''
        const n = key.includes('__') ? str(key.split('__')[0]) : undefined
        return n ? [{ kind: 'mcp', name: n }] : []
      }
      return []
    }
    default:
      return []
  }
}

/** Per-session accumulator: counts by (kind, name, model, day). Codex skills count once per turn */
export class UsageCounter {
  readonly rows = new Map<string, { kind: StoredKind; name: string; model: string; day: string; n: number }>()
  private readonly seenTurn = new Set<string>()

  constructor(
    readonly tool: string,
    private readonly fallbackAt?: string
  ) {}

  add(call: ToolCall): void {
    for (const { kind, name } of classify(this.tool, call)) {
      if (this.tool === 'codex' && kind === 'skill') {
        const k = `${call.turn ?? 0}\u0000${name}`
        if (this.seenTurn.has(k)) continue
        this.seenTurn.add(k)
      }
      const model = call.model ?? ''
      const day = dayOf(call.at, this.fallbackAt)
      const key = `${kind}\u0000${name}\u0000${model}\u0000${day}`
      const cur = this.rows.get(key)
      if (cur) cur.n++
      else this.rows.set(key, { kind, name, model, day, n: 1 })
    }
  }
}

/** Claude subagent transcripts next to the main session file: `<dir>/<id>/subagents/*.jsonl` */
export function claudeSubagentFiles(sessionPath: string): string[] {
  const dir = join(sessionPath.replace(/\.jsonl$/, ''), 'subagents')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

/** Sizes and latest mtime of the subagent files (part of the Claude change signature) */
export function claudeSubagentStat(sessionPath: string): { size: number; mtime: number } {
  let size = 0
  let mtime = 0
  for (const f of claudeSubagentFiles(sessionPath)) {
    try {
      const st = statSync(f)
      size += st.size
      mtime = Math.max(mtime, Math.floor(st.mtimeMs))
    } catch {
      // vanished meanwhile
    }
  }
  return { size, mtime }
}

// ---------------------------------------------------------------- query

export interface UsageStats {
  total: number
  /** Calls in the last `days` days */
  recent: number
  days: number
  /** Earliest day with a call */
  since?: string
  byModel: { model: string; n: number }[]
  byTool: { tool: string; n: number }[]
  /** One entry per day for the last `days` days, oldest first */
  daily: { day: string; n: number }[]
  /**
   * Same days split by model: the most-called models of the period, the rest folded into `others`.
   * `n[i]` is the count for `models[i]` on that day (`others` last when present)
   */
  dailyByModel: { models: string[]; others: boolean; days: { day: string; n: number[] }[] }
}

/** Models drawn as their own line; the rest share one */
export const TOP_DAILY_MODELS = 6

function escLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Codex and Claude replace characters MCP names can't carry (`brave-search` → `brave_search`) */
export function mcpKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_')
}

/**
 * Usage of one skill or MCP server. null while there is nothing to read yet (no index, another schema, usage not built) —
 * the caller should start an index run. Never creates or migrates the index
 */
export function usageOf(home: string, kind: UsageKind, name: string, opts: { days?: number; now?: number; dbPath?: string } = {}): UsageStats | null {
  const days = opts.days ?? 30
  const now = opts.now ?? Date.now()
  // Calendar days (not now − i·24h: a DST change would repeat or skip a day)
  const today = new Date(now)
  const dailyKeys: string[] = []
  for (let i = days - 1; i >= 0; i--) dailyKeys.push(dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i, 12).toISOString(), undefined))
  const db = openDbForRead(opts.dbPath ?? searchIndexPath(home))
  if (!db) return null
  try {
    if (!tableExists(db, 'usage') || metaGet(db, 'usageSchema') !== USAGE_SCHEMA) return null
    const key = mcpKey(name)
    const where =
      kind === 'skill'
        ? `kind = 'skill' and name = ?`
        : `((kind = 'mcp' and name in (?, ?)) or (kind = 'mcpRaw' and (name like ? escape '\\' or name like ? escape '\\')))`
    const args = kind === 'skill' ? [name] : [name, key, `${escLike(name)}\\_%`, `${escLike(key)}\\_%`]
    const rows = db.prepare(`select tool, model, day, sum(n) as n from usage where ${where} group by tool, model, day`).all(...args) as {
      tool: string
      model: string
      day: string
      n: number
    }[]
    const byModel = new Map<string, number>()
    const inPeriod = new Set(dailyKeys)
    const recentByModel = new Map<string, number>()
    const dayModel = new Map<string, number>()
    const byTool = new Map<string, number>()
    const byDay = new Map<string, number>()
    let total = 0
    let since: string | undefined
    for (const r of rows) {
      const n = Number(r.n)
      total += n
      byModel.set(r.model || 'unknown', (byModel.get(r.model || 'unknown') ?? 0) + n)
      byTool.set(r.tool, (byTool.get(r.tool) ?? 0) + n)
      if (r.day && inPeriod.has(r.day)) {
        const m = r.model || 'unknown'
        recentByModel.set(m, (recentByModel.get(m) ?? 0) + n)
        dayModel.set(`${r.day}\u0000${m}`, (dayModel.get(`${r.day}\u0000${m}`) ?? 0) + n)
      }
      if (r.day) {
        byDay.set(r.day, (byDay.get(r.day) ?? 0) + n)
        if (!since || r.day < since) since = r.day
      }
    }
    const daily = dailyKeys.map((day) => ({ day, n: byDay.get(day) ?? 0 }))
    const sortDesc = <K extends string>(m: Map<string, number>, key: K): ({ n: number } & Record<K, string>)[] =>
      [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => ({ [key]: k, n }) as { n: number } & Record<K, string>)
    const ranked = [...recentByModel.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m)
    const top = ranked.slice(0, TOP_DAILY_MODELS)
    const others = ranked.length > TOP_DAILY_MODELS
    const dailyByModel = {
      models: top,
      others,
      days: dailyKeys.map((day) => {
        const n = top.map((m) => dayModel.get(`${day}\u0000${m}`) ?? 0)
        if (others) n.push(ranked.slice(TOP_DAILY_MODELS).reduce((a, m) => a + (dayModel.get(`${day}\u0000${m}`) ?? 0), 0))
        return { day, n }
      })
    }
    return {
      total,
      dailyByModel,
      recent: daily.reduce((a, d) => a + d.n, 0),
      days,
      since,
      byModel: sortDesc(byModel, 'model'),
      byTool: sortDesc(byTool, 'tool'),
      daily
    }
  } finally {
    db.close()
  }
}
