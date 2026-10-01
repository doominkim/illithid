/**
 * Reads the library (source). Layout (M7d, default `<home>/.illithid`):
 *
 *   rules/*.md            shared rules
 *   skills/<name>/        skills
 *   agents/<name>.md      agents (per-tool model/effort + instructions)
 *   mcps/<server>.json    MCP server definitions (file name = server name, content = definition + optional `_` meta)
 *   permissions.json      allowlist (bash · claudeOnly)
 *   memory/MEMORY.md      memory index (+ topic files below)
 *   illithid.json         on/off manifest
 *
 * Without a library: empty sources (not an error) + libraryExists=false. First-run detection uses this.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { libraryRoot, toolsRetiring } from './config'
import { manifestFileIn, readManifest, MANIFEST_FILE } from './manifest'
import { readHooks } from './hooks'
import type { Allowlist, McpServer, McpSource, RuleFile, Sources } from './types'

export interface LibraryPaths {
  root: string
  rulesDir: string
  skillsDir: string
  /** Agent source agents/<name>.md (created on first creation) */
  agentsDir: string
  memoryDir: string
  memoryIndex: string
  mcpsDir: string
  permissions: string
  manifest: string
}

/** Library path table (absolute). Root is config.libraryPath ?? <home>/.illithid */
export function libraryPaths(home: string): LibraryPaths {
  const root = libraryRoot(home)
  return {
    root,
    rulesDir: join(root, 'rules'),
    skillsDir: join(root, 'skills'),
    agentsDir: join(root, 'agents'),
    memoryDir: join(root, 'memory'),
    memoryIndex: join(root, 'memory/MEMORY.md'),
    mcpsDir: join(root, 'mcps'),
    permissions: join(root, 'permissions.json'),
    manifest: manifestFileIn(root)
  }
}

/**
 * @deprecated Pre-M7c names. Kept for compatibility — `allowlist` is permissions.json, `mcp` is the mcps/ directory.
 * New code uses libraryPaths.
 */
export function agentsPaths(home: string): {
  agentsDir: string
  rulesDir: string
  memoryIndex: string
  allowlist: string
  mcp: string
} {
  const p = libraryPaths(home)
  return {
    agentsDir: p.root,
    rulesDir: p.rulesDir,
    memoryIndex: p.memoryIndex,
    allowlist: p.permissions,
    mcp: p.mcpsDir
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Whether the library root exists as a directory */
export function libraryExists(home: string): boolean {
  return isDir(libraryRoot(home))
}

/** Read rules/*.md sorted by file name. Empty list if the directory is missing */
export function readRules(home: string): RuleFile[] {
  const { rulesDir } = libraryPaths(home)
  if (!isDir(rulesDir)) return []
  return readdirSync(rulesDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(rulesDir, name), 'utf8') }))
}

export function readMemoryIndex(home: string): string | null {
  const { memoryIndex } = libraryPaths(home)
  return existsSync(memoryIndex) ? readFileSync(memoryIndex, 'utf8') : null
}

/** Empty allowlist (when permissions.json is missing) */
export function emptyAllowlist(): Allowlist {
  return { bash: [], claudeOnly: { allow: [], deny: [] } }
}

/** permissions.json. null if missing (permission targets are left alone) */
export function readPermissionsFile(home: string): Allowlist | null {
  const { permissions } = libraryPaths(home)
  if (!existsSync(permissions)) return null
  return JSON.parse(readFileSync(permissions, 'utf8')) as Allowlist
}

/** @deprecated readPermissionsFile — returns an empty allowlist if missing */
export function readAllowlist(home: string): Allowlist {
  return readPermissionsFile(home) ?? emptyAllowlist()
}

/** Server order file (`mcps/_order.json` — array of names). Listed servers come first in that order, the rest by name */
export const MCP_ORDER_FILE = '_order.json'

/** Names in _order.json. [] if missing or broken */
export function readMcpOrder(dir: string): string[] {
  const p = join(dir, MCP_ORDER_FILE)
  if (!existsSync(p)) return []
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * Server file name → server name. Files starting with `_` or `.` are meta/hidden, not servers.
 * Order: entries in _order.json first (in that order), the rest by name.
 */
export function mcpServerNamesInDir(dir: string): string[] {
  if (!isDir(dir)) return []
  const present = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.') && !f.startsWith('_'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort()
  const set = new Set(present)
  const ordered = [...new Set(readMcpOrder(dir))].filter((n) => set.has(n))
  const rest = present.filter((n) => !ordered.includes(n))
  return [...ordered, ...rest]
}

/**
 * mcps/*.json → McpSource. `_` keys (meta) are dropped from the source (they stay in the file).
 * Parse failures throw (the source is broken — not a per-target error).
 */
export function readMcp(home: string): McpSource {
  const { mcpsDir } = libraryPaths(home)
  const servers: Record<string, McpServer> = {}
  for (const name of mcpServerNamesInDir(mcpsDir)) {
    const raw = JSON.parse(readFileSync(join(mcpsDir, `${name}.json`), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error(`mcps/${name}.json: top level is not an object`)
    const { _, ...def } = raw as Record<string, unknown>
    void _
    servers[name] = def as McpServer
  }
  return { servers }
}

/**
 * The whole library source. Empty sources if there is no library (libraryExists=false).
 * Broken source files throw as-is (not a per-target error).
 * A broken illithid.json (on/off) throws rather than being treated as all-on
 * (so disabled items are not silently re-applied).
 */
export function readSources(home: string): Sources {
  const paths = libraryPaths(home)
  const exists = isDir(paths.root)
  if (!exists) {
    return {
      agentsDir: paths.root,
      libraryExists: false,
      rules: [],
      memoryIndex: null,
      allowlist: emptyAllowlist(),
      hasPermissions: false,
      mcp: { servers: {} }
    }
  }
  const m = readManifest(home)
  if (m.error) throw new Error(`${MANIFEST_FILE}: ${m.error}`)
  const permissions = readPermissionsFile(home)
  return {
    agentsDir: paths.root,
    libraryExists: true,
    rules: readRules(home),
    memoryIndex: readMemoryIndex(home),
    allowlist: permissions ?? emptyAllowlist(),
    hasPermissions: permissions !== null,
    mcp: readMcp(home),
    manifest: m.manifest,
    hooks: readHooks(home)
  }
}

/** Sources as the sync plans them: retiring tools read as off for every item (see readPlanManifest) */
export function readPlanSources(home: string): Sources {
  const s = readSources(home)
  const off = toolsRetiring(home)
  return off.length && s.manifest ? { ...s, manifest: { ...s.manifest, offTools: off } } : s
}
