/**
 * Document content index and search (artifacts + library). Shares search.sqlite with the session index (sessionIndex.ts).
 * - Artifacts: text kinds only (md, html with tags stripped, txt, json), up to DOC_SIZE_LIMIT. Images (svg included) are skipped
 * - Library (active workspace): rules/*.md, skills/<name>/** text files, memory/**\/*.md, agents/*.md,
 *   mcps/*.json (server name and description fields only — commands, args, env, headers and secret refs are never indexed)
 * - Incremental per document (path, mtime, size). Documents missing from the current list are removed
 * - Source files are only read
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import fg from 'fast-glob'
import { libraryRoot } from '../config'
import { scanArtifacts, type Artifact, type ArtifactTool } from '../scan/artifacts'
import {
  makeSnippet,
  metaGet,
  metaSet,
  openDb,
  searchIndexPath,
  searchSessions,
  totalChanges,
  type IndexOptions,
  type SessionSearchResponse
} from './sessionIndex'

const DOC_SCHEMA = '1'
/** Files larger than this are not indexed */
export const DOC_SIZE_LIMIT = 1024 * 1024
const LIKE_ROW_LIMIT = 2000

export const DOC_KINDS = ['artifact', 'rule', 'skill', 'memory', 'agent', 'mcp'] as const
export type DocKind = (typeof DOC_KINDS)[number]

/** Artifact extensions indexed as text (besides md/html) */
const ARTIFACT_TEXT_EXT = new Set(['.txt', '.json'])
/** Skill file extensions indexed as text */
const SKILL_TEXT_EXT = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.sh',
  '.html',
  '.htm',
  '.csv'
])
/** mcps/<name>.json fields indexed besides the name */
const MCP_TEXT_FIELDS = ['description', '_'] as const

/** Document to index */
export interface DocSource {
  kind: DocKind
  /** Unique within kind: artifact id, rule/agent/mcp name, skill `<name>/<rel>`, memory rel path */
  key: string
  title: string
  tool?: ArtifactTool
  path: string
  mtime: number
  size: number
  /** 'html' strips tags, 'mcp' keeps only name and description fields */
  format: 'text' | 'html' | 'mcp'
}

export interface DocIndexResult {
  docs: number
  indexed: number
  removed: number
  /** Unreadable or binary documents (previous index entry removed) */
  skipped: number
  changes: number
  ms: number
}

export interface DocSearchOptions extends IndexOptions {
  kind?: DocKind
  tool?: ArtifactTool
  /** Max documents (default 200) */
  limit?: number
}

export interface DocSearchResult {
  kind: DocKind
  key: string
  title: string
  tool?: ArtifactTool
  path: string
  /** ISO 8601 */
  mtime: string
  snippet: string
  marks: [number, number][]
}

export interface DocSearchResponse {
  results: DocSearchResult[]
  mode: 'fts' | 'like'
  limited: boolean
  ms: number
}

export interface SearchAllResponse {
  sessions: SessionSearchResponse
  docs: Record<DocKind, DocSearchResult[]>
  mode: 'fts' | 'like'
  limited: boolean
  ms: number
}

// ---------------------------------------------------------------- DB

function openDocDb(path: string): DatabaseSync {
  const db = openDb(path)
  if (metaGet(db, 'docSchema') !== DOC_SCHEMA) {
    db.exec(`
      drop table if exists docs;
      drop table if exists doctext;
      create table docs(
        did integer primary key,
        kind text not null,
        key text not null,
        title text,
        tool text,
        path text not null,
        mtime integer not null,
        size integer not null,
        unique(kind, key)
      );
      create virtual table doctext using fts5(text, tokenize = 'trigram');
    `)
    metaSet(db, 'docSchema', DOC_SCHEMA)
  }
  return db
}

// ---------------------------------------------------------------- Sources

/** Artifact scan → text documents */
export function artifactDocs(artifacts: Artifact[]): DocSource[] {
  const out: DocSource[] = []
  for (const a of artifacts) {
    const ext = extname(a.path).toLowerCase()
    const format =
      a.kind === 'md'
        ? 'text'
        : a.kind === 'html'
          ? 'html'
          : a.kind === 'other' && ARTIFACT_TEXT_EXT.has(ext)
            ? 'text'
            : null
    if (!format || a.size > DOC_SIZE_LIMIT) continue
    out.push({
      kind: 'artifact',
      key: a.id,
      title: a.title,
      tool: a.tool,
      path: a.path,
      mtime: Date.parse(a.mtime) || 0,
      size: a.size,
      format
    })
  }
  return out
}

