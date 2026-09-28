import { existsSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { parse as parseToml, TomlError } from 'smol-toml'
import { tools, type ToolId } from './agents'
import { toolInUse } from './config'
import { sha256 } from './text'
import { atomicWrite, backup, ConcurrentChangeError } from './write'

export interface ModelValue {
  key: string
  /** null if the key is missing. Non-strings are converted to a JSON string */
  value: string | null
}

export interface ToolModels {
  tool: ToolId
  displayName: string
  path: string
  values: ModelValue[]
  error?: string
}

/** Parser error messages can contain raw snippets (config files hold tokens). Keep only the position. */
function safeParseError(e: unknown, format: 'json' | 'toml'): string {
  if (e instanceof TomlError) return `TOML parse failed (line ${e.line}, column ${e.column})`
  const pos = /position (\d+)/.exec((e as Error)?.message ?? '')
  return `${format.toUpperCase()} parse failed${pos ? ` (position ${pos[1]})` : ''}`
}

function toDisplay(v: unknown): string | null {
  if (v === undefined || v === null) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/** Read the top-level object. On failure, an error string */
export function readConfigObject(
  path: string,
  format: 'json' | 'toml'
): { value: Record<string, unknown> } | { error: string } {
  if (!existsSync(path)) return { error: 'file not found' }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    return { error: `read failed: ${(e as NodeJS.ErrnoException).code ?? 'unknown'}` }
  }
  try {
    const value = format === 'toml' ? parseToml(text) : JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { error: 'top level is not an object' }
    }
    return { value: value as Record<string, unknown> }
  } catch (e) {
    return { error: safeParseError(e, format) }
  }
}

/** Dotted key path: JSON `model.name` = key name inside object model; TOML `models.default` = key default in table [models] */
function keyPath(key: string, format: 'json' | 'toml'): string[] {
  void format
  return key.split('.')
}

function getPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj
  for (const k of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

/** Read each tool's default model keys */
export function readModels(home: string): ToolModels[] {
  return tools(home).map((t) => {
    const { path, format, keys } = t.models
    const base = { tool: t.id, displayName: t.displayName, path }
    if (!keys.length) return { ...base, values: [] }
    const res = readConfigObject(path, format)
    if ('error' in res) {
      return { ...base, values: keys.map((key) => ({ key, value: null })), error: res.error }
    }
    return { ...base, values: keys.map((key) => ({ key, value: toDisplay(getPath(res.value, keyPath(key, format))) })) }
  })
}

/** Keys setModel may change (per-tool allowlist) */
export const MODEL_KEYS: Readonly<Record<ToolId, readonly string[]>> = {
  claude: ['model', 'effortLevel'],
  codex: ['model', 'model_reasoning_effort'],
  opencode: ['model', 'small_model'],
  gemini: ['model.name'],
  copilot: [],
  grok: ['models.default']
}

export interface SetModelResult {
  tool: ToolId
  key: string
  path: string
  /** Value before the change (null if absent) */
  previous: string | null
  status: 'written' | 'unchanged'
  backupPath?: string
}

export class SetModelError extends Error {}

/** JSON: parse → change one key (dotted path for nested keys; missing objects are created) → keep existing indentation and trailing newline */
function setJsonKey(text: string, key: string, value: string): string {
  const res = JSON.parse(text) as unknown
  if (res === null || typeof res !== 'object' || Array.isArray(res)) {
    throw new SetModelError('top level is not an object')
  }
  const obj = res as Record<string, unknown>
  const path = keyPath(key, 'json')
  let cur = obj
  for (const k of path.slice(0, -1)) {
    const next = cur[k]
    if (next === undefined) cur[k] = {}
    else if (next === null || typeof next !== 'object' || Array.isArray(next))
      throw new SetModelError(`${k} is not an object; not changing ${key}`)
    cur = cur[k] as Record<string, unknown>
  }
  cur[path[path.length - 1]] = value
  const indent = /^[{[]\r?\n([ \t]+)\S/.exec(text)?.[1] ?? '  '
  const trailing = /\r?\n$/.exec(text)?.[0] ?? ''
  return JSON.stringify(obj, null, indent) + trailing
}

/** In the top-level region (before the first table header), change the single `key = "..."` line or insert it before the first header */
function setTomlKey(text: string, key: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const header = lines.findIndex((l) => /^\s*\[/.test(l))
  const top = header === -1 ? lines.length : header
  const keyRe = new RegExp(`^(\\s*${key}\\s*=\\s*)(.*)$`)
  const literal = JSON.stringify(value)
  const hits = lines
    .slice(0, top)
    .map((l, i) => [i, keyRe.exec(l)] as const)
    .filter(([, m]) => m)
  if (hits.length > 1) throw new SetModelError(`top-level ${key} appears ${hits.length} times`)
  if (hits.length === 1) {
    const [i, m] = hits[0]
    // Value: single-line basic or literal string + optional comment
    const vm = /^("(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$/.exec(m![2])
    if (!vm) throw new SetModelError(`${key} value is not a single-line string; not changing it`)
    lines[i] = m![1] + literal + vm[2]
  } else {
    let at = top
    while (at > 0 && lines[at - 1].trim() === '') at--
    if (header === -1 && at === lines.length) lines.push(`${key} = ${literal}`)
    else lines.splice(at, 0, `${key} = ${literal}`)
  }
  return lines.join(eol)
}

/**
 * `key = "..."` inside one [table] (Grok: [models] default). The line is changed in place, or inserted right after the header;
 * a missing table is appended. Refused when the table is written inline or as dotted keys (not safe to edit by line)
 */
function setTomlTableKey(text: string, table: string, key: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const literal = JSON.stringify(value)
  const esc = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const firstHeader = lines.findIndex((l) => /^\s*\[/.test(l))
  if (lines.slice(0, firstHeader === -1 ? lines.length : firstHeader).some((l) => new RegExp(`^\\s*${esc}\\s*[.=]`).test(l)))
    throw new SetModelError(`${table} is written inline; not changing ${table}.${key}`)
  const header = lines.findIndex((l) => new RegExp(`^\\s*\\[\\s*${esc}\\s*\\]\\s*(#.*)?$`).test(l))
  if (header === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    lines.push('', `[${table}]`, `${key} = ${literal}`, '')
    return lines.join(eol)
  }
  let end = lines.findIndex((l, i) => i > header && /^\s*\[/.test(l))
  if (end === -1) end = lines.length
  const keyRe = new RegExp(`^(\\s*${key}\\s*=\\s*)(.*)$`)
  const hits = lines
    .slice(header + 1, end)
    .map((l, i) => [header + 1 + i, keyRe.exec(l)] as const)
    .filter(([, m]) => m)
  if (hits.length > 1) throw new SetModelError(`${table}.${key} appears ${hits.length} times`)
  if (hits.length === 1) {
    const [i, m] = hits[0]
    const vm = /^("(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$/.exec(m![2])
    if (!vm) throw new SetModelError(`${table}.${key} value is not a single-line string; not changing it`)
    lines[i] = m![1] + literal + vm[2]
  } else lines.splice(header + 1, 0, `${key} = ${literal}`)
  return lines.join(eol)
}

/**
 * Change a single model key in a tool config file. SetModelError for disallowed keys, missing file, or parse failure.
 * Before writing, parse the result to confirm all other top-level keys are unchanged; otherwise don't write.
 */
export function setModel(home: string, tool: ToolId, key: string, value: string): SetModelResult {
  if (!MODEL_KEYS[tool]?.includes(key))
    throw new SetModelError(`${tool}.${key} cannot be changed`)
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 200 ||
    [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
  ) {
    throw new SetModelError('value must be a 1–200 character string without control characters')
  }
  if (!toolInUse(home, tool)) throw new SetModelError(`${tool} is not in use on this device (settings → tools in use)`)
  const t = tools(home).find((x) => x.id === tool)!
  const { path, format } = t.models
  if (!existsSync(path)) throw new SetModelError('config file not found')
  const before = readFileSync(path, 'utf8')
  const parse = (text: string): Record<string, unknown> => {
    const v = format === 'toml' ? parseToml(text) : (JSON.parse(text) as unknown)
    if (v === null || typeof v !== 'object' || Array.isArray(v))
      throw new SetModelError('top level is not an object')
    return v as Record<string, unknown>
  }
  let prevObj: Record<string, unknown>
  try {
    prevObj = parse(before)
  } catch (e) {
    throw new SetModelError(e instanceof SetModelError ? e.message : safeParseError(e, format))
  }
  const kp = keyPath(key, format)
  const previous = toDisplay(getPath(prevObj, kp))
  const base = { tool, key, path, previous }
  if (getPath(prevObj, kp) === value) return { ...base, status: 'unchanged' }

  const after =
    format === 'toml'
      ? kp.length === 2
        ? setTomlTableKey(before, kp[0], kp[1], value)
        : setTomlKey(before, key, value)
      : setJsonKey(before, key, value)
  let nextObj: Record<string, unknown>
  try {
    nextObj = parse(after)
  } catch (e) {
    throw new SetModelError(`validation of the edited result failed: ${safeParseError(e, format)}`)
  }
  // Everything except the changed key must be identical (for a nested key: its parent object minus that key, and all other top-level keys)
  const strip = (o: Record<string, unknown>): Record<string, unknown> => {
    const c = structuredClone(o)
    let cur: Record<string, unknown> | undefined = c
    for (const k of kp.slice(0, -1)) {
      const n: unknown = cur?.[k]
      cur = n && typeof n === 'object' && !Array.isArray(n) ? (n as Record<string, unknown>) : undefined
    }
    if (cur) delete cur[kp[kp.length - 1]]
    // A parent object the edit created (now empty) counts as unchanged
    if (kp.length > 1 && o === nextObj && prevObj[kp[0]] === undefined) delete c[kp[0]]
    return c
  }
  const same = isDeepStrictEqual(strip(prevObj), strip(nextObj))
  if (getPath(nextObj, kp) !== value || !same)
    throw new SetModelError('validation of the edited result failed: other keys would change')

  const backupPath = backup(path)
  try {
    atomicWrite(path, after, { expectHash: sha256(before) })
  } catch (e) {
    if (e instanceof ConcurrentChangeError)
      throw new SetModelError('file changed after it was read — try again')
    throw e
  }
  return { ...base, status: 'written', ...(backupPath ? { backupPath } : {}) }
}
