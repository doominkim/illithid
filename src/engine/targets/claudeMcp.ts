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
export function buildClaudeMcp(
  mcp: McpSource,
  state: Json,
  env: Env,
  secrets?: SecretBackend,
  errors: Record<string, string> = {}
): Json {
  const next = structuredClone(state)
  const servers: Record<string, Json> = {}
  for (const [name, s] of mcpEntries(mcp)) {
    try {
      if (s.transport === 'stdio') {
        const server: Json = { type: 'stdio', command: s.command, args: s.args ?? [] }
        if (s.env) {
          server.env = Object.fromEntries(
            Object.entries(s.env).map(([k, v]) => [k, renderValue(v, 'claude', env, secrets)])
          )
        }
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
  // Servers outside the SSOT (tool-only or per-project) are left alone. Same rule as Codex.
  next.mcpServers = { ...((state.mcpServers as Json | undefined) ?? {}), ...servers }
  return next
}

/** 4. ~/.claude.json — replaces only mcpServers (runtime keys such as projects untouched) */
export const claudeMcp: TargetDef = {
  id: 'claudeMcp',
  tool: 'claude',
  rel: '.claude.json',
  // ~/.claude.json is Claude Code's own state file, created on its first run — never created by the app (toolNotInitialized)
  optional: false,
  seed: '{}\n',
  // Servers outside the SSOT (tool-only or per-project) are not subject to drift
  // Owned region = enabled servers ∪ previously owned servers (without a manifest, all of mcp.json = same as before)
  region: (text, sources, ctx) =>
    jsonSubKeysRegion(text, 'mcpServers', ownedServerNames(sources, 'claude', ctx, 'claudeMcp')),
  build(before, ctx) {
    const { sources, env } = ctx
    const state = parseJsonObject(before)
    const serverErrors: Record<string, string> = {}
    const next = buildClaudeMcp(
      mcpForTool(sources, 'claude'),
      state,
      env,
      ctx.secrets,
      serverErrors
    )
    const stale = staleServerNames(sources, 'claude', ctx, 'claudeMcp')
    removeServers(next, 'mcpServers', stale)
    const after = toJsonText(next, before)
    const { count, same } = untouchedKeysSame(state, next, 'mcpServers')
    const notes = [`${count} keys other than mcpServers unchanged: ${same ? 'OK' : 'broken!'}`]
    notes.push(...toggleNotes(stale, disabledUnownedServers(sources, 'claude', ctx, 'claudeMcp')))
    const owned = enabledServerNames(sources, 'claude')
    const errs = Object.keys(serverErrors).length ? { serverErrors } : {}
    return same
      ? { after, notes, owned, ...errs }
      : { after, notes, owned, ...errs, error: 'keys other than mcpServers changed' }
  }
}
