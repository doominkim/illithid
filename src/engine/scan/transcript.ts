/**
 * Transcript of a single session (read-only). Only the selected session is fully stream-parsed.
 * - Claude: ~/.claude/projects/<proj>/<id>.jsonl (readline)
 * - Codex:  ~/.codex/sessions/**\/rollout-*-<id>.jsonl (readline)
 * - OpenCode: ~/.local/share/opencode/opencode.db (message + part, readOnly)
 * - Gemini: ~/.gemini/tmp/<project>/chats/session-<time>-<id8>.jsonl (records replayed like Gemini CLI: $set, $rewindTo)
 *
 * User requests (prompts) = only user messages actually typed by a person. isMeta, isSidechain, tool_result, system-reminder,
 * command output and injected text (AGENTS.md, environment_context, teammate-message, task-notification …) are excluded.
 * Assistant: text blocks only; tool calls become a one-line kind:'tool' summary. At most 8KB per message.
 */
import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import fg from 'fast-glob'
import type { ToolId } from '../toolIds'
import { clip, isoOrUndefined, readRange } from './common'

export type TranscriptTool = ToolId

export interface TranscriptMessage {
  /** Sequence number within the session (from 0; filtered items get no number) */
  index: number
  role: 'user' | 'assistant'
  text: string
  /** ISO timestamp */
  at?: string
  /** text (default) | tool (one-line tool call summary) */
  kind?: 'text' | 'tool'
  /** Truncated past 8KB */
  truncated?: boolean
}

export interface TranscriptPrompt {
  /** index into messages */
  index: number
  text: string
}

export interface SessionTranscript {
  messages: TranscriptMessage[]
  /** Table of user requests (Contents) — full range, independent of paging */
  prompts: TranscriptPrompt[]
  /** Total message count after filtering */
  total: number
  /** Only part was returned due to limit/before */
  truncated: boolean
}

export interface TranscriptOptions {
  /** Max messages to return (default 500). Taken from the end (relative to before) */
  limit?: number
  /** Only indexes below this (previous page) */
  before?: number
}

const MESSAGE_MAX = 8 * 1024
const TOOL_LINE_MAX = 160
type Json = Record<string, unknown>

// ---------------------------------------------------------------- User text cleanup

const INJECTED_PREFIX = [
  '# AGENTS.md',
  'Caveat:',
  '<environment_context',
  '<teammate-message',
  '<task-notification',
  '<cross-session-message',
  '<local-command-stdout',
  '<local-command-caveat',
  '<bash-stdout',
  '<bash-stderr',
  '<bash-input',
  '<user-memory-input',
  '<INSTRUCTIONS>',
  '<ide_selection',
  '<ide_opened_file',
  // Codex injections: plugin suggestions, internal context, interrupt notices, `!` shell command logs
  '<recommended_plugins',
  '<codex_internal_context',
  '<turn_aborted',
  '<user_shell_command',
  '[Request interrupted'
]

/** Gemini CLI injections into user messages (only filtered for Gemini sessions) */
const GEMINI_INJECTED_PREFIX = ['<session_context', '<hook_context']

export function isGeminiInjected(raw: string): boolean {
  const t = raw.trim()
  return GEMINI_INJECTED_PREFIX.some((p) => t.startsWith(p))
}

/** Gemini user text: injected context blocks are dropped, then the shared cleanup applies */
export function cleanGeminiUserText(raw: string): string | undefined {
  return isGeminiInjected(raw) ? undefined : cleanUserText(raw)
}

function stripTag(text: string, tag: string): string {
  return text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g'), '')
}

/**
 * Keep only human-typed text. undefined for injections or command output.
 * Slash commands render as `<name> <args>`, pasted content as "[pasted content] …".
 */
export function cleanUserText(raw: string): string | undefined {
  let t = raw.trim()
  if (!t) return undefined
  // system-reminder arrives mixed into user text, so strip just the block
  t = stripTag(t, 'system-reminder').trim()
  if (!t) return undefined
  if (INJECTED_PREFIX.some((p) => t.startsWith(p))) return undefined
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t)?.[1]?.trim()
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(t)?.[1]?.trim()
    return args ? `${cmd} ${args}` : cmd
  }
  if (/^<command-message>/.test(t)) return undefined
  t = t
    .replace(
      /<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content>/g,
      (_, inner: string) => `[pasted content] ${inner.trim()}`
    )
    .replace(/<pasted_content\b[^>]*\/>/g, '[pasted content]')
    .trim()
  return t || undefined
}

