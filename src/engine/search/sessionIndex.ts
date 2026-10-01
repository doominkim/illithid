/**
 * Session content index and search (node:sqlite + FTS5 trigram). Source session files are only read.
 * - Index file: <home>/.config/illithid/search.sqlite (recreated if deleted)
 * - Messages are parsed with the transcript.ts reader, so indexes match the transcript view (snippet → contents jump reuses them)
 * - Incremental: per session (mtime, size) — file stat for Claude/Codex/Gemini, (time_updated, message count) for OpenCode. Only changed sessions are reinserted
 * - Human (user) and AI (assistant) text only. Tool call summaries (kind 'tool') only with includeTools
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { APP_CONFIG_DIR } from '../config'
import { TOOL_IDS } from '../toolIds'
import type { Session, SessionTool } from '../scan/sessions'
import {
  Collector,
  openOpencodeDb,
  readClaude,
  readCodex,
  readGemini,
  readGrok,
  readClaudeSubagentStats,
  readOpencodeDb,
  type OpencodeDb,
  type TranscriptMessage
} from '../scan/transcript'
import { ensureModelStats, MODEL_TABLES, ModelStatsCounter } from './modelStats'
import { claudeSubagentFiles, claudeSubagentStat, ensureUsage, UsageCounter } from './usage'

const SCHEMA_VERSION = '2'
const SNIPPET_SIDE = 60
const LIKE_ROW_LIMIT = 2000

export interface IndexOptions {
  /** Index file path (default <home>/.config/illithid/search.sqlite) */
  dbPath?: string
}

export interface IndexSessionsOptions extends IndexOptions {
  onProgress?: (p: { done: number; total: number }) => void
  /** Also index tool call summaries (default false). Changing it triggers a full reindex */
  includeTools?: boolean
  /** Tools whose session list is complete — indexed sessions missing from the list are removed (default: all tools) */
  completeTools?: SessionTool[]
}

export interface IndexResult {
  /** Sessions in the list */
  sessions: number
  /** Sessions reindexed */
  indexed: number
  /** Sessions removed from the index */
  removed: number
  /** Sessions skipped due to read failure (previous index kept) */
  failed: number
  /** Messages inserted */
  inserted: number
  /** SQLite total_changes() — 0 means nothing was written */
  changes: number
  ms: number
}

export interface SearchOptions extends IndexOptions {
  tool?: SessionTool
  project?: string
  role?: 'user' | 'assistant'
  /** Max sessions (default 200) */
  limit?: number
  /** Max matching messages per session (default 5) */
  perSession?: number
}

export interface SessionSearchHit {
  /** Transcript message index (same as readSessionTranscript) */
  idx: number
  role: 'user' | 'assistant'
  at?: string
  /** About 60 chars on each side. Whitespace collapsed to one space */
  snippet: string
  /** Highlighted range within snippet [start, end) */
  marks: [number, number][]
}

export interface SessionSearchResult {
  tool: SessionTool
  id: string
  title: string
  project?: string
  updatedAt?: string
  parentId?: string
  /** Matching messages in this session (up to the cap in LIKE mode) */
  count: number
  hits: SessionSearchHit[]
}

export interface SessionSearchResponse {
  results: SessionSearchResult[]
  /** fts = MATCH for 3+ chars, like = 1–2 chars */
  mode: 'fts' | 'like'
  /** Hit the session limit or the LIKE row cap */
  limited: boolean
  ms: number
}

export interface IndexStatus {
  exists: boolean
  sessions: number
  messages: number
  /** Indexed documents (docIndex.ts) */
  docs?: number
  lastIndexedAt?: string
}

// ---------------------------------------------------------------- DB

export function searchIndexPath(home: string): string {
  return join(home, APP_CONFIG_DIR, 'search.sqlite')
}

interface SqliteModule {
  DatabaseSync: typeof DatabaseSync
}

function sqlite(): SqliteModule {
  const m = process.getBuiltinModule?.('node:sqlite') as SqliteModule | undefined
  if (!m) throw new Error('node:sqlite is unavailable in this runtime')
  return m
}

