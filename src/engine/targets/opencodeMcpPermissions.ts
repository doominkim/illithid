/**
 * opencode.json `permission` — MCP servers' tool rules (mcpPermissions.ts) as OpenCode tool-name patterns: `<server>_*` for the
 * server's default, then `<server>_<tool>` for each tool. OpenCode applies the last matching rule, so each server's catch-all
 * goes before its tools, and the app's keys go after the user's. Keys the sync wrote before and no longer wants are removed;
 * every other key is the user's and stays in place.
 * OpenCode names an MCP tool `<server>_<tool>` with characters outside [A-Za-z0-9_-] turned into `_`.
 * Checked 2026-10-03: opencode.ai/docs/permissions ("the last matching rule winning"), opencode.ai/docs/tools
 */
import { isEnabled } from '../manifest'
import { mcpPermissionsOf } from '../mcpPermissions'
import { mcpEntries, parseJsonObject, toJsonText, untouchedKeysSame } from '../text'
import type { BuildContext, TargetDef, TargetId } from '../types'
import { previouslyOwned } from './toggles'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

const KEY = 'permission'
const ID: TargetId = 'opencodeMcpPermissions'

const ocName = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_')

/** The app's permission entries, in the order they must appear */
function wanted(ctx: BuildContext): [string, string][] {
  if (ctx.retiring) return []
  const out: [string, string][] = []
  for (const [name, s] of mcpEntries(ctx.sources.mcp)) {
    if (!isEnabled(ctx.sources.manifest, 'mcp', name, 'opencode')) continue
    const p = mcpPermissionsOf(s, ctx.sources.allowlist.mcpDefault)
    const server = ocName(name)
    if (p.default) out.push([`${server}_*`, p.default])
    for (const [tool, d] of Object.entries(p.tools ?? {}).sort(([a], [b]) => a.localeCompare(b)))
      out.push([`${server}_${ocName(tool)}`, d])
  }
  return out
}

export const opencodeMcpPermissions: TargetDef = {
  id: ID,
  tool: 'opencode',
  rel: '.config/opencode/opencode.json',
  optional: true,
  alternates: ['.config/opencode/opencode.jsonc'],
  region: (text, _src, ctx) => {
    try {
      const perm = parseJsonObject(text)[KEY]
      if (!isObj(perm)) return null
      const names = new Set(previouslyOwned(ctx, ID))
      const own = Object.entries(perm).filter(([k]) => names.has(k))
      return own.length ? JSON.stringify(own) : null
    } catch {
      return null
    }
  },
  build(before, ctx) {
    if (!before.trim()) return { after: before, notes: ['opencode.json missing — left untouched'] }
    const config = parseJsonObject(before)
    const want = wanted(ctx)
    const prev = new Set(previouslyOwned(ctx, ID))
    const owned = want.map(([k]) => k)
    const perm = config[KEY]
    if (perm !== undefined && !isObj(perm)) {
      if (!want.length)
        return { after: before, notes: [`${KEY} is not an object — left untouched`] }
      return { after: before, notes: [], error: `${KEY} is not an object` }
    }
    const current = perm ?? {}
    const mine = new Set([...prev, ...owned])
    const kept = Object.entries(current).filter(([k]) => !mine.has(k))
    const nextPerm: Json = Object.fromEntries([...kept, ...want])
    if (JSON.stringify(Object.entries(nextPerm)) === JSON.stringify(Object.entries(current)))
      return { after: before, notes: [`${want.length} MCP tool rule(s) — already in place`], owned }
    const next = structuredClone(config)
    if (Object.keys(nextPerm).length) next[KEY] = nextPerm
    else delete next[KEY]
    const after = toJsonText(next, before)
    const rest = untouchedKeysSame(config, next, KEY)
    const keptSame = kept.every(([k, v]) => JSON.stringify(nextPerm[k]) === JSON.stringify(v))
    const ok = rest.same && keptSame
    const notes = [
      `${KEY}: ${want.length} MCP tool rule(s), kept ${kept.length} other(s)`,
      `everything other than the app's ${KEY} keys unchanged: ${ok ? 'OK' : 'broken!'}`
    ]
    return ok
      ? { after, notes, owned }
      : { after, notes, owned, error: `keys other than the app's ${KEY} keys changed` }
  }
}
