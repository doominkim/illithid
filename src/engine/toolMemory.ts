/**
 * Tool auto-memory management (Claude: ~/.claude/projects/<slug>/memory/*.md, Codex: ~/.codex/memories read-only).
 *
 * Rules
 * - slug must be a real directory name directly under ~/.claude/projects (symlinks and path escapes refused, rechecked via realpath).
 * - File names match `[^/]+\.md`. MEMORY.md (the index) is read-only and cannot be promoted, moved, or trashed.
 * - No permanent deletion. Every source removal is a rename into the library `.trash/<stamp>/tool-memory/claude/<slug>/<file>`.
 * - Refused if the target already has the same name (no overwrite).
 * - An index line is one containing `](<file>)`. If absent, removal is skipped and added lines are built from frontmatter name/description.
 */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  readSync,
  renameSync,
  statSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import matter from 'gray-matter'
import { listMemoryFiles, readMemoryFile, TRASH_DIR, writeMemoryFile } from './library'
import { assertInsideLibrary, LibraryError, libraryRealRoot } from './libpath'
import { readHead } from './scan/common'
import { libraryPaths } from './sources'
import { atomicWrite } from './write'

/** Limit Claude reads from the index (the rest is cut off) */
export const INDEX_MAX_LINES = 200
export const INDEX_MAX_BYTES = 25 * 1024
export const INDEX_FILE = 'MEMORY.md'
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

const PROJECTS_REL = join('.claude', 'projects')
const CODEX_MEMORIES_REL = join('.codex', 'memories')
const FILE_RE = /^[^/\\\0]+\.md$/
const READ_LIMIT = 1024 * 1024
const HEAD_LIMIT = 64 * 1024

export interface IndexStat {
  lines: number
  bytes: number
}

export interface ClaudeMemoryFile {
  file: string
  /** Index line title ?? frontmatter name ?? file name */
  title: string
  type?: string
  description?: string
  mtime: string
  /** Index has a `](file)` line */
  inIndex: boolean
  /** Same file name exists anywhere in shared memory */
  inShared: boolean
}

export interface ClaudeMemoryProject {
  slug: string
  /** Original folder read from session JSONL */
  cwd?: string
  /** cwd is known but that path no longer exists */
  missing: boolean
  /** Under /tmp·/private/tmp */
  temp: boolean
  files: ClaudeMemoryFile[]
  index: IndexStat & { exists: boolean; broken: string[] }
  updatedAt: string
}

export interface ClaudeMemoryScan {
  projects: ClaudeMemoryProject[]
  /** Shared index (library memory/MEMORY.md) size. null if missing */
  shared: IndexStat | null
  limits: IndexStat
}

export interface CodexMemoryEntry {
  name: string
  kind: 'file' | 'dir'
  /** File line count (none for dir) */
  lines?: number
  bytes: number
  /** File count inside dir */
  files?: number
  updatedAt: string
}

export interface ToolMemoryMoveResult {
  /** New location (absolute) */
  path: string
  /** Lines removed from the source index */
  removedLines: number
  /** Lines added to the target index */
  addedLines: number
  /** Trash path if the source was trashed */
  trashPath?: string
  /** Path of the index if it was trashed too */
  indexTrashPath?: string
}

// ---------------------------------------------------------------- paths·validation

/** Path → Claude project slug (every non-alphanumeric becomes `-`) */
export function claudeProjectSlug(path: string): string {
  return resolve(String(path)).replace(/[^a-zA-Z0-9]/g, '-')
}

function projectsRoot(home: string): string {
  return join(home, PROJECTS_REL)
}

function projectsRealRoot(home: string): string {
  const root = projectsRoot(home)
  if (!existsSync(root)) throw new LibraryError('notFound', '~/.claude/projects is missing')
  return realpathSync(root)
}

