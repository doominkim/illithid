/**
 * Library editing API. All writes stay inside the library root (realpath-checked) and use write.ts atomic writes.
 * Deletion is not permanent: items move to `<library>/.trash/<timestamp>/…` (reversible).
 * Errors are thrown as LibraryError(code). Messages never contain file contents or secrets.
 *
 * Layout (M7d): rules/*.md · skills/<name>/ · agents/<name>.md · mcps/<server>.json · permissions.json · memory/ · illithid.json
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync
} from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import matter from 'gray-matter'
import { activeWorkspaceId, libraryRoot } from './config'
import { secretAccountsInWorkspaces } from './workspace'
import { assertInsideLibrary, LibraryError, libraryRealRoot } from './libpath'
import {
  assertStorableSecret,
  isEnvRefValue,
  isSecretRef,
  parseSecretRef,
  secretRef,
  secretRefsOf,
  SecretError,
  type SecretBackend
} from './secrets'
import { MANIFEST_FILE, readManifest, renameManifestEntry } from './manifest'
import { libraryPaths, MCP_ORDER_FILE, mcpServerNamesInDir, readMcpOrder } from './sources'
import type { Allowlist, McpServer } from './types'
import { appTmpName, atomicWrite } from './write'

export { LibraryError } from './libpath'
export type { LibraryErrorCode } from './libpath'

/** Trash directory name inside the library */
export const TRASH_DIR = '.trash'
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Mode for new library files (rules and skills are not secret) */
const LIB_FILE_MODE = 0o644
/** Mode for server definition files (${VAR} references are the norm, but literals can slip in) */
const MCP_FILE_MODE = 0o600

export interface TrashResult {
  /** Trash path it was moved to (absolute) */
  trashPath: string
}

export interface McpUpsertResult {
  /** Whether it was newly added (false = replaced) */
  created: boolean
  /** Warnings such as secret-looking literals. Key names only */
  warnings: string[]
  /** Written file (absolute) */
  path: string
}

// ---------------------------------------------------------------- Common

function checkName(name: string, kind: 'rule' | 'skill' | 'mcp' | 'memory' | 'agent'): void {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..'))
    throw new LibraryError('invalidName', `invalid ${kind} name format`)
  if (kind === 'rule' && !name.endsWith('.md'))
    throw new LibraryError('invalidName', 'rule name must end with .md')
}

