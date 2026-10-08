import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import fg from 'fast-glob'
import { tilde } from '../agents'
import { isUnder, toPosix } from '../pathUtil'
import { expandHome, libraryRoot, readConfig } from '../config'
import { pathId, readHead } from './common'

export type ArtifactKind = 'md' | 'html' | 'image' | 'other'

/** Tool that produced the artifact */
export type ArtifactTool = 'claude' | 'codex' | 'opencode' | 'cursor' | 'unknown'

export interface Artifact {
  id: string
  title: string
  path: string
  /** Source location label */
  source: string
  project?: string
  kind: ArtifactKind
  tool: ArtifactTool
  size: number
  /** ISO 8601 */
  mtime: string
  /** Session that made it (Codex generated images: the folder is the session id), with its title from the session index */
  sessionId?: string
  sessionTitle?: string
}

/**
 * Source location.
 * - dir: every file under root
 * - plans-under: files in `.plans` directories within depth levels under root
 */
export interface ArtifactSource {
  label: string
  root: string
  mode: 'dir' | 'plans-under'
  depth?: number
  /** 'first-segment': uses the directory name directly under root as the project */
  project?: 'first-segment'
  /** Tool that produced files in this location. If unset, decided by root path rules, then manifest.json */
  tool?: ArtifactTool
}

/** manifest.json is metadata for tool detection, so it is excluded from the artifact list */
const IGNORE = ['**/node_modules/**', '**/.git/**', '**/manifest.json']
const HEAD_LIMIT = 4096

/**
 * Default source locations (when config.artifactSources is unset): standard tool plan paths and library artifacts.
 * Only existing paths are included. Other locations are added via config (artifactSources).
 */
export function defaultArtifactSources(home: string): ArtifactSource[] {
  const dir = (rel: string, project?: 'first-segment'): ArtifactSource => ({
    label: `~/${rel}`,
    root: join(home, rel),
    mode: 'dir',
    project
  })
  const libArtifacts = join(libraryRoot(home), 'artifacts')
  return [
    dir('.claude/plans'),
    dir('.codex/generated_images', 'first-segment'),
    {
      label: tilde(home, libArtifacts),
      root: libArtifacts,
      mode: 'dir' as const,
      project: 'first-segment' as const
    },
    dir('.cursor/plans'),
    dir('.omx/plans')
  ].filter((s) => existsSync(s.root))
}

/** Effective source locations: the defaults, then config.artifactSources (bad or repeated roots are dropped) */
export function artifactSources(home: string): ArtifactSource[] {
  const out = defaultArtifactSources(home)
  const seen = new Set(out.map((s) => s.root))
  for (const c of configuredArtifactSources(home)) {
    if (seen.has(c.root)) continue
    seen.add(c.root)
    out.push(c)
  }
  return out
}

/** config.artifactSources with roots expanded (~/ and absolute only; trailing separators removed). Not deduplicated */
function configuredArtifactSources(home: string): ArtifactSource[] {
  const out: ArtifactSource[] = []
  for (const c of readConfig(home).config.artifactSources ?? []) {
    const expanded = expandHome(home, c.root)
    if (!expanded) continue
    const root = expanded.replace(/[\\/]+$/, '') || expanded
    out.push({
      label: c.label ?? artifactSourceKey(home, root),
      root,
      mode: c.mode ?? 'dir',
      ...(c.depth ? { depth: c.depth } : {}),
      ...(c.project ? { project: c.project } : {})
    })
  }
  return out
}

/** `~/…` with forward slashes for a path under home (the form config.json and the Settings list use on every platform), else the path */
export function artifactSourceKey(home: string, p: string): string {
  return isUnder(home, p) ? '~/' + toPosix(relative(home, p)) : p
}

/** One row of the Settings list: built-in locations (existing ones only) first, then every configured one */
export interface ArtifactSourceEntry {
  label: string
  /** ~ form, the key for removing a configured entry */
  root: string
  builtin: boolean
  exists: boolean
}

export function listArtifactSources(home: string): ArtifactSourceEntry[] {
  const out: ArtifactSourceEntry[] = defaultArtifactSources(home).map((s) => ({
    label: s.label,
    root: artifactSourceKey(home, s.root),
    builtin: true,
    exists: true
  }))
  const seen = new Set(out.map((s) => s.root))
  for (const c of configuredArtifactSources(home)) {
    const root = artifactSourceKey(home, c.root)
    if (seen.has(root)) continue
    seen.add(root)
    out.push({ label: c.label, root, builtin: false, exists: existsSync(c.root) })
  }
  return out
}

/** Location rule: a tool-specific directory under HOME maps to that tool */
const LOCATION_TOOL: [string, ArtifactTool][] = [
  ['.claude', 'claude'],
  ['.codex', 'codex'],
  ['.omx', 'codex'], // oh-my-codex
  ['.cursor', 'cursor']
]

export function toolOfLocation(home: string, root: string): ArtifactTool | undefined {
  const rel = relative(home, root)
  if (!rel || rel.startsWith('..')) return undefined
  const top = rel.split(sep)[0]
  return LOCATION_TOOL.find(([d]) => d === top)?.[1]
}

/** manifest.json tool string -> tool */
const MANIFEST_TOOL: [RegExp, ArtifactTool][] = [
  [/claude/i, 'claude'],
  [/codex|image_gen|gpt|openai/i, 'codex'],
  [/opencode/i, 'opencode'],
  [/cursor/i, 'cursor']
]

