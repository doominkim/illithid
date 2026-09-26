import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import fg from 'fast-glob'
import { clip, isoOrUndefined, readRange } from './common'
import { titleText } from './transcript'

export { readSessionTranscript, cleanUserText, titleText, toolLine } from './transcript'
export type {
  SessionTranscript,
  TranscriptMessage,
  TranscriptPrompt,
  TranscriptOptions,
  TranscriptTool
} from './transcript'

export type SessionTool = 'claude' | 'codex' | 'opencode'

export interface Session {
  id: string
  tool: SessionTool
  /** Summary/title, or the first 80 chars of the first user message */
  title: string
  cwd?: string
  /** Last directory name of cwd */
  project?: string
  /** ISO 8601 */
  startedAt?: string
  updatedAt?: string
  messageCount?: number
  /** Parent session id for subagent or fork sessions */
  parentId?: string
  /** JSONL file or SQLite DB path */
  path: string
  /** Generated only when id is [A-Za-z0-9_-] only */
  resumeCommand?: string
}

export interface SessionScanResult {
  sessions: Session[]
  /** Per-tool failures (missing files excluded) */
  errors: { tool: SessionTool; message: string }[]
}

const CHUNK = 64 * 1024
const TITLE_SCAN_LIMIT = 256 * 1024
const TITLE_MAX = 80
const SAFE_ID = /^[A-Za-z0-9_-]+$/

type Json = Record<string, unknown>

function resumeCommand(tool: SessionTool, id: string): string | undefined {
  if (!SAFE_ID.test(id)) return undefined
  if (tool === 'claude') return `claude --resume ${id}`
  if (tool === 'codex') return `codex resume ${id}`
  return `opencode -s ${id}`
}

function projectOf(cwd: string | undefined): string | undefined {
  return cwd ? basename(cwd) || cwd : undefined
}

function parseLines(text: string, dropFirst: boolean, dropLast: boolean): Json[] {
  const lines = text.split('\n')
  if (dropFirst) lines.shift()
  if (dropLast) lines.pop()
  const out: Json[] = []
  for (const l of lines) {
    if (!l.trim()) continue
    try {
      const v = JSON.parse(l) as unknown
      if (v && typeof v === 'object') out.push(v as Json)
    } catch {
      // Drop truncated lines
    }
  }
  return out
}