function writeLibFile(home: string, path: string, content: string, mode = LIB_FILE_MODE): string {
  const target = assertInsideLibrary(home, path)
  return atomicWrite(target, content, existsSync(target) ? {} : { mode })
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Move a path inside the library to .trash/<ts>/<path relative to the library> */
function moveToTrash(home: string, path: string): TrashResult {
  const root = libraryRealRoot(home)
  const real = assertInsideLibrary(home, path)
  if (!existsSync(real) && !isLink(real)) throw new LibraryError('notFound', 'target does not exist')
  const rel = relative(root, real)
  if (!rel || rel.startsWith(TRASH_DIR + sep) || rel === TRASH_DIR)
    throw new LibraryError('outsideLibrary', 'trash and root cannot be deleted')
  let trashPath = join(root, TRASH_DIR, stamp(), rel)
  for (let i = 1; existsSync(trashPath); i++)
    trashPath = join(root, TRASH_DIR, `${stamp()}-${i}`, rel)
  mkdirSync(dirname(trashPath), { recursive: true, mode: 0o700 })
  renameSync(real, trashPath) // same library, so same filesystem
  return { trashPath }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// ---------------------------------------------------------------- rules

function rulePath(home: string, name: string): string {
  checkName(name, 'rule')
  return join(libraryPaths(home).rulesDir, name)
}

/** Rule names (sorted by filename) */
export function listRules(home: string): string[] {
  const dir = libraryPaths(home).rulesDir
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .sort()
}

export function readRule(home: string, name: string): string {
  const p = assertInsideLibrary(home, rulePath(home, name))
  if (!existsSync(p)) throw new LibraryError('notFound', 'rule not found')
  return readFileSync(p, 'utf8')
}

/** Replace an existing rule's content (notFound if missing — use createRule to create) */
export function writeRule(home: string, name: string, content: string): string {
  const p = rulePath(home, name)
  if (!existsSync(assertInsideLibrary(home, p))) throw new LibraryError('notFound', 'rule not found')
  return writeLibFile(home, p, content)
}

export function createRule(home: string, name: string, content = ''): string {
  const p = rulePath(home, name)
  if (existsSync(assertInsideLibrary(home, p)))
    throw new LibraryError('exists', 'a rule with the same name exists')
  return writeLibFile(home, p, content)
}

export function deleteRule(home: string, name: string): TrashResult {
  return moveToTrash(home, rulePath(home, name))
}

/**
 * Rename a rule: move the file + manifest rules.<from> → <to>. Appends .md to `to` if missing.
 * Refuses names that collide with the Claude memory index copy (MEMORY.md), case-insensitively (macOS filesystem).
 * Tool-side state is untouched — the next sync copies the new name and marks the old app copy as deleteCandidate.
 */
export function renameRule(home: string, from: string, to: string): { name: string } {
  const next = typeof to === 'string' && to && !to.endsWith('.md') ? `${to}.md` : to
  const src = rulePath(home, from)
  const dst = rulePath(home, next)
  if (next.toLowerCase() === 'memory.md') throw new LibraryError('invalidName', 'MEMORY.md is the memory index name')
  if (from === next) throw new LibraryError('invalidName', 'same name')
  const realSrc = assertInsideLibrary(home, src)
  if (!existsSync(realSrc) || isLink(src) || !lstatSync(realSrc).isFile())
    throw new LibraryError('notFound', 'rule not found')
  const realDst = assertInsideLibrary(home, dst)
  if (existsSync(realDst) || isLink(dst)) throw new LibraryError('exists', 'a rule with the same name exists')
  const mf = readManifest(home)
  if (mf.error) throw new LibraryError('invalidSchema', `${MANIFEST_FILE}: ${mf.error}`)
  renameSync(realSrc, realDst)
  try {
    renameManifestEntry(home, 'rules', from, next)
  } catch (e) {
    try {
      renameSync(realDst, realSrc)
    } catch {
      // A rollback failure yields to the original error
    }
    if (e instanceof LibraryError) throw e
    throw new LibraryError('invalidSchema', `rename failed: ${(e as Error).message.split('\n')[0]}`)
  }
  return { name: next }
}

// ---------------------------------------------------------------- memory

/** Validate a relative path (.md) inside memory/ → absolute path. e.g. MEMORY.md, feedback/x.md */
function memoryPath(home: string, rel: string): string {
  if (
    typeof rel !== 'string' ||
    !rel ||
    isAbsolute(rel) ||
    rel.includes('\0') ||
    !rel.endsWith('.md')
  )
    throw new LibraryError('invalidName', 'invalid memory path')
  const norm = normalize(rel)
  const parts = norm.split(sep)
  if (parts.some((x) => x === '..' || x === '.' || x.startsWith('.') || !x))
    throw new LibraryError('invalidName', 'invalid memory path')
  return join(libraryPaths(home).memoryDir, norm)
}

/** Relative paths of memory/**\/*.md (sorted, hidden excluded) */
export function listMemoryFiles(home: string): string[] {
  const dir = libraryPaths(home).memoryDir
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string, r: string): void => {
    for (const n of readdirSync(d).sort()) {
      if (n.startsWith('.')) continue
      const p = join(d, n)
      const rp = r ? `${r}/${n}` : n
      const st = lstatSync(p)
      if (st.isDirectory()) walk(p, rp)
      else if (st.isFile() && n.endsWith('.md')) out.push(rp)
    }
  }
  walk(dir, '')
  return out
}

export function readMemoryFile(home: string, rel: string): string {
  const p = assertInsideLibrary(home, memoryPath(home, rel))
  if (!existsSync(p)) throw new LibraryError('notFound', 'memory file not found')
  return readFileSync(p, 'utf8')
}

/** Write a memory file (created if missing, including subdirectories) */
export function writeMemoryFile(home: string, rel: string, content: string): string {
  return writeLibFile(home, memoryPath(home, rel), content)
}

export function deleteMemoryFile(home: string, rel: string): TrashResult {
  return moveToTrash(home, memoryPath(home, rel))
}

// ---------------------------------------------------------------- skills

function skillDir(home: string, name: string): string {
  checkName(name, 'skill')
  return join(libraryRoot(home), 'skills', name)
}

/** Validate a relative path inside a skill directory → absolute path */
function skillFilePath(home: string, name: string, rel: string): string {
  const dir = skillDir(home, name)
  if (typeof rel !== 'string' || !rel || isAbsolute(rel) || rel.includes('\0'))
    throw new LibraryError('outsideLibrary', 'invalid skill file path')
  const norm = normalize(rel)
  if (
    norm === '..' ||
    norm.startsWith('..' + sep) ||
    norm === '.' ||
    norm.split(sep).includes('..')
  )
    throw new LibraryError('outsideLibrary', 'path outside the skill directory')
  const abs = join(dir, norm)
  // Also check it is inside the skill directory itself (real path)
  const realDir = assertInsideLibrary(home, dir)
  const realAbs = assertInsideLibrary(home, abs)
  const r = relative(realDir, realAbs)
  if (!r || r.startsWith('..') || isAbsolute(r))
    throw new LibraryError('outsideLibrary', 'path outside the skill directory (symlink)')
  return realAbs
}

/** Files inside a skill (relative paths, sorted). Hidden files and .DS_Store excluded */
export function listSkillFiles(home: string, name: string): string[] {
  const dir = assertInsideLibrary(home, skillDir(home, name))
  if (!existsSync(dir)) throw new LibraryError('notFound', 'skill not found')
  const out: string[] = []
  const walk = (d: string, r: string): void => {
    for (const n of readdirSync(d).sort()) {
      if (n.startsWith('.')) continue
      const p = join(d, n)
      const rp = r ? `${r}/${n}` : n
      const st = lstatSync(p)
      if (st.isDirectory()) walk(p, rp)
      else if (st.isFile()) out.push(rp)
    }
  }
  walk(dir, '')
  return out
}

export function readSkillFile(home: string, name: string, rel: string): string {
  const p = skillFilePath(home, name, rel)
  if (!existsSync(p)) throw new LibraryError('notFound', 'file not found')
  return readFileSync(p, 'utf8')
}

/** Write a file inside a skill (created if missing). notFound if the skill directory is missing */
export function writeSkillFile(home: string, name: string, rel: string, content: string): string {
  const dir = skillDir(home, name)
  if (!existsSync(assertInsideLibrary(home, dir))) throw new LibraryError('notFound', 'skill not found')
  return writeLibFile(home, skillFilePath(home, name, rel), content)
}

/** Safe as a YAML scalar (a JSON string is valid YAML double-quoted) */
function yamlString(v: string): string {
  return JSON.stringify(v)
}

/** New skill: skills/<name>/SKILL.md (frontmatter name·description) */
export function createSkill(home: string, name: string, description: string): string {
  const dir = skillDir(home, name)
  if (existsSync(assertInsideLibrary(home, dir)) || isLink(dir))
    throw new LibraryError('exists', 'a skill with the same name exists')
  if (typeof description !== 'string' || !description.trim())
    throw new LibraryError('invalidSchema', 'description is required')
  const body = `---\nname: ${name}\ndescription: ${yamlString(description.trim())}\n---\n\n# ${name}\n\n`
  return writeLibFile(home, join(dir, 'SKILL.md'), body)
}

export function deleteSkill(home: string, name: string): TrashResult {
  return moveToTrash(home, skillDir(home, name))
}

// ---------------------------------------------------------------- SKILL.md (description · body · name)

/** SKILL.md split into frontmatter fields and body */
export interface SkillDoc {
  /** Library folder name */
  name: string
  /** frontmatter name (null if absent) */
  frontmatterName: string | null
  /** frontmatter description (empty string if absent) */
  description: string
  /** frontmatter keys other than name·description (preserved, not edited) */
  extra: Record<string, unknown>
  /** Body without frontmatter (leading blank lines removed) */
  body: string
}

export interface SkillDocInput {
  description: string
  body: string
}

const noEvalEngine = (): never => {
  throw new Error('js front matter is not supported')
}
const MATTER_OPTS = { engines: { js: noEvalEngine, javascript: noEvalEngine } }

interface SplitDoc {
  bom: string
  eol: string
  /** Whether there is frontmatter */
  has: boolean
  /** Lines between the opening and closing --- (no EOL) */
  fmLines: string[]
  /** Raw closing --- line (no EOL) */
  close: string
  /** Blank lines after the closing line and before the body (with EOL) */
  sep: string
  body: string
}

/** Raw SKILL.md → frontmatter lines and body. Without frontmatter, has=false and everything is body */
function splitDoc(text: string): SplitDoc {
  const bom = text.startsWith('﻿') ? '﻿' : ''
  const t = text.slice(bom.length)
  const eol = /\r\n/.test(t) ? '\r\n' : '\n'
  const none: SplitDoc = { bom, eol, has: false, fmLines: [], close: '---', sep: '', body: t }
  const open = /^---[ \t]*\r?\n/.exec(t)
  if (!open) return none
  const rest = t.slice(open[0].length)
  const lines = rest.split(/\r?\n/)
  const idx = lines.findIndex((l) => /^(---|\.\.\.)[ \t]*$/.test(l))
  if (idx < 0) return none
  // Compute the raw offset after the closing line from line lengths (EOLs checked in the raw text)
  let pos = 0
  for (let i = 0; i < idx; i++) {
    pos += lines[i].length
    pos += rest.startsWith('\r\n', pos) ? 2 : 1
  }
  pos += lines[idx].length
  if (rest.startsWith('\r\n', pos)) pos += 2
  else if (rest.startsWith('\n', pos)) pos += 1
  const after = rest.slice(pos)
  const sep = /^(?:[ \t]*\r?\n)*/.exec(after)![0]
  return {
    bom,
    eol,
    has: true,
    fmLines: lines.slice(0, idx),
    close: lines[idx],
    sep,
    body: after.slice(sep.length)
  }
}

function joinDoc(d: SplitDoc, fmLines: string[] | null, body: string): string {
  if (!fmLines) return d.bom + body
  const sep = d.has ? d.sep : d.eol
  return d.bom + ['---', ...fmLines, d.has ? d.close : '---'].join(d.eol) + d.eol + (body ? sep + body : '')
}

function parseFrontmatter(text: string, label = 'SKILL.md'): Record<string, unknown> {
  let data: unknown
  try {
    // gray-matter caches parse results for identical input and returns a shared object — copy it
    data = structuredClone(matter(text, MATTER_OPTS).data)
  } catch {
    throw new LibraryError('invalidSchema', `${label} frontmatter cannot be read`)
  }
  if (!isObj(data)) throw new LibraryError('invalidSchema', `${label} frontmatter is not an object`)
  return data
}

/** YAML string value (after key:). Single line: plain if possible, else double-quoted. Multi-line: block literal */
export function yamlValueLines(value: string): string[] {
  if (!value.includes('\n')) {
    const plain =
      /^[A-Za-z0-9\uAC00-\uD7A3][^\n]*$/.test(value) &&
      !/[:#]\s|\s#|:$|^\s|\s$|[\t"'{}[\],&*!|>%@`]/.test(value) &&
      !/^(true|false|null|yes|no|on|off|~|[-+]?[0-9][0-9_.eE+-]*)$/i.test(value)
    return [plain ? value : yamlString(value)]
  }
  // Control characters, trailing spaces, etc. don't round-trip well as block literals → double quotes
  const ctrl = [...value].some((c) => {
    const n = c.charCodeAt(0)
    return (n < 0x20 && n !== 0x0a && n !== 0x09) || n === 0x7f
  })
  if (ctrl) return [yamlString(value)]
  const trailing = /\n*$/.exec(value)![0].length
  const chomp = trailing === 0 ? '-' : trailing === 1 ? '' : '+'
  const content = trailing ? value.slice(0, value.length - trailing) : value
  const lines = content.split('\n')
  const indicator = /^[ \t]/.test(lines[0]) ? '2' : ''
  const out = [`|${indicator}${chomp}`]
  for (const l of lines) out.push(l ? `  ${l}` : '')
  for (let i = 1; i < trailing; i++) out.push('')
  return out
}

/** Line range [start, end] of a top-level key entry, or null. Includes following indented lines */
function keyRange(lines: string[], key: string): [number, number] | null {
  const re = new RegExp(`^(${key}|"${key}"|'${key}')[ \\t]*:(\\s|$)`)
  const start = lines.findIndex((l) => re.test(l))
  if (start < 0) return null
  let end = start
  for (let j = start + 1; j < lines.length; j++) {
    const l = lines[j]
    if (!l.trim()) continue
    if (/^[ \t]/.test(l)) end = j
    else break
  }
  return [start, end]
}

/** Replace key's value in frontmatter lines if present, else insert it (after afterKey, or at the end/start) */
function setKey(lines: string[], key: string, value: string, insertFirst = false): string[] {
  const entry = yamlValueLines(value)
  const block = entry.length === 1 ? [`${key}: ${entry[0]}`] : [`${key}: ${entry[0]}`, ...entry.slice(1)]
  const r = keyRange(lines, key)
  if (r) return [...lines.slice(0, r[0]), ...block, ...lines.slice(r[1] + 1)]
  if (insertFirst) return [...block, ...lines]
  const nameAt = keyRange(lines, 'name')
  if (nameAt) return [...lines.slice(0, nameAt[1] + 1), ...block, ...lines.slice(nameAt[1] + 1)]
  return [...lines, ...block]
}

/**
 * New raw SKILL.md with only some frontmatter keys changed. Other keys, order, and comments stay line by line.
 * If the line-level result doesn't parse as expected, rewrite the whole frontmatter (values preserved, formatting changes).
 */
interface DocPatch {
  name?: string
  description?: string
  /** Top-level mapping keys (claude·codex·opencode). null or empty object removes the key */
  blocks?: Record<string, Record<string, string> | null>
}

/** Replace or insert (at the end) a mapping key block in frontmatter lines. Empty entries remove it */
function setBlock(lines: string[], key: string, entries: Record<string, string> | null): string[] {
  const r = keyRange(lines, key)
  const kv = Object.entries(entries ?? {})
  const block = kv.length
    ? [`${key}:`, ...kv.flatMap(([k, v]) => yamlValueLines(v).map((l, i) => (i === 0 ? `  ${k}: ${l}` : `  ${l}`)))]
    : []
  if (r) return [...lines.slice(0, r[0]), ...block, ...lines.slice(r[1] + 1)]
  return [...lines, ...block]
}

function patchSkillText(text: string, patch: DocPatch, body?: string, label = 'SKILL.md'): string {
  const d = splitDoc(text)
  const before = d.has ? parseFrontmatter(text, label) : {}
  const want: Record<string, unknown> = { ...before }
  if (patch.name !== undefined) want.name = patch.name
  if (patch.description !== undefined) want.description = patch.description
  for (const [k, v] of Object.entries(patch.blocks ?? {})) {
    if (v && Object.keys(v).length) want[k] = { ...v }
    else delete want[k]
  }
  const nextBody = body ?? d.body
  const blocksChange = Object.keys(patch.blocks ?? {}).some((k) => !isDeepStrictEqual(before[k], want[k]))
  if (!d.has && patch.name === undefined && !patch.description && !blocksChange) return joinDoc(d, null, nextBody)
  let lines = d.fmLines
  if (patch.name !== undefined && before.name !== patch.name)
    lines = setKey(lines, 'name', patch.name, true)
  if (patch.description !== undefined && before.description !== patch.description)
    lines = setKey(lines, 'description', patch.description)
  for (const [k, v] of Object.entries(patch.blocks ?? {}))
    if (!isDeepStrictEqual(before[k], want[k])) lines = setBlock(lines, k, v)
  let out = joinDoc(d, lines, nextBody)
  const check = (s: string): boolean => {
    try {
      return isDeepStrictEqual(parseFrontmatter(s, label), want) && splitDoc(s).body === nextBody
    } catch {
      return false
    }
  }
  if (check(out)) return out
  // Fallback: full rewrite preserving values (gray-matter/js-yaml safeDump)
  const dumped = splitDoc(matter.stringify('', want))
  out = joinDoc({ ...d, has: false }, dumped.fmLines, nextBody)
  if (check(out)) return out
  throw new LibraryError('invalidSchema', `${label} frontmatter could not be updated safely`)
}

/** SKILL.md → name·description·other frontmatter keys·body */
export function readSkillDoc(home: string, name: string): SkillDoc {
  const text = readSkillFile(home, name, 'SKILL.md')
  const d = splitDoc(text)
  const data = d.has ? parseFrontmatter(text) : {}
  const { name: fmName, description, ...extra } = data
  return {
    name,
    frontmatterName: typeof fmName === 'string' ? fmName : null,
    description: typeof description === 'string' ? description : '',
    extra,
    body: d.body
  }
}

/** Save description and body. Other frontmatter keys and order are preserved. description cannot be empty */
export function writeSkillDoc(home: string, name: string, input: SkillDocInput): string {
  if (!isObj(input) || typeof input.description !== 'string' || typeof input.body !== 'string')
    throw new LibraryError('invalidSchema', 'description and body must be strings')
  if (!input.description.trim()) throw new LibraryError('invalidSchema', 'description is required')
  const text = readSkillFile(home, name, 'SKILL.md')
  const next = patchSkillText(text, { description: input.description }, input.body)
  if (next === text) return skillFilePath(home, name, 'SKILL.md')
  return writeSkillFile(home, name, 'SKILL.md', next)
}

/**
 * Rename a skill: move the library folder + SKILL.md frontmatter name + manifest skills.<from> → <to>.
 * Tool-side state (app copy records) is untouched — the next sync copies the new name, and the old
 * app copy becomes a deleteCandidate gone from the source. Mentions of the name in the body are not changed.
 */
export function renameSkill(home: string, from: string, to: string): { name: string } {
  const src = skillDir(home, from)
  const dst = skillDir(home, to)
  if (from === to) throw new LibraryError('invalidName', 'same name')
  const realSrc = assertInsideLibrary(home, src)
  if (!existsSync(realSrc) || isLink(src) || !lstatSync(realSrc).isDirectory())
    throw new LibraryError('notFound', 'skill not found')
  const realDst = assertInsideLibrary(home, dst)
  if (existsSync(realDst) || isLink(dst)) throw new LibraryError('exists', 'a skill with the same name exists')
  const mf = readManifest(home)
  if (mf.error) throw new LibraryError('invalidSchema', `${MANIFEST_FILE}: ${mf.error}`)
  // Build the new SKILL.md first (on failure nothing changes)
  const skillMd = join(realSrc, 'SKILL.md')
  const oldText = existsSync(skillMd) ? readFileSync(skillMd, 'utf8') : null
  const newText = oldText === null ? null : patchSkillText(oldText, { name: to })
  renameSync(realSrc, realDst)
  try {
    if (newText !== null && newText !== oldText) writeLibFile(home, join(dst, 'SKILL.md'), newText)
    renameManifestEntry(home, 'skills', from, to)
  } catch (e) {
    try {
      if (oldText !== null) writeLibFile(home, join(dst, 'SKILL.md'), oldText)
      renameSync(realDst, realSrc)
    } catch {
      // A rollback failure yields to the original error
    }
    if (e instanceof LibraryError) throw e
    throw new LibraryError('invalidSchema', `rename failed: ${(e as Error).message.split('\n')[0]}`)
  }
  return { name: to }
}

// ---------------------------------------------------------------- agents

/** Agent tool keys (top-level frontmatter mappings) */
export const AGENT_TOOLS = ['claude', 'codex', 'opencode'] as const
export type AgentTool = (typeof AGENT_TOOLS)[number]

/** Model·effort for one tool. Absent = that tool's default */
export interface AgentToolSettings {
  model?: string
  effort?: string
}

/** agents/<name>.md split into fields and body */
export interface AgentDoc {
  /** Library file name (without extension) */
  name: string
  description: string
  tools: Partial<Record<AgentTool, AgentToolSettings>>
  /** Body without frontmatter (instructions) */
  body: string
}

export interface AgentDocInput {
  description: string
  body: string
  tools: Partial<Record<AgentTool, AgentToolSettings>>
}

/** Model·effort value: one line of 1–200 chars, no control characters */
function validAgentValue(v: string): boolean {
  return (
    v.length > 0 &&
    v.length <= 200 &&
    ![...v].some((c) => {
      const n = c.charCodeAt(0)
      return n < 0x20 || n === 0x7f
    })
  )
}

function agentPath(home: string, name: string): string {
  checkName(name, 'agent')
  return join(libraryPaths(home).agentsDir, `${name}.md`)
}

/** Normalize tool settings (drop empty values, validate format). invalidSchema on error */
function normalizeAgentTools(v: unknown): Record<AgentTool, Record<string, string> | null> {
  if (v !== undefined && !isObj(v)) throw new LibraryError('invalidSchema', 'tools must be an object')
  const src = (v ?? {}) as Record<string, unknown>
  for (const k of Object.keys(src))
    if (!(AGENT_TOOLS as readonly string[]).includes(k))
      throw new LibraryError('invalidSchema', `unsupported tool: ${k}`)
  const out = {} as Record<AgentTool, Record<string, string> | null>
  for (const tool of AGENT_TOOLS) {
    const t = src[tool]
    if (t !== undefined && t !== null && !isObj(t)) throw new LibraryError('invalidSchema', `${tool} must be an object`)
    const e: Record<string, string> = {}
    for (const key of ['model', 'effort'] as const) {
      const raw = (t as Record<string, unknown> | undefined)?.[key]
      if (raw === undefined || raw === null || raw === '') continue
      if (typeof raw !== 'string' || !validAgentValue(raw.trim()))
        throw new LibraryError('invalidSchema', `invalid ${tool}.${key} format`)
      e[key] = raw.trim()
    }
    out[tool] = Object.keys(e).length ? e : null
  }
  return out
}

/** Raw text → AgentDoc. invalidSchema if the frontmatter can't be read */
export function parseAgentText(name: string, text: string): AgentDoc {
  const d = splitDoc(text)
  const data = d.has ? parseFrontmatter(text, `${name}.md`) : {}
  const tools: AgentDoc['tools'] = {}
  for (const tool of AGENT_TOOLS) {
    const t = data[tool]
    if (!isObj(t)) continue
    const e: AgentToolSettings = {}
    if (typeof t.model === 'string' && t.model.trim()) e.model = t.model.trim()
    if (typeof t.effort === 'string' && t.effort.trim()) e.effort = t.effort.trim()
    if (e.model || e.effort) tools[tool] = e
  }
  return {
    name,
    description: typeof data.description === 'string' ? data.description : '',
    tools,
    body: d.body
  }
}

/** Agent names (agents/*.md matching naming rules, sorted). [] if the folder is missing */
export function listAgents(home: string): string[] {
  const dir = libraryPaths(home).agentsDir
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .map((f) => f.slice(0, -3))
    .filter((n) => NAME_RE.test(n) && !n.includes('..'))
    .sort()
}

export function readAgentText(home: string, name: string): string {
  const p = assertInsideLibrary(home, agentPath(home, name))
  if (!existsSync(p) || isLink(p)) throw new LibraryError('notFound', 'agent not found')
  return readFileSync(p, 'utf8')
}

export function readAgentDoc(home: string, name: string): AgentDoc {
  return parseAgentText(name, readAgentText(home, name))
}

/** Save description, body, and per-tool model/effort. Other frontmatter keys and order are preserved */
export function writeAgentDoc(home: string, name: string, input: AgentDocInput): string {
  if (!isObj(input) || typeof input.description !== 'string' || typeof input.body !== 'string')
    throw new LibraryError('invalidSchema', 'description and body must be strings')
  if (!input.description.trim()) throw new LibraryError('invalidSchema', 'description is required')
  const blocks = normalizeAgentTools(input.tools)
  const text = readAgentText(home, name)
  const next = patchSkillText(text, { description: input.description, blocks }, input.body, `${name}.md`)
  const p = agentPath(home, name)
  if (next === text) return p
  return writeLibFile(home, p, next)
}

/** New agent: agents/<name>.md (frontmatter name·description, blank body). Creates agents/ if missing */
export function createAgent(home: string, name: string, description: string): string {
  const p = agentPath(home, name)
  if (existsSync(assertInsideLibrary(home, p)) || isLink(p))
    throw new LibraryError('exists', 'an agent with the same name exists')
  if (typeof description !== 'string' || !description.trim())
    throw new LibraryError('invalidSchema', 'description is required')
  const fm = [`name: ${name}`, ...setKey([], 'description', description.trim())]
  return writeLibFile(home, p, `---\n${fm.join('\n')}\n---\n\n`)
}

/**
 * Library-format raw text (for import and normalized comparison). frontmatter name·description·tool blocks + body.
 * Identical fields always yield identical bytes.
 */
export function agentLibraryText(name: string, input: AgentDocInput): string {
  checkName(name, 'agent')
  const blocks = normalizeAgentTools(input.tools)
  let lines = setKey([], 'name', name, true)
  lines = setKey(lines, 'description', input.description)
  for (const tool of AGENT_TOOLS) lines = setBlock(lines, tool, blocks[tool])
  const body = input.body.replace(/^(?:[ \t]*\r?\n)+/, '')
  return `---\n${lines.join('\n')}\n---\n${body ? `\n${body}` : '\n'}`
}

/** Normalized raw text of a library agent (null if read or validation fails) */
export function agentNormalizedText(home: string, name: string): string | null {
  try {
    return agentLibraryText(name, readAgentDoc(home, name))
  } catch {
    return null
  }
}

/** Import: write a new agents/<name>.md verbatim (exists if present). Creates agents/ if missing */
export function writeNewAgentText(home: string, name: string, text: string): string {
  const p = agentPath(home, name)
  if (existsSync(assertInsideLibrary(home, p)) || isLink(p))
    throw new LibraryError('exists', 'an agent with the same name exists')
  parseAgentText(name, text) // validate frontmatter
  return writeLibFile(home, p, text)
}

export function deleteAgent(home: string, name: string): TrashResult {
  return moveToTrash(home, agentPath(home, name))
}

/**
 * Rename an agent: move the file + frontmatter name + manifest agents.<from> → <to>.
 * Tool-side state is untouched — the next sync copies the new name and marks the old app copy as deleteCandidate.
 */
export function renameAgent(home: string, from: string, to: string): { name: string } {
  const src = agentPath(home, from)
  const dst = agentPath(home, to)
  if (from === to) throw new LibraryError('invalidName', 'same name')
  const realSrc = assertInsideLibrary(home, src)
  if (!existsSync(realSrc) || isLink(src) || !lstatSync(realSrc).isFile())
    throw new LibraryError('notFound', 'agent not found')
  const realDst = assertInsideLibrary(home, dst)
  if (existsSync(realDst) || isLink(dst)) throw new LibraryError('exists', 'an agent with the same name exists')
  const mf = readManifest(home)
  if (mf.error) throw new LibraryError('invalidSchema', `${MANIFEST_FILE}: ${mf.error}`)
  const oldText = readFileSync(realSrc, 'utf8')
  const newText = patchSkillText(oldText, { name: to }, undefined, `${from}.md`)
  renameSync(realSrc, realDst)
  try {
    if (newText !== oldText) writeLibFile(home, dst, newText)
    renameManifestEntry(home, 'agents', from, to)
  } catch (e) {
    try {
      writeLibFile(home, dst, oldText)
      renameSync(realDst, realSrc)
    } catch {
      // A rollback failure yields to the original error
    }
    if (e instanceof LibraryError) throw e
    throw new LibraryError('invalidSchema', `rename failed: ${(e as Error).message.split('\n')[0]}`)
  }
  return { name: to }
}

// ---------------------------------------------------------------- Secret heuristics

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const PLACEHOLDER_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g
/** Known token prefixes */
const TOKEN_PREFIX =
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}|\b(ghp|gho|ghu|ghs|github_pat|xox[abpr]|glpat|AKIA)[-_A-Za-z0-9]{6,}/
/** Opaque token candidates (/ and . excluded to tell apart from paths and package names) */
const OPAQUE_RUN = /[A-Za-z0-9_\-+=]{20,}/g

function opaque(run: string): boolean {
  const digit = /[0-9]/.test(run)
  const lower = /[a-z]/.test(run)
  const upper = /[A-Z]/.test(run)
  // Mixed-case alphanumerics of 20+, or 32+ with digits (hex, etc.). Lowercase-dash package names excluded
  return (digit && lower && upper) || (digit && (lower || upper) && run.length >= 32)
}

/**
 * Whether the value minus ${VAR} looks like a secret literal (20+ mixed alphanumerics, known token prefix).
 * Heuristic — use for warnings only.
 */
export function looksLikeSecret(value: string): boolean {
  const rest = value.replace(PLACEHOLDER_RE, '')
  if (TOKEN_PREFIX.test(rest)) return true
  return (rest.match(OPAQUE_RUN) ?? []).some(opaque)
}

/** Key names that hold secrets (KEY, TOKEN, SECRET, PASSWORD, AUTH, CREDENTIAL …) */
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASS(WORD|WD)?|AUTH|CREDENTIAL|PRIVATE|API_?KEY|BEARER)/i
/** Path or URL shape */
const PATH_LIKE = /^(~|\.{1,2})?\/[^\s]*$|^[A-Za-z]:[\\/]/
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Default verdict on whether (key, value) is a secret (looksSecret for import substitution candidates).
 * Path/URL shape → false. Secret-like key name → true. 20+ high-entropy value → true. Otherwise → false.
 */
