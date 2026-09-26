import {
  blockBodyMulti,
  mcpEntries,
  outsideBlockMulti,
  removeBlockMulti,
  spliceBlockMulti,
  toggleNotes,
  type MarkerPair
} from '../text'
import { isSecretRef, type SecretBackend } from '../secrets'
import type { Env, McpSource, TargetDef } from '../types'
import { bareEnvName, httpHeaders, isServerError, renderValue, secretValue } from './mcpRender'
import {
  disabledUnownedServers,
  enabledServerNames,
  mcpForTool,
  ownedServerNames,
  staleServerNames
} from './toggles'

/** App marker (M7d) */
export const TOML_MCP_BEGIN = '# BEGIN illithid mcp — DO NOT EDIT: generated from library mcps/'
export const TOML_MCP_END = '# END illithid mcp'
/** Earlier app marker with a Korean header (before the English rewrite). Escaped to match byte-for-byte */
export const LEGACY_KO_TOML_MCP_BEGIN =
  '# BEGIN illithid mcp — DO NOT EDIT: \uB77C\uC774\uBE0C\uB7EC\uB9AC mcps/ \uC5D0\uC11C \uC0DD\uC131\uB428'
/** Previous app name (harnesssync) marker */
export const LEGACY_HS_TOML_MCP_BEGIN =
  '# BEGIN harnesssync mcp — DO NOT EDIT: \uB77C\uC774\uBE0C\uB7EC\uB9AC mcps/ \uC5D0\uC11C \uC0DD\uC131\uB428'
export const LEGACY_HS_TOML_MCP_END = '# END harnesssync mcp'
/** Previous app name (agent-console) marker */
export const LEGACY_APP_TOML_MCP_BEGIN =
  '# BEGIN agent-console mcp — DO NOT EDIT: \uB77C\uC774\uBE0C\uB7EC\uB9AC mcps/ \uC5D0\uC11C \uC0DD\uC131\uB428'
export const LEGACY_APP_TOML_MCP_END = '# END agent-console mcp'
/** Previous system (sync.mjs) marker */
export const LEGACY_TOML_MCP_BEGIN =
  '# BEGIN agents-sync mcp — DO NOT EDIT: ~/.agents/sync/mcp.json \uC5D0\uC11C \uC0DD\uC131\uB428'
export const LEGACY_TOML_MCP_END = '# END agents-sync mcp'

export const TOML_MCP_MARKERS: MarkerPair = [TOML_MCP_BEGIN, TOML_MCP_END]
export const LEGACY_TOML_MCP_MARKERS: readonly MarkerPair[] = [
  [LEGACY_KO_TOML_MCP_BEGIN, TOML_MCP_END],
  [LEGACY_HS_TOML_MCP_BEGIN, LEGACY_HS_TOML_MCP_END],
  [LEGACY_APP_TOML_MCP_BEGIN, LEGACY_APP_TOML_MCP_END],
  [LEGACY_TOML_MCP_BEGIN, LEGACY_TOML_MCP_END]
]
const ALL_TOML_MCP_MARKERS: readonly MarkerPair[] = [TOML_MCP_MARKERS, ...LEGACY_TOML_MCP_MARKERS]

function tomlString(v: unknown): string {
  return JSON.stringify(v)
}

