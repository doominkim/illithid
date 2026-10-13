import { libraryRoot } from '../engine/config'
import type { Refused } from '../shared/api'

let revision = 0
let contentRevision = 0
export type WorkspaceRewriteOwner = () => void
const rewrites = new Map<string, WorkspaceRewriteOwner>()

export function isWorkspaceRewriting(root: string): boolean {
  return rewrites.has(root)
}

/** A Git restore or pull owns the working tree until its files and sync have settled. */
export function workspaceWriteRefusal(home: string): Refused | null {
  if (!isWorkspaceRewriting(libraryRoot(home))) return null
  return {
    refused: 'notAvailable',
    message: 'This workspace is being restored or pulled. Wait for it to finish and try again.'
  }
}

export function assertWorkspaceWritable(home: string, owner?: WorkspaceRewriteOwner): void {
  if (owner && rewrites.get(libraryRoot(home)) === owner) return
  const refused = workspaceWriteRefusal(home)
  if (refused) throw Object.assign(new Error(refused.message), { code: 'workspaceChanged' })
}

/** Acquire synchronously, before the operation's first await. Always release in finally. */
export function beginWorkspaceRewrite(home: string): WorkspaceRewriteOwner {
  assertWorkspaceWritable(home)
  const root = libraryRoot(home)
  const owner = (): void => {
    if (rewrites.get(root) === owner) rewrites.delete(root)
  }
  rewrites.set(root, owner)
  return owner
}

export interface WorkspaceRevision {
  root: string
  revision: number
  contentRevision: number
}

/** Bind an asynchronous operation to the library it was started from. */
export function captureWorkspace(home: string): WorkspaceRevision {
  return { root: libraryRoot(home), revision, contentRevision }
}

/** Successful app writes and switches invalidate results prepared from an earlier library revision. */
export function advanceWorkspaceRevision(kind: 'write' | 'switch' = 'write'): void {
  if (kind === 'switch') revision++
  contentRevision++
}

export function assertWorkspaceCurrent(
  home: string,
  origin: WorkspaceRevision,
  includeEdits = true
): void {
  if (
    origin.root !== libraryRoot(home) ||
    origin.revision !== revision ||
    (includeEdits && origin.contentRevision !== contentRevision)
  )
    throw Object.assign(
      new Error(
        'The workspace or its contents changed while this operation was running. Reopen it and try again.'
      ),
      {
        code: 'workspaceChanged'
      }
    )
}
