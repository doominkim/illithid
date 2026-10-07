import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePlainJsonConfig, toSettingsText } from './geminiMcp'
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
import { mcpForTool, ownedServerNames } from './toggles'
import { type Allowlist, type AllowlistEntry, type McpSource, type TargetDef } from '../types'

type Json = Record<string, unknown>
/** permissions subkeys owned by the app */
export const OWNED_PERMISSION_KEYS = ['allow', 'deny', 'ask'] as const

type Permissions = { allow?: string[]; deny?: string[]; ask?: string[]; [k: string]: unknown }

/** Resolve native server names before treating a separator as the boundary between server and tool. */
function nativeServerNames(home: string | undefined): string[] {
  if (!home) return []
  const names = new Set<string>()
  const add = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const servers = (value as Json).mcpServers
    if (servers && typeof servers === 'object' && !Array.isArray(servers))
      for (const name of Object.keys(servers)) names.add(name)
  }
  try {
    const config = parseJsonObject(readFileSync(join(home, '.claude.json'), 'utf8'))
    add(config)
    if (config.projects && typeof config.projects === 'object' && !Array.isArray(config.projects))
      for (const project of Object.values(config.projects)) add(project)
  } catch {
    // Unavailable native names leave compound rules ambiguous; keep those rules.
  }
  return [...names]
}

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
  build(before, ctx) {
    const { sources } = ctx
    if (!sources.hasPermissions && ctx.retiring) {
      return {
        after: before,
        notes: ['library has no permissions.json — this target is left untouched']
      }
    }
    const settings = parseJsonObject(before)
    let allowlist = allowlistFor(sources.allowlist, 'claude')
    const preservationNotes: string[] = []
    if (!sources.hasPermissions) {
      // MCP rules are independently owned. Without command rules, preserve the user's remaining permissions.
      const owned = ownedServerNames(sources, 'claude', ctx, 'claudeMcp')
      const ownedSet = new Set(owned)
      const names = [...new Set([...owned, ...nativeServerNames(ctx.home)])].sort(
        (a, b) => b.length - a.length
      )
      const mcp = mcpForTool(sources, 'claude')
      const managedRules = new Set(
        mcpEntries(mcp).flatMap(([name, server]) =>
          Object.values(claudeMcpRules(name, server)).flat()
        )
      )
      const ambiguousRules = new Set<string>()
      const isOwnedRule = (rule: string): boolean => {
        const owner = names.find(
          (name) => rule === `mcp__${name}` || rule.startsWith(`mcp__${name}__`)
        )
        if (!owner || !ownedSet.has(owner)) return false
        const prefix = `mcp__${owner}`
        if (rule === prefix || managedRules.has(rule)) return true
        // An unknown compound suffix can instead be a longer, unmanaged server name.
        if (rule.slice(prefix.length + 2).includes('__')) {
          ambiguousRules.add(rule)
          return false
        }
        return true
      }
      const permissions = settings.permissions as Permissions | undefined
      const keep = (list: string[] | undefined): string[] =>
        (list ?? []).filter((rule) => !isOwnedRule(rule))
      const nativeRules = {
        allow: keep(permissions?.allow),
        deny: keep(permissions?.deny),
        ask: keep(permissions?.ask)
      }
      if (ambiguousRules.size)
        preservationNotes.push(
          `${ambiguousRules.size} ambiguous MCP permission rules preserved because prior state records server names only; review or remove these native Claude rules explicitly`
        )
      const hasMcpRules = mcpEntries(mcpForTool(sources, 'claude')).some(([name, server]) =>
        Object.values(claudeMcpRules(name, server)).some((list) => list.length)
      )
      const hasOwnedRules = OWNED_PERMISSION_KEYS.some((key) => {
        const list = permissions?.[key] ?? []
        return nativeRules[key].length !== list.length
      })
      if (!hasMcpRules && !hasOwnedRules)
        return {
          after: before,
          notes: ['no managed command or MCP permissions — left untouched', ...preservationNotes]
        }
      allowlist = {
        bash: [],
        claudeOnly: nativeRules
      }
    }
    const next = buildClaudePermissions(allowlist, mcpForTool(sources, 'claude'), settings)
    const after = toJsonText(next, before)
    const { count, same } = untouchedKeysSame(settings, next, 'permissions')
    const notes = [
      `${count} keys other than permissions unchanged: ${same ? 'OK' : 'broken!'}`,
      ...preservationNotes
    ]
    return same ? { after, notes } : { after, notes, error: 'keys other than permissions changed' }
  }
}

/**
 * ~/.qwen/settings.json — Qwen Code reads Claude-syntax permissions.allow/ask/deny (`Bash(git status:*)`, `Read(.env)`,
 * `mcp__server__tool`), so it gets the same lists as Claude Code. Without a library permissions.json they are left alone
 */
export const qwenPermissions: TargetDef = {
  id: 'qwenPermissions',
  tool: 'qwen',
  rel: '.qwen/settings.json',
  optional: false,
  createIfInUse: true,
  seed: '{}\n',
  region: (text) => jsonSubKeysRegion(text, 'permissions', [...OWNED_PERMISSION_KEYS]),
  build(before, ctx) {
    const { sources } = ctx
    if (!sources.hasPermissions)
      return {
        after: before,
        notes: ['library has no permissions.json — Qwen permissions are left untouched']
      }
    const settings = parsePlainJsonConfig(before, 'settings.json')
    const next = buildClaudePermissions(
      allowlistFor(sources.allowlist, 'qwen'),
      mcpForTool(sources, 'qwen'),
      settings
    )
    const after =
      JSON.stringify(next) === JSON.stringify(settings) ? before : toSettingsText(before, next)
    const { count, same } = untouchedKeysSame(settings, next, 'permissions')
    const notes = [`${count} keys other than permissions unchanged: ${same ? 'OK' : 'broken!'}`]
    // The library owns these lists: rules only Qwen had are replaced — import them first to keep them
    const was = (settings.permissions ?? {}) as Permissions
    const now = next.permissions as Permissions
    const dropped = OWNED_PERMISSION_KEYS.flatMap((k) =>
      (Array.isArray(was[k]) ? was[k] : []).filter((r) => !(now[k] ?? []).includes(r))
    )
    if (dropped.length)
      notes.push(
        `Qwen rules not in the library are replaced (import them to keep): ${dropped.join(', ')}`
      )
    return same ? { after, notes } : { after, notes, error: 'keys other than permissions changed' }
  }
}
