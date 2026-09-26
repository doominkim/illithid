import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolId } from '../agents'
import {
  appDataRoot,
  LEGACY_APP_GENERATIONS,
  WORKSPACE_ID_RE,
  WORKSPACES_DIR,
  workspaceIds
} from '../config'
import { isEnabled } from '../manifest'
import { mcpEntries } from '../text'
import type { BuildContext, McpSource, Sources, TargetId } from '../types'

/** mcp.json with only the servers enabled for the tool (`_` meta keys kept) */
export function mcpForTool(sources: Sources, tool: ToolId): McpSource {
  const m = sources.manifest
  if (!m) return sources.mcp
  const servers = Object.fromEntries(
    Object.entries(sources.mcp.servers).filter(
      ([name]) => name.startsWith('_') || isEnabled(m, 'mcp', name, tool)
    )
  )
  return { ...sources.mcp, servers }
}

/** Names of servers enabled for the tool */
export function enabledServerNames(sources: Sources, tool: ToolId): string[] {
  return mcpEntries(mcpForTool(sources, tool)).map(([n]) => n)
}

/** Previously owned entries recorded in state */
export function previouslyOwned(ctx: BuildContext | undefined, id: TargetId): string[] {
  return ctx?.owned?.[id] ?? []
}

/** Workspace folder ids (only well-formed directories) */
function dirIds(root: string): string[] {
  try {
    return readdirSync(root).filter((n) => WORKSPACE_ID_RE.test(n) && statSync(join(root, n)).isDirectory())
  } catch {
    return []
  }
}

/**
 * Aliases of an app library path entry — every app library location with the same relative path (absolute and `~/` forms):
 * for each current or previous app data root (`~/.illithid`, `~/.harnesssync`), every workspace on disk (`<root>/workspaces/<id>/x`)
 * and the pre-workspace root layout (`<root>/x`), plus the previous app name whose library was the root (`~/.agent-console/x`).
 * Lets entries written to tool config before a workspace switch, migration, or rename be recognized as app-owned.
 */
export function legacyLibraryAliases(home: string | undefined, items: string[]): string[] {
  if (!home) return []
  const h = home
  const dataRoots = [
    appDataRoot(h),
    ...LEGACY_APP_GENERATIONS.filter((g) => g.layout === 'root').map((g) => join(h, g.libraryDir))
  ]
  const libRoots = LEGACY_APP_GENERATIONS.filter((g) => g.layout === 'library').map((g) =>
    join(h, g.libraryDir)
  )
  const ids = new Set(workspaceIds(h))
  for (const r of dataRoots) for (const id of dirIds(join(r, WORKSPACES_DIR))) ids.add(id)
  const roots = [
    ...dataRoots,
    ...libRoots,
    ...dataRoots.flatMap((r) => [...ids].map((id) => join(r, WORKSPACES_DIR, id)))
  ]
  const out = new Set<string>()
  for (const x of items) {
    const abs = x.startsWith('~/') ? join(h, x.slice(2)) : x
    let rel: string | null = null
    for (const r of dataRoots) {
      const ws = join(r, WORKSPACES_DIR)
      if (abs.startsWith(ws + '/')) {
        const rest = abs.slice(ws.length + 1)
        const i = rest.indexOf('/')
        rel = i < 0 ? '' : rest.slice(i)
      } else if (abs === r || abs.startsWith(r + '/')) rel = abs.slice(r.length)
      if (rel !== null) break
    }
    if (rel === null)
      for (const r of libRoots) if (abs === r || abs.startsWith(r + '/')) rel = abs.slice(r.length)
    if (rel === null) continue
    for (const r of roots) {
      const p = r + rel
      out.add(p)
      out.add('~' + p.slice(h.length))
    }
  }
  return [...out]
}

/** Owned region names = currently enabled servers ∪ previously owned servers */
export function ownedServerNames(
  sources: Sources,
  tool: ToolId,
  ctx: BuildContext | undefined,
  id: TargetId
): string[] {
  return [...new Set([...enabledServerNames(sources, tool), ...previouslyOwned(ctx, id)])]
}

/** Servers the app previously owned that are now disabled or gone from the source */
export function staleServerNames(
  sources: Sources,
  tool: ToolId,
  ctx: BuildContext | undefined,
  id: TargetId
): string[] {
  const on = new Set(enabledServerNames(sources, tool))
  return previouslyOwned(ctx, id).filter((n) => !on.has(n) && !n.startsWith('_'))
}

/** Servers in the source that are disabled for this tool but have no app-ownership record (may remain in tool config) */
export function disabledUnownedServers(
  sources: Sources,
  tool: ToolId,
  ctx: BuildContext | undefined,
  id: TargetId
): string[] {
  const on = new Set(enabledServerNames(sources, tool))
  const prev = new Set(previouslyOwned(ctx, id))
  return mcpEntries(sources.mcp)
    .map(([n]) => n)
    .filter((n) => !on.has(n) && !prev.has(n))
}