export function isSecretPair(key: string, value: string): boolean {
  if (PATH_LIKE.test(value) || URL_LIKE.test(value)) return false
  if (SECRET_KEY_RE.test(key)) return true
  return looksLikeSecret(value)
}

function isStrRecord(v: unknown): v is Record<string, string> {
  return isObj(v) && Object.values(v).every((x) => typeof x === 'string')
}

/**
 * Validate a server definition. If there are errors, don't save. Warnings are saved but reported.
 * Messages carry key names only (no values). `_` keys (meta) are not validated.
 */
export function validateMcpServer(def: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const d = def as Record<string, unknown> | null
  if (!d || typeof d !== 'object' || Array.isArray(d))
    return { errors: ['definition is not an object'], warnings }
  if (d.transport !== 'stdio' && d.transport !== 'http') errors.push('transport must be stdio | http')
  if (d.transport === 'stdio') {
    if (typeof d.command !== 'string' || !d.command.trim()) errors.push('stdio requires command')
    if (d.url !== undefined) errors.push('stdio does not use url')
    if (d.headers !== undefined) errors.push('stdio does not use headers')
  }
  if (d.transport === 'http') {
    if (typeof d.url !== 'string' || !d.url.trim()) errors.push('http requires url')
    else {
      try {
        const u = new URL(d.url.replace(PLACEHOLDER_RE, 'x'))
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
          errors.push('url must be http(s)')
        if (u.username || u.password)
          warnings.push('url contains user info — replacing with ${VAR} recommended')
        for (const [k, v] of u.searchParams) {
          if (looksLikeSecret(v))
            warnings.push(`url query ${k} looks like a secret — \${VAR} reference recommended`)
        }
      } catch {
        errors.push('invalid url format')
      }
    }
    if (d.command !== undefined) errors.push('http does not use command')
    if (d.env !== undefined) errors.push('http does not use env')
  }
  if (d.args !== undefined) {
    if (!Array.isArray(d.args) || !d.args.every((a) => typeof a === 'string'))
      errors.push('args must be a string array')
    else
      d.args.forEach((a, i) => {
        if (looksLikeSecret(a as string))
          warnings.push(`args[${i}] looks like a secret — args do not expand env vars`)
      })
  }
  for (const key of ['env', 'headers'] as const) {
    if (d[key] === undefined) continue
    if (!isStrRecord(d[key])) {
      errors.push(`${key} must be an object of string values`)
      continue
    }
    for (const [k, v] of Object.entries(d[key] as Record<string, string>)) {
      if (!k) errors.push(`empty key in ${key}`)
      if (isSecretRef(v)) {
        const r = parseSecretRef(v)
        if (!r || r.table !== key || r.key !== k)
          errors.push(`${key}.${k} has an invalid secret reference format`)
      } else if (looksLikeSecret(v))
        warnings.push(`${key}.${k} looks like a secret literal — replacing with a \${VAR} reference recommended`)
    }
  }
  if (d.timeoutMs !== undefined && (typeof d.timeoutMs !== 'number' || d.timeoutMs <= 0))
    errors.push('timeoutMs must be positive')
  if (
    d.bearerEnv !== undefined &&
    (typeof d.bearerEnv !== 'string' || !ENV_NAME_RE.test(d.bearerEnv))
  )
    errors.push('bearerEnv must be an env var name')
  if (d.bearerEnv !== undefined && d.transport !== 'http') errors.push('bearerEnv is http-only')
  if (d.bearerToken !== undefined) {
    const r = typeof d.bearerToken === 'string' ? parseSecretRef(d.bearerToken) : null
    if (!r || r.table !== 'headers' || r.key !== 'Authorization')
      errors.push('bearerToken must be a secret:<server>/headers/Authorization reference')
    if (d.transport !== 'http') errors.push('bearerToken is http-only')
    if (d.bearerEnv !== undefined) errors.push('bearerToken and bearerEnv cannot be used together')
    if (isObj(d.headers) && Object.keys(d.headers).some((h) => h.toLowerCase() === 'authorization'))
      errors.push('bearerToken and headers.Authorization cannot be used together')
  }
  if (d.codex !== undefined && !isObj(d.codex)) errors.push('codex must be an object')
  if (d._ !== undefined && typeof d._ !== 'string' && !isObj(d._))
    errors.push('_ (meta) must be a string or object')
  return { errors, warnings }
}

