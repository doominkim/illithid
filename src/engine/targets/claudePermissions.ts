import {
  jsonSubKeysRegion,
  mcpEntries,
  parseJsonObject,
  normalizeEntry,
  toJsonText,
  untouchedKeysSame
} from '../text'
import { type Allowlist, type McpSource, type TargetDef } from '../types'

type Json = Record<string, unknown>
/** permissions subkeys owned by the app */
export const OWNED_PERMISSION_KEYS = ['allow', 'deny', 'ask'] as const

type Permissions = { allow?: string[]; deny?: string[]; ask?: string[]; [k: string]: unknown }

export function buildClaudePermissions(allowlist: Allowlist, mcp: McpSource, settings: Json): Json {
  const next = structuredClone(settings) as Json & { permissions?: Permissions }
  next.permissions = next.permissions ?? {}
  next.permissions.allow = [
    ...allowlist.bash.map((e) => {
      const { argv, claudeExact } = normalizeEntry(e)
      return `Bash(${argv.join(' ')}${claudeExact ? '' : ':*'})`
    }),
    ...allowlist.claudeOnly.allow
  ]
  next.permissions.deny = [...allowlist.claudeOnly.deny]
  // Mirrors Codex MCP tool approval (approve/prompt/writes) into Claude permissions.ask,
  // so both tools gate the same MCP write tools the same way (gate alignment 2026-09-20).
  const ask: string[] = []
  for (const [name, s] of mcpEntries(mcp)) {
    for (const [tool, mode] of Object.entries(s.codex?.toolApprovals ?? {})) {
      if (mode !== 'auto') ask.push(`mcp__${name}__${tool}`)
    }
  }
  ask.push(...(allowlist.claudeOnly.ask ?? []))
  if (ask.length) next.permissions.ask = ask
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
    const next = buildClaudePermissions(sources.allowlist, sources.mcp, settings)
    const after = toJsonText(next)
    const { count, same } = untouchedKeysSame(settings, next, 'permissions')
    const notes = [`${count} keys other than permissions unchanged: ${same ? 'OK' : 'broken!'}`]
    return same ? { after, notes } : { after, notes, error: 'keys other than permissions changed' }
  }
}
