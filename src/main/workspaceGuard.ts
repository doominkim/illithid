import { libraryRoot } from '../engine/config'

let revision = 0
let contentRevision = 0

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
