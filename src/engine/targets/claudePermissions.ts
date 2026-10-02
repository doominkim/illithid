import {
  jsonSubKeysRegion,
  mcpEntries,
  parseJsonObject,
  normalizeEntry,
  toJsonText,
  untouchedKeysSame
} from '../text'
import { allowlistFor } from '../permissions'
import { claudeMcpRules } from '../mcpPermissions'
import { type Allowlist, type AllowlistEntry, type McpSource, type TargetDef } from '../types'

type Json = Record<string, unknown>
/** permissions subkeys owned by the app */
export const OWNED_PERMISSION_KEYS = ['allow', 'deny', 'ask'] as const

type Permissions = { allow?: string[]; deny?: string[]; ask?: string[]; [k: string]: unknown }

export function buildClaudePermissions(allowlist: Allowlist, mcp: McpSource, settings: Json): Json {
  const next = structuredClone(settings) as Json & { permissions?: Permissions }
  next.permissions = next.permissions ?? {}
  const bash = (list: AllowlistEntry[] | undefined): string[] =>
    (list ?? []).map((e) => {
      const { argv, claudeExact } = normalizeEntry(e)
      return `Bash(${argv.join(' ')}${claudeExact ? '' : ':*'})`
    })
  // MCP servers' tool rules (and Codex-only approvals, mirrored as ask so both tools gate the same tools)
  const mcpRules = mcpEntries(mcp).map(([name, s]) => claudeMcpRules(name, s))
  const fromMcp = (d: 'allow' | 'ask' | 'deny'): string[] => mcpRules.flatMap((r) => r[d])
  next.permissions.allow = [
    ...bash(allowlist.bash),
    ...fromMcp('allow'),
    ...allowlist.claudeOnly.allow
  ]
  next.permissions.deny = [
    ...bash(allowlist.bashDeny),
    ...fromMcp('deny'),
    ...allowlist.claudeOnly.deny
  ]
  const ask: string[] = [...bash(allowlist.bashAsk), ...fromMcp('ask')]
  ask.push(...(allowlist.claudeOnly.ask ?? []))
  // The same entry can come from a rule and from a server's Codex approvals: write it once
  const once = (list: string[]): string[] => [...new Set(list)]
  next.permissions.allow = once(next.permissions.allow)
  next.permissions.deny = once(next.permissions.deny)
  if (ask.length) next.permissions.ask = once(ask)
  else delete next.permissions.ask
  return next
}

/** 3. ~/.claude/settings.json — replaces only permissions.allow/deny/ask (other keys untouched) */
export const claudePermissions: TargetDef = {
  id: 'claudePermissions',
  tool: 'claude',
  rel: '.claude/settings.json',
  // settings.json is plain user config — created with only our keys when there is content and Claude is explicitly in use
  optional: false,
  createIfInUse: true,
  seed: '{}\n',
  // Other permissions keys (defaultMode, additionalDirectories, etc.) are user-owned and not subject to drift
  region: (text) => jsonSubKeysRegion(text, 'permissions', [...OWNED_PERMISSION_KEYS]),
  build(before, { sources }) {
    if (!sources.hasPermissions) {
      return {
        after: before,
        notes: ['library has no permissions.json — this target is left untouched']
      }
    }
    const settings = parseJsonObject(before)
    const next = buildClaudePermissions(
      allowlistFor(sources.allowlist, 'claude'),
      sources.mcp,
      settings
    )
    const after = toJsonText(next, before)
    const { count, same } = untouchedKeysSame(settings, next, 'permissions')
    const notes = [`${count} keys other than permissions unchanged: ${same ? 'OK' : 'broken!'}`]
    return same ? { after, notes } : { after, notes, error: 'keys other than permissions changed' }
  }
}
