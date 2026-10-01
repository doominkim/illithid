/**
 * Read-only GitHub access for skill downloads. Two API calls per install (HEAD commit + recursive tree, unauthenticated
 * limit 60/hour), file bodies from raw.githubusercontent.com pinned to the commit.
 */
import {
  assertRepo,
  getBytes,
  getJson,
  getText,
  isObj,
  MarketError,
  str,
  type FetchFn
} from './http'

export const GITHUB_API = 'https://api.github.com'
export const GITHUB_RAW = 'https://raw.githubusercontent.com'

/** Skill download limits */
export const SKILL_MAX_FILES = 500
export const SKILL_MAX_BYTES = 20 * 1024 * 1024
export const SKILL_MAX_FILE_BYTES = 5 * 1024 * 1024

export interface TreeEntry {
  path: string
  mode: string
  type: string
  size?: number
  sha?: string
}

const SHA_RE = /^[0-9a-f]{40}$/

export async function resolveSha(fetchFn: FetchFn, repo: string): Promise<string> {
  assertRepo(repo)
  const sha = (
    await getText(fetchFn, `${GITHUB_API}/repos/${repo}/commits/HEAD`, 1024, {
      Accept: 'application/vnd.github.sha'
    })
  ).trim()
  if (!SHA_RE.test(sha)) throw new MarketError('invalid', 'unexpected commit response')
  return sha
}

/** Recursive tree at a commit. `root` is the top-level tree SHA */
export async function listTree(
  fetchFn: FetchFn,
  repo: string,
  sha: string
): Promise<{ root: string; entries: TreeEntry[] }> {
  assertRepo(repo)
  if (!SHA_RE.test(sha)) throw new MarketError('invalid', 'invalid commit')
  const body = await getJson(
    fetchFn,
    `${GITHUB_API}/repos/${repo}/git/trees/${sha}?recursive=1`,
    16 * 1024 * 1024
  )
  if (!isObj(body) || !Array.isArray(body.tree))
    throw new MarketError('invalid', 'unexpected tree response')
  const out: TreeEntry[] = []
  for (const e of body.tree) {
    if (!isObj(e)) continue
    const path = str(e.path)
    const mode = str(e.mode)
    const type = str(e.type)
    if (!path || !mode || !type) continue
    out.push({
      path,
      mode,
      type,
      size: typeof e.size === 'number' ? e.size : undefined,
      sha: str(e.sha)
    })
  }
  if (body.truncated === true) throw new MarketError('tooLarge', 'repository is too large to list')
  return { root: str(body.sha) ?? '', entries: out }
}

/** Content version of a folder: its tree SHA (changes only when something inside changes) */
export function dirSha(tree: { root: string; entries: TreeEntry[] }, dir: string): string {
  if (!dir) return tree.root
  return tree.entries.find((e) => e.type === 'tree' && e.path === dir)?.sha ?? ''
}

export async function rawFile(
  fetchFn: FetchFn,
  repo: string,
  sha: string,
  path: string,
  maxBytes = SKILL_MAX_FILE_BYTES
): Promise<Uint8Array> {
  assertRepo(repo)
  if (!SHA_RE.test(sha) || pathProblem(path)) throw new MarketError('invalid', 'invalid file path')
  const url = `${GITHUB_RAW}/${repo}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`
  return getBytes(fetchFn, url, maxBytes)
}

/** Reason a repository-relative path is unsafe to write, or null (same rules as workspace zip import) */
export function pathProblem(p: string): string | null {
  if (typeof p !== 'string' || !p || p.includes('\0')) return 'empty name'
  if (p.includes('\\')) return 'backslash path'
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'absolute path'
  const segs = p.split('/')
  if (segs.some((s) => s === '..')) return 'parent path (..)'
  if (segs.some((s) => s === '' || s === '.')) return 'empty path segment'
  return null
}

const SKILL_MD = ['SKILL.md', 'skill.md']

function hasSkillMd(files: Set<string>, dir: string): string | null {
  for (const f of SKILL_MD) {
    const p = dir ? `${dir}/${f}` : f
    if (files.has(p)) return p
  }
  return null
}

/**
 * Folder holding the skill: `skills/<id>`, `<id>`, then any `…/<id>` (shortest), then the repository root.
 * Returns the folder ('' = root) or null
 */
export function findSkillDir(tree: TreeEntry[], skillId: string): string | null {
  const files = new Set(tree.filter((e) => e.type === 'blob').map((e) => e.path))
  for (const d of [`skills/${skillId}`, skillId]) if (hasSkillMd(files, d)) return d
  const deep = [...files]
    .filter((p) => SKILL_MD.some((f) => p.endsWith(`/${skillId}/${f}`)))
    .map((p) => p.slice(0, p.lastIndexOf('/')))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
  if (deep.length) return deep[0]
  return hasSkillMd(files, '') ? '' : null
}

export interface SkillFilePlan {
  /** Path relative to the skill folder */
  rel: string
  /** Path in the repository */
  path: string
  size: number
  /** Executable in git (100755) */
  exec: boolean
}

/**
 * Files to download under `dir`. Symlinks (120000), submodules, unsafe paths, .git entries, nested skills (any
 * sub-folder with its own SKILL.md) and case-insensitive duplicates are skipped; limits throw tooLarge
 */
export function skillFilePlan(
  tree: TreeEntry[],
  dir: string
): { files: SkillFilePlan[]; skipped: string[] } {
  const prefix = dir ? `${dir}/` : ''
  const nested = tree
    .filter(
      (e) =>
        e.type === 'blob' &&
        e.path.startsWith(prefix) &&
        SKILL_MD.some((f) => e.path.endsWith(`/${f}`))
    )
    .map((e) => e.path.slice(0, e.path.lastIndexOf('/') + 1))
    .filter((d) => d !== prefix)
  const files: SkillFilePlan[] = []
  const skipped: string[] = []
  const lower = new Set<string>()
  let total = 0
  for (const e of tree) {
    if (prefix && !e.path.startsWith(prefix)) continue
    const rel = e.path.slice(prefix.length)
    if (!rel || e.type === 'tree') continue
    if (nested.some((d) => e.path.startsWith(d))) continue
    if (e.type !== 'blob' || e.mode === '120000' || e.mode === '160000') {
      skipped.push(rel)
      continue
    }
    if (
      pathProblem(rel) ||
      pathProblem(e.path) ||
      rel.split('/').some((x) => x === '.git') ||
      lower.has(rel.toLowerCase())
    ) {
      skipped.push(rel)
      continue
    }
    lower.add(rel.toLowerCase())
    const size = e.size ?? 0
    if (size > SKILL_MAX_FILE_BYTES) throw new MarketError('tooLarge', `file too large: ${rel}`)
    total += size
    files.push({ rel, path: e.path, size, exec: e.mode === '100755' })
  }
  if (files.length > SKILL_MAX_FILES)
    throw new MarketError('tooLarge', `too many files (${files.length})`)
  if (total > SKILL_MAX_BYTES) throw new MarketError('tooLarge', 'skill is too large')
  if (!files.some((f) => SKILL_MD.includes(f.rel)))
    throw new MarketError('notFound', 'SKILL.md not found')
  return { files, skipped }
}
