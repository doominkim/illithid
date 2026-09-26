/**
 * Watches the library (source) for changes. Uses recursive fs.watch (macOS and Windows; Linux supports recursion on Node 20+)
 * and reports changes, excluding .trash/, .git/, and tmp files, once per debounce window (default 1s). No dependencies (no chokidar).
 */
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { sep } from 'node:path'
import { isAppTmpName } from './write'

export interface WatchLibraryOptions {
  /** Debounce (ms). Default 1000 */
  debounceMs?: number
  /** Watch error (permissions, watcher limits, etc.). Watching stops after this is called */
  onError?: (err: Error) => void
}

export interface LibraryChange {
  /** Relative paths changed within the debounce window (deduplicated, sorted). [] if unknown */
  paths: string[]
  at: string
}

export type Unsubscribe = () => void

const IGNORED_TOP = new Set(['.trash', '.git'])

/** Whether the path should be ignored (relative to root) */
export function isIgnoredLibraryPath(rel: string): boolean {
  if (!rel) return false
  const first = rel.split(/[\\/]/)[0]
  if (IGNORED_TOP.has(first)) return true
  const base = rel.split(/[\\/]/).pop() ?? ''
  if (base === '.DS_Store') return true
  if (isAppTmpName(base)) return true
  return false
}

/**
 * Watches for changes under root. Call the returned function to stop watching.
 * If root does not exist, watches nothing and returns a no-op unsubscribe (call again after the library is created).
 */
export function watchLibrary(
  root: string,
  onChange: (change: LibraryChange) => void,
  opts: WatchLibraryOptions = {}
): Unsubscribe {
  if (!existsSync(root)) return () => {}
  const debounceMs = opts.debounceMs ?? 1000
  let timer: NodeJS.Timeout | undefined
  const pending = new Set<string>()
  let closed = false
  let watcher: FSWatcher | undefined

  const flush = (): void => {
    timer = undefined
    if (closed) return
    const paths = [...pending].sort()
    pending.clear()
    onChange({ paths, at: new Date().toISOString() })
  }
  const stop = (): void => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    watcher?.close()
  }

  try {
    watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      const rel = filename === null ? '' : String(filename).split(sep).join('/')
      if (isIgnoredLibraryPath(rel)) return
      if (rel) pending.add(rel)
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, debounceMs)
    })
    watcher.on('error', (e) => {
      stop()
      opts.onError?.(e)
    })
  } catch (e) {
    opts.onError?.(e as Error)
    return () => {}
  }
  return stop
}
