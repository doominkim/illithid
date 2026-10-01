/**
 * Where marketplace items came from: `<library>/market.json`. Used for the installed badge and update checks.
 * Entries whose library item no longer exists are ignored (renames and deletes leave them stale on purpose).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { libraryRoot } from '../config'
import { assertInsideLibrary } from '../libpath'
import { atomicWrite } from '../write'

export const MARKET_FILE = 'market.json'

export type MarketKind = 'skill' | 'mcp' | 'rule'
export type MarketSource = 'skills.sh' | 'mcp-registry' | 'awesome-copilot'

export interface MarketOrigin {
  kind: MarketKind
  /** Library name (rules include .md) */
  name: string
  source: MarketSource
  /** Source id: `owner/repo/skillId`, registry server name, or rule id */
  id: string
  /** Version marker: skill folder tree SHA, server version, or rule lastUpdated */
  ref: string
  /** Skills only: folder in the repository ('' = root) */
  path?: string
  /** MCP only: install option (`package:<i>` / `remote:<i>`) */
  choice?: string
  /** MCP package installs: registry type and identifier (OCI without tag), used to match across versions */
  pkg?: { type: string; id: string }
  installedAt: string
}

interface MarketFile {
  version: 1
  items: Record<string, MarketOrigin>
}

function filePath(home: string): string {
  return join(libraryRoot(home), MARKET_FILE)
}

export function originKey(kind: MarketKind, name: string): string {
  return `${kind}:${name}`
}

export function readOrigins(home: string): Record<string, MarketOrigin> {
  const p = filePath(home)
  if (!existsSync(p)) return {}
  try {
    const f = JSON.parse(readFileSync(p, 'utf8')) as MarketFile
    return f && typeof f.items === 'object' && f.items ? f.items : {}
  } catch {
    return {}
  }
}

export function recordOrigin(home: string, o: MarketOrigin): void {
  const items = { ...readOrigins(home), [originKey(o.kind, o.name)]: o }
  const sorted = Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b)))
  atomicWrite(
    assertInsideLibrary(home, filePath(home)),
    JSON.stringify({ version: 1, items: sorted }, null, 2) + '\n',
    { mode: 0o644 }
  )
}

/** Library path of an item (for existence checks) */
export function itemPath(home: string, kind: MarketKind, name: string): string {
  const root = libraryRoot(home)
  if (kind === 'skill') return join(root, 'skills', name)
  if (kind === 'rule') return join(root, 'rules', name)
  return join(root, 'mcps', `${name}.json`)
}

export function itemExists(home: string, kind: MarketKind, name: string): boolean {
  return existsSync(itemPath(home, kind, name))
}

const KINDS: readonly MarketKind[] = ['skill', 'mcp', 'rule']
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** market.json can arrive in an imported zip: only well-formed entries are looked at */
function validOrigin(o: unknown): o is MarketOrigin {
  const x = o as MarketOrigin
  return (
    !!x &&
    typeof x === 'object' &&
    KINDS.includes(x.kind) &&
    typeof x.name === 'string' &&
    NAME_RE.test(x.name) &&
    !x.name.includes('..') &&
    typeof x.id === 'string' &&
    typeof x.ref === 'string'
  )
}

/** Origins whose library item still exists */
export function liveOrigins(home: string): MarketOrigin[] {
  return Object.values(readOrigins(home)).filter(
    (o) => validOrigin(o) && itemExists(home, o.kind, o.name)
  )
}
