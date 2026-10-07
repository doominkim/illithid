/**
 * Creates the library skeleton (first run). In the active workspace folder (`~/.illithid/workspaces/<id>`, default id
 * `default`) it creates rules/ skills/ mcps/ memory/ and .gitignore(.trash/). No content is created —
 * filling it is up to the importer or the editing API.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { libraryPaths } from './sources'
import { atomicWrite } from './write'

export interface InitLibraryOptions {
  /** Also run `git init` (default false). Skipped if already a repo */
  git?: boolean
}

export interface InitLibraryResult {
  root: string
  /** Entries created by this call (relative to root; the root itself is '.') */
  created: string[]
  /** Entries skipped because they already existed */
  existed: string[]
  gitInitialized: boolean
}

/** Workspace name file (`workspaces/<id>/workspace.json`) */
export const WORKSPACE_FILE = 'workspace.json'

export const LIBRARY_DIRS = ['rules', 'skills', 'mcps', 'memory'] as const
export const GITIGNORE = '# Illithid trash (deleted items stay here for a while)\n.trash/\n'
/**
 * .gitignore contents written by earlier initLibrary versions (for empty-skeleton detection, most recent first).
 * Kept byte-exact; the Korean text is escaped.
 */
export const LEGACY_GITIGNORES = [
  '# Illithid \uD734\uC9C0\uD1B5 (\uC0AD\uC81C\uD55C \uD56D\uBAA9\uC774 \uC7A0\uC2DC \uBA38\uBB34\uB294 \uACF3)\n.trash/\n',
  '# HarnessSync \uD734\uC9C0\uD1B5 (\uC0AD\uC81C\uD55C \uD56D\uBAA9\uC774 \uC7A0\uC2DC \uBA38\uBB34\uB294 \uACF3)\n.trash/\n',
  '# agent-console \uD734\uC9C0\uD1B5 (\uC0AD\uC81C\uD55C \uD56D\uBAA9\uC774 \uC7A0\uC2DC \uBA38\uBB34\uB294 \uACF3)\n.trash/\n'
] as const

/** Creates the library skeleton (active workspace). If present, fills in only what is missing (idempotent) */
export function initLibrary(home: string, opts: InitLibraryOptions = {}): InitLibraryResult {
  return initLibraryAt(libraryPaths(home).root, opts)
}

/** Creates the skeleton in the given workspace folder (idempotent). Without workspace.json, name = folder name */
export function initLibraryAt(root: string, opts: InitLibraryOptions = {}): InitLibraryResult {
  const created: string[] = []
  const existed: string[] = []
  if (existsSync(root)) {
    if (!statSync(root).isDirectory()) throw new Error('library path is not a directory')
    existed.push('.')
  } else {
    mkdirSync(root, { recursive: true, mode: 0o755 })
    created.push('.')
  }
  const wf = join(root, WORKSPACE_FILE)
  if (existsSync(wf)) existed.push(WORKSPACE_FILE)
  else {
    atomicWrite(wf, JSON.stringify({ name: basename(root) }, null, 2) + '\n', { mode: 0o644 })
    created.push(WORKSPACE_FILE)
  }
  for (const d of LIBRARY_DIRS) {
    const dir = join(root, d)
    if (existsSync(dir)) existed.push(d)
    else {
      mkdirSync(dir, { mode: 0o755 })
      created.push(d)
    }
  }
  const gi = join(root, '.gitignore')
  if (existsSync(gi)) existed.push('.gitignore')
  else {
    atomicWrite(gi, GITIGNORE, { mode: 0o644 })
    created.push('.gitignore')
  }
  let gitInitialized = false
  if (opts.git && !existsSync(join(root, '.git'))) {
    execFileSync('git', ['init', '-q', root], { stdio: 'ignore' })
    // Library files are LF: keep Git for Windows' autocrlf default from rewriting them in a repo the app creates
    execFileSync('git', ['-C', root, 'config', 'core.autocrlf', 'false'], { stdio: 'ignore' })
    gitInitialized = true
  }
  return { root, created, existed, gitInitialized }
}
