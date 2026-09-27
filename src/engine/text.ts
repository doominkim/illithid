import { createHash } from 'node:crypto'
import { TargetError, type AllowlistEntry, type McpServer, type McpSource } from './types'

/**
 * Parse a target JSON file. Keep only the position so failure messages never include raw snippets
 * (V8's JSON.parse errors can include part of the input, and target files may contain tokens).
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (e) {
    const pos = /position (\d+)/.exec((e as Error).message)
    throw new TargetError(`JSON parse failed${pos ? ` (position ${pos[1]})` : ''}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TargetError('JSON top level is not an object')
  }
  return value as Record<string, unknown>
}

/** Replace only the marker block; append at end of file if no markers. */
export function spliceBlock(original: string, begin: string, end: string, body: string): string {
  const block = `${begin}\n${body}\n${end}`
  const i = original.indexOf(begin)
  const j = original.indexOf(end)
  if (i !== -1 && j !== -1 && j > i) {
    return original.slice(0, i) + block + original.slice(j + end.length)
  }
  const base = original.trimEnd()
  return (base ? base + '\n\n' : '') + block + '\n'
}

/** Everything outside the marker block — where hand-written/runtime content lives */
export function outsideBlock(text: string, begin: string, end: string): string {
  const i = text.indexOf(begin)
  const j = text.indexOf(end)
  if (i === -1 || j === -1 || j < i) return text
  return text.slice(0, i) + text.slice(j + end.length)
}

export function normalizeEntry(e: AllowlistEntry): { argv: string[]; claudeExact: boolean } {
  return Array.isArray(e)
    ? { argv: e, claudeExact: false }
    : { argv: e.argv, claudeExact: !!e.claudeExact }
}

/** Server list excluding keys starting with `_` (comments) */
export function mcpEntries(mcp: McpSource): [string, McpServer][] {
  return Object.entries(mcp.servers).filter(([name]) => !name.startsWith('_'))
}

/** Shared serialization for JSON targets */
export function toJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

/** Check that top-level keys other than the given key are unchanged. */
export function untouchedKeysSame(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  key: string
): { count: number; same: boolean } {
  const untouched = Object.keys(before).filter((k) => k !== key)
  const same = untouched.every((k) => JSON.stringify(before[k]) === JSON.stringify(after[k]))
  return { count: untouched.length, same }
}

export function lineCount(text: string): number {
  return text.split('\n').length
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Body between markers. null if markers are missing or out of order */
export function blockBody(text: string, begin: string, end: string): string | null {
  const i = text.indexOf(begin)
  const j = text.indexOf(end)
  if (i === -1 || j === -1 || j < i) return null
  return text.slice(i + begin.length, j)
}

function parseObjectOrNull(text: string): Record<string, unknown> | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** JSON.stringify of a top-level key's value. null on parse failure or missing key */
export function jsonKeyRegion(text: string, key: string): string | null {
  const obj = parseObjectOrNull(text)
  if (!obj) return null
  const v = obj[key]
  return v === undefined ? null : JSON.stringify(v)
}

/**
 * Pick only subKeys from a top-level key object, sort by name, and stringify.
 * null on parse failure, when key is not an object, or when nothing was picked
 */
export function jsonSubKeysRegion(text: string, key: string, subKeys: string[]): string | null {
  const obj = parseObjectOrNull(text)
  if (!obj) return null
  const v = obj[key]
  if (!isPlainObject(v)) return null
  const picked: Record<string, unknown> = {}
  for (const k of [...new Set(subKeys)].sort()) {
    if (Object.prototype.hasOwnProperty.call(v, k) && v[k] !== undefined) picked[k] = v[k]
  }
  return Object.keys(picked).length ? JSON.stringify(picked) : null
}

/** Remove names from a JSON target's server table (key) */
export function removeServers(obj: Record<string, unknown>, key: string, names: string[]): void {
  const table = obj[key]
  if (!names.length || !isPlainObject(table)) return
  for (const n of names) delete table[n]
}

/** Notes about on/off (names only) */
export function toggleNotes(removed: string[], keptUnowned: string[]): string[] {
  const out: string[] = []
  if (removed.length) out.push(`removed previously owned servers that are now off: ${removed.join(', ')}`)
  if (keptUnowned.length)
    out.push(
      `servers that are off but have no app ownership record — left as-is in tool config: ${keptUnowned.join(', ')}`
    )
  return out
}

// ---------------------------------------------------------------- Markers (current + legacy)

/** Marker pair [begin, end] */
export type MarkerPair = readonly [string, string]

/** Position of a marker pair in text. null if missing or out of order */
function findBlock(text: string, [begin, end]: MarkerPair): { i: number; j: number } | null {
  const i = text.indexOf(begin)
  const j = text.indexOf(end)
  return i !== -1 && j !== -1 && j > i ? { i, j } : null
}

/** First marker pair present in text (in priority order). null if none */
export function presentMarkers(text: string, pairs: readonly MarkerPair[]): MarkerPair | null {
  for (const p of pairs) if (findBlock(text, p)) return p
  return null
}

/**
 * Replace a block. In place if the current marker block exists; otherwise, if a legacy marker block (older system or app name) exists,
 * replace that whole block with a current marker block. If neither exists, append at end of file.
 */
export function spliceBlockMulti(
  original: string,
  current: MarkerPair,
  legacy: readonly MarkerPair[],
  body: string
): string {
  const found = presentMarkers(original, [current, ...legacy])
  if (!found) return spliceBlock(original, current[0], current[1], body)
  const { i, j } = findBlock(original, found)!
  const block = `${current[0]}\n${body}\n${current[1]}`
  return original.slice(0, i) + block + original.slice(j + found[1].length)
}

/** Body of the current or legacy marker block. null if none */
export function blockBodyMulti(text: string, pairs: readonly MarkerPair[]): string | null {
  const p = presentMarkers(text, pairs)
  return p ? blockBody(text, p[0], p[1]) : null
}

/** Everything outside the current or legacy marker block */
export function outsideBlockMulti(text: string, pairs: readonly MarkerPair[]): string {
  const p = presentMarkers(text, pairs)
  return p ? outsideBlock(text, p[0], p[1]) : text
}

/**
 * Remove the whole current or legacy marker block (tidying surrounding blank lines). Returns the input unchanged if there is no block.
 * Used to clear a previously written block when the app has nothing to write (0 rules/memory/servers)
 */
export function removeBlockMulti(text: string, pairs: readonly MarkerPair[]): string {
  const p = presentMarkers(text, pairs)
  if (!p) return text
  const { i, j } = findBlock(text, p)!
  const head = text.slice(0, i).trimEnd()
  const tail = text.slice(j + p[1].length).replace(/^\s*\n/, '').replace(/^\n+/, '')
  if (!head) return tail
  if (!tail.trim()) return head + '\n'
  return head + '\n\n' + tail
}

/** Remove `//` and `/* *\/` comments outside strings (for reading JSON files their tool parses with comments allowed) */
export function stripJsonComments(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
    } else if (ch === '"') {
      inString = true
      out += ch
      i++
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      out += ch
      i++
    }
  }
  return out
}
