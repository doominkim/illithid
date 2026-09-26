import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolId } from './agents'
import { libraryRoot } from './config'
import { assertInsideLibrary } from './libpath'
import { atomicWrite } from './write'

/** Name of the on/off file at the library root */
export const MANIFEST_FILE = 'illithid.json'
/** on/off file names from previous app names (most recent first). Read/written only when the new file is missing (rename migration moves them) */
export const LEGACY_MANIFEST_FILES = ['harnesssync.json', 'agent-console.json'] as const

export type ManifestKind = 'rules' | 'skills' | 'mcp' | 'agents'
export const MANIFEST_KINDS: readonly ManifestKind[] = ['rules', 'skills', 'mcp', 'agents']

/** Tools that can be toggled per kind. OpenCode skills scan the library directly, so they aren't toggleable */
export const MANIFEST_TOOLS: Readonly<Record<ManifestKind, readonly ToolId[]>> = {
  rules: ['claude', 'codex', 'opencode'],
  skills: ['claude', 'codex'],
  mcp: ['claude', 'codex', 'opencode'],
  agents: ['claude', 'codex', 'opencode']
}

export type ToolToggles = Partial<Record<ToolId, boolean>>

/** A missing key means on (true). Only false is stored in the file */
export interface Manifest {
  version: 1
  rules: Record<string, ToolToggles>
  skills: Record<string, ToolToggles>
  mcp: Record<string, ToolToggles>
  agents: Record<string, ToolToggles>
  [key: string]: unknown
}

export interface ManifestRead {
  path: string
  exists: boolean
  manifest: Manifest
  error?: string
}

export class ManifestError extends Error {}

/** Manifest path in the library root. If only a previous-name file exists, that one (most recent first) */
export function manifestFileIn(root: string): string {
  const cur = join(root, MANIFEST_FILE)
  if (existsSync(cur)) return cur
  const legacy = LEGACY_MANIFEST_FILES.map((f) => join(root, f)).find((p) => existsSync(p))
  return legacy ?? cur
}

export function manifestPath(home: string): string {
  return manifestFileIn(libraryRoot(home))
}

export function emptyManifest(): Manifest {
  return { version: 1, rules: {}, skills: {}, mcp: {}, agents: {} }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Parsed value → Manifest. An error string if malformed */
export function parseManifest(raw: unknown): Manifest | string {
  if (!isObj(raw)) return 'top level is not an object'
  if (raw.version !== 1) return 'unsupported version'
  const out: Manifest = { ...raw, version: 1, rules: {}, skills: {}, mcp: {}, agents: {} }
  for (const kind of MANIFEST_KINDS) {
    const sec = raw[kind] ?? {}
    if (!isObj(sec)) return `${kind} is not an object`
    for (const [name, toggles] of Object.entries(sec)) {
      if (!isObj(toggles)) return `${kind}.${name} is not an object`
      const t: ToolToggles = {}
      for (const [tool, v] of Object.entries(toggles)) {
        if (!(MANIFEST_TOOLS[kind] as readonly string[]).includes(tool))
          return `${kind}.${name}.${tool} is an unsupported tool`
        if (typeof v !== 'boolean') return `${kind}.${name}.${tool} must be boolean`
        t[tool as ToolId] = v
      }
      out[kind][name] = t
    }
  }
  return out
}

/** Reads illithid.json. If missing, everything is on */
export function readManifest(home: string): ManifestRead {
  const path = manifestPath(home)
  if (!existsSync(path)) return { path, exists: false, manifest: emptyManifest() }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { path, exists: true, manifest: emptyManifest(), error: 'JSON parse failed' }
  }
  const m = parseManifest(raw)
  if (typeof m === 'string') return { path, exists: true, manifest: emptyManifest(), error: m }
  return { path, exists: true, manifest: m }
}

/** Whether enabled. true if there is no manifest */
export function isEnabled(
  m: Manifest | undefined,
  kind: ManifestKind,
  name: string,
  tool: ToolId
): boolean {
  return m?.[kind]?.[name]?.[tool] !== false
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * Saves a toggle (atomic write of the library's illithid.json). Does not apply to tools.
 * on=true removes the key (and prunes empty objects). Returns the updated manifest.
 */
export function setToggle(
  home: string,
  kind: ManifestKind,
  name: string,
  tool: ToolId,
  on: boolean
): Manifest {
  if (!MANIFEST_KINDS.includes(kind)) throw new ManifestError(`unknown kind: ${String(kind)}`)
  if (!(MANIFEST_TOOLS[kind] as readonly string[]).includes(tool))
    throw new ManifestError(`${kind} does not support ${String(tool)} toggles`)
  if (!NAME_RE.test(name) || (kind === 'rules' && !name.endsWith('.md')))
    throw new ManifestError('invalid name format')
  const cur = readManifest(home)
  if (cur.error) throw new ManifestError(`${MANIFEST_FILE}: ${cur.error}`)
  const m: Manifest = structuredClone(cur.manifest)
  const entry: ToolToggles = { ...(m[kind][name] ?? {}) }
  if (on) delete entry[tool]
  else entry[tool] = false
  if (Object.keys(entry).length) m[kind][name] = entry
  else delete m[kind][name]
  const target = assertInsideLibrary(home, cur.path)
  atomicWrite(target, JSON.stringify(m, null, 2) + '\n', existsSync(target) ? {} : { mode: 0o644 })
  return m
}

/**
 * Moves the kind.<from> toggle to kind.<to> on rename (to's old key is replaced by or removed with from's value).
 * Writes nothing if unchanged. true if changed
 */
export function renameManifestEntry(home: string, kind: ManifestKind, from: string, to: string): boolean {
  if (!MANIFEST_KINDS.includes(kind)) throw new ManifestError(`unknown kind: ${String(kind)}`)
  if (!NAME_RE.test(from) || !NAME_RE.test(to)) throw new ManifestError('invalid name format')
  const cur = readManifest(home)
  if (cur.error) throw new ManifestError(`${MANIFEST_FILE}: ${cur.error}`)
  const sec = cur.manifest[kind]
  const hasFrom = Object.prototype.hasOwnProperty.call(sec, from)
  const hasTo = Object.prototype.hasOwnProperty.call(sec, to)
  if (!hasFrom && !hasTo) return false
  const m: Manifest = structuredClone(cur.manifest)
  const moved = m[kind][from]
  delete m[kind][from]
  delete m[kind][to]
  if (moved && Object.keys(moved).length) m[kind][to] = moved
  const target = assertInsideLibrary(home, cur.path)
  atomicWrite(target, JSON.stringify(m, null, 2) + '\n', existsSync(target) ? {} : { mode: 0o644 })
  return true
}