function isRealDir(p: string): boolean {
  try {
    const st = lstatSync(p)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

function isRealFile(p: string): boolean {
  try {
    const st = lstatSync(p)
    return st.isFile() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

function within(root: string, p: string): boolean {
  const r = relative(root, p)
  return !!r && !r.startsWith('..' + sep) && r !== '..' && !r.startsWith(sep)
}

/** Validate slug → real project directory (realpath) */
function slugDir(home: string, slug: unknown): string {
  if (typeof slug !== 'string' || !slug || slug === '.' || slug === '..' || /[/\\\0]/.test(slug))
    throw new LibraryError('invalidName', 'invalid project name')
  const root = projectsRealRoot(home)
  const dir = join(root, slug)
  if (!isRealDir(dir)) throw new LibraryError('notFound', 'project not found')
  const real = realpathSync(dir)
  if (dirname(real) !== root || basename(real) !== slug)
    throw new LibraryError('outsideLibrary', 'invalid project path')
  return real
}

/** The project's memory directory (may be missing). If present it must be a real directory */
function memDir(home: string, slug: string): string {
  const dir = join(slugDir(home, slug), 'memory')
  if (existsSync(dir) || lstatSafe(dir)) {
    if (!isRealDir(dir)) throw new LibraryError('outsideLibrary', 'memory is not a directory')
    if (!within(dirname(dir), realpathSync(dir)))
      throw new LibraryError('outsideLibrary', 'invalid memory path')
  }
  return dir
}

function lstatSafe(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

function checkFile(file: unknown, allowIndex: boolean): string {
  if (typeof file !== 'string' || !FILE_RE.test(file) || file.startsWith('.') || file === '..')
    throw new LibraryError('invalidName', 'invalid memory file name')
  if (!allowIndex && file === INDEX_FILE)
    throw new LibraryError('invalidName', 'MEMORY.md is not a valid target')
  return file
}

/** Existing regular file (symlinks refused) */
function existingFile(home: string, slug: string, file: string, allowIndex = false): string {
  checkFile(file, allowIndex)
  const dir = memDir(home, slug)
  const p = join(dir, file)
  if (!isRealFile(p)) throw new LibraryError('notFound', 'memory file not found')
  if (dirname(realpathSync(p)) !== realpathSync(dir))
    throw new LibraryError('outsideLibrary', 'invalid memory file path')
  return p
}

// ---------------------------------------------------------------- index

const LINK_LINE = /^\s*[-*]\s*\[([^\]]*)\]\(([^)\s]+)\)/
const linkTag = (file: string): string => `](${file})`

function readText(p: string): string {
  return isRealFile(p) ? readFileSync(p, 'utf8') : ''
}

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function joinLines(lines: string[]): string {
  return lines.length ? lines.join('\n') + '\n' : ''
}

function indexStat(text: string): IndexStat {
  return { lines: splitLines(text).length, bytes: Buffer.byteLength(text, 'utf8') }
}

/** Remove lines containing `](file)` */
function removeIndexLines(text: string, file: string): { text: string; removed: number } {
  const lines = splitLines(text)
  const kept = lines.filter((l) => !l.includes(linkTag(file)))
  return { text: joinLines(kept), removed: lines.length - kept.length }
}

/** File frontmatter (empty if broken) */
function frontmatter(content: string): { name?: string; description?: string; type?: string } {
  try {
    const d = matter(content).data as Record<string, unknown>
    const meta =
      d.metadata && typeof d.metadata === 'object' ? (d.metadata as Record<string, unknown>) : {}
    const s = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : undefined
    return { name: s(d.name), description: s(d.description), type: s(d.type) ?? s(meta.type) }
  } catch {
    return {}
  }
}

/** Index line to carry over: fix only the link of the source line, or build one from frontmatter */
function indexLineFor(srcIndex: string, file: string, content: string, link: string): string {
  const line = splitLines(srcIndex).find((l) => l.includes(linkTag(file)))
  if (line) return line.split(linkTag(file)).join(linkTag(link))
  const fm = frontmatter(content)
  const title = fm.name ?? file.replace(/\.md$/, '')
  return `- [${title}](${link})${fm.description ? ` — ${fm.description}` : ''}`
}

/** Append a line at the end */
function appendLine(text: string, line: string): string {
  return joinLines([...splitLines(text), line])
}

/** Append at the end of the `## <type>` section (or at the very end if absent) */
function insertUnderHeading(text: string, heading: string, line: string): string {
  const lines = splitLines(text)
  const h = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`)
  if (h < 0) return appendLine(text, line)
  let end = h + 1
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++
  let at = end
  while (at > h + 1 && !lines[at - 1].trim()) at--
  lines.splice(at, 0, line)
  return joinLines(lines)
}

// ---------------------------------------------------------------- trash

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Library .trash/<stamp>/tool-memory/claude/<slug>/ (an unused stamp directory) */
function trashDirFor(home: string, slug: string): string {
  const root = libraryRealRoot(home)
  const sub = join('tool-memory', 'claude', slug)
  let dir = join(root, TRASH_DIR, stamp(), sub)
  for (let i = 1; existsSync(dir); i++) dir = join(root, TRASH_DIR, `${stamp()}-${i}`, sub)
  const checked = assertInsideLibrary(home, dir)
  mkdirSync(checked, { recursive: true, mode: 0o700 })
  return checked
}

function renameNew(from: string, to: string): void {
  if (lstatSafe(to)) throw new LibraryError('exists', 'target already has the same name')
  renameSync(from, to)
}

// ---------------------------------------------------------------- reads

/** cwd from the head of session JSONL (up to 5 files, newest first) */
function sessionCwd(dir: string): string | undefined {
  let files: { p: string; m: number; size: number }[] = []
  try {
    files = readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => {
        const p = join(dir, n)
        const st = statSync(p)
        return { p, m: st.mtimeMs, size: st.size }
      })
      .sort((a, b) => b.m - a.m)
      .slice(0, 5)
  } catch {
    return undefined
  }
  for (const f of files) {
    let head = ''
    try {
      head = readHead(f.p, f.size, HEAD_LIMIT)
    } catch {
      continue
    }
    for (const line of head.split('\n')) {
      if (!line.includes('"cwd"')) continue
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd
        if (typeof cwd === 'string' && cwd.startsWith('/')) return cwd
      } catch {
        // truncated line
      }
    }
  }
  return undefined
}

function isTemp(cwd: string | undefined, slug: string): boolean {
  if (cwd) return /^\/(private\/)?tmp(\/|$)/.test(cwd)
  return (
    slug === '-tmp' ||
    slug.startsWith('-tmp-') ||
    slug === '-private-tmp' ||
    slug.startsWith('-private-tmp-')
  )
}

function sharedNames(home: string): Set<string> {
  try {
    return new Set(listMemoryFiles(home).map((r) => r.split('/').pop()!))
  } catch {
    return new Set()
  }
}

function sharedIndexStat(home: string): IndexStat | null {
  try {
    return indexStat(readMemoryFile(home, INDEX_FILE))
  } catch {
    return null
  }
}

/** Scan ~/.claude/projects/<slug>/memory. Skips slots without memory .md files (excluding the index) */
export function scanClaudeMemory(home: string): ClaudeMemoryScan {
  const out: ClaudeMemoryScan = {
    projects: [],
    shared: sharedIndexStat(home),
    limits: { lines: INDEX_MAX_LINES, bytes: INDEX_MAX_BYTES }
  }
  const root = projectsRoot(home)
  if (!isRealDir(root)) return out
  const shared = sharedNames(home)
  for (const slug of readdirSync(root).sort()) {
    const pdir = join(root, slug)
    const mdir = join(pdir, 'memory')
    if (!isRealDir(pdir) || !isRealDir(mdir)) continue
    const names = readdirSync(mdir).filter(
      (n) => FILE_RE.test(n) && !n.startsWith('.') && n !== INDEX_FILE && isRealFile(join(mdir, n))
    )
    if (!names.length) continue
    const indexText = readText(join(mdir, INDEX_FILE))
    const indexLines = splitLines(indexText)
    const titles = new Map<string, string>()
    const broken: string[] = []
    for (const l of indexLines) {
      const m = LINK_LINE.exec(l)
      if (!m) continue
      const link = m[2]
      if (/^[a-z]+:/i.test(link) || link.startsWith('#')) continue
      const target = link.split('#')[0]
      if (!titles.has(target)) titles.set(target, m[1].trim())
      const abs = resolve(mdir, target)
      if (!within(mdir, abs) || !existsSync(abs)) broken.push(target)
    }
    let latest = 0
    const files: ClaudeMemoryFile[] = names.sort().map((file) => {
      const p = join(mdir, file)
      const st = statSync(p)
      latest = Math.max(latest, st.mtimeMs)
      let fm: ReturnType<typeof frontmatter> = {}
      try {
        fm = frontmatter(readHead(p, st.size, HEAD_LIMIT))
      } catch {
        // read failed — name only
      }
      const inIndex = indexLines.some((l) => l.includes(linkTag(file)))
      return {
        file,
        title: titles.get(file) || fm.name || file.replace(/\.md$/, ''),
        ...(fm.type ? { type: fm.type } : {}),
        ...(fm.description ? { description: fm.description } : {}),
        mtime: st.mtime.toISOString(),
        inIndex,
        inShared: shared.has(file)
      }
    })
    const indexPath = join(mdir, INDEX_FILE)
    if (isRealFile(indexPath)) latest = Math.max(latest, statSync(indexPath).mtimeMs)
    const cwd = sessionCwd(pdir)
    out.projects.push({
      slug,
      ...(cwd ? { cwd } : {}),
      missing: !!cwd && !existsSync(cwd),
      temp: isTemp(cwd, slug),
      files,
      index: { ...indexStat(indexText), exists: isRealFile(indexPath), broken },
      updatedAt: new Date(latest).toISOString()
    })
  }
  return out
}

/** Claude memory file body (MEMORY.md included, up to 1MB) */
export function readClaudeMemoryFile(home: string, slug: string, file: string): string {
  const p = existingFile(home, slug, file, true)
  const size = statSync(p).size
  return readHead(p, size, READ_LIMIT)
}

/** Codex memory listing order (pipeline reversed: final digest → raw material). Others (extensions·skills etc.) are not memory */
export const CODEX_MEMORY_ORDER = [
  'memory_summary.md',
  'MEMORY.md',
  'raw_memories.md',
  'rollout_summaries'
] as const
export const CODEX_ROLLOUT_DIR = 'rollout_summaries'
/** Bytes read per preview chunk */
export const CODEX_READ_CHUNK = 64 * 1024
const CODEX_READ_MAX = 256 * 1024

export interface CodexMemoryChunk {
  rel: string
  text: string
  offset: number
  size: number
  truncated: boolean
  /** Start byte for the next read when truncated */
  nextOffset?: number
}

export interface CodexRolloutSummary {
  name: string
  bytes: number
  updatedAt: string
}

function codexRoot(home: string): string {
  return join(home, CODEX_MEMORIES_REL)
}

const visibleMd = (dir: string): string[] =>
  readdirSync(dir).filter(
    (n) => !n.startsWith('.') && n.endsWith('.md') && isRealFile(join(dir, n))
  )

/** Memory entries in ~/.codex/memories (fixed order, read-only). rollout_summaries reports .md count and total size */
export function scanCodexMemory(home: string): CodexMemoryEntry[] {
  const root = codexRoot(home)
  if (!isRealDir(root)) return []
  const out: CodexMemoryEntry[] = []
  for (const name of CODEX_MEMORY_ORDER) {
    const p = join(root, name)
    if (name === CODEX_ROLLOUT_DIR) {
      if (!isRealDir(p)) continue
      let bytes = 0
      let latest = statSync(p).mtimeMs
      const names = visibleMd(p)
      for (const n of names) {
        const st = statSync(join(p, n))
        bytes += st.size
        latest = Math.max(latest, st.mtimeMs)
      }
      out.push({
        name,
        kind: 'dir',
        bytes,
        files: names.length,
        updatedAt: new Date(latest).toISOString()
      })
    } else if (isRealFile(p)) {
      const st = statSync(p)
      let lines = 0
      try {
        lines = splitLines(readFileSync(p, 'utf8')).length
      } catch {
        // read failed
      }
      out.push({ name, kind: 'file', lines, bytes: st.size, updatedAt: st.mtime.toISOString() })
    }
  }
  return out
}

/** rollout_summaries/*.md (newest first) */
export function listCodexRolloutSummaries(home: string): CodexRolloutSummary[] {
  const dir = join(codexRoot(home), CODEX_ROLLOUT_DIR)
  if (!isRealDir(dir)) return []
  return visibleMd(dir)
    .map((name) => {
      const st = statSync(join(dir, name))
      return { name, bytes: st.size, updatedAt: st.mtime.toISOString(), m: st.mtimeMs }
    })
    .sort((a, b) => b.m - a.m || a.name.localeCompare(b.name))
    .map(({ name, bytes, updatedAt }) => ({ name, bytes, updatedAt }))
}

/** Validate a path relative to the memories root → real file path */
function codexFile(home: string, rel: unknown): string {
  if (
    typeof rel !== 'string' ||
    !rel ||
    rel.includes('\0') ||
    rel.startsWith('/') ||
    !rel.endsWith('.md')
  )
    throw new LibraryError('invalidName', 'invalid Codex memory path')
  const parts = rel.split('/')
  if (parts.length > 2 || parts.some((x) => !x || x === '.' || x === '..' || x.startsWith('.')))
    throw new LibraryError('invalidName', 'invalid Codex memory path')
  const root = codexRoot(home)
  if (!isRealDir(root)) throw new LibraryError('notFound', '~/.codex/memories is missing')
  const p = join(root, ...parts)
  if (!isRealFile(p)) throw new LibraryError('notFound', 'Codex memory file not found')
  if (!within(realpathSync(root), realpathSync(p)))
    throw new LibraryError('outsideLibrary', 'invalid Codex memory path')
  return p
}

/**
 * Read part of a Codex memory file (read-only). limit bytes from offset; when truncated, cut at the last newline (or a UTF-8 boundary).
 */
export function readCodexMemoryFile(
  home: string,
  rel: string,
  offset = 0,
  limit = CODEX_READ_CHUNK
): CodexMemoryChunk {
  const p = codexFile(home, rel)
  const size = statSync(p).size
  const off = Number.isInteger(offset) && offset > 0 ? Math.min(offset, size) : 0
  const lim =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, CODEX_READ_MAX) : CODEX_READ_CHUNK
  const fd = openSync(p, 'r')
  let buf: Buffer
  try {
    const want = Math.min(lim, size - off)
    buf = Buffer.alloc(want)
    const n = readSync(fd, buf, 0, want, off)
    buf = buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
  let end = buf.length
  if (off + end < size) {
    const nl = buf.lastIndexOf(0x0a)
    if (nl >= 0) end = nl + 1
    else {
      // if the last character was partially read, cut at its start
      let i = end - 1
      while (i > 0 && (buf[i] & 0xc0) === 0x80) i--
      const lead = buf[i]
      const len = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
      if (i + len > end && i > 0) end = i
    }
  }
  const next = off + end
  const truncated = next < size
  return {
    rel,
    text: buf.subarray(0, end).toString('utf8'),
    offset: off,
    size,
    truncated,
    ...(truncated ? { nextOffset: next } : {})
  }
}

// ---------------------------------------------------------------- writes

function checkType(type: unknown): MemoryType {
  if (typeof type !== 'string' || !(MEMORY_TYPES as readonly string[]).includes(type))
    throw new LibraryError('invalidName', 'invalid type')
  return type as MemoryType
}

/**
 * Promote to shared (move): write library memory/<type>/<file> and add a line to the shared index `## <type>` section,
 * trash the source and remove its index line. Refused if the same path exists in shared.
 */
export function promoteClaudeMemory(
  home: string,
  slug: string,
  file: string,
  type: string
): ToolMemoryMoveResult {
  const t = checkType(type)
  const src = existingFile(home, slug, file)
  const dir = dirname(src)
  const rel = `${t}/${file}`
  const libPath = assertInsideLibrary(home, join(libraryPaths(home).memoryDir, rel))
  if (lstatSafe(libPath)) throw new LibraryError('exists', 'the same path already exists in shared')
  const content = readFileSync(src, 'utf8')
  const srcIndexPath = join(dir, INDEX_FILE)
  const srcIndex = readText(srcIndexPath)
  const line = indexLineFor(srcIndex, file, content, rel)
  // 1) write to shared + shared index
  const written = writeMemoryFile(home, rel, content)
  let sharedIndex = ''
  try {
    sharedIndex = readMemoryFile(home, INDEX_FILE)
  } catch (e) {
    if (!(e instanceof LibraryError && e.code === 'notFound')) throw e
  }
  let added = 0
  if (!sharedIndex.includes(linkTag(rel))) {
    writeMemoryFile(home, INDEX_FILE, insertUnderHeading(sharedIndex, t, line))
    added = 1
  }
  // 2) source → trash, remove source index line
  const trash = join(trashDirFor(home, slug), file)
  renameNew(src, trash)
  const r = removeIndexLines(srcIndex, file)
  if (r.removed) atomicWrite(srcIndexPath, r.text)
  return { path: written, removedLines: r.removed, addedLines: added, trashPath: trash }
}

/** Move to another project: creates the target memory folder if missing. Updates both indexes */
export function moveClaudeMemory(
  home: string,
  slug: string,
  file: string,
  toSlug: string
): ToolMemoryMoveResult {
  const src = existingFile(home, slug, file)
  const toProject = slugDir(home, toSlug)
  if (toProject === dirname(dirname(src))) throw new LibraryError('invalidName', 'same project')
  const toDir = memDir(home, toSlug)
  const dest = join(toDir, file)
  if (lstatSafe(dest)) throw new LibraryError('exists', 'target already has the same name')
  const content = readFileSync(src, 'utf8')
  const srcIndexPath = join(dirname(src), INDEX_FILE)
  const srcIndex = readText(srcIndexPath)
  const line = indexLineFor(srcIndex, file, content, file)
  if (!existsSync(toDir)) mkdirSync(toDir, { mode: 0o700 })
  renameNew(src, dest)
  const destIndexPath = join(toDir, INDEX_FILE)
  const destIndex = readText(destIndexPath)
  let added = 0
  if (!destIndex.includes(linkTag(file))) {
    atomicWrite(destIndexPath, appendLine(destIndex, line))
    added = 1
  }
  const r = removeIndexLines(srcIndex, file)
  if (r.removed) atomicWrite(srcIndexPath, r.text)
  return { path: dest, removedLines: r.removed, addedLines: added }
}

/** Trash: move the file + remove its index line. If only MEMORY.md remains and it has no link lines, trash the index too */
export function trashClaudeMemory(home: string, slug: string, file: string): ToolMemoryMoveResult {
  const src = existingFile(home, slug, file)
  const dir = dirname(src)
  const trashDir = trashDirFor(home, slug)
  const trash = join(trashDir, file)
  renameNew(src, trash)
  const indexPath = join(dir, INDEX_FILE)
  const r = removeIndexLines(readText(indexPath), file)
  if (r.removed) atomicWrite(indexPath, r.text)
  const result: ToolMemoryMoveResult = {
    path: trash,
    removedLines: r.removed,
    addedLines: 0,
    trashPath: trash
  }
  const leftMd = readdirSync(dir).some(
    (n) => n.endsWith('.md') && n !== INDEX_FILE && !n.startsWith('.')
  )
  const hasLinks = splitLines(r.text).some((l) => LINK_LINE.test(l))
  if (!leftMd && !hasLinks && isRealFile(indexPath)) {
    const it = join(trashDir, INDEX_FILE)
    renameNew(indexPath, it)
    result.indexTrashPath = it
  }
  return result
}
