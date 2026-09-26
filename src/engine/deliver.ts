/**
 * Centralizes how sources are "placed" on the tool side (delivery strategy). skillSync and ruleSync call only this.
 *
 * - copy     copies source content to the tool side (the only implementation for now; confirmed by the user 2026-09-23)
 * - symlink  places a symlink pointing at the source on the tool side (type placeholder only — not implemented yet)
 *
 * Planning and status checks only ask `deliveredShape` for "what is on the tool side now", so they are not tied to the strategy constant.
 */
import { randomBytes } from 'node:crypto'
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { dirContentHash } from './skills'
import { appTmpName, atomicWrite } from './write'

export type DeliverStrategy = 'copy' | 'symlink'

/** Current strategy. Changing it makes planning (plan*) and execution (apply*) follow together */
export const DELIVER_STRATEGY: DeliverStrategy = 'copy'

/** What form the tool-side entry currently has */
export type DeliveredShape =
  | { kind: 'absent' }
  | { kind: 'copy'; isDir: boolean }
  | { kind: 'symlink'; target: string; toSource: boolean }
  | { kind: 'other' }

export function deliveredShape(dest: string, source: string): DeliveredShape {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(dest)
  } catch {
    return { kind: 'absent' }
  }
  if (st.isSymbolicLink()) {
    const link = readlinkSync(dest)
    const target = resolve(dirname(dest), link)
    let toSource = false
    try {
      toSource = realpathSync(target) === realpathSync(source)
    } catch {
      toSource = target === resolve(source)
    }
    return { kind: 'symlink', target: link, toSource }
  }
  if (st.isDirectory()) return { kind: 'copy', isDir: true }
  if (st.isFile()) return { kind: 'copy', isDir: false }
  return { kind: 'other' }
}

/** Whether the shape counts as "correctly placed" under this strategy */
export function shapeMatches(
  shape: DeliveredShape,
  strategy: DeliverStrategy = DELIVER_STRATEGY
): boolean {
  if (strategy === 'copy') return shape.kind === 'copy'
  return shape.kind === 'symlink' && shape.toSource
}

export interface DeliverFileOptions {
  strategy?: DeliverStrategy
  /** New file mode (copy) */
  mode?: number
  /** sha256 of existing content right before writing (null = must not exist). ConcurrentChangeError if different */
  expectHash?: string | null
}

/** Places one file on the tool side. content is the already-read source content */
export function deliverFile(
  source: string,
  dest: string,
  content: string,
  opts: DeliverFileOptions = {}
): void {
  const strategy = opts.strategy ?? DELIVER_STRATEGY
  if (strategy === 'copy') {
    atomicWrite(dest, content, {
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
      ...(opts.expectHash !== undefined ? { expectHash: opts.expectHash } : {})
    })
    return
  }
  void source
  throw new Error(`delivery strategy ${strategy} is not implemented yet`)
}

export interface DeliverDirOptions {
  strategy?: DeliverStrategy
  /** The copy must match this dirContentHash (otherwise fails with 'hashMismatch') */
  expectedHash?: string
  /**
   * Clears the dest slot (removes a link or pushes out the previous copy). Called after the tmp copy, right before rename.
   * On failure the caller rolls back via restore.
   */
  vacate?: () => void
  /** Restores the original state if rename fails */
  restore?: () => void
}

export type DeliverDirResult = { ok: true } | { ok: false; reason: 'hashMismatch' | string }

function tmpDirFor(dir: string, name: string): string {
  return join(dir, appTmpName(name, randomBytes(4).toString('hex')))
}

/**
 * Places a directory on the tool side (copy: copy to a tmp inside the tool directory -> verify hash -> vacate -> rename).
 * Creates the parent directory of dest.
 */
export function deliverDir(
  source: string,
  dest: string,
  opts: DeliverDirOptions = {}
): DeliverDirResult {
  const strategy = opts.strategy ?? DELIVER_STRATEGY
  if (strategy !== 'copy')
    return { ok: false, reason: `delivery strategy ${strategy} is not implemented yet` }
  const parent = dirname(dest)
  mkdirSync(parent, { recursive: true, mode: 0o755 })
  const tmp = tmpDirFor(parent, dest.slice(parent.length + 1))
  let placed = false
  try {
    cpSync(realpathSync(source), tmp, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false
    })
    if (opts.expectedHash !== undefined && dirContentHash(tmp) !== opts.expectedHash)
      return { ok: false, reason: 'hashMismatch' }
    opts.vacate?.()
    try {
      renameSync(tmp, dest)
      placed = true
    } catch (e) {
      opts.restore?.()
      throw e
    }
    return { ok: true }
  } finally {
    if (!placed) {
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        // tmp cleanup failures surface via leftoverSkillTmps
      }
    }
  }
}
