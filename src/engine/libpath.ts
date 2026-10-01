import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { libraryRoot, readConfig } from './config'

/**
 * Library path error codes
 * - invalidName     name format violation
 * - outsideLibrary  outside the library root (including escapes via symlink)
 * - notFound        target not found
 * - exists          already exists (create)
 * - invalidSchema   mcp server definition failed validation
 * - configError     config.json is broken, so the library location is uncertain
 * - libraryMissing  library root does not exist
 */
export type LibraryErrorCode =
  | 'invalidName'
  | 'outsideLibrary'
  | 'notFound'
  | 'exists'
  | 'invalidSchema'
  | 'configError'
  | 'libraryMissing'
  /** The tool is not in use on this device (config.toolsInUse) — its files are not written */
  | 'toolNotInUse'

export class LibraryError extends Error {
  constructor(
    public code: LibraryErrorCode,
    message: string
  ) {
    super(message)
  }
}

function within(root: string, p: string): boolean {
  const r = relative(root, p)
  return r === '' || (!!r && !r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r))
}

/** Real path of the library root for writes. LibraryError on config error or missing root */
export function libraryRealRoot(home: string): string {
  const cfg = readConfig(home)
  if (cfg.error) throw new LibraryError('configError', `config.json: ${cfg.error}`)
  const root = libraryRoot(home)
  if (!existsSync(root)) throw new LibraryError('libraryMissing', 'library root does not exist')
  return realpathSync(root)
}

/**
 * Verifies via realpath that path is inside the library root and returns the absolute path resolved against the root.
 * The realpath of the nearest existing ancestor must be inside the root, and if path itself exists, so must its realpath.
 */
export function assertInsideLibrary(home: string, path: string): string {
  const root = libraryRealRoot(home)
  const abs = resolve(path)
  // Logical path check (escaping via ..)
  const logicalRoot = resolve(libraryRoot(home))
  if (!within(logicalRoot, abs) && !within(root, abs))
    throw new LibraryError('outsideLibrary', 'path outside library')
  let probe = abs
  while (!existsSync(probe) && !isSymlink(probe)) {
    const up = dirname(probe)
    if (up === probe) break
    probe = up
  }
  let real: string
  try {
    real = realpathSync(probe)
  } catch {
    // Broken symlink
    throw new LibraryError('outsideLibrary', 'unresolvable symlink')
  }
  if (!within(root, real))
    throw new LibraryError('outsideLibrary', 'path outside library (symlink)')
  // Resolved real path + remaining relative path
  return resolve(real, relative(probe, abs))
}

export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
