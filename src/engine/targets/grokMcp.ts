/**
 * ~/.grok/config.toml — library MCP servers as [mcp_servers.<name>] tables inside the app marker block (same markers and
 * outside-the-block handling as Codex). Grok's server keys: command, args, env, url, headers. Grok expands ${VAR} itself, so
 * those stay as written; `secret:` references are resolved to their values (like every other tool that has no Keychain access).
 */
import { parse as parseToml } from 'smol-toml'
import {
  blockBodyMulti,
  mcpEntries,
  outsideBlockMulti,
  presentMarkers,
  removeBlockMulti,
  spliceBlockMulti,
  toggleNotes
} from '../text'
import type { SecretBackend } from '../secrets'
import type { Env, McpSource, TargetDef } from '../types'
import {
  extractCodexTables,
  LEGACY_TOML_MCP_MARKERS,
  stripCodexManagedTables,
  TOML_MCP_MARKERS
} from './codexMcp'
import { GROK_COMPAT_MARKERS } from './grokCompat'
import { isServerError, renderHttpHeaders, renderValue } from './mcpRender'
import {
  disabledUnownedServers,
  enabledServerNames,
  mcpForTool,
  ownedServerNames,
  staleServerNames
} from './toggles'

const ALL_MARKERS = [TOML_MCP_MARKERS, ...LEGACY_TOML_MCP_MARKERS]

const tomlString = (v: unknown): string => JSON.stringify(v)
const tomlKey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k))

/** Grok-only server keys the library doesn't model: kept from the user's previous table of the same name */
export const GROK_KEPT_SERVER_KEYS = ['enabled', 'tool_timeout_sec', 'tool_timeouts'] as const

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

function tomlInline(v: unknown): string | null {
  if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return String(v)
  if (typeof v === 'string') return tomlString(v)
  if (isObj(v)) {
    const parts: string[] = []
    for (const [k, x] of Object.entries(v)) {
      const r = tomlInline(x)
      if (r === null) return null
      parts.push(`${tomlKey(k)} = ${r}`)
    }
    return `{ ${parts.join(', ')} }`
  }
  return null
}