/** For list titles: cleaned user text, else the teammate message body (subagent sessions) */
export function titleText(raw: string): string | undefined {
  const clean = cleanUserText(raw)
  if (clean) return clean
  const t = raw.trim()
  const mate =
    /^<(?:teammate-message|cross-session-message)[^>]*>([\s\S]*?)(<\/(?:teammate-message|cross-session-message)>|$)/.exec(
      t
    )?.[1]
  return mate?.trim() || undefined
}

/** Collect and clean only text blocks from a content array/string */
export function userTextOf(content: unknown): string | undefined {
  const texts: string[] = []
  if (typeof content === 'string') texts.push(content)
  else if (Array.isArray(content))
    for (const p of content as Json[])
      if (p && (p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string')
        texts.push(p.text)
  const real = texts.map(cleanUserText).filter((x): x is string => !!x)
  return real.length ? real.join('\n\n') : undefined
}

function limitText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MESSAGE_MAX) return { text, truncated: false }
  let cut = text.slice(0, MESSAGE_MAX)
  while (Buffer.byteLength(cut, 'utf8') > MESSAGE_MAX) cut = cut.slice(0, -64)
  return { text: cut + '\n…(truncated)', truncated: true }
}

/** One-line tool call summary: "Bash: description" */
export function toolLine(name: string, input: unknown): string {
  let detail = ''
  const o = (input && typeof input === 'object' ? input : {}) as Json
  for (const k of [
    'description',
    'command',
    'cmd',
    'pattern',
    'query',
    'file_path',
    'path',
    'url',
    'prompt'
  ]) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) {
      detail = v
      break
    }
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      detail = (v as string[]).join(' ')
      break
    }
  }
  if (!detail && typeof input === 'string') detail = input
  return clip(detail ? `${name}: ${detail}` : name, TOOL_LINE_MAX)
}

// ---------------------------------------------------------------- Shared collector

/** A tool call seen while reading a transcript (for usage stats). Input is passed through, never stored by the index */
export interface ToolCall {
  name: string
  input: unknown
  /** Codex: `mcp__<server>` for MCP tools */
  namespace?: string
  model?: string
  at?: string
  /** Codex: turn counter (a new turn_context starts a new turn) */
  turn?: number
}

/** Token counts of one model call. `input` excludes cached input */
export interface TurnUsage {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
}

/** mistake = edit/read slip (closest to a model error), command = non-zero exit, policy = permission or hook block */
export type ToolErrorKind = 'mistake' | 'command' | 'policy' | 'userReject' | 'other'

/**
 * Model usage hooks (model stats). Readers pass on model ids, times, counts and tool names only — never message text.
 * `turn` is one model call (one API response)
 */
export interface StatsHooks {
  turn(t: {
    model?: string
    effort?: string
    at?: string
    endAt?: string
    usage: TurnUsage
    cost?: number
  }): void
  toolError(e: { name?: string; kind: ToolErrorKind; at?: string }): void
  /** A request typed by the user starts */
  prompt(at?: string): void
  interrupt(at?: string): void
  /** Explicit end of the current request (Codex task_complete) */
  requestEnd(at?: string): void
  /** Codex subscription usage */
  limits(l: { at?: string; usedPercent: number; windowMinutes?: number; plan?: string }): void
}