/** Reads only the first and last 64KB as JSON lines. Small files are read once. */
function headTail(path: string, size: number): { head: Json[]; tail: Json[] } {
  if (size <= CHUNK * 2) {
    const all = parseLines(readRange(path, 0, size), false, false)
    return { head: all, tail: all }
  }
  return {
    head: parseLines(readRange(path, 0, CHUNK), false, true),
    tail: parseLines(readRange(path, size - CHUNK, CHUNK), true, false)
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function lastTimestamp(lines: Json[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = isoOrUndefined(lines[i].timestamp)
    if (t) return t
  }
  return undefined
}

function firstTimestamp(lines: Json[]): string | undefined {
  for (const l of lines) {
    const t = isoOrUndefined(l.timestamp)
    if (t) return t
  }
  return undefined
}

/** Collects user input text only. */
function userText(parts: unknown): string | undefined {
  const texts: string[] = []
  if (typeof parts === 'string') texts.push(parts)
  else if (Array.isArray(parts)) {
    for (const p of parts as Json[]) {
      if (p && (p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string') {
        texts.push(p.text)
      }
    }
  }
  // Title rule = the transcript's user-request cleanup rule (transcript.cleanUserText). Falls back to the teammate message body
  const real = texts.map(titleText).filter((t): t is string => !!t)
  return real.length ? real.join(' ') : undefined
}

// ---------------------------------------------------------------- Claude

function scanClaude(home: string): Session[] {
  const root = join(home, '.claude/projects')
  if (!existsSync(root)) return []
  // Subagent transcripts (<session>/subagents/*.jsonl) cannot be resumed, so they are excluded.
  const files = fg.sync('*/*.jsonl', {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    stats: true
  })
  const out: Session[] = []
  for (const f of files) {
    const size = f.stats?.size ?? 0
    const mtime = f.stats?.mtime?.toISOString()
    let head: Json[] = []
    let tail: Json[] = []
    try {
      ;({ head, tail } = headTail(f.path, size))
    } catch {
      continue
    }
    const all = [...head, ...tail]
    let id: string | undefined
    let cwd: string | undefined
    for (const l of head) {
      id ??= str(l.sessionId)
      cwd ??= str(l.cwd)
      if (id && cwd) break
    }
    id ??= basename(f.path, '.jsonl')

    // Title priority: custom-title > ai-title > summary > first user message
    let custom: string | undefined
    let ai: string | undefined
    let summary: string | undefined
    for (const l of all) {
      if (l.type === 'custom-title') custom = str(l.customTitle) ?? str(l.title) ?? custom
      else if (l.type === 'ai-title') ai = str(l.aiTitle) ?? ai
      else if (l.type === 'summary') summary = str(l.summary) ?? summary
    }
    let first: string | undefined
    if (!custom && !ai && !summary) {
      for (const l of head) {
        if (l.type !== 'user' || l.isMeta || l.isSidechain) continue
        const m = l.message as Json | undefined
        if (!m || m.role !== 'user') continue
        first = userText(m.content)
        if (first) break
      }
    }
    out.push({
      id,
      tool: 'claude',
      title: clip(custom ?? ai ?? summary ?? first ?? '', TITLE_MAX),
      cwd,
      project: projectOf(cwd),
      startedAt: firstTimestamp(head),
      updatedAt: lastTimestamp(tail) ?? mtime,
      path: f.path,
      resumeCommand: resumeCommand('claude', id)
    })
  }
  return out
}

// ---------------------------------------------------------------- Codex

/** ~/.codex/session_index.jsonl: { id, thread_name, updated_at } */
function codexIndex(home: string): Map<string, string> {
  const map = new Map<string, string>()
  const p = join(home, '.codex/session_index.jsonl')
  if (!existsSync(p)) return map
  for (const l of parseLines(readFileSync(p, 'utf8'), false, false)) {
    const id = str(l.id)
    const name = str(l.thread_name)
    if (id && name) map.set(id, name)
  }
  return map
}

function codexFirstUserText(lines: Json[]): string | undefined {
  for (const l of lines) {
    const p = l.payload as Json | undefined
    if (!p) continue
    let t: string | undefined
    if (l.type === 'event_msg' && p.type === 'user_message') t = userText(p.message)
    else if (l.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      t = userText(p.content)
    }
    if (t) return t
  }
  return undefined
}

function scanCodex(home: string): Session[] {
  const root = join(home, '.codex/sessions')
  if (!existsSync(root)) return []
  const names = codexIndex(home)
  const files = fg.sync('**/rollout-*.jsonl', {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    stats: true
  })
  const out: Session[] = []
  for (const f of files) {
    const size = f.stats?.size ?? 0
    const mtime = f.stats?.mtime?.toISOString()
    let head: Json[] = []
    let tail: Json[] = []
    try {
      ;({ head, tail } = headTail(f.path, size))
    } catch {
      continue
    }
    const meta = head.find((l) => l.type === 'session_meta')?.payload as Json | undefined
    const fromName = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
      f.path
    )?.[1]
    const id = str(meta?.id) ?? fromName ?? basename(f.path, '.jsonl')
    const cwd = str(meta?.cwd)
    const source = meta?.source as Json | undefined
    const spawn = (source?.subagent as Json | undefined)?.thread_spawn as Json | undefined
    const parentId = str(spawn?.parent_thread_id) ?? str(meta?.forked_from_id)

    const indexed = names.get(id)
    let first: string | undefined
    if (!indexed) {
      first = codexFirstUserText(head)
      // Injected messages (AGENTS.md, developer instructions) are long, so the first input often lies past 64KB.
      // For title lookup only, read up to the first 256KB.
      if (!first && size > CHUNK) {
        first = codexFirstUserText(
          parseLines(readRange(f.path, 0, Math.min(size, TITLE_SCAN_LIMIT)), false, true)
        )
      }
      // Subagents have no user input, so nickname(role) is used instead.
      if (!first) {
        const nick = str(meta?.agent_nickname)
        const role = str(meta?.agent_role)
        if (nick || role) first = role && nick ? `${nick} (${role})` : (nick ?? role)
      }
    }
    out.push({
      id,
      tool: 'codex',
      title: clip(indexed ?? first ?? '', TITLE_MAX),
      cwd,
      project: projectOf(cwd),
      startedAt: isoOrUndefined(meta?.timestamp) ?? firstTimestamp(head),
      updatedAt: lastTimestamp(tail) ?? mtime,
      parentId,
      path: f.path,
      resumeCommand: resumeCommand('codex', id)
    })
  }
  return out
}

// ---------------------------------------------------------------- OpenCode

interface SqliteModule {
  DatabaseSync: new (
    path: string,
    opts?: { readOnly?: boolean }
  ) => {
    prepare(sql: string): { all(): unknown[] }
    close(): void
  }
}

function scanOpencode(home: string): Session[] {
  const dbPath = join(home, '.local/share/opencode/opencode.db')
  if (!existsSync(dbPath)) return []
  // node:sqlite is available without a flag on Node 22.13+. Load it at runtime instead of a static import
  // so the rest of the scan still works on runtimes without it.
  const sqlite = process.getBuiltinModule?.('node:sqlite') as SqliteModule | undefined
  if (!sqlite) throw new Error('node:sqlite is unavailable in this runtime')
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db
      .prepare(
        `select s.id, s.title, s.directory, s.parent_id, s.time_created, s.time_updated,
                (select count(*) from message m where m.session_id = s.id) as message_count
           from session s`
      )
      .all() as Json[]
    return rows.map((r) => {
      const id = String(r.id)
      const cwd = str(r.directory)
      return {
        id,
        tool: 'opencode' as const,
        title: clip(str(r.title) ?? '', TITLE_MAX),
        cwd,
        project: projectOf(cwd),
        startedAt: isoOrUndefined(r.time_created),
        updatedAt: isoOrUndefined(r.time_updated),
        messageCount: typeof r.message_count === 'number' ? r.message_count : undefined,
        parentId: str(r.parent_id),
        path: dbPath,
        resumeCommand: resumeCommand('opencode', id)
      }
    })
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------- Entry point

/** Read-only scan. Sorted by updatedAt descending. Returns the rest even if one tool fails. */
export function scanSessions(home: string, tools?: SessionTool[]): SessionScanResult {
  const scanners: Record<SessionTool, (h: string) => Session[]> = {
    claude: scanClaude,
    codex: scanCodex,
    opencode: scanOpencode
  }
  const sessions: Session[] = []
  const errors: SessionScanResult['errors'] = []
  for (const tool of tools ?? (Object.keys(scanners) as SessionTool[])) {
    try {
      sessions.push(...scanners[tool](home))
    } catch (e) {
      errors.push({ tool, message: (e as Error).message })
    }
  }
  sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  return { sessions, errors }
}
