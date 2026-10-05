/**
 * Model usage from local session logs, kept next to the session index (search.sqlite): turns, tokens, tool calls and errors,
 * requests (typed prompt → end of the answer) and context size per model and day.
 * Only model ids, local dates, counts and tool/skill/MCP names are stored — never message text or call arguments.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { StatsHooks, ToolCall, ToolErrorKind, TurnUsage } from '../scan/transcript'
import { metaGet, metaSet, openDbForRead, searchIndexPath, tableExists } from './sessionIndex'
import { classify, dayOf, mcpKey } from './usage'
import { modelMetricSupport } from '../../shared/modelMetrics'
import {
  convertedCost,
  readPriceBook,
  ratesFor,
  type ConvertedCost,
  type PriceBook,
  type CostTokens
} from './modelPricing'

export const MODEL_SCHEMA = '2'

/** Samples under these counts show counts only, not rates or distributions */
export const MIN_REQUESTS = 30
export const MIN_TOOL_CALLS = 100
const MIN_COST_TURNS = 30

/** Tools that start a subagent (Claude, Codex, OpenCode) */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task', 'spawn_agent', 'task'])

const ERROR_KINDS: readonly ToolErrorKind[] = [
  'mistake',
  'command',
  'policy',
  'userReject',
  'other'
]

/** Create (or reset on a version change) the model tables. Returns true when they were (re)created */
export function ensureModelStats(db: DatabaseSync): boolean {
  const costNew = !tableExists(db, 'model_cost_turn')
  db.exec(`create table if not exists model_cost_turn(
    sid integer not null, tool text not null, model text not null, effort text not null, day text not null,
    request_at text, context integer not null,
    t_input integer not null, t_cache_read integer not null, t_cache_write integer not null, t_output integer not null, t_reasoning integer not null,
    recorded real
  ); create index if not exists model_cost_turn_key on model_cost_turn(tool, model, effort, day); create index if not exists model_cost_turn_sid on model_cost_turn(sid);`)
  if (tableExists(db, 'model_day') && metaGet(db, 'modelSchema') === MODEL_SCHEMA) return costNew
  db.exec(`
    drop table if exists model_day;
    drop table if exists model_request;
    drop table if exists model_ctx;
    drop table if exists model_tool;
    drop table if exists model_limit;
    create table model_day(
      sid integer not null, tool text not null, model text not null, effort text not null, day text not null, subagent integer not null,
      turns integer not null, tool_calls integer not null, sub_sessions integer not null,
      err_mistake integer not null, err_command integer not null, err_policy integer not null, err_user integer not null, err_other integer not null,
      interrupts integer not null,
      t_input integer not null, t_cache_read integer not null, t_cache_write integer not null, t_output integer not null, t_reasoning integer not null,
      cost real not null
    );
    create index model_day_key on model_day(tool, model, effort, day);
    create index model_day_sid on model_day(sid);
    create table model_request(
      sid integer not null, tool text not null, model text not null, effort text not null, at text not null, day text not null,
      dur_sec integer not null, turns integer not null, tools integer not null, subagents integer not null, out_tokens integer not null
    );
    create index model_request_key on model_request(tool, model, effort, day);
    create index model_request_sid on model_request(sid);
    create table model_ctx(sid integer not null, tool text not null, model text not null, effort text not null, day text not null, ctx integer not null);
    create index model_ctx_key on model_ctx(tool, model, effort, day);
    create index model_ctx_sid on model_ctx(sid);
    create table model_tool(
      sid integer not null, tool text not null, model text not null, effort text not null, day text not null,
      kind text not null, name text not null, calls integer not null, errors integer not null
    );
    create index model_tool_key on model_tool(tool, model, effort, day);
    create index model_tool_sid on model_tool(sid);
    create table model_limit(sid integer not null, at text not null, day text not null, used_percent real not null, window_minutes integer, plan text);
    create index model_limit_sid on model_limit(sid);
  `)
  metaSet(db, 'modelSchema', MODEL_SCHEMA)
  return true
}

export const MODEL_TABLES = [
  'model_day',
  'model_request',
  'model_ctx',
  'model_tool',
  'model_limit',
  'model_cost_turn'
] as const

/** Same model under a dated id or a provider prefix counts as one; different models are never merged */
export function normalizeModel(model: string | undefined): string | undefined {
  if (!model || model === '<synthetic>') return undefined
  const m = model
    .split('/')
    .pop()!
    .replace(/-\d{8}$/, '')
  return m || undefined
}

interface DayRow {
  model: string
  effort: string
  day: string
  subagent: number
  turns: number
  toolCalls: number
  subSessions: number
  errors: Record<ToolErrorKind, number>
  interrupts: number
  tokens: TurnUsage
  cost: number
}

interface OpenRequest {
  start: number
  startAt: string
  last?: number
  end?: number
  model?: string
  effort: string
  turns: number
  tools: number
  subagents: number
  out: number
  interrupted: boolean
}