/** Classify a failed tool result from the first part of its text (the text itself is not kept) */
export function toolErrorKind(text: string): ToolErrorKind {
  const t = text.slice(0, 400).toLowerCase()
  if (t.includes("user doesn't want") || t.includes('the user doesn') || t.includes('rejected'))
    return 'userReject'
  if (
    t.includes('permission') ||
    t.includes('denied') ||
    t.includes('hook') ||
    t.includes('blocked') ||
    t.includes('not allowed')
  )
    return 'policy'
  if (
    t.includes('has not been read') ||
    t.includes('modified since') ||
    t.includes('string to replace not found') ||
    t.includes('no changes to make') ||
    (t.includes('found') && t.includes('matches')) ||
    t.includes('does not exist') ||
    t.includes('no such file') ||
    t.includes('enoent')
  )
    return 'mistake'
  if (
    t.includes('exit code') ||
    t.includes('exited with') ||
    t.includes('error:') ||
    t.includes('failed') ||
    t.includes('timed out')
  )
    return 'command'
  return 'other'
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** Message collector. With a sink, messages are passed through instead of accumulated (streaming for indexing) */
export class Collector {
  /** Optional tool-call hook (usage stats) */
  onCall?: (call: ToolCall) => void
  /** Optional model usage hooks (model stats) */
  stats?: StatsHooks
  messages: TranscriptMessage[] = []
  prompts: TranscriptPrompt[] = []
  /** Messages received so far = next index */
  count = 0

  constructor(private readonly sink?: (m: TranscriptMessage) => void) {}

  push(
    role: 'user' | 'assistant',
    text: string,
    at?: string,
    kind: 'text' | 'tool' = 'text'
  ): void {
    const { text: t, truncated } = limitText(text)
    const index = this.count++
    const m: TranscriptMessage = {
      index,
      role,
      text: t,
      ...(at ? { at } : {}),
      ...(kind === 'tool' ? { kind } : {}),
      ...(truncated ? { truncated: true } : {})
    }
    if (this.sink) {
      this.sink(m)
      return
    }
    this.messages.push(m)
    if (role === 'user' && kind === 'text') this.prompts.push({ index, text: clip(t, 200) })
  }

  result(opts: TranscriptOptions): SessionTranscript {
    const limit = Math.max(1, opts.limit ?? 500)
    const before = opts.before ?? this.messages.length
    const slice = this.messages.filter((m) => m.index < before)
    const page = slice.slice(Math.max(0, slice.length - limit))
    return {
      messages: page,
      prompts: this.prompts,
      total: this.messages.length,
      truncated: page.length < this.messages.length
    }
  }
}

export async function eachJsonLine(path: string, fn: (line: Json) => void): Promise<void> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  for await (const line of rl) {
    if (!line.trim()) continue
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      continue
    }
    if (v && typeof v === 'object') fn(v as Json)
  }
}

// ---------------------------------------------------------------- Claude

function claudeFile(home: string, id: string): string | undefined {
  const root = join(home, '.claude/projects')
  if (!existsSync(root) || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined
  return fg.sync(`*/${id}.jsonl`, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true
  })[0]
}

/** `/name` typed by the user: `<command-name>/name</command-name>` in the user message (only the name is used) */
const COMMAND_RE = /<command-name>\/?([A-Za-z0-9][A-Za-z0-9:._-]{0,127})<\/command-name>/

/** Claude usage block → turn tokens (input_tokens already excludes the cache; thinking tokens are part of the output) */
function claudeUsage(u: Json | undefined): TurnUsage {
  const details = u?.output_tokens_details as Json | undefined
  return {
    input: num(u?.input_tokens),
    cacheRead: num(u?.cache_read_input_tokens),
    cacheWrite: num(u?.cache_creation_input_tokens),
    output: num(u?.output_tokens),
    reasoning: num(details?.thinking_tokens)
  }
}

/** Effort of one Claude response: `perTurnEffort` in current logs, `effort` in older ones (equal when both are present) */
function claudeEffort(l: Json): string | undefined {
  const e = l.perTurnEffort ?? l.effort
  return typeof e === 'string' && e ? e : undefined
}

/** Text of a tool_result block (string or text parts) */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return (content as Json[]).map((x) => (x && typeof x.text === 'string' ? x.text : '')).join(' ')
  return ''
}

/**
 * Model stats of a Claude transcript line, shared by the main reader and the subagent reader. Streaming writes several lines
 * per API response with the same message id, so turns count once per id
 */
function claudeStatsLine(
  l: Json,
  stats: StatsHooks,
  seen: Set<string>,
  toolNames: Map<string, string>
): void {
  const m = l.message as Json | undefined
  const at = isoOrUndefined(l.timestamp)
  if (l.type === 'assistant' && m?.role === 'assistant') {
    const id = typeof m.id === 'string' ? m.id : undefined
    if (!id || !seen.has(id)) {
      if (id) seen.add(id)
      stats.turn({
        model: typeof m.model === 'string' ? m.model : undefined,
        effort: claudeEffort(l),
        at,
        usage: claudeUsage(m.usage as Json | undefined)
      })
    }
    if (Array.isArray(m.content))
      for (const b of m.content as Json[])
        if (b?.type === 'tool_use' && typeof b.id === 'string')
          toolNames.set(b.id, String(b.name ?? ''))
    return
  }
  if (l.type === 'user' && m?.role === 'user' && Array.isArray(m.content))
    for (const b of m.content as Json[])
      if (b?.type === 'tool_result' && b.is_error)
        stats.toolError({
          name: typeof b.tool_use_id === 'string' ? toolNames.get(b.tool_use_id) : undefined,
          kind: toolErrorKind(toolResultText(b.content)),
          at
        })
}

