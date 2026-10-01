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
 * Copilot-only server keys the library can't express. Kept from the existing entry of the same name, since dropping them would
 * widen tool access (tools, deferTools), break sign-in (oauth*, auth) or change timeouts
 */
export const COPILOT_KEPT_SERVER_KEYS = [
  'tools',
  'deferTools',
  'oauthClientId',
  'oauthClientSecret',
  'auth',
  'timeout',
  'taskSupport',
  'slowConnectionThresholdMs'
] as const

/**
 * Library servers → Copilot mcp-config.json mcpServers entries.
 * - stdio → type stdio, command/args/env
 * - http  → type http, url (+ headers)
 * ${VAR} is passed through as-is; `secret:` references are resolved to their values.
 * Servers whose secrets could not be resolved go into errors and are dropped from servers (existing entries stay)
 */
export function buildCopilotMcp(
  mcp: McpSource,
  config: Json,
  env: Env,
  secrets?: SecretBackend,
  errors: Record<string, string> = {},
  /** Filled with server name → Copilot-only keys kept from the existing entry */
  kept: Record<string, string[]> = {}
): Json {
  const next = structuredClone(config)
  const servers: Record<string, Json> = {}
  for (const [name, s] of mcpEntries(mcp)) {
    try {
      if (s.transport === 'stdio') {
        const server: Json = { type: 'stdio', command: s.command, args: s.args ?? [] }
        if (s.env)
          server.env = Object.fromEntries(
            Object.entries(s.env).map(([k, v]) => [k, renderValue(v, 'claude', env, secrets)])
          )
        servers[name] = server
      } else {
        const server: Json = { type: 'http', url: s.url }
        const headers = renderHttpHeaders(s, 'claude', env, secrets)
        if (Object.keys(headers).length) server.headers = headers
        servers[name] = server
      }
    } catch (e) {
      if (!isServerError(e)) throw e
      errors[name] = e.message
    }
  }
  Object.assign(
    kept,
    keepToolOnlyKeys(servers, (config.mcpServers ?? {}) as Json, COPILOT_KEPT_SERVER_KEYS)
  )
  // Servers outside the SSOT (Copilot-only, plugins) are left alone. No empty table is added to a file that has none
  const merged = { ...((config.mcpServers as Json | undefined) ?? {}), ...servers }
  if (config.mcpServers !== undefined || Object.keys(merged).length) next.mcpServers = merged
  return next
}

/** ~/.copilot/mcp-config.json — replaces only mcpServers (other keys and their order untouched) */
export const copilotMcp: TargetDef = {
  id: 'copilotMcp',
  tool: 'copilot',
  rel: '.copilot/mcp-config.json',
  // Plain user config (Copilot runs without it) — created with only our keys when Copilot is explicitly in use
  optional: false,
  createIfInUse: true,
  seed: '{}\n',
  region: (text, sources, ctx) =>
    jsonSubKeysRegion(text, 'mcpServers', ownedServerNames(sources, 'copilot', ctx, 'copilotMcp')),
  build(before, ctx) {
    const { sources, env } = ctx
    const config = parsePlainJsonConfig(before, 'mcp-config.json')
    const serverErrors: Record<string, string> = {}
    const kept: Record<string, string[]> = {}
    const next = buildCopilotMcp(
      mcpForTool(sources, 'copilot'),
      config,
      env,
      ctx.secrets,
      serverErrors,
      kept
    )
    const stale = staleServerNames(sources, 'copilot', ctx, 'copilotMcp')
    removeServers(next, 'mcpServers', stale)
    const after =
      JSON.stringify(next) === JSON.stringify(config) ? before : toSettingsText(before, next)
    const { count, same } = untouchedKeysSame(config, next, 'mcpServers')
    const notes = [`${count} keys other than mcpServers unchanged: ${same ? 'OK' : 'broken!'}`]
    notes.push(...toggleNotes(stale, disabledUnownedServers(sources, 'copilot', ctx, 'copilotMcp')))
    for (const [n, keys] of Object.entries(kept))
      notes.push(`kept Copilot-only settings of ${n}: ${keys.join(', ')}`)
    const owned = enabledServerNames(sources, 'copilot')
    const errs = Object.keys(serverErrors).length ? { serverErrors } : {}
    return same
      ? { after, notes, owned, ...errs }
      : { after, notes, owned, ...errs, error: 'keys other than mcpServers changed' }
  }
}