/** Open (and create or migrate) the search index. The document tables (docIndex.ts) live in the same file */
export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  const db = new (sqlite().DatabaseSync)(path, { timeout: 5000 })
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;')
  const ver = tableExists(db, 'meta') ? metaGet(db, 'schema') : undefined
  if (ver !== SCHEMA_VERSION) {
    db.exec(`
      drop table if exists messages;
      drop table if exists usage;
      drop table if exists model_day;
      drop table if exists model_request;
      drop table if exists model_ctx;
      drop table if exists model_tool;
      drop table if exists model_limit;
      drop table if exists msg;
      drop table if exists sessions;
      drop table if exists meta;
      create table meta(key text primary key, value text);
      create table sessions(
        sid integer primary key,
        tool text not null,
        id text not null,
        path text,
        mtime integer not null default 0,
        size integer not null default 0,
        title text,
        project text,
        updatedAt text,
        parentId text,
        nmsg integer not null default 0,
        unique(tool, id)
      );
      create table msg(
        mid integer primary key,
        sid integer not null,
        idx integer not null,
        role text not null,
        at text
      );
      create index msg_sid on msg(sid);
      create virtual table messages using fts5(text, tokenize = 'trigram');
    `)
    db.prepare(`insert into meta(key, value) values ('schema', ?)`).run(SCHEMA_VERSION)
  }
  return db
}

/**
 * Open the index for a read without creating or migrating anything: undefined when the file is missing or was written by
 * another schema version (reads must never wipe the index — only an index run migrates)
 */
export function openDbForRead(path: string): DatabaseSync | undefined {
  if (!existsSync(path)) return undefined
  const db = new (sqlite().DatabaseSync)(path, { timeout: 5000 })
  if (!tableExists(db, 'meta') || metaGet(db, 'schema') !== SCHEMA_VERSION) {
    db.close()
    return undefined
  }
  return db
}

export function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare(`select 1 from sqlite_master where type = 'table' and name = ?`).get(name)
}

export function metaGet(db: DatabaseSync, key: string): string | undefined {
  return (
    db.prepare('select value from meta where key = ?').get(key) as { value?: string } | undefined
  )?.value
}

export function metaSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run(key, value)
}

export function totalChanges(db: DatabaseSync): number {
  return Number((db.prepare('select total_changes() as n').get() as { n: number }).n)
}

// ---------------------------------------------------------------- Indexing

interface Row {
  sid: number
  tool: string
  id: string
  path: string | null
  mtime: number
  size: number
  title: string | null
  project: string | null
  updatedAt: string | null
  parentId: string | null
}

/** Change-detection key for a session. undefined if the file is missing */
function signature(s: Session): { mtime: number; size: number } | undefined {
  if (s.tool === 'opencode') {
    return { mtime: s.updatedAt ? Date.parse(s.updatedAt) || 0 : 0, size: s.messageCount ?? 0 }
  }
  try {
    const st = statSync(s.path)
    // Claude subagent transcripts live next to the session and feed usage stats: their changes count too
    if (s.tool === 'claude') {
      const sub = claudeSubagentStat(s.path)
      return { mtime: Math.max(Math.floor(st.mtimeMs), sub.mtime), size: st.size + sub.size }
    }
    return { mtime: Math.floor(st.mtimeMs), size: st.size }
  } catch {
    return undefined
  }
}

const keyOf = (tool: string, id: string): string => `${tool}\u0000${id}`