const INTERRUPT_MARK = '[Request interrupted by user'

export async function readClaude(path: string, c: Collector): Promise<void> {
  let model: string | undefined
  const seen = new Set<string>()
  const toolNames = new Map<string, string>()
  await eachJsonLine(path, (l) => {
    const m = l.message as Json | undefined
    const at = isoOrUndefined(l.timestamp)
    if (l.type === 'user' && m?.role === 'user') {
      if (l.isMeta || l.isSidechain) return
      const raw =
        c.onCall || c.stats
          ? typeof m.content === 'string'
            ? m.content
            : JSON.stringify(m.content ?? '')
          : ''
      if (c.onCall) {
        const cmd = COMMAND_RE.exec(raw)
        if (cmd) c.onCall({ name: 'SlashCommand', input: { command: cmd[1] }, model, at })
      }
      if (c.stats) claudeStatsLine(l, c.stats, seen, toolNames)
      const text = userTextOf(m.content)
      if (c.stats) {
        if (raw.includes(INTERRUPT_MARK)) c.stats.interrupt(at)
        else if (text) c.stats.prompt(at)
      }
      if (text) c.push('user', text, at)
      return
    }
    if (l.type === 'assistant' && m?.role === 'assistant' && Array.isArray(m.content)) {
      if (l.isSidechain) return
      if (typeof m.model === 'string') model = m.model
      if (c.stats) claudeStatsLine(l, c.stats, seen, toolNames)
      const texts: string[] = []
      for (const b of m.content as Json[]) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) texts.push(b.text)
        else if (b.type === 'tool_use') {
          if (texts.length) c.push('assistant', texts.splice(0).join('\n\n'), at)
          c.push('assistant', toolLine(String(b.name ?? 'tool'), b.input), at, 'tool')
          c.onCall?.({
            name: String(b.name ?? ''),
            input: b.input,
            model: typeof m.model === 'string' ? m.model : undefined,
            at
          })
        }
      }
      if (texts.length) c.push('assistant', texts.join('\n\n'), at)
    }
  })
}

/** Model stats and tool calls of a Claude subagent transcript (sidechain lines included — they are the subagent's own turns) */
export async function readClaudeSubagentStats(
  path: string,
  onCall: (c: ToolCall) => void,
  stats?: StatsHooks
): Promise<void> {
  const seen = new Set<string>()
  const toolNames = new Map<string, string>()
  await eachJsonLine(path, (l) => {
    if (stats) claudeStatsLine(l, stats, seen, toolNames)
    const m = l.message as Json | undefined
    if (l.type !== 'assistant' || !m || !Array.isArray(m.content)) return
    const at = typeof l.timestamp === 'string' ? l.timestamp : undefined
    for (const b of m.content as Json[])
      if (b && b.type === 'tool_use')
        onCall({
          name: String(b.name ?? ''),
          input: b.input,
          model: typeof m.model === 'string' ? m.model : undefined,
          at
        })
  })
}

// ---------------------------------------------------------------- Codex

function codexFile(home: string, id: string): string | undefined {
  const root = join(home, '.codex/sessions')
  if (!existsSync(root) || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined
  return fg.sync(`**/rollout-*${id}.jsonl`, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true
  })[0]
}

