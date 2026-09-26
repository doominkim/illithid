import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'

/** Stable path-based id (first 16 chars of sha1). */
export function pathId(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 16)
}

/** Reads only the [start, start+length) range of a file. */
export function readRange(path: string, start: number, length: number): string {
  if (length <= 0) return ''
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = readSync(fd, buf, 0, length, start)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function readHead(path: string, size: number, limit: number): string {
  return readRange(path, 0, Math.min(size, limit))
}

/** Collapses whitespace to single spaces and truncates at max chars. */
export function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

export function isoOrUndefined(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString()
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return new Date(t).toISOString()
  }
  return undefined
}