/** If several tools are listed, the one appearing first in the string (the tool that made the draft) */
export function toolOfManifestString(s: string): ArtifactTool {
  let best: { at: number; tool: ArtifactTool } | null = null
  for (const [re, tool] of MANIFEST_TOOL) {
    const at = s.search(re)
    if (at >= 0 && (!best || at < best.at)) best = { at, tool }
  }
  return best?.tool ?? 'unknown'
}

/** Per-directory manifest.json result cache. Each directory is read once */
export interface ManifestCache {
  /** dir -> result from that directory's manifest.json (missing or no tool = null) */
  byDir: Map<string, ArtifactTool | null>
  /** Number of times manifest.json was actually read */
  reads: number
}

export const newManifestCache = (): ManifestCache => ({ byDir: new Map(), reads: 0 })

function manifestToolAt(dir: string, cache: ManifestCache): ArtifactTool | null {
  const hit = cache.byDir.get(dir)
  if (hit !== undefined) return hit
  let tool: ArtifactTool | null = null
  const p = join(dir, 'manifest.json')
  if (existsSync(p)) {
    cache.reads++
    try {
      const o = JSON.parse(readFileSync(p, 'utf8')) as { tool?: unknown }
      if (typeof o?.tool === 'string' && o.tool.trim()) tool = toolOfManifestString(o.tool)
    } catch {
      tool = null
    }
  }
  cache.byDir.set(dir, tool)
  return tool
}

/** tool from the nearest manifest.json, walking up from the file directory to root */
function toolFromManifests(file: string, root: string, cache: ManifestCache): ArtifactTool {
  let dir = dirname(file)
  for (;;) {
    const t = manifestToolAt(dir, cache)
    if (t) return t
    if (dir === root) return 'unknown'
    const up = dirname(dir)
    const rel = relative(root, up)
    if (up === dir || rel.startsWith('..')) return 'unknown'
    dir = up
  }
}

function kindOf(path: string): ArtifactKind {
  const ext = extname(path).toLowerCase()
  if (['.md', '.markdown', '.mdx'].includes(ext)) return 'md'
  if (['.html', '.htm'].includes(ext)) return 'html'
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'].includes(ext)) return 'image'
  return 'other'
}

/** First `#` heading for md, <title> for html. Reads only the first 4KB. */
function titleOf(path: string, kind: ArtifactKind, size: number): string {
  const fallback = basename(path)
  if (kind !== 'md' && kind !== 'html') return fallback
  let head: string
  try {
    head = readHead(path, size, HEAD_LIMIT)
  } catch {
    return fallback
  }
  const m =
    kind === 'md'
      ? /^#[ \t]+(.+?)[ \t#]*$/m.exec(head)
      : (/<title[^>]*>([^<]+)<\/title>/i.exec(head) ?? /<h1[^>]*>([^<]+)<\/h1>/i.exec(head))
  const t = m?.[1]?.trim()
  return t ? t : fallback
}

function listFiles(root: string): fg.Entry[] {
  return fg.sync('**/*', {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    suppressErrors: true,
    stats: true,
    ignore: IGNORE
  })
}

function plansDirs(root: string, depth: number): string[] {
  return fg.sync('**/.plans', {
    cwd: root,
    absolute: true,
    onlyDirectories: true,
    dot: true,
    deep: depth,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: IGNORE
  })
}

function toArtifact(
  e: fg.Entry,
  source: ArtifactSource,
  tool: ArtifactTool,
  project?: string
): Artifact {
  const size = e.stats?.size ?? 0
  const kind = kindOf(e.path)
  return {
    id: pathId(e.path),
    title: titleOf(e.path, kind, size),
    path: e.path,
    source: source.label,
    project,
    kind,
    tool,
    size,
    mtime: (e.stats?.mtime ?? new Date(0)).toISOString()
  }
}

/** Read-only scan. Sorted by mtime descending. */
export function scanArtifacts(
  home: string,
  sources?: ArtifactSource[],
  cache: ManifestCache = newManifestCache()
): Artifact[] {
  const out = new Map<string, Artifact>()
  for (const src of sources ?? artifactSources(home)) {
    if (!existsSync(src.root)) continue
    const fixed = src.tool ?? toolOfLocation(home, src.root)
    const toolOf = (file: string, base: string): ArtifactTool =>
      fixed ?? toolFromManifests(file, base, cache)
    if (src.mode === 'dir') {
      for (const e of listFiles(src.root)) {
        if (out.has(e.path)) continue
        let project: string | undefined
        if (src.project === 'first-segment') {
          const parts = relative(src.root, e.path).split(sep)
          if (parts.length > 1) project = parts[0]
        }
        out.set(e.path, toArtifact(e, src, toolOf(e.path, src.root), project))
      }
    } else {
      for (const dir of plansDirs(src.root, src.depth ?? 4)) {
        const project = basename(dirname(dir))
        for (const e of listFiles(dir)) {
          if (!out.has(e.path))
            out.set(e.path, toArtifact(e, src, toolOf(e.path, src.root), project))
        }
      }
    }
  }
  return [...out.values()].sort((a, b) => b.mtime.localeCompare(a.mtime))
}