function codexArgs(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

const EXIT_CODE_RE = /[Ee]xit code:? ?(\d+)|"exit_code":\s*(\d+)/

/** Codex event_msg lines for model stats: request boundaries, tokens per model call, subscription usage */
function codexStatsEvent(
  p: Json,
  at: string | undefined,
  stats: StatsHooks,
  state: { model?: string; effort?: string; taskOpen: boolean }
): void {
  switch (p.type) {
    case 'task_started':
      state.taskOpen = true
      stats.prompt(at)
      return
    case 'user_message':
      // Older logs have no task events: each user message starts a request
      if (!state.taskOpen) stats.prompt(at)
      return
    case 'task_complete':
      state.taskOpen = false
      stats.requestEnd(at)
      return
    case 'turn_aborted':
      state.taskOpen = false
      stats.interrupt(at)
      return
    case 'token_count': {
      const info = p.info as Json | undefined
      const u = info?.last_token_usage as Json | undefined
      if (u) {
        const cached = num(u.cached_input_tokens)
        stats.turn({
          model: state.model,
          effort: state.effort,
          at,
          usage: {
            input: Math.max(0, num(u.input_tokens) - cached),
            cacheRead: cached,
            cacheWrite: num(u.cache_write_input_tokens),
            output: num(u.output_tokens),
            reasoning: num(u.reasoning_output_tokens)
          }
        })
      }
      const rl = p.rate_limits as Json | undefined
      const primary = rl?.primary as Json | undefined
      if (typeof primary?.used_percent === 'number')
        stats.limits({
          at,
          usedPercent: primary.used_percent,
          windowMinutes:
            typeof primary.window_minutes === 'number' ? primary.window_minutes : undefined,
          plan: typeof rl?.plan_type === 'string' ? rl.plan_type : undefined
        })
      return
    }
  }
}

export async function readCodex(path: string, c: Collector): Promise<void> {
  let model: string | undefined
  let turn = 0
  const state: { model?: string; effort?: string; taskOpen: boolean } = { taskOpen: false }
  const callNames = new Map<string, string>()
  await eachJsonLine(path, (l) => {
    if (l.type === 'turn_context') {
      const tc = l.payload as Json | undefined
      if (typeof tc?.model === 'string') model = tc.model
      state.model = model
      const effort = tc?.effort ?? tc?.reasoning_effort
      state.effort = typeof effort === 'string' ? effort : undefined
      turn++
      return
    }
    if (l.type === 'event_msg') {
      const p = l.payload as Json | undefined
      if (c.stats && p) codexStatsEvent(p, isoOrUndefined(l.timestamp), c.stats, state)
      return
    }
    if (l.type !== 'response_item') return
    const p = l.payload as Json | undefined
    if (!p) return
    const at = isoOrUndefined(l.timestamp)
    if (c.stats && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '')
      const exit = EXIT_CODE_RE.exec(out)
      const code = exit ? (exit[1] ?? exit[2]) : undefined
      if (code && code !== '0')
        c.stats.toolError({
          name: typeof p.call_id === 'string' ? callNames.get(p.call_id) : undefined,
          kind: 'command',
          at
        })
      return
    }
    if (p.type === 'message' && p.role === 'user') {
      const text = userTextOf(p.content)
      if (text) c.push('user', text, at)
    } else if (p.type === 'message' && p.role === 'assistant' && Array.isArray(p.content)) {
      const texts = (p.content as Json[])
        .filter(
          (b) => (b.type === 'output_text' || b.type === 'text') && typeof b.text === 'string'
        )
        .map((b) => b.text as string)
        .filter((t) => t.trim())
      if (texts.length) c.push('assistant', texts.join('\n\n'), at)
    } else if (
      p.type === 'function_call' ||
      p.type === 'custom_tool_call' ||
      p.type === 'local_shell_call'
    ) {
      const name = String(p.name ?? (p.type === 'local_shell_call' ? 'shell' : 'tool'))
      const input = codexArgs(p.arguments ?? p.input ?? p.action)
      if (typeof p.call_id === 'string') callNames.set(p.call_id, name)
      c.push('assistant', toolLine(name, input), at, 'tool')
      c.onCall?.({
        name,
        input,
        namespace: typeof p.namespace === 'string' ? p.namespace : undefined,
        model,
        at,
        turn
      })
    }
  })
}

// ---------------------------------------------------------------- OpenCode

interface SqliteModule {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => OpencodeDb
}

export interface OpencodeDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
  close(): void
}

/** Open the OpenCode DB read-only (opened once when reading multiple sessions) */
export function openOpencodeDb(home: string): OpencodeDb {
  const dbPath = join(home, '.local/share/opencode/opencode.db')
  if (!existsSync(dbPath)) throw new Error('OpenCode DB not found')
  const sqlite = process.getBuiltinModule?.('node:sqlite') as SqliteModule | undefined
  if (!sqlite) throw new Error('node:sqlite is unavailable in this runtime')
  return new sqlite.DatabaseSync(dbPath, { readOnly: true })
}

function readOpencode(home: string, id: string, c: Collector): void {
  const db = openOpencodeDb(home)
  try {
    readOpencodeDb(db, id, c)
  } finally {
    db.close()
  }
}

