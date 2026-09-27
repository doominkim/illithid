import {
  jsonSubKeysRegion,
  mcpEntries,
  removeServers,
  toggleNotes,
  parseJsonObject,
  toJsonText,
  untouchedKeysSame
} from '../text'
import { type Env, type McpSource, type TargetDef } from '../types'
import type { SecretBackend } from '../secrets'
import { isServerError, renderHttpHeaders, renderValue } from './mcpRender'
import {
  disabledUnownedServers,
  enabledServerNames,
  mcpForTool,
  ownedServerNames,
  staleServerNames
} from './toggles'

type Json = Record<string, unknown>

/** Servers whose secrets could not be resolved go into errors and are dropped from servers (existing entries stay) */
export function buildOpencodeMcp(
  mcp: McpSource,
  config: Json,
  env: Env,
  secrets?: SecretBackend,
  errors: Record<string, string> = {}
): Json {
  const next = structuredClone(config)
  const servers: Record<string, Json> = {}
  for (const [name, s] of mcpEntries(mcp)) {
    try {
      if (s.transport === 'stdio') {
        const server: Json = {
          type: 'local',
          command: [s.command, ...(s.args ?? [])],
          enabled: true
        }
        if (s.env) {
          server.environment = Object.fromEntries(
            Object.entries(s.env).map(([k, v]) => [k, renderValue(v, 'opencode', env, secrets)])
          )
        }
        if (s.timeoutMs) server.timeout = s.timeoutMs
        servers[name] = server
      } else {
        const server: Json = { type: 'remote', url: s.url, enabled: true }
        const headers = renderHttpHeaders(s, 'opencode', env, secrets)
        if (Object.keys(headers).length) server.headers = headers
        servers[name] = server
      }
    } catch (e) {
      if (!isServerError(e)) throw e
      errors[name] = e.message
    }
  }
  // Servers outside the SSOT (e.g. local figma) are left alone.
  next.mcp = { ...((config.mcp as Json | undefined) ?? {}), ...servers }
  return next
}

/** 6. ~/.config/opencode/opencode.json — replaces only mcp (other keys untouched) */
export const opencodeMcp: TargetDef = {
  id: 'opencodeMcp',
  tool: 'opencode',
  rel: '.config/opencode/opencode.json',
  // opencode.json is plain user config (OpenCode runs without it) — created with only our keys when there is content, OpenCode is
  // explicitly in use and no opencode.jsonc is there (creating a second config file would change how OpenCode merges its settings)
  optional: false,
  createIfInUse: true,
  alternates: ['.config/opencode/opencode.jsonc'],
  seed: '{}\n',
  // Servers outside the SSOT (e.g. local figma) are not subject to drift
  region: (text, sources, ctx) =>
    jsonSubKeysRegion(text, 'mcp', ownedServerNames(sources, 'opencode', ctx, 'opencodeMcp')),
  build(before, ctx) {
    const { sources, env } = ctx
    const config = parseJsonObject(before)
    const serverErrors: Record<string, string> = {}
    const next = buildOpencodeMcp(
      mcpForTool(sources, 'opencode'),
      config,
      env,
      ctx.secrets,
      serverErrors
    )
    const stale = staleServerNames(sources, 'opencode', ctx, 'opencodeMcp')
    removeServers(next, 'mcp', stale)
    const after = toJsonText(next)
    const { count, same } = untouchedKeysSame(config, next, 'mcp')
    const notes = [`${count} keys other than mcp unchanged: ${same ? 'OK' : 'broken!'}`]
    notes.push(
      ...toggleNotes(stale, disabledUnownedServers(sources, 'opencode', ctx, 'opencodeMcp'))
    )
    const owned = enabledServerNames(sources, 'opencode')
    const errs = Object.keys(serverErrors).length ? { serverErrors } : {}
    return same
      ? { after, notes, owned, ...errs }
      : { after, notes, owned, ...errs, error: 'keys other than mcp changed' }
  }
}