// ---------------------------------------------------------------- mcp (mcps/<name>.json)

function mcpPath(home: string, name: string): string {
  checkName(name, 'mcp')
  return join(libraryPaths(home).mcpsDir, `${name}.json`)
}

/** Server list (`_` and hidden files excluded). Order: _order.json, then the rest by name */
export function listMcpServers(home: string): string[] {
  return mcpServerNamesInDir(libraryPaths(home).mcpsDir)
}

/** Save server order (mcps/_order.json). Validates name format only, not existence */
export function writeMcpOrder(home: string, names: string[]): string {
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || !NAME_RE.test(n)))
    throw new LibraryError('invalidName', 'invalid server name format')
  const p = join(libraryPaths(home).mcpsDir, MCP_ORDER_FILE)
  return writeLibFile(home, p, JSON.stringify([...new Set(names)], null, 2) + '\n')
}

/** Current order file content ([] if absent) */
export function readMcpOrderList(home: string): string[] {
  return readMcpOrder(libraryPaths(home).mcpsDir)
}

function orderFileExists(home: string): boolean {
  return existsSync(join(libraryPaths(home).mcpsDir, MCP_ORDER_FILE))
}

/** Server definition file content (including `_` meta). notFound if missing, invalidSchema if broken */
export function readMcpServer(home: string, name: string): McpServer {
  const p = assertInsideLibrary(home, mcpPath(home, name))
  if (!existsSync(p)) throw new LibraryError('notFound', 'server not found')
  let obj: unknown
  try {
    obj = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    throw new LibraryError('invalidSchema', `mcps/${name}.json parse failed`)
  }
  if (!isObj(obj))
    throw new LibraryError('invalidSchema', `mcps/${name}.json top level is not an object`)
  return obj as McpServer
}