/** Incremental indexing. Never run twice concurrently on the same file (caller holds the lock) */
export async function indexSessions(
  home: string,
  sessions: Session[],
  opts: IndexSessionsOptions = {}
): Promise<IndexResult> {
  const t0 = Date.now()
  const db = openDb(opts.dbPath ?? searchIndexPath(home))
  const base = totalChanges(db)
  const includeTools = !!opts.includeTools
  let opencode: OpencodeDb | undefined
  try {
    // Reindex everything if includeTools changed
    // A new (or migrated) usage table needs every session read once more — in one transaction so an interrupted
    // upgrade can't leave an empty table marked current
    db.exec('begin')
    try {
      // Each is checked on its own; either one being new means every session is read again
      const usageNew = ensureUsage(db)
      const modelNew = ensureModelStats(db)
      if (usageNew || modelNew) db.exec('update sessions set mtime = -1')
      db.exec('commit')
    } catch (e) {
      db.exec('rollback')
      throw e
    }
    const prevTools = metaGet(db, 'includeTools')
    if (prevTools !== undefined && prevTools !== String(includeTools)) {
      db.exec(
        `delete from messages; delete from msg; delete from sessions; delete from usage; ${MODEL_TABLES.map((t) => `delete from ${t};`).join(' ')}`
      )
    }
    if (prevTools !== String(includeTools)) metaSet(db, 'includeTools', String(includeTools))

    const existing = new Map<string, Row>()
    for (const r of db
      .prepare(
        'select sid, tool, id, path, mtime, size, title, project, updatedAt, parentId from sessions'
      )
      .all() as unknown as Row[])
      existing.set(keyOf(r.tool, r.id), r)

    // Dedupe the list (earlier = more recent wins)
    const list: Session[] = []
    const seen = new Set<string>()
    for (const s of sessions) {
      const k = keyOf(s.tool, s.id)
      if (seen.has(k)) continue
      seen.add(k)
      list.push(s)
    }

    const delMessages = db.prepare(
      'delete from messages where rowid in (select mid from msg where sid = ?)'
    )
    const delMsg = db.prepare('delete from msg where sid = ?')
    const delSession = db.prepare('delete from sessions where sid = ?')
    const delUsage = db.prepare('delete from usage where sid = ?')
    const delModel = MODEL_TABLES.map((t) => db.prepare(`delete from ${t} where sid = ?`))
    const insUsage = db.prepare(
      'insert into usage(sid, tool, kind, name, model, day, n) values (?, ?, ?, ?, ?, ?, ?)'
    )

    // Sessions that disappeared
    const complete = new Set<string>(opts.completeTools ?? TOOL_IDS)
    const gone = [...existing.values()].filter(
      (r) => complete.has(r.tool) && !seen.has(keyOf(r.tool, r.id))
    )
    if (gone.length) {
      db.exec('begin')
      try {
        for (const r of gone) {
          delMessages.run(r.sid)
          delMsg.run(r.sid)
          delUsage.run(r.sid)
          for (const d of delModel) d.run(r.sid)
          delSession.run(r.sid)
        }
        db.exec('commit')
      } catch (e) {
        db.exec('rollback')
        throw e
      }
    }

    // Changed sessions / sessions where only metadata such as title changed
    const todo: { s: Session; sig: { mtime: number; size: number }; row?: Row }[] = []
    const metaOnly: { s: Session; row: Row }[] = []
    for (const s of list) {
      const sig = signature(s)
      if (!sig) continue
      const row = existing.get(keyOf(s.tool, s.id))
      if (!row || row.mtime !== sig.mtime || row.size !== sig.size || row.path !== s.path)
        todo.push({ s, sig, row })
      else if (
        (row.title ?? '') !== (s.title ?? '') ||
        (row.project ?? '') !== (s.project ?? '') ||
        (row.updatedAt ?? '') !== (s.updatedAt ?? '') ||
        (row.parentId ?? '') !== (s.parentId ?? '')
      )
        metaOnly.push({ s, row })
    }

    const updMeta = db.prepare(
      'update sessions set title = ?, project = ?, updatedAt = ?, parentId = ? where sid = ?'
    )
    if (metaOnly.length) {
      db.exec('begin')
      for (const { s, row } of metaOnly)
        updMeta.run(
          s.title ?? '',
          s.project ?? null,
          s.updatedAt ?? null,
          s.parentId ?? null,
          row.sid
        )
      db.exec('commit')
    }

    const insSession = db.prepare(
      'insert into sessions(tool, id, path, mtime, size, title, project, updatedAt, parentId, nmsg) values (?, ?, ?, 0, 0, ?, ?, ?, ?, 0)'
    )
    const finish = db.prepare(
      'update sessions set path = ?, mtime = ?, size = ?, title = ?, project = ?, updatedAt = ?, parentId = ?, nmsg = ? where sid = ?'
    )
    const insMsg = db.prepare('insert into msg(sid, idx, role, at) values (?, ?, ?, ?)')
    const insText = db.prepare('insert into messages(rowid, text) values (?, ?)')

    let done = 0
    let indexed = 0
    let failed = 0
    let inserted = 0
    opts.onProgress?.({ done, total: todo.length })
    for (const { s, sig, row } of todo) {
      db.exec('begin')
      try {
        let sid: number
        if (row) {
          sid = row.sid
          delMessages.run(sid)
          delMsg.run(sid)
        } else {
          sid = Number(
            insSession.run(
              s.tool,
              s.id,
              s.path,
              s.title ?? '',
              s.project ?? null,
              s.updatedAt ?? null,
              s.parentId ?? null
            ).lastInsertRowid
          )
        }
        let n = 0
        const sink = (m: TranscriptMessage): void => {
          if (m.kind === 'tool' && !includeTools) return
          const mid = insMsg.run(sid, m.index, m.role, m.at ?? null).lastInsertRowid
          insText.run(mid, m.text)
          n++
        }
        const c = new Collector(sink)
        const usage = new UsageCounter(s.tool, s.updatedAt)
        // Codex and OpenCode child sessions are subagents as a whole; Claude subagents are separate files read below
        const models = new ModelStatsCounter(s.tool, s.updatedAt, !!s.parentId)
        c.onCall = (call) => {
          usage.add(call)
          models.call(call)
        }
        c.stats = models
        switch (s.tool) {
          case 'claude':
            await readClaude(s.path, c)
            models.finish()
            for (const f of claudeSubagentFiles(s.path)) {
              models.beginSubagent()
              try {
                await readClaudeSubagentStats(
                  f,
                  (call) => {
                    usage.add(call)
                    models.call(call)
                  },
                  models
                )
              } catch {
                // an unreadable or vanished subagent file must not fail the whole session
              }
              models.endSubagent()
            }
            break
          case 'codex':
            await readCodex(s.path, c)
            break
          case 'opencode':
            opencode ??= openOpencodeDb(home)
            readOpencodeDb(opencode, s.id, c)
            break
          case 'gemini':
            await readGemini(s.path, c)
            break
          case 'copilot':
            throw new Error('Copilot sessions are not supported yet')
          case 'grok':
            await readGrok(s.path, c)
            break
          default: {
            const never: never = s.tool
            throw new Error(`unknown tool ${String(never)}`)
          }
        }
        delUsage.run(sid)
        for (const u of usage.rows.values())
          insUsage.run(sid, s.tool, u.kind, u.name, u.model, u.day, u.n)
        models.write(db, sid)
        finish.run(
          s.path,
          sig.mtime,
          sig.size,
          s.title ?? '',
          s.project ?? null,
          s.updatedAt ?? null,
          s.parentId ?? null,
          n,
          sid
        )
        db.exec('commit')
        indexed++
        inserted += n
      } catch {
        db.exec('rollback')
        failed++
      }
      done++
      opts.onProgress?.({ done, total: todo.length })
      // Yield to the event loop between large sessions (to send progress messages)
      await new Promise((r) => setImmediate(r))
    }

    const changes = totalChanges(db) - base
    if (changes > 0) metaSet(db, 'lastIndexedAt', new Date().toISOString())
    return {
      sessions: list.length,
      indexed,
      removed: gone.length,
      failed,
      inserted,
      changes,
      ms: Date.now() - t0
    }
  } finally {
    opencode?.close()
    db.close()
  }
}