export function readOpencodeDb(db: OpencodeDb, id: string, c: Collector): void {
  const messages = db
    .prepare(
      'select id, time_created, data from message where session_id = ? order by time_created, id'
    )
    .all(id) as Json[]
  const partStmt = db.prepare(
    'select data from part where message_id = ? order by time_created, id'
  )
  for (const m of messages) {
    let data: Json
    try {
      data = JSON.parse(String(m.data)) as Json
    } catch {
      continue
    }
    const role = data.role === 'user' ? 'user' : data.role === 'assistant' ? 'assistant' : null
    if (!role) continue
    const time = data.time as Json | undefined
    const at = isoOrUndefined(time?.created) ?? isoOrUndefined(m.time_created)
    if (c.stats) {
      if (role === 'user') c.stats.prompt(at)
      else {
        const tk = data.tokens as Json | undefined
        const cache = tk?.cache as Json | undefined
        c.stats.turn({
          model: typeof data.modelID === 'string' ? data.modelID : undefined,
          at,
          endAt: isoOrUndefined(time?.completed),
          usage: {
            input: num(tk?.input),
            cacheRead: num(cache?.read),
            cacheWrite: num(cache?.write),
            output: num(tk?.output),
            reasoning: num(tk?.reasoning)
          },
          cost: typeof data.cost === 'number' ? data.cost : undefined
        })
      }
    }
    const texts: string[] = []
    for (const row of partStmt.all(String(m.id)) as Json[]) {
      let part: Json
      try {
        part = JSON.parse(String(row.data)) as Json
      } catch {
        continue
      }
      if (part.type === 'text' && typeof part.text === 'string' && !part.synthetic) {
        if (role === 'user') {
          const t = cleanUserText(part.text)
          if (t) texts.push(t)
        } else if (part.text.trim()) texts.push(part.text)
      } else if (part.type === 'tool' && role === 'assistant') {
        if (texts.length) c.push('assistant', texts.splice(0).join('\n\n'), at)
        const state = part.state as Json | undefined
        const title = typeof state?.title === 'string' ? state.title : undefined
        c.push(
          'assistant',
          toolLine(String(part.tool ?? 'tool'), title ?? state?.input),
          at,
          'tool'
        )
        c.onCall?.({
          name: String(part.tool ?? ''),
          input: state?.input,
          model: typeof data.modelID === 'string' ? data.modelID : undefined,
          at
        })
        if (state?.status === 'error')
          c.stats?.toolError({ name: String(part.tool ?? ''), kind: 'other', at })
      }
    }
    if (texts.length) c.push(role, texts.join('\n\n'), at)
  }
}

// ---------------------------------------------------------------- Gemini

/** First 8 chars of the session id are the file name suffix: session-<time>-<id8>.jsonl */
function geminiFile(home: string, id: string): string | undefined {
  const root = join(home, '.gemini/tmp')
  if (!existsSync(root) || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined
  const files = fg.sync(`*/chats/session-*-${id.slice(0, 8)}.jsonl`, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true
  })
  return files.find((f) => geminiHeaderId(f) === id)
}

function geminiHeaderId(path: string): string | undefined {
  try {
    const first = readRange(path, 0, 64 * 1024).split('\n', 1)[0]
    const v = JSON.parse(first) as Json
    return typeof v.sessionId === 'string' ? v.sessionId : undefined
  } catch {
    return undefined
  }
}

export interface GeminiConversation {
  /** Header fields merged with every $set (sessionId, projectHash, startTime, lastUpdated, kind, summary …) */
  meta: Json
  /** Messages after replaying $set.messages and $rewindTo, in order */
  messages: Json[]
}

const isMessage = (r: Json): boolean => typeof r.id === 'string'

/**
 * Replay a Gemini CLI session file the way Gemini loads it: message records by id (a later record with the same id replaces
 * the earlier one in place), `$set` merges metadata (`$set.messages` replaces all messages), `$rewindTo` drops that message
 * and everything after it (all messages if the id is unknown)
 */
export function replayGemini(records: Iterable<Json>): GeminiConversation {
  let meta: Json = {}
  const byId = new Map<string, Json>()
  const addAll = (list: unknown): void => {
    if (Array.isArray(list))
      for (const m of list as Json[])
        if (m && typeof m === 'object' && isMessage(m)) byId.set(m.id as string, m)
  }
  for (const r of records) {
    if (typeof r.$rewindTo === 'string') {
      let found = false
      for (const id of [...byId.keys()]) {
        if (id === r.$rewindTo) found = true
        if (found) byId.delete(id)
      }
      if (!found) byId.clear()
    } else if (isMessage(r)) byId.set(r.id as string, r)
    else if (r.$set && typeof r.$set === 'object' && !Array.isArray(r.$set)) {
      const set = r.$set as Json
      if (Array.isArray(set.messages)) {
        byId.clear()
        addAll(set.messages)
      }
      meta = { ...meta, ...set }
    } else if (typeof r.sessionId === 'string') {
      meta = { ...meta, ...r }
      addAll(r.messages)
    }
  }
  delete meta.messages
  return { meta, messages: [...byId.values()] }
}