export interface McpWriteOptions {
  /**
   * Secret backend. If given, plaintext in headers·env·bearerToken (non-empty, not a ${VAR} or secret: reference) is
   * stored in the backend and only `secret:` references go to the library. Entries of this server no longer used after replace/delete are removed.
   * If omitted, plaintext is stored as is and reported in warnings (previous behavior).
   */
  secrets?: SecretBackend
}

interface PendingSecret {
  account: string
  value: string
}

/** Definition with plaintext replaced by secret: references, plus the values to store (backend not touched yet) */
function externalizeSecrets(
  name: string,
  def: Record<string, unknown>
): { next: Record<string, unknown>; pending: PendingSecret[] } {
  const next = structuredClone(def)
  const pending: PendingSecret[] = []
  const stash = (table: 'headers' | 'env', key: string, value: string): string => {
    const ref = secretRef(name, table, key)
    pending.push({ account: ref.slice('secret:'.length), value })
    return ref
  }
  for (const table of ['headers', 'env'] as const) {
    const t = next[table]
    if (!isStrRecord(t)) continue
    for (const [k, v] of Object.entries(t)) {
      if (!v || isSecretRef(v) || (isEnvRefValue(v) && !looksLikeSecret(v))) continue
      t[k] = stash(table, k, v)
    }
  }
  const bt = next.bearerToken
  if (typeof bt === 'string') {
    const trimmed = bt.trim()
    const env = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed)
    if (!trimmed) delete next.bearerToken
    else if (env) {
      delete next.bearerToken
      next.bearerEnv = env[1]
    } else if (!isSecretRef(trimmed)) {
      next.bearerToken = stash('headers', 'Authorization', trimmed.replace(/^Bearer\s+/i, ''))
    }
  }
  return { next, pending }
}

