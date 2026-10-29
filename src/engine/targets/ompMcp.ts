import {
  jsonSubKeysRegion,
  mcpEntries,
  removeServers,
  toggleNotes,
  untouchedKeysSame
} from '../text'
import type { Env, McpSource, TargetDef } from '../types'
import type { SecretBackend } from '../secrets'
import { isServerError, renderHttpHeaders, renderValue } from './mcpRender'
import { keepToolOnlyKeys, parsePlainJsonConfig, toSettingsText } from './geminiMcp'
import {
  disabledUnownedServers,
  enabledServerNames,
  mcpForTool,
  ownedServerNames,
  staleServerNames
} from './toggles'

type Json = Record<string, unknown>

/**
 * omp-only server keys the library can't express. Kept from the existing entry of the same name, since dropping them would
 * break sign-in (auth, oauth), turn a server the user switched off back on (enabled) or change how omp talks to it
 */
export const OMP_KEPT_SERVER_KEYS = [
  'auth',
  'oauth',
  'enabled',
  'instructions',
  'requestIdFormat',
  'cwd'
] as const

/**
 * Server names omp accepts: up to 100 letters, digits, `_ . : -`, words joined by single spaces (validateServerName in
 * @oh-my-pi/pi-coding-agent src/mcp/config-writer.ts)
 */
export const OMP_SERVER_NAME_RE = /^[a-zA-Z0-9_.:-]+(?: [a-zA-Z0-9_.:-]+)*$/

export function ompServerNameOk(name: string): boolean {
  return name.length <= 100 && OMP_SERVER_NAME_RE.test(name)
}

/**
 * Library servers → omp mcp.json mcpServers entries (src/config/mcp-schema.json).
 * - stdio → type stdio, command/args/env (+ timeout in ms)
 * - http  → type http, url (+ headers, timeout in ms)
 * ${VAR} is passed through — omp expands ${VAR} and ${VAR:-default} itself; `secret:` references are resolved to their values.
 * A library server without a timeout keeps the entry's own. Servers whose secrets could not be resolved, or whose name omp
 * rejects, go into errors and are left out (existing entries stay)
 */
export function buildOmpMcp(
  mcp: McpSource,
  config: Json,
  env: Env,
  secrets?: SecretBackend,
  errors: Record<string, string> = {},
  /** Filled with server name → omp-only keys kept from the existing entry */
  kept: Record<string, string[]> = {}
): Json {
  const next = structuredClone(config)
  const prev = (config.mcpServers ?? {}) as Json
  const servers: Record<string, Json> = {}
  for (const [name, s] of mcpEntries(mcp)) {
    if (!ompServerNameOk(name)) {
      errors[name] =
        'omp server names are up to 100 letters, digits, _ . : - (single spaces between words)'
      continue
    }
    try {
      let server: Json
      if (s.transport === 'stdio') {
        server = { type: 'stdio', command: s.command, args: s.args ?? [] }
        if (s.env)
          server.env = Object.fromEntries(
            Object.entries(s.env).map(([k, v]) => [k, renderValue(v, 'claude', env, secrets)])
          )
      } else {
        server = { type: 'http', url: s.url }
        const headers = renderHttpHeaders(s, 'claude', env, secrets)
        if (Object.keys(headers).length) server.headers = headers
      }
      const old = prev[name] as Json | undefined
      if (s.timeoutMs) server.timeout = s.timeoutMs
      else if (old && typeof old === 'object' && typeof old.timeout === 'number')
        server.timeout = old.timeout
      servers[name] = server
    } catch (e) {
      if (!isServerError(e)) throw e
      errors[name] = e.message
    }
  }
  Object.assign(kept, keepToolOnlyKeys(servers, prev, OMP_KEPT_SERVER_KEYS))
  // Servers outside the library (omp-only) are left alone. No empty table is added to a file that has none
  const merged = { ...((config.mcpServers as Json | undefined) ?? {}), ...servers }
  if (config.mcpServers !== undefined || Object.keys(merged).length) next.mcpServers = merged
  return next
}

/**
 * ~/.omp/agent/mcp.json — replaces only the library's entries under mcpServers. `$schema`, `disabledServers`,
 * `enabledServers` and omp-only servers are kept
 */
export const ompMcp: TargetDef = {
  id: 'ompMcp',
  tool: 'omp',
  rel: '.omp/agent/mcp.json',
  // Plain user config (omp runs without it) — created with only our keys when omp is explicitly in use
  optional: false,
  createIfInUse: true,
  seed: '{}\n',
  region: (text, sources, ctx) =>
    jsonSubKeysRegion(text, 'mcpServers', ownedServerNames(sources, 'omp', ctx, 'ompMcp')),
  build(before, ctx) {
    const { sources, env } = ctx
    const config = parsePlainJsonConfig(before, 'mcp.json')
    const serverErrors: Record<string, string> = {}
    const kept: Record<string, string[]> = {}
    const next = buildOmpMcp(
      mcpForTool(sources, 'omp'),
      config,
      env,
      ctx.secrets,
      serverErrors,
      kept
    )
    const stale = staleServerNames(sources, 'omp', ctx, 'ompMcp')
    removeServers(next, 'mcpServers', stale)
    const after =
      JSON.stringify(next) === JSON.stringify(config) ? before : toSettingsText(before, next)
    const { count, same } = untouchedKeysSame(config, next, 'mcpServers')
    const notes = [`${count} keys other than mcpServers unchanged: ${same ? 'OK' : 'broken!'}`]
    notes.push(...toggleNotes(stale, disabledUnownedServers(sources, 'omp', ctx, 'ompMcp')))
    for (const [n, keys] of Object.entries(kept))
      notes.push(`kept omp-only settings of ${n}: ${keys.join(', ')}`)
    const owned = enabledServerNames(sources, 'omp').filter(ompServerNameOk)
    // omp's own denylist wins over any entry: shown, never changed
    const denied = Array.isArray(config.disabledServers)
      ? owned.filter((n) => (config.disabledServers as unknown[]).includes(n))
      : []
    if (denied.length) notes.push(`turned off in omp's disabledServers: ${denied.join(', ')}`)
    const errs = Object.keys(serverErrors).length ? { serverErrors } : {}
    return same
      ? { after, notes, owned, ...errs }
      : { after, notes, owned, ...errs, error: 'keys other than mcpServers changed' }
  }
}