/** Text of a Gemini content value (string or part list). Thought parts are skipped */
export function geminiText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as unknown[])
    .map((p) =>
      typeof p === 'string'
        ? p
        : p && typeof p === 'object' && !(p as Json).thought && typeof (p as Json).text === 'string'
          ? ((p as Json).text as string)
          : ''
    )
    .join('')
}

async function readJsonLines(path: string): Promise<Json[]> {
  const out: Json[] = []
  await eachJsonLine(path, (l) => out.push(l))
  return out
}

export async function readGemini(path: string, c: Collector): Promise<void> {
  const { messages } = replayGemini(await readJsonLines(path))
  for (const m of messages) {
    const at = isoOrUndefined(m.timestamp)
    if (m.type === 'user') {
      const text = cleanGeminiUserText(geminiText(m.content))
      if (text) c.push('user', text, at)
    } else if (m.type === 'gemini') {
      const text = geminiText(m.content)
      if (text.trim()) c.push('assistant', text, at)
      if (Array.isArray(m.toolCalls))
        for (const t of m.toolCalls as Json[])
          if (t && typeof t === 'object') {
            c.push(
              'assistant',
              toolLine(String(t.name ?? t.displayName ?? 'tool'), t.args),
              at,
              'tool'
            )
            c.onCall?.({
              name: String(t.name ?? ''),
              input: t.args,
              model: typeof m.model === 'string' ? m.model : undefined,
              at
            })
          }
    }
  }
}

// ---------------------------------------------------------------- Grok

/**
 * Grok chat_history.jsonl: {type:'user', content:[{type:'text', text}]}, {type:'assistant', content, model_id, tool_calls:[{name,
 * arguments}]}, plus system / reasoning / tool_result records (skipped). Messages carry no timestamps
 */
function grokFile(home: string, id: string): string | undefined {
  const root = join(home, '.grok/sessions')
  if (!existsSync(root) || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined
  return fg.sync(`*/${id}/chat_history.jsonl`, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true
  })[0]
}

export async function readGrok(path: string, c: Collector): Promise<void> {
  await eachJsonLine(path, (l) => {
    if (l.type === 'user') {
      const text = userTextOf(l.content)
      if (text) c.push('user', text)
      return
    }
    if (l.type !== 'assistant') return
    const model = typeof l.model_id === 'string' ? l.model_id : undefined
    if (typeof l.content === 'string' && l.content.trim()) c.push('assistant', l.content)
    if (Array.isArray(l.tool_calls))
      for (const t of l.tool_calls as Json[]) {
        if (!t || typeof t !== 'object') continue
        const name = String(t.name ?? '')
        let input: unknown = t.arguments
        if (typeof input === 'string')
          try {
            input = JSON.parse(input)
          } catch {
            // keep the raw string
          }
        c.push('assistant', toolLine(name || 'tool', input), undefined, 'tool')
        c.onCall?.({ name, input, model })
      }
  })
}

// ---------------------------------------------------------------- Qwen Code

/**
 * Qwen Code chats: ~/.qwen/projects/<cwd with non-alphanumerics → '-'>/chats/<sessionId>.jsonl, one ChatRecord per line
 * ({uuid, parentUuid, sessionId, timestamp, cwd, type: user|assistant|tool_result|system, message: {role, parts}, model?,
 * usageMetadata?, toolCallResult?, isSidechain?}). Records form a tree through parentUuid; rewinding starts a new branch
 */
export function qwenFile(home: string, id: string): string | undefined {
  const root = join(home, '.qwen/projects')
  if (!existsSync(root) || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined
  return fg.sync(`*/chats/${id}.jsonl`, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true
  })[0]
}

/** Records on the active branch, oldest first: the parentUuid chain from the last main-session record (sidechains skipped) */
export function qwenActiveChain(records: Json[]): Json[] {
  const byId = new Map<string, Json>()
  for (const r of records) if (typeof r.uuid === 'string') byId.set(r.uuid, r)
  let cur: Json | undefined
  for (let i = records.length - 1; i >= 0 && !cur; i--)
    if (typeof records[i].uuid === 'string' && !records[i].isSidechain) cur = records[i]
  const chain: Json[] = []
  const seen = new Set<string>()
  while (cur && !seen.has(cur.uuid as string)) {
    seen.add(cur.uuid as string)
    chain.push(cur)
    cur = typeof cur.parentUuid === 'string' ? byId.get(cur.parentUuid) : undefined
  }
  return chain.reverse()
}

