import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_CONFIG_DIR } from '../config'
import { atomicWrite } from '../write'

/**
 * Parse cache for session files: a file's parsed metadata is reused while its (mtime, size) are unchanged.
 * Only a cache — a missing, corrupt or old-version file means a full parse, never an error.
 */

const VERSION = 1

interface Entry {
  /** Tool that owns the file, so a scan limited to some tools keeps the others' entries */
  t: string
  /** mtimeMs */
  m: number
  /** size in bytes */
  s: number
  v: unknown
}

export function sessionScanCachePath(home: string): string {
  return join(home, APP_CONFIG_DIR, 'session-scan.json')
}

export class SessionScanCache {
  private readonly old = new Map<string, Entry>()
  private readonly next = new Map<string, Entry>()
  private readonly scanned = new Set<string>()
  private dirty = false

  constructor(private readonly path: string) {
    try {
      const o = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; entries?: Record<string, Entry> }
      if (o.version === VERSION && o.entries && typeof o.entries === 'object') {
        for (const [k, e] of Object.entries(o.entries)) {
          if (e && typeof e.t === 'string' && typeof e.m === 'number' && typeof e.s === 'number') this.old.set(k, e)
        }
      }
    } catch {
      // No cache yet, or unreadable: start empty
    }
  }

  /** Marks a tool as scanned in this run: its entries not seen again are dropped on save */
  begin(tool: string): void {
    this.scanned.add(tool)
  }

  get<T>(tool: string, path: string, mtimeMs: number, size: number): T | undefined {
    const e = this.old.get(path)
    if (!e || e.t !== tool || e.m !== mtimeMs || e.s !== size) return undefined
    this.next.set(path, e)
    return e.v as T
  }

  set(tool: string, path: string, mtimeMs: number, size: number, value: unknown): void {
    this.next.set(path, { t: tool, m: mtimeMs, s: size, v: value })
    this.dirty = true
  }

  /** Writes only when something changed. Failures are ignored (the next scan parses again) */
  save(): void {
    for (const [k, e] of this.old) {
      if (!this.scanned.has(e.t) && !this.next.has(k)) this.next.set(k, e)
    }
    if (!this.dirty && this.next.size === this.old.size) return
    try {
      atomicWrite(this.path, JSON.stringify({ version: VERSION, entries: Object.fromEntries(this.next) }), { mode: 0o600 })
    } catch {
      // Read-only home or a concurrent writer: keep going without the cache
    }
  }
}