/** Library servers → Grok tables. A server whose secret can't be resolved keeps its previous table (from prevBody) */
export function buildGrokMcpBody(
  mcp: McpSource,
  env: Env,
  secrets?: SecretBackend,
  prevBody = '',
  kept: Record<string, Json> = {}
): { body: string; serverErrors: Record<string, string> } {
  const lines: string[] = []
  const serverErrors: Record<string, string> = {}
  for (const [name, s] of mcpEntries(mcp)) {
    const key = /^[A-Za-z0-9_]+$/.test(name) ? name : tomlString(name)
    const out: string[] = []
    try {
      out.push(`[mcp_servers.${key}]`)
      if (s.transport === 'stdio') {
        out.push(`command = ${tomlString(s.command)}`)
        out.push(`args = [${(s.args ?? []).map(tomlString).join(', ')}]`)
        if (s.timeoutMs) out.push(`startup_timeout_sec = ${Math.ceil(s.timeoutMs / 1000)}`)
        for (const k of GROK_KEPT_SERVER_KEYS) {
          const v = kept[name]?.[k] === undefined ? null : tomlInline(kept[name][k])
          if (v !== null) out.push(`${k} = ${v}`)
        }
        if (s.env && Object.keys(s.env).length) {
          out.push('', `[mcp_servers.${key}.env]`)
          for (const [k, v] of Object.entries(s.env))
            out.push(`${tomlKey(k)} = ${tomlString(renderValue(v, 'claude', env, secrets))}`)
        }
      } else {
        out.push(`url = ${tomlString(s.url)}`)
        for (const k of GROK_KEPT_SERVER_KEYS) {
          const v = kept[name]?.[k] === undefined ? null : tomlInline(kept[name][k])
          if (v !== null) out.push(`${k} = ${v}`)
        }
        const headers = renderHttpHeaders(s, 'claude', env, secrets)
        if (Object.keys(headers).length) {
          out.push('', `[mcp_servers.${key}.headers]`)
          for (const [k, v] of Object.entries(headers))
            out.push(`${tomlString(k)} = ${tomlString(v)}`)
        }
      }
    } catch (e) {
      if (!isServerError(e)) throw e
      serverErrors[name] = e.message
      const prev = extractCodexTables(prevBody, name)
      if (prev.length) lines.push(...prev, '')
      continue
    }
    lines.push(...out, '')
  }
  return { body: lines.join('\n').trimEnd(), serverErrors }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Removes app-owned server tables outside the MCP block without touching the compat block: a table is stripped up to the next
 * `[` line, so comment lines after it — the compat block's BEGIN marker — would go with it
 */
function stripOwnedTables(text: string, names: string[]): string {
  const p = presentMarkers(text, [GROK_COMPAT_MARKERS])
  if (!p) return stripCodexManagedTables(text, names)
  const i = text.indexOf(p[0])
  const j = text.indexOf(p[1]) + p[1].length
  return (
    stripCodexManagedTables(text.slice(0, i), names) +
    text.slice(i, j) +
    stripCodexManagedTables(text.slice(j), names)
  )
}

export const grokMcp: TargetDef = {
  id: 'grokMcp',
  tool: 'grok',
  rel: '.grok/config.toml',
  optional: false,
  createIfInUse: true,
  region: (text) => blockBodyMulti(text, ALL_MARKERS),
  build(before, ctx) {
    const { sources, env } = ctx
    const stripped = stripOwnedTables(
      outsideBlockMulti(before, ALL_MARKERS),
      ownedServerNames(sources, 'grok', ctx, 'grokMcp')
    )
    // Grok-only keys on the user's (or the app's previous) tables of the same name are carried over
    const kept: Record<string, Json> = {}
    try {
      const prev = parseToml(before) as Json
      if (isObj(prev.mcp_servers))
        for (const [n, d] of Object.entries(prev.mcp_servers))
          if (isObj(d)) {
            const k = Object.fromEntries(
              GROK_KEPT_SERVER_KEYS.filter((x) => d[x] !== undefined).map((x) => [x, d[x]])
            )
            if (Object.keys(k).length) kept[n] = k
          }
    } catch {
      // unparsable before: the result check below refuses anyway
    }
    const { body, serverErrors } = buildGrokMcpBody(
      mcpForTool(sources, 'grok'),
      env,
      ctx.secrets,
      before,
      kept
    )
    const enabled = enabledServerNames(sources, 'grok')
    const after = enabled.length
      ? spliceBlockMulti(stripped, TOML_MCP_MARKERS, LEGACY_TOML_MCP_MARKERS, body)
      : removeBlockMulti(stripped, ALL_MARKERS)
    const outsideBefore = outsideBlockMulti(before, ALL_MARKERS)
    const movedIn = enabled.filter((n) =>
      new RegExp(`^\\[mcp_servers\\.(?:${escapeRe(n)}|"${escapeRe(n)}")\\]`, 'm').test(
        outsideBefore
      )
    )
    // Servers defined inline or as dotted keys outside the block can't be moved by line and would clash: refuse instead of writing broken TOML
    try {
      parseToml(after)
    } catch {
      return {
        after: before,
        notes: [
          'config.toml would not be valid TOML after the change — an mcp_servers entry outside the app block is written inline or as dotted keys; move it to a [mcp_servers.<name>] table'
        ],
        error: 'invalid TOML result'
      }
    }
    return {
      after,
      notes: [
        ...(movedIn.length
          ? [
              `moved server tables from outside the markers into the block (app-owned from now on): ${movedIn.join(', ')}`
            ]
          : []),
        ...toggleNotes(
          staleServerNames(sources, 'grok', ctx, 'grokMcp'),
          disabledUnownedServers(sources, 'grok', ctx, 'grokMcp')
        )
      ],
      owned: enabled,
      ...(Object.keys(serverErrors).length ? { serverErrors } : {})
    }
  }
}