const time = (at: string | undefined): number | undefined => {
  const t = Date.parse(at ?? '')
  return Number.isFinite(t) ? t : undefined
}

/** Per-session accumulator fed by the transcript readers (StatsHooks) and the tool-call hook */
export class ModelStatsCounter implements StatsHooks {
  readonly days = new Map<string, DayRow>()
  readonly requests: {
    model: string
    effort: string
    at: string
    day: string
    dur: number
    turns: number
    tools: number
    subagents: number
    out: number
  }[] = []
  readonly costTurns: {
    model: string
    effort: string
    day: string
    requestAt: string | null
    context: number
    tokens: TurnUsage
    recorded: number | null
  }[] = []
  readonly ctx: { model: string; effort: string; day: string; ctx: number }[] = []
  readonly tools = new Map<
    string,
    {
      model: string
      effort: string
      day: string
      kind: string
      name: string
      calls: number
      errors: number
    }
  >()
  readonly limitRows: {
    at: string
    day: string
    usedPercent: number
    windowMinutes?: number
    plan?: string
  }[] = []
  private model?: string
  private effort = ''
  /** Current lines come from a subagent transcript */
  private sub: boolean
  /** Models already counted as a subagent session in the current subagent transcript */
  private subSeen = new Set<string>()
  private cur?: OpenRequest
  private readonly seenSkillTurn = new Set<string>()

  constructor(
    readonly tool: string,
    private readonly fallbackAt?: string,
    /** The whole session is a subagent (Codex/OpenCode child sessions) */
    private readonly sessionIsSubagent = false
  ) {
    this.sub = sessionIsSubagent
  }

  /** Lines that follow belong to one Claude subagent transcript */
  beginSubagent(): void {
    this.closeRequest()
    this.sub = true
    this.subSeen = new Set()
  }

  endSubagent(): void {
    this.sub = this.sessionIsSubagent
    this.subSeen = new Set()
  }

  private dayRow(model: string, effort: string, at: string | undefined): DayRow {
    const day = dayOf(at, this.fallbackAt)
    const subagent = this.sub ? 1 : 0
    const key = `${model}\u0000${effort}\u0000${day}\u0000${subagent}`
    let r = this.days.get(key)
    if (!r) {
      r = {
        model,
        effort,
        day,
        subagent,
        turns: 0,
        toolCalls: 0,
        subSessions: 0,
        errors: { mistake: 0, command: 0, policy: 0, userReject: 0, other: 0 },
        interrupts: 0,
        tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        cost: 0
      }
      this.days.set(key, r)
    }
    return r
  }

  private toolRow(
    model: string,
    effort: string,
    at: string | undefined,
    kind: string,
    name: string
  ): { calls: number; errors: number } {
    const day = dayOf(at, this.fallbackAt)
    const key = `${model}\u0000${effort}\u0000${day}\u0000${kind}\u0000${name}`
    let r = this.tools.get(key)
    if (!r) {
      r = { model, effort, day, kind, name, calls: 0, errors: 0 }
      this.tools.set(key, r)
    }
    return r
  }

  turn(t: {
    model?: string
    effort?: string
    at?: string
    endAt?: string
    usage: TurnUsage
    cost?: number
  }): void {
    const model = normalizeModel(t.model) ?? (t.model === '<synthetic>' ? undefined : this.model)
    if (!model) return
    this.model = model
    // Codex sets effort per turn context (kept until the next one); Claude and OpenCode carry it on each response, if at all
    this.effort = t.effort ?? (this.tool === 'codex' ? this.effort : '')
    const effort = this.effort
    const r = this.dayRow(model, effort, t.at)
    r.turns++
    if (this.sub && !this.subSeen.has(`${model}\u0000${effort}`)) {
      this.subSeen.add(`${model}\u0000${effort}`)
      r.subSessions++
    }
    const u = t.usage
    r.tokens.input += u.input
    r.tokens.cacheRead += u.cacheRead
    r.tokens.cacheWrite += u.cacheWrite
    r.tokens.output += u.output
    r.tokens.reasoning += u.reasoning
    r.cost += t.cost ?? 0
    const ctx = u.input + u.cacheRead + u.cacheWrite
    if (ctx > 0) this.ctx.push({ model, effort, day: r.day, ctx })
    this.costTurns.push({
      model,
      effort,
      day: r.day,
      requestAt: !this.sub && this.cur ? this.cur.startAt : null,
      context: ctx,
      tokens: { ...u },
      recorded: t.cost ?? null
    })
    const cur = this.cur
    if (cur && !this.sub) {
      cur.turns++
      cur.out += u.output
      cur.model = model
      cur.effort = effort
      const end = time(t.endAt) ?? time(t.at)
      if (end !== undefined) cur.last = Math.max(cur.last ?? 0, end)
    }
  }