function globFiles(cwd: string, pattern: string): fg.Entry[] {
  return fg.sync(pattern, {
    cwd,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    suppressErrors: true,
    stats: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/__pycache__/**']
  })
}

/** Library documents of the active workspace */
export function libraryDocs(home: string): DocSource[] {
  const root = libraryRoot(home)
  const out: DocSource[] = []
  const add = (
    kind: DocKind,
    e: fg.Entry,
    key: string,
    title: string,
    format: DocSource['format'] = 'text'
  ): void => {
    const size = e.stats?.size ?? 0
    if (size > DOC_SIZE_LIMIT) return
    out.push({
      kind,
      key,
      title,
      path: join(root, e.path),
      mtime: Math.floor(e.stats?.mtimeMs ?? 0),
      size,
      format
    })
  }
  for (const e of globFiles(root, 'rules/*.md')) add('rule', e, e.name, e.name)
  for (const e of globFiles(root, 'agents/*.md'))
    add('agent', e, e.name.slice(0, -3), e.name.slice(0, -3))
  for (const e of globFiles(root, 'memory/**/*.md')) {
    const rel = e.path.slice('memory/'.length)
    add('memory', e, rel, rel)
  }
  for (const e of globFiles(root, 'skills/*/**')) {
    const ext = extname(e.name).toLowerCase()
    if (!SKILL_TEXT_EXT.has(ext)) continue
    const [, name, ...rest] = e.path.split('/')
    const rel = rest.join('/')
    add(
      'skill',
      e,
      `${name}/${rel}`,
      rel === 'SKILL.md' ? name : `${name} · ${rel}`,
      ext === '.html' || ext === '.htm' ? 'html' : 'text'
    )
  }
  for (const e of globFiles(root, 'mcps/*.json')) {
    if (e.name.startsWith('_')) continue
    const name = e.name.slice(0, -'.json'.length)
    add('mcp', e, name, name, 'mcp')
  }
  return out
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

/** HTML → plain text (scripts, styles, comments and tags removed; common entities decoded) */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' '
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

/** Only the name and description fields of an MCP definition */
export function mcpDocText(name: string, raw: string): string {
  const parts = [name]
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    for (const f of MCP_TEXT_FIELDS)
      if (typeof o?.[f] === 'string' && (o[f] as string).trim()) parts.push((o[f] as string).trim())
  } catch {
    // Invalid JSON → name only
  }
  return parts.join('\n')
}

/** Document text. undefined for binary (NUL byte) or unreadable files */
function readDocText(d: DocSource): string | undefined {
  let buf: Buffer
  try {
    buf = readFileSync(d.path)
  } catch {
    return undefined
  }
  if (buf.length > DOC_SIZE_LIMIT || buf.subarray(0, 8192).includes(0)) return undefined
  const raw = buf.toString('utf8')
  if (d.format === 'html') return htmlToText(raw)
  if (d.format === 'mcp') return mcpDocText(d.key, raw)
  return raw
}

// ---------------------------------------------------------------- Indexing

interface DocRow {
  did: number
  kind: DocKind
  key: string
  title: string | null
  tool: string | null
  path: string
  mtime: number
  size: number
}

const docKey = (kind: string, key: string): string => `${kind}\u0000${key}`

export interface IndexDocsOptions extends IndexOptions {
  /** Kinds whose document list is complete — indexed documents of these kinds missing from the list are removed (default: all) */
  completeKinds?: DocKind[]
}

/** Incremental document indexing. Never run concurrently on the same file (caller holds the lock) */
export function indexDocs(
  home: string,
  docs: DocSource[],
  opts: IndexDocsOptions = {}
): DocIndexResult {
  const t0 = Date.now()
  const db = openDocDb(opts.dbPath ?? searchIndexPath(home))
  const base = totalChanges(db)
  try {
    const existing = new Map<string, DocRow>()
    for (const r of db
      .prepare('select did, kind, key, title, tool, path, mtime, size from docs')
      .all() as unknown as DocRow[])
      existing.set(docKey(r.kind, r.key), r)
    const list = new Map<string, DocSource>()
    for (const d of docs) if (!list.has(docKey(d.kind, d.key))) list.set(docKey(d.kind, d.key), d)

    const delText = db.prepare('delete from doctext where rowid = ?')
    const delDoc = db.prepare('delete from docs where did = ?')
    const complete = new Set<string>(opts.completeKinds ?? DOC_KINDS)
    const gone = [...existing.entries()]
      .filter(([k, r]) => complete.has(r.kind) && !list.has(k))
      .map(([, r]) => r)

    const ins = db.prepare(
      'insert into docs(kind, key, title, tool, path, mtime, size) values (?, ?, ?, ?, ?, ?, ?)'
    )
    const upd = db.prepare(
      'update docs set title = ?, tool = ?, path = ?, mtime = ?, size = ? where did = ?'
    )
    const insText = db.prepare('insert into doctext(rowid, text) values (?, ?)')
    const updMeta = db.prepare('update docs set title = ?, tool = ? where did = ?')

    let indexed = 0
    let skipped = 0
    db.exec('begin')
    try {
      for (const r of gone) {
        delText.run(r.did)
        delDoc.run(r.did)
      }
      for (const [k, d] of list) {
        const row = existing.get(k)
        if (row && row.path === d.path && row.mtime === d.mtime && row.size === d.size) {
          if ((row.title ?? '') !== d.title || (row.tool ?? null) !== (d.tool ?? null))
            updMeta.run(d.title, d.tool ?? null, row.did)
          continue
        }
        const text = readDocText(d)
        if (text === undefined) {
          if (row) {
            delText.run(row.did)
            delDoc.run(row.did)
          }
          skipped++
          continue
        }
        let did: number
        if (row) {
          did = row.did
          delText.run(did)
          upd.run(d.title, d.tool ?? null, d.path, d.mtime, d.size, did)
        } else
          did = Number(
            ins.run(d.kind, d.key, d.title, d.tool ?? null, d.path, d.mtime, d.size).lastInsertRowid
          )
        insText.run(did, text)
        indexed++
      }
      db.exec('commit')
    } catch (e) {
      db.exec('rollback')
      throw e
    }
    const changes = totalChanges(db) - base
    if (changes > 0) metaSet(db, 'docsIndexedAt', new Date().toISOString())
    return { docs: list.size, indexed, removed: gone.length, skipped, changes, ms: Date.now() - t0 }
  } finally {
    db.close()
  }
}

/** Artifacts + library of the active workspace → incremental index */
export function indexAllDocs(home: string, opts: IndexOptions = {}): DocIndexResult {
  return indexDocs(home, [...artifactDocs(scanArtifacts(home)), ...libraryDocs(home)], opts)
}

export function docCount(home: string, opts: IndexOptions = {}): number {
  const db = openDocDb(opts.dbPath ?? searchIndexPath(home))
  try {
    return Number((db.prepare('select count(*) as n from docs').get() as { n: number }).n)
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------- Search

interface DocHitRow extends DocRow {
  text: string
  total: number
}

export function searchDocs(
  home: string,
  query: string,
  opts: DocSearchOptions = {}
): DocSearchResponse {
  const t0 = Date.now()
  const q = query.trim()
  const mode: 'fts' | 'like' = [...q].length >= 3 ? 'fts' : 'like'
  const path = opts.dbPath ?? searchIndexPath(home)
  let exists = true
  try {
    statSync(path)
  } catch {
    exists = false
  }
  if (!q || !exists) return { results: [], mode, limited: false, ms: 0 }
  const limit = Math.max(1, opts.limit ?? 200)
  const db = openDocDb(path)
  try {
    const where: string[] = []
    const params: (string | number)[] = []
    if (mode === 'fts') {
      where.push('doctext match ?')
      params.push(`"${q.replace(/"/g, '""')}"`)
    } else {
      where.push(`t.text like ? escape '\\'`)
      params.push(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`)
    }
    if (opts.kind) {
      where.push('d.kind = ?')
      params.push(opts.kind)
    }
    if (opts.tool) {
      where.push('d.tool = ?')
      params.push(opts.tool)
    }
    // Most recently modified first. LIKE scans are capped, so recent documents are read first
    const cap = mode === 'like' ? Math.min(limit, LIKE_ROW_LIMIT) : limit
    const rows = db
      .prepare(
        `select d.did, d.kind, d.key, d.title, d.tool, d.path, d.mtime, d.size, t.text, count(*) over () as total
           from doctext t join docs d on d.did = t.rowid
          where ${where.join(' and ')}
          order by d.mtime desc
          limit ${cap}`
      )
      .all(...params) as unknown as DocHitRow[]
    const total = Number(rows[0]?.total ?? 0)
    const results: DocSearchResult[] = rows.map((r) => ({
      kind: r.kind,
      key: r.key,
      title: r.title || basename(r.path),
      ...(r.tool ? { tool: r.tool as ArtifactTool } : {}),
      path: r.path,
      mtime: new Date(Number(r.mtime)).toISOString(),
      ...makeSnippet(String(r.text ?? ''), q)
    }))
    return { results, mode, limited: total > rows.length, ms: Date.now() - t0 }
  } finally {
    db.close()
  }
}

/** Sessions + documents, documents grouped by kind (⌘K) */
export function searchAll(
  home: string,
  query: string,
  opts: IndexOptions & { limit?: number } = {}
): SearchAllResponse {
  const t0 = Date.now()
  const sessions = searchSessions(home, query, { ...opts, limit: opts.limit ?? 50, perSession: 1 })
  const docs = Object.fromEntries(DOC_KINDS.map((k) => [k, [] as DocSearchResult[]])) as Record<
    DocKind,
    DocSearchResult[]
  >
  let limited = sessions.limited
  for (const kind of DOC_KINDS) {
    const r = searchDocs(home, query, { ...opts, kind, limit: opts.limit ?? 50 })
    docs[kind] = r.results
    limited ||= r.limited
  }
  return { sessions, docs, mode: sessions.mode, limited, ms: Date.now() - t0 }
}