/** Parts of a Qwen record's message (@google/genai Content) */
export function qwenParts(r: Json): Json[] {
  const parts = (r.message as Json | undefined)?.parts
  return Array.isArray(parts) ? (parts as Json[]).filter((p) => p && typeof p === 'object') : []
}

/** User text of a Qwen user record (injected context blocks dropped, like Gemini) */
export function qwenUserText(r: Json): string | undefined {
  return cleanGeminiUserText(geminiText(qwenParts(r)))
}

/** usageMetadata uses Gemini names; promptTokenCount includes cached tokens */
function qwenUsage(u: Json | undefined): TurnUsage {
  const prompt = num(u?.promptTokenCount)
  const cached = num(u?.cachedContentTokenCount)
  return {
    input: Math.max(0, prompt - cached),
    cacheRead: cached,
    cacheWrite: 0,
    output: num(u?.candidatesTokenCount),
    reasoning: num(u?.thoughtsTokenCount)
  }
}

export async function readQwen(path: string, c: Collector): Promise<void> {
  const toolNames = new Map<string, string>()
  for (const r of qwenActiveChain(await readJsonLines(path))) {
    const at = isoOrUndefined(r.timestamp)
    if (r.type === 'user') {
      const text = qwenUserText(r)
      if (text) {
        c.stats?.prompt(at)
        c.push('user', text, at)
      }
    } else if (r.type === 'assistant') {
      const model = typeof r.model === 'string' ? r.model : undefined
      if (c.stats && r.usageMetadata)
        c.stats.turn({ model, at, usage: qwenUsage(r.usageMetadata as Json) })
      const texts: string[] = []
      for (const p of qwenParts(r)) {
        if (typeof p.text === 'string' && !p.thought && p.text.trim()) texts.push(p.text)
        const call = p.functionCall as Json | undefined
        if (!call || typeof call !== 'object') continue
        if (texts.length) c.push('assistant', texts.splice(0).join('\n\n'), at)
        const name = String(call.name ?? '')
        if (typeof call.id === 'string') toolNames.set(call.id, name)
        c.push('assistant', toolLine(name || 'tool', call.args), at, 'tool')
        c.onCall?.({ name, input: call.args, model, at })
      }
      if (texts.length) c.push('assistant', texts.join('\n\n'), at)
    } else if (r.type === 'tool_result' && c.stats) {
      const res = r.toolCallResult as Json | undefined
      if (res?.status !== 'error' && !res?.error) continue
      const err = res.error as Json | undefined
      const text = String(err?.message ?? res.resultDisplay ?? '')
      c.stats.toolError({
        name: typeof res.callId === 'string' ? toolNames.get(res.callId) : undefined,
        kind: toolErrorKind(text),
        at
      })
    }
  }
}

// ---------------------------------------------------------------- Entry point

/** Transcript of a single session. Throws if the file is missing */
export async function readSessionTranscript(
  home: string,
  tool: TranscriptTool,
  id: string,
  opts: TranscriptOptions = {}
): Promise<SessionTranscript> {
  const c = new Collector()
  switch (tool) {
    case 'claude': {
      const f = claudeFile(home, id)
      if (!f) throw new Error('session file not found')
      await readClaude(f, c)
      break
    }
    case 'codex': {
      const f = codexFile(home, id)
      if (!f) throw new Error('session file not found')
      await readCodex(f, c)
      break
    }
    case 'opencode':
      readOpencode(home, id, c)
      break
    case 'gemini': {
      const f = geminiFile(home, id)
      if (!f) throw new Error('session file not found')
      await readGemini(f, c)
      break
    }
    case 'copilot':
      throw new Error('Copilot sessions are not supported yet')
    case 'grok': {
      const f = grokFile(home, id)
      if (!f) throw new Error('session file not found')
      await readGrok(f, c)
      break
    }
    case 'qwen': {
      const f = qwenFile(home, id)
      if (!f) throw new Error('session file not found')
      await readQwen(f, c)
      break
    }
    default: {
      const never: never = tool
      throw new Error(`unknown tool ${String(never)}`)
    }
  }
  return c.result(opts)
}
