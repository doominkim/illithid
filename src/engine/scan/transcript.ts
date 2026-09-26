/**
 * Transcript of a single session (read-only). Only the selected session is fully stream-parsed.
 * - Claude: ~/.claude/projects/<proj>/<id>.jsonl (readline)
 * - Codex:  ~/.codex/sessions/**\/rollout-*-<id>.jsonl (readline)
 * - OpenCode: ~/.local/share/opencode/opencode.db (message + part, readOnly)
 *
 * User requests (prompts) = only user messages actually typed by a person. isMeta, isSidechain, tool_result, system-reminder,
 * command output and injected text (AGENTS.md, environment_context, teammate-message, task-notification …) are excluded.
 * Assistant: text blocks only; tool calls become a one-line kind:'tool' summary. At most 8KB per message.
 */
import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import fg from 'fast-glob'
import { clip, isoOrUndefined } from './common'

export type TranscriptTool = 'claude' | 'codex' | 'opencode'

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

/** Message collector. With a sink, messages are passed through instead of accumulated (streaming for indexing) */
export class Collector {
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

async function eachJsonLine(path: string, fn: (line: Json) => void): Promise<void> {
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

export async function readClaude(path: string, c: Collector): Promise<void> {
  await eachJsonLine(path, (l) => {
    const m = l.message as Json | undefined
    const at = isoOrUndefined(l.timestamp)
    if (l.type === 'user' && m?.role === 'user') {
      if (l.isMeta || l.isSidechain) return
      const text = userTextOf(m.content)
      if (text) c.push('user', text, at)
      return
    }
    if (l.type === 'assistant' && m?.role === 'assistant' && Array.isArray(m.content)) {
      if (l.isSidechain) return
      const texts: string[] = []
      for (const b of m.content as Json[]) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) texts.push(b.text)
        else if (b.type === 'tool_use') {
          if (texts.length) c.push('assistant', texts.splice(0).join('\n\n'), at)
          c.push('assistant', toolLine(String(b.name ?? 'tool'), b.input), at, 'tool')
        }
      }
      if (texts.length) c.push('assistant', texts.join('\n\n'), at)
    }
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

export async function readCodex(path: string, c: Collector): Promise<void> {
  await eachJsonLine(path, (l) => {
    if (l.type !== 'response_item') return
    const p = l.payload as Json | undefined
    if (!p) return
    const at = isoOrUndefined(l.timestamp)
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
      c.push('assistant', toolLine(name, input), at, 'tool')
    }
  })
}

// ---------------------------------------------------------------- OpenCode

interface SqliteModule {
  DatabaseSync: new (
    path: string,
    opts?: { readOnly?: boolean }
  ) => OpencodeDb
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
      }
    }
    if (texts.length) c.push(role, texts.join('\n\n'), at)
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
  if (tool === 'claude') {
    const f = claudeFile(home, id)
    if (!f) throw new Error('session file not found')
    await readClaude(f, c)
  } else if (tool === 'codex') {
    const f = codexFile(home, id)
    if (!f) throw new Error('session file not found')
    await readCodex(f, c)
  } else readOpencode(home, id, c)
  return c.result(opts)
}