/** secret: references to other server names are rejected (cleanup scope is per server) */
function checkRefOwner(name: string, def: unknown): void {
  if (secretRefsOf(def).some((r) => r.server !== name))
    throw new LibraryError('invalidSchema', "cannot reference another server's secret")
}

function readMcpServerSafe(home: string, name: string): Record<string, unknown> | undefined {
  try {
    return readMcpServer(home, name) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function secretFail(e: unknown): never {
  if (e instanceof SecretError) throw new LibraryError('invalidSchema', e.message)
  throw e
}

/**
 * Add or replace a server (atomic write of mcps/<name>.json). If the new definition lacks `_` meta, the existing file's `_` is kept.
 * Validation errors throw LibraryError('invalidSchema'); suspected secret literals are returned as warnings.
 * With opts.secrets, plaintext moves to the backend and only references go to the library.
 */
export function upsertMcpServer(
  home: string,
  name: string,
  def: McpServer,
  opts: McpWriteOptions = {}
): McpUpsertResult {
  const p = mcpPath(home, name)
  let candidate = def as Record<string, unknown>
  let pending: PendingSecret[] = []
  if (opts.secrets && isObj(def)) {
    try {
      ;({ next: candidate, pending } = externalizeSecrets(name, def as Record<string, unknown>))
      for (const x of pending) assertStorableSecret(x.value)
    } catch (e) {
      secretFail(e)
    }
  }
  const { errors, warnings } = validateMcpServer(candidate)
  if (errors.length) throw new LibraryError('invalidSchema', errors.join('; '))
  checkRefOwner(name, candidate)
  const target = assertInsideLibrary(home, p)
  const created = !existsSync(target)
  const prev = created ? undefined : readMcpServerSafe(home, name)
  let next: Record<string, unknown> = { ...candidate }
  if (!created && next._ === undefined && prev && prev._ !== undefined)
    next = { ...next, _: prev._ }
  if (opts.secrets) {
    try {
      for (const x of pending) opts.secrets.set(x.account, x.value)
    } catch (e) {
      secretFail(e)
    }
  }
  const path = writeLibFile(home, p, JSON.stringify(next, null, 2) + '\n', MCP_FILE_MODE)
  // Clean up secrets this server no longer uses
  if (opts.secrets && prev) {
    const keep = new Set(secretRefsOf(next).map((r) => r.account))
    for (const r of secretRefsOf(prev))
      if (r.server === name && !keep.has(r.account)) {
        try {
          opts.secrets.delete(r.account)
        } catch {
          warnings.push(`secret cleanup failed: ${r.account}`)
        }
      }
  }
  // If an order file exists, append the new server at the end (otherwise name order applies, leave it)
  if (created && orderFileExists(home)) {
    const order = readMcpOrderList(home)
    if (!order.includes(name)) writeMcpOrder(home, [...order, name])
  }
  return { created, warnings, path }
}

/**
 * Delete a server — moves the file to .trash/<ts>/mcps/<name>.json (for undo) and removes it from the order file.
 * With opts.secrets, this server's secret entries are deleted too (restoring from trash won't bring the values back).
 */
export function deleteMcpServer(
  home: string,
  name: string,
  opts: McpWriteOptions = {}
): TrashResult & { secretsDeleted?: number } {
  const prev = readMcpServerSafe(home, name)
  const r = moveToTrash(home, mcpPath(home, name))
  if (orderFileExists(home)) {
    const order = readMcpOrderList(home)
    if (order.includes(name))
      writeMcpOrder(
        home,
        order.filter((n) => n !== name)
      )
  }
  if (!opts.secrets) return r
  let secretsDeleted = 0
  // The keychain is shared across workspaces — keep entries another workspace references
  const shared = secretAccountsInWorkspaces(home, activeWorkspaceId(home))
  for (const ref of secretRefsOf(prev)) {
    if (ref.server !== name || shared.has(ref.account)) continue
    try {
      if (opts.secrets.delete(ref.account)) secretsDeleted++
    } catch {
      // The file is already in the trash — leftover entries get overwritten on the next save
    }
  }
  return { ...r, secretsDeleted }
}

// ---------------------------------------------------------------- permissions (permissions.json)

/** Validate allowlist format. List of error messages (no values) */
export function validatePermissions(v: unknown): string[] {
  const errs: string[] = []
  if (!isObj(v)) return ['top level is not an object']
  if (!Array.isArray(v.bash)) errs.push('bash must be an array')
  else
    v.bash.forEach((e, i) => {
      const argv = Array.isArray(e) ? e : isObj(e) ? e.argv : undefined
      if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string' && a))
        errs.push(`bash[${i}] must be a non-empty string argv array or {argv, claudeExact}`)
      if (isObj(e) && e.claudeExact !== undefined && typeof e.claudeExact !== 'boolean')
        errs.push(`bash[${i}].claudeExact must be a boolean`)
    })
  if (!isObj(v.claudeOnly)) errs.push('claudeOnly must be an object')
  else {
    for (const k of ['allow', 'deny'] as const) {
      const list = v.claudeOnly[k]
      if (!Array.isArray(list) || !list.every((x) => typeof x === 'string'))
        errs.push(`claudeOnly.${k} must be a string array`)
    }
    const ask = v.claudeOnly.ask
    if (ask !== undefined && (!Array.isArray(ask) || !ask.every((x) => typeof x === 'string')))
      errs.push('claudeOnly.ask must be a string array')
  }
  return errs
}

/** permissions.json. null if absent, invalidSchema if broken */
export function readPermissions(home: string): Allowlist | null {
  const p = assertInsideLibrary(home, libraryPaths(home).permissions)
  if (!existsSync(p)) return null
  let obj: unknown
  try {
    obj = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    throw new LibraryError('invalidSchema', 'permissions.json parse failed')
  }
  const errs = validatePermissions(obj)
  if (errs.length) throw new LibraryError('invalidSchema', errs.join('; '))
  return obj as Allowlist
}

/** Atomic write of permissions.json (created if missing). invalidSchema on bad format */
export function writePermissions(home: string, allowlist: Allowlist): string {
  const errs = validatePermissions(allowlist)
  if (errs.length) throw new LibraryError('invalidSchema', errs.join('; '))
  return writeLibFile(
    home,
    libraryPaths(home).permissions,
    JSON.stringify(allowlist, null, 2) + '\n'
  )
}

// ---------------------------------------------------------------- Internal (for importer)

/** Move an absolute path inside the library to the trash (for importer overwrite) */
export function trashLibraryPath(home: string, absPath: string): TrashResult {
  return moveToTrash(home, absPath)
}

/** Copy a directory to library skills/<name> (tmp → rename). exists if already present */
export function copySkillIntoLibrary(home: string, name: string, from: string): string {
  const dir = skillDir(home, name)
  const target = assertInsideLibrary(home, dir)
  if (existsSync(target) || isLink(target))
    throw new LibraryError('exists', 'a skill with the same name exists')
  const tmp = assertInsideLibrary(home, join(dirname(dir), appTmpName(name, String(Date.now()))))
  mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
  try {
    cpSync(from, tmp, { recursive: true, dereference: true, errorOnExist: true, force: false })
    renameSync(tmp, target)
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
  }
  return target
}