export function indexStatus(home: string, opts: IndexOptions = {}): IndexStatus {
  const path = opts.dbPath ?? searchIndexPath(home)
  if (!existsSync(path)) return { exists: false, sessions: 0, messages: 0 }
  const db = openDb(path)
  try {
    const sessions = Number(
      (db.prepare('select count(*) as n from sessions').get() as { n: number }).n
    )
    const messages = Number((db.prepare('select count(*) as n from msg').get() as { n: number }).n)
    const docs = tableExists(db, 'docs')
      ? Number((db.prepare('select count(*) as n from docs').get() as { n: number }).n)
      : 0
    return { exists: true, sessions, messages, docs, lastIndexedAt: metaGet(db, 'lastIndexedAt') }
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------- Search

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** About 60 chars around the first match + highlight range */
export function makeSnippet(
  text: string,
  q: string
): { snippet: string; marks: [number, number][] } {
  const flat = text.replace(/\s+/g, ' ').trim()
  const re = new RegExp(escapeRe(q.replace(/\s+/g, ' ')), 'giu')
  const found: [number, number][] = []
  for (const m of flat.matchAll(re)) {
    if (!m[0]) break
    found.push([m.index, m.index + m[0].length])
  }
  const first = found[0] ?? [0, 0]
  let start = Math.max(0, first[0] - SNIPPET_SIDE)
  let end = Math.min(flat.length, first[1] + SNIPPET_SIDE)
  // Never split surrogate pairs
  if (start > 0 && /[\uDC00-\uDFFF]/.test(flat[start] ?? '')) start--
  if (end < flat.length && /[\uDC00-\uDFFF]/.test(flat[end] ?? '')) end++
  const pre = start > 0 ? '…' : ''
  const post = end < flat.length ? '…' : ''
  const marks = found
    .filter(([a, b]) => a >= start && b <= end)
    .map(([a, b]): [number, number] => [a - start + pre.length, b - start + pre.length])
  return { snippet: pre + flat.slice(start, end) + post, marks }
}

interface HitRow {
  sid: number
  idx: number
  role: 'user' | 'assistant'
  at: string | null
  mid: number
  rn: number
  n: number
  total: number
}

interface SessionRow {
  sid: number
  tool: SessionTool
  id: string
  title: string | null
  project: string | null
  updatedAt: string | null
  parentId: string | null
}

export function searchSessions(
  home: string,
  query: string,
  opts: SearchOptions = {}
): SessionSearchResponse {
  const t0 = Date.now()
  const q = query.trim()
  const path = opts.dbPath ?? searchIndexPath(home)
  const mode: 'fts' | 'like' = [...q].length >= 3 ? 'fts' : 'like'
  if (!q || !existsSync(path)) return { results: [], mode, limited: false, ms: 0 }
  const limit = Math.max(1, opts.limit ?? 200)
  const per = Math.max(1, opts.perSession ?? 5)
  const db = openDb(path)
  try {
    const where: string[] = []
    const params: (string | number)[] = []
    if (mode === 'fts') {
      where.push('m.messages match ?')
      params.push(`"${q.replace(/"/g, '""')}"`)
    } else {
      where.push(`m.text like ? escape '\\'`)
      params.push(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`)
    }
    if (opts.tool) {
      where.push('s.tool = ?')
      params.push(opts.tool)
    }
    if (opts.project) {
      where.push('s.project = ?')
      params.push(opts.project)
    }
    if (opts.role) {
      where.push('g.role = ?')
      params.push(opts.role)
    }
    // LIKE has a row cap, so read recent sessions first (index order would drop recent sessions)
    const inner = `select g.sid, g.idx, g.role, g.at, g.mid
      from messages m join msg g on g.mid = m.rowid join sessions s on s.sid = g.sid
      where ${where.join(' and ')}${mode === 'like' ? ` order by s.updatedAt desc, g.idx limit ${LIKE_ROW_LIMIT + 1}` : ''}`
    const rows = db
      .prepare(
        `select * from (
           select h.*, row_number() over (partition by h.sid order by h.idx) as rn,
                  count(*) over (partition by h.sid) as n,
                  count(*) over () as total
             from (${inner}) h
         ) where rn <= ${per}`
      )
      .all(...params) as unknown as HitRow[]
    const likeLimited = mode === 'like' && Number(rows[0]?.total ?? 0) > LIKE_ROW_LIMIT

    const bySid = new Map<number, HitRow[]>()
    for (const r of rows) {
      const list = bySid.get(r.sid) ?? []
      list.push(r)
      bySid.set(r.sid, list)
    }
    const sessStmt = db.prepare(
      'select sid, tool, id, title, project, updatedAt, parentId from sessions where sid = ?'
    )
    const sess = [...bySid.keys()].map((sid) => sessStmt.get(sid) as unknown as SessionRow)
    sess.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    const top = sess.slice(0, limit)
    const textStmt = db.prepare('select text from messages where rowid = ?')
    const results: SessionSearchResult[] = top.map((s) => {
      const hits = (bySid.get(s.sid) ?? []).sort((a, b) => a.idx - b.idx)
      return {
        tool: s.tool,
        id: s.id,
        title: s.title ?? '',
        ...(s.project ? { project: s.project } : {}),
        ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
        ...(s.parentId ? { parentId: s.parentId } : {}),
        count: Number(hits[0]?.n ?? 0),
        hits: hits.map((h) => {
          const text = String((textStmt.get(h.mid) as { text?: string } | undefined)?.text ?? '')
          return {
            idx: Number(h.idx),
            role: h.role,
            ...(h.at ? { at: h.at } : {}),
            ...makeSnippet(text, q)
          }
        })
      }
    })
    return { results, mode, limited: sess.length > limit || likeLimited, ms: Date.now() - t0 }
  } finally {
    db.close()
  }
}

/** Titles of indexed sessions of one tool by id (read-only; empty when there is no index yet) */
export function sessionTitles(home: string, tool: string, ids: string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (!ids.length) return out
  const db = openDbForRead(searchIndexPath(home))
  if (!db) return out
  try {
    const q = db.prepare(
      `select id, title from sessions where tool = ? and id in (${ids.map(() => '?').join(',')})`
    )
    for (const r of q.all(tool, ...ids) as { id: string; title: string | null }[])
      if (r.title?.trim()) out.set(r.id, r.title)
  } finally {
    db.close()
  }
  return out
}
