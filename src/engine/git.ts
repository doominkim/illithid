/**
 * git module for the library repo (simple-git).
 *
 * - Queries: gitStatus/gitLog/gitDiff never talk to the remote. Remote refresh is separate (gitFetch).
 * - Writes: gitPull (--ff-only), gitCommit (explicit paths), gitPush (upstream, no force).
 *   Failures return { ok:false, reason } instead of throwing. No merge is attempted on conflict/divergence.
 * - Every write function first checks that repoDir is the repo root.
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, normalize, sep } from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'

export interface GitFileStatus {
  path: string
  /** First porcelain char (index). ' ' = unchanged, '?' = untracked */
  index: string
  /** Second porcelain char (working tree) */
  workingDir: string
}

export interface GitStatus {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFileStatus[]
  conflicted: string[]
  clean: boolean
}

export interface GitCommitInfo {
  hash: string
  date: string
  message: string
  author: string
}

export type GitResult<T = object> = ({ ok: true } & T) | { ok: false; reason: string }

/** Library files are written with LF; Git for Windows' default autocrlf would rewrite them on checkout */
export const GIT_CONFIG = ['core.autocrlf=false']

function git(repoDir: string): SimpleGit {
  return simpleGit({ baseDir: repoDir, config: GIT_CONFIG })
}

function reasonOf(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).trim()
}

/** Check that repoDir is a git repo root. Returns a reason string if not, null if it is. */
async function checkRepoRoot(repoDir: string): Promise<string | null> {
  let real: string
  try {
    real = realpathSync(repoDir)
  } catch {
    return `path does not exist: ${repoDir}`
  }
  try {
    const top = (await git(real).revparse(['--show-toplevel'])).trim()
    if (realpathSync(top) !== real) return `not the repo root: ${repoDir} (root: ${top})`
    return null
  } catch (e) {
    return `not a git repo: ${repoDir} (${reasonOf(e)})`
  }
}

export async function gitStatus(repoDir: string): Promise<GitStatus> {
  const s = await git(repoDir).status()
  return {
    branch: s.current,
    upstream: s.tracking,
    ahead: s.ahead,
    behind: s.behind,
    files: s.files.map((f) => ({ path: f.path, index: f.index, workingDir: f.working_dir })),
    conflicted: s.conflicted,
    clean: s.isClean()
  }
}

/** Update remote-tracking branches only (working tree and local branches untouched). */
export async function gitFetch(repoDir: string): Promise<GitResult> {
  const bad = await checkRepoRoot(repoDir)
  if (bad) return { ok: false, reason: bad }
  try {
    await git(repoDir).fetch()
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
}

export async function gitLog(repoDir: string, n = 5): Promise<GitCommitInfo[]> {
  const g = git(repoDir)
  try {
    await g.raw(['rev-parse', '--verify', '-q', 'HEAD'])
  } catch {
    return [] // Repo with no commits (detected independent of git's message language)
  }
  const log = await g.log({ maxCount: n })
  return log.all.map((c) => ({
    hash: c.hash,
    date: c.date,
    message: c.message,
    author: c.author_name
  }))
}

/** Raw working tree diff against HEAD (staged + unstaged). Untracked files are not included. */
export async function gitDiff(repoDir: string, path?: string): Promise<string> {
  const args = ['diff', 'HEAD']
  if (path) args.push('--', path)
  return git(repoDir).raw(args)
}

/** Only fast-forward from the remote. On divergence/conflict, stop without merge or rebase. */
export async function gitPull(repoDir: string): Promise<GitResult<{ summary: string }>> {
  const bad = await checkRepoRoot(repoDir)
  if (bad) return { ok: false, reason: bad }
  const g = git(repoDir)
  try {
    const s = await g.status()
    if (!s.tracking) return { ok: false, reason: `no upstream (branch: ${s.current})` }
    const out = await g.raw(['pull', '--ff-only', '--no-rebase'])
    return { ok: true, summary: out.trim() }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
}

function checkPaths(paths: string[]): string | null {
  if (paths.length === 0) return 'at least one path to commit is required'
  for (const p of paths) {
    if (!p || isAbsolute(p)) return `must be a path relative to the repo: ${p}`
    const n = normalize(p)
    if (n === '.' || n === '..' || n.startsWith('..' + sep) || n.startsWith('-')) {
      return `path not allowed: ${p}`
    }
  }
  return null
}

/**
 * Commit only the given paths. No add -A, and other already-staged files are not mixed in
 * (`git commit -- <paths>` commits only those paths). No trailers are added.
 */
export async function gitCommit(
  repoDir: string,
  message: string,
  paths: string[]
): Promise<GitResult<{ hash: string }>> {
  const bad = await checkRepoRoot(repoDir)
  if (bad) return { ok: false, reason: bad }
  if (!message.trim()) return { ok: false, reason: 'commit message is empty' }
  const badPath = checkPaths(paths)
  if (badPath) return { ok: false, reason: badPath }
  const g = git(repoDir)
  try {
    const s = await g.status()
    if (s.conflicted.length)
      return { ok: false, reason: `there are conflicted files: ${s.conflicted.join(', ')}` }
    // Stage only the given paths so new files and deletions are committed too (not -A)
    await g.raw(['add', '--', ...paths])
    await g.raw(['commit', '-m', message, '--', ...paths])
    const hash = (await g.revparse(['HEAD'])).trim()
    return { ok: true, hash }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
}

/** Push to the upstream, only if one is set. No force. */
export async function gitPush(repoDir: string): Promise<GitResult<{ upstream: string }>> {
  const bad = await checkRepoRoot(repoDir)
  if (bad) return { ok: false, reason: bad }
  const g = git(repoDir)
  try {
    const s = await g.status()
    if (s.detached || !s.current)
      return { ok: false, reason: 'refusing to push from a detached HEAD' }
    if (!s.tracking) return { ok: false, reason: `no upstream (branch: ${s.current})` }
    const branch = s.current
    const remote = (await g.raw(['config', '--get', `branch.${branch}.remote`])).trim()
    const merge = (await g.raw(['config', '--get', `branch.${branch}.merge`])).trim()
    if (!remote || !merge || remote === '.') {
      return { ok: false, reason: `cannot read upstream config (branch: ${branch})` }
    }
    await g.raw(['push', remote, `HEAD:${merge}`])
    return { ok: true, upstream: s.tracking }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
}
