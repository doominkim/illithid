/**
 * Library scripts, shared by hooks (the script action's `use` option). Two kinds:
 * - file:   `scripts/<name>.sh`. Its description is the first `# description: …` comment line. Every hook that uses it gets a
 *           copy of it in each tool, like its own run.sh
 * - folder: `scripts/<name>/` with SCRIPT.md (frontmatter description and entry, the file the hooks run) and any other files the
 *           entry calls by relative path. The tools get the whole folder once
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'
import matter from 'gray-matter'
import { LIBRARY_SCRIPT_RE } from './scriptNames'
import { libraryPaths } from './sources'

export { LIBRARY_SCRIPT_RE, SCRIPT_TEMPLATE } from './scriptNames'

export const SCRIPTS_DIR = 'scripts'
export const SCRIPT_DOC = 'SCRIPT.md'
export const SCRIPT_ENTRY = 'run.sh'
/** What a folder script may hold for the tools to get a copy */
export const SCRIPT_FOLDER_LIMITS = { files: 200, bytes: 5 * 1024 * 1024 } as const
/** Folders that belong to a project, not to a script the tools copy */
const IGNORED = new Set(['.git', 'node_modules', '.venv', '__pycache__'])

/** Why the tools don't get a folder script */
export type ScriptProblem = 'ignoredFolder' | 'symlink' | 'tooLarge' | 'noEntry' | 'badDoc'

export interface LibraryScript {
  name: string
  kind: 'file' | 'folder'
  description: string
  /** The file the hooks run (its content for a folder script) */
  content: string
  /** folder: the file the hooks run, relative to the folder */
  entry?: string
  /** folder: every file, relative and sorted */
  files?: string[]
  /** folder: set when the tools don't get it */
  problem?: ScriptProblem
}

export interface ScriptDoc {
  description: string
  entry: string
  body: string
}

export function scriptsDir(home: string): string {
  return join(libraryPaths(home).root, SCRIPTS_DIR)
}

export function scriptPath(home: string, name: string): string {
  return join(scriptsDir(home), `${name}.sh`)
}

export function scriptDirPath(home: string, name: string): string {
  return join(scriptsDir(home), name)
}

/** The first `# description: …` line (empty when there is none) */
export function scriptDescription(content: string): string {
  const m = /^#\s*description:[ \t]*(.*)$/im.exec(content)
  return m ? m[1].trim() : ''
}

// gray-matter must never evaluate code in frontmatter
const noEval = (): never => {
  throw new Error('code frontmatter is not supported')
}
const MATTER_OPTS = { engines: { js: noEval, javascript: noEval } }

/** SCRIPT.md → description, entry (run.sh when left out) and notes. null when the frontmatter can't be read */
export function parseScriptDoc(text: string): ScriptDoc | null {
  try {
    const m = matter(text, MATTER_OPTS)
    const d = (m.data ?? {}) as Record<string, unknown>
    return {
      description: typeof d.description === 'string' ? d.description : '',
      entry: typeof d.entry === 'string' && d.entry ? d.entry : SCRIPT_ENTRY,
      body: m.content.replace(/^\s*\n/, '')
    }
  } catch {
    return null
  }
}

export function renderScriptDoc(doc: ScriptDoc): string {
  const head = `---\ndescription: ${JSON.stringify(doc.description)}\nentry: ${JSON.stringify(doc.entry)}\n---\n`
  const body = doc.body.trim()
  return head + (body ? `\n${body}\n` : '')
}

/** A relative path that stays inside the folder (no `..`, not absolute, not SCRIPT.md), with / separators */
export function scriptRelPath(rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel || isAbsolute(rel) || rel.includes('\0')) return null
  const norm = normalize(rel)
  if (norm === '.' || norm.split(sep).includes('..')) return null
  return norm.split(sep).join('/')
}

/** Files of a folder (relative, sorted) and what keeps the tools from getting it, entry aside */
export function scanScriptFolder(dir: string): { files: string[]; problem?: ScriptProblem } {
  const files: string[] = []
  let bytes = 0
  let problem: ScriptProblem | undefined
  const walk = (d: string, rel: string): void => {
    for (const n of readdirSync(d).sort()) {
      if (n === '.DS_Store') continue
      const p = join(d, n)
      const r = rel ? `${rel}/${n}` : n
      const st = lstatSync(p)
      if (st.isSymbolicLink()) problem ??= 'symlink'
      else if (IGNORED.has(n)) problem ??= 'ignoredFolder'
      else if (st.isDirectory()) walk(p, r)
      else if (st.isFile()) {
        files.push(r)
        bytes += st.size
      }
    }
  }
  walk(dir, '')
  if (!problem && (files.length > SCRIPT_FOLDER_LIMITS.files || bytes > SCRIPT_FOLDER_LIMITS.bytes))
    problem = 'tooLarge'
  return { files: files.sort(), ...(problem ? { problem } : {}) }
}

/** The entry when it is a file of the folder that isn't SCRIPT.md, else null */
export function scriptEntryIn(files: readonly string[], entry: string): string | null {
  const rel = scriptRelPath(entry)
  return rel && rel !== SCRIPT_DOC && files.includes(rel) ? rel : null
}

function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

export function isFolderScript(home: string, name: string): boolean {
  const dir = scriptDirPath(home, name)
  return isDir(dir) && existsSync(join(dir, SCRIPT_DOC))
}

export function scriptNames(home: string): string[] {
  const dir = scriptsDir(home)
  if (!existsSync(dir)) return []
  const names = new Set<string>()
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.sh') && LIBRARY_SCRIPT_RE.test(f.slice(0, -3))) names.add(f.slice(0, -3))
    else if (LIBRARY_SCRIPT_RE.test(f) && isFolderScript(home, f)) names.add(f)
  }
  return [...names].sort()
}

function readFolderScript(home: string, name: string): LibraryScript {
  const dir = scriptDirPath(home, name)
  const doc = parseScriptDoc(readFileSync(join(dir, SCRIPT_DOC), 'utf8'))
  const scan = scanScriptFolder(dir)
  const entry = doc?.entry ?? SCRIPT_ENTRY
  const found = scriptEntryIn(scan.files, entry)
  const problem: ScriptProblem | undefined = !doc
    ? 'badDoc'
    : (scan.problem ?? (found ? undefined : 'noEntry'))
  return {
    name,
    kind: 'folder',
    description: doc?.description ?? '',
    entry: found ?? entry,
    files: scan.files,
    content: found ? readFileSync(join(dir, found), 'utf8') : '',
    ...(problem ? { problem } : {})
  }
}

/** null when the script is missing */
export function readScript(home: string, name: string): LibraryScript | null {
  if (!LIBRARY_SCRIPT_RE.test(name)) return null
  if (isFolderScript(home, name)) return readFolderScript(home, name)
  const p = scriptPath(home, name)
  if (!existsSync(p) || !statSync(p).isFile()) return null
  const content = readFileSync(p, 'utf8')
  return { name, kind: 'file', description: scriptDescription(content), content }
}

export function readScripts(home: string): LibraryScript[] {
  return scriptNames(home)
    .map((n) => readScript(home, n))
    .filter((s): s is LibraryScript => !!s)
}