/** Server key in an mcp_servers table header (raw, including quotes) */
const TABLE_HEADER = /^\[mcp_servers\.((?:"[^"]+")|(?:[A-Za-z0-9_-]+))(\.|\])/

/** Extracts one server's tables (including subtables) from a block body. [] if none */
export function extractCodexTables(text: string, name: string): string[] {
  const keys = new Set([name, `"${name}"`])
  const out: string[] = []
  let taking = false
  for (const line of text.split('\n')) {
    const header = TABLE_HEADER.exec(line)
    if (header) taking = keys.has(header[1])
    else if (/^\[/.test(line)) taking = false
    if (taking) out.push(line)
  }
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out
}

export interface CodexMcpBody {
  body: string
  /** Headers etc. that could not be carried over to Codex (key names only) */
  warnings: string[]
  /** Server whose secrets could not be resolved → message. That server keeps its table from the previous block */
  serverErrors: Record<string, string>
}

/**
 * mcp.json → Codex [mcp_servers.*] tables.
 * - `secret:` headers and bearerToken become http_headers literals (Codex rejects a bearer_token literal)
 * - Headers whose whole value is ${VAR} go to env_http_headers; bearerEnv goes to bearer_token_env_var
 * prevBody is the previous marker block body — used to keep existing tables for servers with missing secrets.
 */
export function buildCodexMcpBody(
  mcp: McpSource,
  env: Env,
  secrets?: SecretBackend,
  prevBody = ''
): CodexMcpBody {
  const lines: string[] = []
  const warnings: string[] = []
  const serverErrors: Record<string, string> = {}
  for (const [name, s] of mcpEntries(mcp)) {
    const key = /^[A-Za-z0-9_-]+$/.test(name) && !name.includes('-') ? name : `"${name}"`
    const out: string[] = []
    const warn: string[] = []
    try {
      out.push(`[mcp_servers.${key}]`)
      if (s.transport === 'stdio') {
        out.push(`command = ${tomlString(s.command)}`)
        out.push(`args = [${(s.args ?? []).map(tomlString).join(', ')}]`)
        if (s.timeoutMs) out.push(`startup_timeout_sec = ${s.timeoutMs / 1000}`)
      } else {
        out.push(`url = ${tomlString(s.url)}`)
        // Codex can't prefix header values. A Bearer env var uses its dedicated key.
        if (s.bearerEnv) out.push(`bearer_token_env_var = ${tomlString(s.bearerEnv)}`)
      }
      const cx = s.codex ?? {}
      if (cx.defaultToolsApprovalMode) {
        out.push(`default_tools_approval_mode = ${tomlString(cx.defaultToolsApprovalMode)}`)
      }
      if (cx.enabledTools) {
        out.push(`enabled_tools = [${cx.enabledTools.map(tomlString).join(', ')}]`)
      }
      // Codex only accepts literals for stdio env — env vars and secrets are resolved in place.
      if (s.transport === 'stdio' && s.env) {
        out.push('', `[mcp_servers.${key}.env]`)
        for (const [k, v] of Object.entries(s.env)) {
          out.push(`${k} = ${tomlString(renderValue(v, 'literal', env, secrets))}`)
        }
      }
      if (s.transport !== 'stdio') {
        const { headers, bearerRef } = httpHeaders({ ...s, bearerEnv: undefined })
        const literal: [string, string][] = []
        const envMapped: [string, string][] = []
        for (const [k, v] of Object.entries(headers)) {
          if (isSecretRef(v)) literal.push([k, secretValue(v, secrets)])
          else if (bareEnvName(v)) envMapped.push([k, bareEnvName(v)!])
          else warn.push(`! ${name}.${k} header can't be carried over to Codex (prefixed value)`)
        }
        if (bearerRef) literal.push(['Authorization', `Bearer ${secretValue(bearerRef, secrets)}`])
        if (literal.length) {
          out.push('', `[mcp_servers.${key}.http_headers]`)
          for (const [k, v] of literal) out.push(`${tomlString(k)} = ${tomlString(v)}`)
        }
        if (envMapped.length) {
          out.push('', `[mcp_servers.${key}.env_http_headers]`)
          for (const [k, envName] of envMapped) out.push(`${k} = ${tomlString(envName)}`)
        }
      }
      for (const [tool, mode] of Object.entries(cx.toolApprovals ?? {})) {
        out.push('', `[mcp_servers.${key}.tools.${tool}]`, `approval_mode = ${tomlString(mode)}`)
      }
    } catch (e) {
      if (!isServerError(e)) throw e
      serverErrors[name] = e.message
      const prev = extractCodexTables(prevBody, name)
      if (prev.length) lines.push(...prev, '')
      continue
    }
    lines.push(...out, '')
    warnings.push(...warn)
  }
  return { body: lines.join('\n').trimEnd(), warnings, serverErrors }
}

/** Removes leftover table blocks outside the markers for servers now owned by the SSOT. */
export function stripCodexManagedTables(text: string, names: string[]): string {
  const managed = new Set(names.flatMap((n) => [n, `"${n}"`]))
  const out: string[] = []
  let skipping = false
  for (const line of text.split('\n')) {
    const header = TABLE_HEADER.exec(line)
    if (header) skipping = managed.has(header[1])
    else if (/^\[/.test(line)) skipping = false
    if (!skipping) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 5. ~/.codex/config.toml — replace only mcp.json servers in the marker block */
export const codexMcp: TargetDef = {
  id: 'codexMcp',
  rel: '.codex/config.toml',
  optional: true,
  region: (text) => blockBodyMulti(text, ALL_TOML_MCP_MARKERS),
  build(before, ctx) {
    const { sources, env } = ctx
    // Tables to remove outside the markers = enabled servers ∪ previously owned servers (off servers with no ownership record are kept as the user's)
    const stripped = stripCodexManagedTables(
      outsideBlockMulti(before, ALL_TOML_MCP_MARKERS),
      ownedServerNames(sources, 'codex', ctx, 'codexMcp')
    )
    const { body, warnings, serverErrors } = buildCodexMcpBody(
      mcpForTool(sources, 'codex'),
      env,
      ctx.secrets,
      blockBodyMulti(before, ALL_TOML_MCP_MARKERS) ?? ''
    )
    // With no enabled servers, don't create an empty block and remove any previously written one
    const none = !enabledServerNames(sources, 'codex').length
    const after = none
      ? removeBlockMulti(stripped, ALL_TOML_MCP_MARKERS)
      : spliceBlockMulti(stripped, TOML_MCP_MARKERS, LEGACY_TOML_MCP_MARKERS, body)
    // Same-name server tables outside the markers (user area) move into the block (app-owned from then on)
    const outsideBefore = outsideBlockMulti(before, ALL_TOML_MCP_MARKERS)
    const movedIn = enabledServerNames(sources, 'codex').filter((n) =>
      new RegExp(`^\\[mcp_servers\\.(?:${escapeRe(n)}|"${escapeRe(n)}")\\]`, 'm').test(outsideBefore)
    )
    const kept = (after.match(/^\[mcp_servers\./gm) ?? []).length
    const legacy = blockBodyMulti(before, LEGACY_TOML_MCP_MARKERS) !== null
    return {
      after,
      notes: [
        ...warnings,
        ...(legacy ? ['legacy marker block → replaced with app marker'] : []),
        ...(movedIn.length ? [`moved server tables from outside the markers into the block (app-owned from now on): ${movedIn.join(', ')}`] : []),
        `${kept} mcp_servers tables total (servers outside the SSOT kept)`,
        ...toggleNotes(
          staleServerNames(sources, 'codex', ctx, 'codexMcp'),
          disabledUnownedServers(sources, 'codex', ctx, 'codexMcp')
        )
      ],
      owned: enabledServerNames(sources, 'codex'),
      ...(Object.keys(serverErrors).length ? { serverErrors } : {})
    }
  }
}