  /** Tool call hook (the same calls feed the skill/MCP usage counter) */
  call(call: ToolCall): void {
    const model = normalizeModel(call.model) ?? this.model
    if (!model) return
    const effort = this.effort
    const r = this.dayRow(model, effort, call.at)
    r.toolCalls++
    this.toolRow(model, effort, call.at, 'tool', call.name || '?').calls++
    for (const { kind, name } of classify(this.tool, call)) {
      if (this.tool === 'codex' && kind === 'skill') {
        const k = `${call.turn ?? 0}\u0000${name}`
        if (this.seenSkillTurn.has(k)) continue
        this.seenSkillTurn.add(k)
      }
      this.toolRow(
        model,
        effort,
        call.at,
        kind === 'mcpRaw' ? 'mcp' : kind,
        kind === 'skill' ? name : mcpKey(name)
      ).calls++
    }
    const cur = this.cur
    if (cur && !this.sub) {
      cur.tools++
      if (SUBAGENT_TOOLS.has(call.name)) cur.subagents++
      const at = time(call.at)
      if (at !== undefined) cur.last = Math.max(cur.last ?? 0, at)
    }
  }

  toolError(e: { name?: string; kind: ToolErrorKind; at?: string }): void {
    const model = this.model
    if (!model) return
    this.dayRow(model, this.effort, e.at).errors[e.kind]++
    if (e.name) this.toolRow(model, this.effort, e.at, 'tool', e.name).errors++
  }

  prompt(at?: string): void {
    if (this.sub) return
    this.closeRequest()
    const start = time(at)
    if (start === undefined || !at) return
    this.cur = {
      start,
      startAt: at,
      effort: this.effort,
      turns: 0,
      tools: 0,
      subagents: 0,
      out: 0,
      interrupted: false
    }
  }

  interrupt(at?: string): void {
    const model = this.cur?.model ?? this.model
    if (model) this.dayRow(model, this.cur?.effort ?? this.effort, at).interrupts++
    if (this.cur) this.cur.interrupted = true
    this.closeRequest()
  }

  requestEnd(at?: string): void {
    if (this.cur) this.cur.end = time(at)
    this.closeRequest()
  }

  limits(l: { at?: string; usedPercent: number; windowMinutes?: number; plan?: string }): void {
    if (!l.at) return
    const prev = this.limitRows[this.limitRows.length - 1]
    // Only changes are kept (every model call repeats the same value)
    if (
      prev &&
      prev.usedPercent === l.usedPercent &&
      prev.windowMinutes === l.windowMinutes &&
      prev.plan === l.plan
    )
      return
    this.limitRows.push({
      at: l.at,
      day: dayOf(l.at, undefined),
      usedPercent: l.usedPercent,
      windowMinutes: l.windowMinutes,
      plan: l.plan
    })
  }

  /** Requests that ended without a model answer, or were interrupted, carry no duration */
  private closeRequest(): void {
    const r = this.cur
    this.cur = undefined
    if (!r || r.interrupted || !r.model) return
    const end = r.end ?? r.last
    if (end === undefined) return
    this.requests.push({
      model: r.model,
      effort: r.effort,
      at: r.startAt,
      day: dayOf(r.startAt, this.fallbackAt),
      dur: Math.max(0, Math.round((end - r.start) / 1000)),
      turns: r.turns,
      tools: r.tools,
      subagents: r.subagents,
      out: r.out
    })
  }

  finish(): void {
    this.closeRequest()
  }

  /** Replace this session's rows */
  write(db: DatabaseSync, sid: number): void {
    this.finish()
    for (const t of MODEL_TABLES) db.prepare(`delete from ${t} where sid = ?`).run(sid)
    const insDay = db.prepare(
      `insert into model_day(sid, tool, model, effort, day, subagent, turns, tool_calls, sub_sessions, err_mistake, err_command, err_policy, err_user, err_other,
       interrupts, t_input, t_cache_read, t_cache_write, t_output, t_reasoning, cost) values (${Array(21).fill('?').join(', ')})`
    )
    for (const r of this.days.values())
      insDay.run(
        sid,
        this.tool,
        r.model,
        r.effort,
        r.day,
        r.subagent,
        r.turns,
        r.toolCalls,
        r.subSessions,
        r.errors.mistake,
        r.errors.command,
        r.errors.policy,
        r.errors.userReject,
        r.errors.other,
        r.interrupts,
        r.tokens.input,
        r.tokens.cacheRead,
        r.tokens.cacheWrite,
        r.tokens.output,
        r.tokens.reasoning,
        r.cost
      )
    const insReq = db.prepare(
      'insert into model_request(sid, tool, model, effort, at, day, dur_sec, turns, tools, subagents, out_tokens) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    for (const r of this.requests)
      insReq.run(
        sid,
        this.tool,
        r.model,
        r.effort,
        r.at,
        r.day,
        r.dur,
        r.turns,
        r.tools,
        r.subagents,
        r.out
      )
    const insCost = db.prepare(
      'insert into model_cost_turn(sid, tool, model, effort, day, request_at, context, t_input, t_cache_read, t_cache_write, t_output, t_reasoning, recorded) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    for (const r of this.costTurns)
      insCost.run(
        sid,
        this.tool,
        r.model,
        r.effort,
        r.day,
        r.requestAt,
        r.context,
        r.tokens.input,
        r.tokens.cacheRead,
        r.tokens.cacheWrite,
        r.tokens.output,
        r.tokens.reasoning,
        r.recorded
      )
    const insCtx = db.prepare(
      'insert into model_ctx(sid, tool, model, effort, day, ctx) values (?, ?, ?, ?, ?, ?)'
    )
    for (const r of this.ctx) insCtx.run(sid, this.tool, r.model, r.effort, r.day, r.ctx)
    const insTool = db.prepare(
      'insert into model_tool(sid, tool, model, effort, day, kind, name, calls, errors) values (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    for (const r of this.tools.values())
      insTool.run(sid, this.tool, r.model, r.effort, r.day, r.kind, r.name, r.calls, r.errors)
    const insLimit = db.prepare(
      'insert into model_limit(sid, at, day, used_percent, window_minutes, plan) values (?, ?, ?, ?, ?, ?)'
    )
    for (const r of this.limitRows)
      insLimit.run(sid, r.at, r.day, r.usedPercent, r.windowMinutes ?? null, r.plan ?? null)
  }
}

// ---------------------------------------------------------------- query

export interface ModelKey {
  tool: string
  model: string
  /** Reasoning effort (Codex, Claude Code); '' when the log has none */
  effort: string
}

/** Min, quartiles, mean, p90 and max of a sample. null when the sample is empty */
export interface Dist {
  min: number
  p25: number
  median: number
  mean: number
  p75: number
  p90: number
  max: number
  n: number
}

export interface ErrorCounts {
  mistake: number
  command: number
  policy: number
  userReject: number
  other: number
}

export interface TokenCounts {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
}

export interface ModelSummary extends ModelKey {
  /** False distinguishes unsupported metrics from measured zeroes. */
  metrics?: import('../../shared/modelMetrics').ModelMetricSupport
  first: string
  last: string
  activeDays: number
  pricing?: ConvertedCost
  /** Main sessions (subagents counted apart) */
  sessions: number
  subagentSessions: number
  requests: number
  turns: number
  toolCalls: number
  errors: ErrorCounts
  interrupts: number
  tokens: TokenCounts
  /** OpenCode only (what its log records) */
  cost: number | null
  /** Medians; null below the sample size */
  median: {
    responseSec: number | null
    toolsPerRequest: number | null
    turnsPerRequest: number | null
    outputPerRequest: number | null
    contextPerTurn: number | null
  }
}

export interface ModelRange {
  /** Last N calendar days (default: everything) */
  days?: number
  /** Inclusive day range (YYYY-MM-DD); wins over days */
  from?: string
  to?: string
  now?: number
  dbPath?: string
}

export interface SessionRef {
  tool: string
  id: string
  title: string
  project?: string
}

export interface ModelDetail {
  summary: ModelSummary
  costDaily?: { day: string; cost: number | null; converted: number | null }[]
  costDist?: Dist | null
  daily: { day: string; turns: number; output: number; context: number }[]
  dist: {
    responseSec: Dist | null
    toolsPerRequest: Dist | null
    turnsPerRequest: Dist | null
    outputPerRequest: Dist | null
    contextPerTurn: Dist | null
  }
  /** Session holding the maximum of each request metric */
  maxSessions: {
    responseSec?: SessionRef
    toolsPerRequest?: SessionRef
    outputPerRequest?: SessionRef
  }
  tools: { name: string; calls: number; errors: number }[]
  skills: { name: string; calls: number }[]
  mcp: { name: string; calls: number }[]
  projects: { project: string; turns: number }[]
  sessions: (SessionRef & {
    first: string
    last: string
    turns: number
    toolCalls: number
    mistakes: number
    output: number
  })[]
  /** Codex subscription usage (account-wide, not per model): highest value per day and window */
  limits: { day: string; usedPercent: number; windowMinutes: number | null; plan: string | null }[]
}

export function dist(values: number[]): Dist | null {
  if (!values.length) return null
  const v = [...values].sort((a, b) => a - b)
  const q = (p: number): number => v[Math.min(v.length - 1, Math.round(p * (v.length - 1)))]
  return {
    min: v[0],
    p25: q(0.25),
    median: q(0.5),
    mean: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10,
    p75: q(0.75),
    p90: q(0.9),
    max: v[v.length - 1],
    n: v.length
  }
}

/** First day of the range (inclusive), or undefined for everything */
function rangeOf(o: ModelRange): { from?: string; to?: string } {
  if (o.from || o.to) return { from: o.from, to: o.to }
  if (!o.days) return {}
  const now = new Date(o.now ?? Date.now())
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (o.days - 1), 12)
  return { from: dayOf(start.toISOString(), undefined) }
}

function dayWhere(r: { from?: string; to?: string }, col = 'day'): { sql: string; args: string[] } {
  const parts: string[] = []
  const args: string[] = []
  if (r.from) {
    parts.push(`${col} >= ?`)
    args.push(r.from)
  }
  if (r.to) {
    parts.push(`${col} <= ?`)
    args.push(r.to)
  }
  return { sql: parts.length ? ` and ${parts.join(' and ')}` : '', args }
}

const keyStr = (k: ModelKey): string => `${k.tool}\u0000${k.model}\u0000${k.effort}`

function open(o: ModelRange, home: string): DatabaseSync | null {
  const db = openDbForRead(o.dbPath ?? searchIndexPath(home))
  if (!db) return null
  if (!tableExists(db, 'model_day') || metaGet(db, 'modelSchema') !== MODEL_SCHEMA) {
    db.close()
    return null
  }
  return db
}

interface SumRow {
  tool: string
  model: string
  effort: string
  first: string
  last: string
  active: number
  sessions: number
  subSessions: number
  turns: number
  toolCalls: number
  mistake: number
  command: number
  policy: number
  userReject: number
  other: number
  interrupts: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  cost: number
}

const SUM_SELECT = `select tool, model, effort, min(day) as first, max(day) as last, count(distinct day) as active,
  count(distinct case when subagent = 0 then sid end) as sessions, sum(sub_sessions) as subSessions,
  sum(turns) as turns, sum(tool_calls) as toolCalls, sum(err_mistake) as mistake, sum(err_command) as command, sum(err_policy) as policy,
  sum(err_user) as userReject, sum(err_other) as other, sum(interrupts) as interrupts,
  sum(t_input) as input, sum(t_cache_read) as cacheRead, sum(t_cache_write) as cacheWrite, sum(t_output) as output, sum(t_reasoning) as reasoning,
  sum(cost) as cost from model_day`

function summaryOf(r: SumRow, requests: RequestRow[], ctx: number[]): ModelSummary {
  const enough = requests.length >= MIN_REQUESTS
  const med = (vals: number[]): number | null => (enough ? dist(vals)!.median : null)
  return {
    metrics: modelMetricSupport(r.tool),
    tool: r.tool,
    model: r.model,
    effort: r.effort,
    first: r.first,
    last: r.last,
    activeDays: Number(r.active),
    sessions: Number(r.sessions),
    subagentSessions: Number(r.subSessions),
    requests: requests.length,
    turns: Number(r.turns),
    toolCalls: Number(r.toolCalls),
    errors: {
      mistake: Number(r.mistake),
      command: Number(r.command),
      policy: Number(r.policy),
      userReject: Number(r.userReject),
      other: Number(r.other)
    },
    interrupts: Number(r.interrupts),
    tokens: {
      input: Number(r.input),
      cacheRead: Number(r.cacheRead),
      cacheWrite: Number(r.cacheWrite),
      output: Number(r.output),
      reasoning: Number(r.reasoning)
    },
    cost: r.tool === 'opencode' ? Math.round(Number(r.cost) * 10000) / 10000 : null,
    median: {
      responseSec: med(requests.map((q) => q.dur)),
      toolsPerRequest: med(requests.map((q) => q.tools)),
      turnsPerRequest: med(requests.map((q) => q.turns)),
      outputPerRequest: med(requests.map((q) => q.out)),
      contextPerTurn: ctx.length ? dist(ctx)!.median : null
    }
  }
}

interface RequestRow {
  sid: number
  dur: number
  turns: number
  tools: number
  subagents: number
  out: number
}

interface CostTurnRow extends CostTokens {
  sid: number
  requestAt: string | null
  day: string
  context: number
  recorded: number | null
}
function pricingFor(
  db: DatabaseSync,
  summary: ModelSummary,
  w: { sql: string; args: (string | number)[] },
  book: PriceBook
): {
  pricing: ConvertedCost
  daily: NonNullable<ModelDetail['costDaily']>
  distribution: Dist | null
} {
  const where = `tool = ? and model = ? and effort = ?${w.sql}`
  const args = [summary.tool, summary.model, summary.effort, ...w.args]
  const rows = tableExists(db, 'model_cost_turn')
    ? (db
        .prepare(
          `select sid, request_at as requestAt, day, context, t_input as input, t_cache_read as cacheRead, t_cache_write as cacheWrite, t_output as output, t_reasoning as reasoning, recorded from model_cost_turn where ${where}`
        )
        .all(...args) as unknown as CostTurnRow[])
    : []
  if (!rows.length) {
    const pricing = convertedCost(
      summary.model,
      summary.tool,
      summary.tokens,
      summary.requests,
      summary.cost && summary.cost > 0 ? summary.cost : null,
      book
    )
    pricing.needsReindex = true
    pricing.medianPerRequest = null
    pricing.medianPerTurn = null
    const maxContext = Number(
      (
        db.prepare(`select max(ctx) as max from model_ctx where ${where}`).get(...args) as {
          max: number | null
        }
      ).max ?? 0
    )
    if (
      JSON.stringify(ratesFor(summary.model, book, 0)) !==
      JSON.stringify(ratesFor(summary.model, book, maxContext))
    ) {
      pricing.converted = null
      pricing.parts = null
      if (pricing.source !== 'recorded') {
        pricing.total = null
        pricing.perRequest = null
        pricing.source = 'unpriced'
      }
    }
    return { pricing, daily: [], distribution: null }
  }
  const measuredRows = rows.filter(
    (r) => r.input + r.output + r.cacheRead + r.cacheWrite + r.reasoning > 0 || r.recorded !== null
  )
  const costs = measuredRows.map((r) => ({
    row: r,
    cost: convertedCost(summary.model, summary.tool, r, 1, r.recorded, book, r.context)
  }))
  const sum = (list: typeof costs, field: 'total' | 'converted'): number | null =>
    list.some((c) => c.cost[field] === null) ? null : list.reduce((a, c) => a + c.cost[field]!, 0)
  const total = costs.length ? sum(costs, 'total') : null,
    converted = costs.length ? sum(costs, 'converted') : null
  const recorded = summary.tool === 'opencode' && rows.every((r) => r.recorded !== null)
  const parts =
    converted === null
      ? null
      : costs.reduce(
          (a, c) => ({
            input: a.input + c.cost.parts!.input,
            output: a.output + c.cost.parts!.output,
            cacheRead: a.cacheRead + c.cost.parts!.cacheRead,
            cacheWrite: a.cacheWrite + c.cost.parts!.cacheWrite
          }),
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        )
  const days = [...new Set(measuredRows.map((r) => r.day))].sort()
  const daily = days.map((day) => {
    const list = costs.filter((c) => c.row.day === day)
    return {
      day,
      cost: list.length ? sum(list, 'total') : null,
      converted: list.length ? sum(list, 'converted') : null
    }
  })
  const completed = new Set(
    (
      db.prepare(`select sid, at from model_request where ${where}`).all(...args) as {
        sid: number
        at: string
      }[]
    ).map((r) => `${r.sid}|${r.at}`)
  )
  const groups = new Map<string, typeof costs>()
  for (const c of costs) {
    const key = `${c.row.sid}|${c.row.requestAt}`
    if (!c.row.requestAt || !completed.has(key)) continue
    const list = groups.get(key) ?? []
    list.push(c)
    groups.set(key, list)
  }
  const samples = [...groups.values()]
    .map((g) => sum(g, 'total'))
    .filter((c): c is number => c !== null)
  const distribution = samples.length >= MIN_REQUESTS ? dist(samples) : null
  const turnSamples = costs
    .map((c) => c.cost.total)
    .filter((c): c is number => c !== null && Number.isFinite(c))
  const turnDistribution =
    turnSamples.length === costs.length && turnSamples.length >= MIN_COST_TURNS
      ? dist(turnSamples)
      : null
  return {
    pricing: {
      total,
      converted,
      perRequest: total === null || summary.requests <= 0 ? null : total / summary.requests,
      medianPerRequest: distribution?.median ?? null,
      medianPerTurn: turnDistribution?.median ?? null,
      source:
        total === null
          ? 'unpriced'
          : recorded
            ? 'recorded'
            : summary.tool === 'opencode' && rows.some((r) => r.recorded !== null)
              ? 'mixed'
              : 'converted',
      priceSource: costs[0]?.cost.priceSource ?? book.source,
      date: costs[0]?.cost.date ?? book.date,
      parts
    },
    daily,
    distribution
  }
}

/** Every model used in the range. null when the index has no model stats yet (the caller should start an index run) */
export function modelList(home: string, o: ModelRange = {}): ModelSummary[] | null {
  const db = open(o, home)
  if (!db) return null
  try {
    const r = rangeOf(o)
    const w = dayWhere(r)
    const rows = db
      .prepare(`${SUM_SELECT} where 1 = 1${w.sql} group by tool, model, effort`)
      .all(...w.args) as unknown as SumRow[]
    const reqs = new Map<string, RequestRow[]>()
    for (const q of db
      .prepare(
        `select sid, tool, model, effort, dur_sec as dur, turns, tools, subagents, out_tokens as out from model_request where 1 = 1${w.sql}`
      )
      .all(...w.args) as unknown as (RequestRow & ModelKey)[]) {
      const k = keyStr(q)
      const list = reqs.get(k)
      if (list) list.push(q)
      else reqs.set(k, [q])
    }
    const ctx = new Map<string, number[]>()
    for (const c of db
      .prepare(`select tool, model, effort, ctx from model_ctx where 1 = 1${w.sql}`)
      .all(...w.args) as unknown as (ModelKey & { ctx: number })[]) {
      const k = keyStr(c)
      const list = ctx.get(k)
      if (list) list.push(Number(c.ctx))
      else ctx.set(k, [Number(c.ctx)])
    }
    const book = readPriceBook(home)
    return rows
      .filter((x) => Number(x.turns) > 0 || Number(x.toolCalls) > 0)
      .map((x) => {
        const summary = summaryOf(x, reqs.get(keyStr(x)) ?? [], ctx.get(keyStr(x)) ?? [])
        summary.pricing = pricingFor(db, summary, w, book).pricing
        return summary
      })
      .sort((a, b) => b.last.localeCompare(a.last) || b.turns - a.turns)
  } finally {
    db.close()
  }
}

interface SessionMeta {
  tool: string
  id: string
  title: string | null
  project: string | null
  parentSid: number | null
}

/** One model in the range. null when the index has no model stats yet */
export function modelDetail(home: string, key: ModelKey, o: ModelRange = {}): ModelDetail | null {
  const db = open(o, home)
  if (!db) return null
  try {
    const r = rangeOf(o)
    const w = dayWhere(r)
    const k = [key.tool, key.model, key.effort]
    const where = `tool = ? and model = ? and effort = ?${w.sql}`
    const args = [...k, ...w.args]
    const sum = db
      .prepare(`${SUM_SELECT} where ${where} group by tool, model, effort`)
      .get(...args) as unknown as SumRow | undefined
    const requests = db
      .prepare(
        `select sid, dur_sec as dur, turns, tools, subagents, out_tokens as out from model_request where ${where}`
      )
      .all(...args) as unknown as RequestRow[]
    const ctx = (
      db.prepare(`select ctx from model_ctx where ${where}`).all(...args) as { ctx: number }[]
    ).map((c) => Number(c.ctx))
    const summary: ModelSummary = sum
      ? summaryOf(sum, requests, ctx)
      : summaryOf(
          {
            tool: key.tool,
            model: key.model,
            effort: key.effort,
            first: '',
            last: '',
            active: 0,
            sessions: 0,
            subSessions: 0,
            turns: 0,
            toolCalls: 0,
            mistake: 0,
            command: 0,
            policy: 0,
            userReject: 0,
            other: 0,
            interrupts: 0,
            input: 0,
            cacheRead: 0,
            cacheWrite: 0,
            output: 0,
            reasoning: 0,
            cost: 0
          },
          [],
          []
        )

    const priceData = pricingFor(db, summary, w, readPriceBook(home))
    summary.pricing = priceData.pricing
    const daily = (
      db
        .prepare(
          `select day, sum(turns) as turns, sum(t_output) as output, sum(t_input + t_cache_read + t_cache_write) as context from model_day where ${where} group by day order by day`
        )
        .all(...args) as { day: string; turns: number; output: number; context: number }[]
    ).map((d) => ({
      day: d.day,
      turns: Number(d.turns),
      output: Number(d.output),
      context: Number(d.context)
    }))

    const enough = requests.length >= MIN_REQUESTS
    const reqDist = (f: (q: RequestRow) => number): Dist | null =>
      enough ? dist(requests.map(f)) : null

    // Sessions: Claude subagent rows already sit under the parent sid; Codex/OpenCode child sessions roll up to their parent
    const meta = new Map<number, SessionMeta>()
    for (const s of db
      .prepare(
        `select s.sid, s.tool, s.id, s.title, s.project, p.sid as parentSid from sessions s left join sessions p on p.tool = s.tool and p.id = s.parentId
         where s.sid in (select distinct sid from model_day where ${where})`
      )
      .all(...args) as unknown as (SessionMeta & { sid: number })[])
      meta.set(Number(s.sid), s)
    const rootOf = (sid: number): number => meta.get(sid)?.parentSid ?? sid
    const refOf = (sid: number): SessionRef | undefined => {
      const m = meta.get(sid)
      if (!m) {
        const row = db
          .prepare('select tool, id, title, project from sessions where sid = ?')
          .get(sid) as unknown as SessionMeta | undefined
        return row
          ? {
              tool: row.tool,
              id: row.id,
              title: row.title ?? '',
              project: row.project ?? undefined
            }
          : undefined
      }
      return { tool: m.tool, id: m.id, title: m.title ?? '', project: m.project ?? undefined }
    }
    const maxOf = (f: (q: RequestRow) => number): SessionRef | undefined => {
      if (!enough) return undefined
      const top = requests.reduce<RequestRow | undefined>(
        (a, q) => (!a || f(q) > f(a) ? q : a),
        undefined
      )
      return top ? refOf(top.sid) : undefined
    }

    const bySession = new Map<
      number,
      {
        first: string
        last: string
        turns: number
        toolCalls: number
        mistakes: number
        output: number
      }
    >()
    for (const d of db
      .prepare(
        `select sid, min(day) as first, max(day) as last, sum(turns) as turns, sum(tool_calls) as toolCalls, sum(err_mistake) as mistakes, sum(t_output) as output
         from model_day where ${where} group by sid`
      )
      .all(...args) as unknown as {
      sid: number
      first: string
      last: string
      turns: number
      toolCalls: number
      mistakes: number
      output: number
    }[]) {
      const root = rootOf(Number(d.sid))
      const cur = bySession.get(root)
      if (!cur)
        bySession.set(root, {
          first: d.first,
          last: d.last,
          turns: Number(d.turns),
          toolCalls: Number(d.toolCalls),
          mistakes: Number(d.mistakes),
          output: Number(d.output)
        })
      else {
        cur.first = d.first < cur.first ? d.first : cur.first
        cur.last = d.last > cur.last ? d.last : cur.last
        cur.turns += Number(d.turns)
        cur.toolCalls += Number(d.toolCalls)
        cur.mistakes += Number(d.mistakes)
        cur.output += Number(d.output)
      }
    }
    const sessions = [...bySession.entries()]
      .map(([sid, v]) => {
        const ref = refOf(sid)
        return ref ? { ...ref, ...v } : undefined
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.turns - a.turns)
      .slice(0, 50)

    const toolRows = db
      .prepare(
        `select kind, name, sum(calls) as calls, sum(errors) as errors from model_tool where ${where} group by kind, name order by calls desc`
      )
      .all(...args) as { kind: string; name: string; calls: number; errors: number }[]
    const pick = (kind: string): { name: string; calls: number; errors: number }[] =>
      toolRows
        .filter((t) => t.kind === kind)
        .map((t) => ({ name: t.name, calls: Number(t.calls), errors: Number(t.errors) }))

    const dw = dayWhere(r, 'd.day')
    const projects = (
      db
        .prepare(
          `select coalesce(s.project, '') as project, sum(d.turns) as turns from model_day d join sessions s on s.sid = d.sid
           where d.tool = ? and d.model = ? and d.effort = ?${dw.sql} group by s.project order by turns desc`
        )
        .all(...k, ...dw.args) as { project: string; turns: number }[]
    ).map((p) => ({ project: p.project, turns: Number(p.turns) }))

    const lw = dayWhere(r)
    const limits =
      key.tool === 'codex'
        ? (
            db
              .prepare(
                `select day, max(used_percent) as usedPercent, window_minutes as windowMinutes, max(plan) as plan from model_limit where 1 = 1${lw.sql}
                 group by day, window_minutes order by day`
              )
              .all(...lw.args) as {
              day: string
              usedPercent: number
              windowMinutes: number | null
              plan: string | null
            }[]
          ).map((l) => ({
            day: l.day,
            usedPercent: Number(l.usedPercent),
            windowMinutes: l.windowMinutes === null ? null : Number(l.windowMinutes),
            plan: l.plan
          }))
        : []

    return {
      summary,
      costDaily: priceData.daily,
      costDist: priceData.distribution,
      daily,
      dist: {
        responseSec: reqDist((q) => q.dur),
        toolsPerRequest: reqDist((q) => q.tools),
        turnsPerRequest: reqDist((q) => q.turns),
        outputPerRequest: reqDist((q) => q.out),
        contextPerTurn: dist(ctx)
      },
      maxSessions: {
        responseSec: maxOf((q) => q.dur),
        toolsPerRequest: maxOf((q) => q.tools),
        outputPerRequest: maxOf((q) => q.out)
      },
      tools: pick('tool').slice(0, 30),
      skills: pick('skill')
        .slice(0, 30)
        .map(({ name, calls }) => ({ name, calls })),
      mcp: pick('mcp')
        .slice(0, 30)
        .map(({ name, calls }) => ({ name, calls })),
      projects: projects.slice(0, 20),
      sessions,
      limits
    }
  } finally {
    db.close()
  }
}

/** Models used in one session (its subagents included), by share of turns. null when there is nothing to read yet */
export function sessionModels(
  home: string,
  tool: string,
  id: string,
  o: { dbPath?: string } = {}
): { tool: string; model: string; effort: string; turns: number; share: number }[] | null {
  const db = open(o, home)
  if (!db) return null
  try {
    const rows = db
      .prepare(
        `select d.tool, d.model, d.effort, sum(d.turns) as turns from model_day d join sessions s on s.sid = d.sid
         where (s.tool = ? and s.id = ?) or (s.tool = ? and s.parentId = ?) group by d.tool, d.model, d.effort order by turns desc`
      )
      .all(tool, id, tool, id) as { tool: string; model: string; effort: string; turns: number }[]
    const total = rows.reduce((a, r) => a + Number(r.turns), 0)
    return rows.map((r) => ({
      tool: r.tool,
      model: r.model,
      effort: r.effort,
      turns: Number(r.turns),
      share: total ? Number(r.turns) / total : 0
    }))
  } finally {
    db.close()
  }
}

export const MODEL_ERROR_KINDS = ERROR_KINDS
