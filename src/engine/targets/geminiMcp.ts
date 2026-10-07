import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  jsonSubKeysRegion,
  stripJsonComments,
  mcpEntries,
  parseJsonObject,
  removeServers,
  toggleNotes,
  untouchedKeysSame
} from '../text'
import { isEnabled } from '../manifest'
import { TargetError, type Env, type McpSource, type Sources, type TargetDef } from '../types'
import { librarySkillNames } from './skillOverrides'
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

/**
 * Gemini-only server keys the library can't express. Kept from the existing entry of the same name, since dropping them would
 * widen tool access (includeTools/excludeTools), break sign-in (oauth, authProviderType, service account) or change trust
 */
export const GEMINI_KEPT_SERVER_KEYS = [
  'trust',
  'includeTools',
  'excludeTools',
  'oauth',
  'authProviderType',
  'targetAudience',
  'targetServiceAccount',
  'cwd',
  'description'
] as const

/**
 * Library servers → Gemini CLI mcpServers entries.
 * - stdio → command/args/env (+ timeout in ms)
 * - http  → httpUrl (+ headers). Gemini reads `url` as SSE, so streamable HTTP must be httpUrl
 * ${VAR} is passed through — Gemini expands $VAR/${VAR} in settings.json strings itself. `trust` is never written.
 * Servers whose secrets could not be resolved go into errors and are dropped from servers (existing entries stay)
 */
export function buildGeminiMcp(
  mcp: McpSource,
  settings: Json,
  env: Env,
  secrets?: SecretBackend,
  errors: Record<string, string> = {},
  /** Filled with server name → Gemini-only keys kept from the existing entry */
  kept: Record<string, string[]> = {}
): Json {
  const next = structuredClone(settings)
  const servers: Record<string, Json> = {}
  const prev = (settings.mcpServers ?? {}) as Json
  for (const [name, s] of mcpEntries(mcp)) {
    try {
      if (s.transport === 'stdio') {
        const server: Json = { command: s.command, args: s.args ?? [] }
        if (s.env) {
          server.env = Object.fromEntries(
            Object.entries(s.env).map(([k, v]) => [k, renderValue(v, 'claude', env, secrets)])
          )
        }
        if (s.timeoutMs) server.timeout = s.timeoutMs
        servers[name] = server
      } else {
        const server: Json = { httpUrl: s.url }
        const headers = renderHttpHeaders(s, 'claude', env, secrets)
        if (Object.keys(headers).length) server.headers = headers
        if (s.timeoutMs) server.timeout = s.timeoutMs
        servers[name] = server
      }
    } catch (e) {
      if (!isServerError(e)) throw e
      errors[name] = e.message
    }
  }
  Object.assign(kept, keepToolOnlyKeys(servers, prev, GEMINI_KEPT_SERVER_KEYS))
  // Servers outside the SSOT (Gemini-only, extensions) are left alone. No empty table is added to a file that has none
  const merged = { ...((settings.mcpServers as Json | undefined) ?? {}), ...servers }
  if (settings.mcpServers !== undefined || Object.keys(merged).length) next.mcpServers = merged
  return next
}

/**
 * JSON config its tool reads with comments allowed (Gemini settings.json, Copilot mcp-config.json). The app only edits plain JSON:
 * anything else is refused rather than rewritten without the user's comments
 */
export function parsePlainJsonConfig(text: string, file: string): Json {
  try {
    return parseJsonObject(text)
  } catch (e) {
    if (!(e instanceof TargetError)) throw e
    throw new TargetError(`${e.message} — ${file} has comments or is not plain JSON; not written`)
  }
}

/** Keep same-name entries' tool-only keys (listed in keys) in the rendered servers. Returns server name → kept keys */
export function keepToolOnlyKeys(
  servers: Record<string, Json>,
  prev: Json,
  keys: readonly string[]
): Record<string, string[]> {
  const kept: Record<string, string[]> = {}
  for (const [name, server] of Object.entries(servers)) {
    const old = prev[name]
    if (!old || typeof old !== 'object' || Array.isArray(old)) continue
    const hit = keys.filter((k) => (old as Json)[k] !== undefined)
    for (const k of hit) server[k] = structuredClone((old as Json)[k])
    if (hit.length) kept[name] = hit
  }
  return kept
}

/**
 * Library skills on for the tool that its own settings turn off — all of them if skills.enabled is false, else those in
 * skills.disabled (Gemini CLI and Qwen Code share these keys). Warned about, never changed
 */
export function geminiDisabledSkills(
  settings: Json,
  sources: Sources,
  tool: SettingsMcpTool = 'gemini'
): { allOff: boolean; names: string[] } {
  const sk = settings.skills
  if (!sk || typeof sk !== 'object' || Array.isArray(sk)) return { allOff: false, names: [] }
  const s = sk as Json
  const on = librarySkillNames(sources).filter((n) =>
    isEnabled(sources.manifest, 'skills', n, tool)
  )
  if (s.enabled === false) return { allOff: true, names: on }
  return {
    allOff: false,
    names: Array.isArray(s.disabled) ? on.filter((n) => (s.disabled as unknown[]).includes(n)) : []
  }
}

/** geminiDisabledSkills from the tool's settings.json (read with comments allowed, like the tool). Empty if missing or unreadable */
export function geminiDisabledSkillsOf(
  home: string,
  sources: Sources,
  tool: SettingsMcpTool = 'gemini'
): string[] {
  try {
    const v = JSON.parse(
      stripJsonComments(readFileSync(join(home, SETTINGS_REL[tool]), 'utf8'))
    ) as unknown
    return v && typeof v === 'object' && !Array.isArray(v)
      ? geminiDisabledSkills(v as Json, sources, tool).names
      : []
  } catch {
    return []
  }
}

function disabledSkillNotes(settings: Json, sources: Sources, tool: SettingsMcpTool): string[] {
  const { allOff, names } = geminiDisabledSkills(settings, sources, tool)
  if (!names.length) return []
  if (allOff)
    return [
      `skills.enabled is false in settings.json — ${TOOL_LABEL[tool]} loads no skills, including library ones`
    ]
  return [
    `library skills disabled by skills.disabled in settings.json (left as-is): ${names.join(', ')}`
  ]
}

/** Serialize keeping the file's indentation and trailing newline */
export function toSettingsText(before: string, value: Json): string {
  const indent = /^[{[]\r?\n([ \t]+)\S/.exec(before)?.[1] ?? '  '
  return JSON.stringify(value, null, indent) + '\n'
}

/** Tools whose settings.json holds Gemini-format mcpServers (Qwen Code is a Gemini CLI fork) */
export type SettingsMcpTool = 'gemini' | 'qwen'
const SETTINGS_REL: Readonly<Record<SettingsMcpTool, string>> = {
  gemini: '.gemini/settings.json',
  qwen: '.qwen/settings.json'
}
const TOOL_LABEL: Readonly<Record<SettingsMcpTool, string>> = { gemini: 'Gemini', qwen: 'Qwen' }

/** <tool home>/settings.json — replaces only mcpServers (other keys and their order untouched) */
function settingsMcpTarget(id: 'geminiMcp' | 'qwenMcp', tool: SettingsMcpTool): TargetDef {
  return {
    id,
    tool,
    rel: SETTINGS_REL[tool],
    // Plain user config (the tool runs without it) — created with only our keys when the tool is explicitly in use
    optional: false,
    createIfInUse: true,
    seed: '{}\n',
    region: (text, sources, ctx) =>
      jsonSubKeysRegion(text, 'mcpServers', ownedServerNames(sources, tool, ctx, id)),
    build(before, ctx) {
      const { sources, env } = ctx
      const settings = parsePlainJsonConfig(before, 'settings.json')
      const serverErrors: Record<string, string> = {}
      const kept: Record<string, string[]> = {}
      const next = buildGeminiMcp(
        mcpForTool(sources, tool),
        settings,
        env,
        ctx.secrets,
        serverErrors,
        kept
      )
      const stale = staleServerNames(sources, tool, ctx, id)
      removeServers(next, 'mcpServers', stale)
      const after =
        JSON.stringify(next) === JSON.stringify(settings) ? before : toSettingsText(before, next)
      const { count, same } = untouchedKeysSame(settings, next, 'mcpServers')
      const notes = [`${count} keys other than mcpServers unchanged: ${same ? 'OK' : 'broken!'}`]
      notes.push(...toggleNotes(stale, disabledUnownedServers(sources, tool, ctx, id)))
      for (const [n, keys] of Object.entries(kept))
        notes.push(`kept ${TOOL_LABEL[tool]}-only settings of ${n}: ${keys.join(', ')}`)
      notes.push(...disabledSkillNotes(settings, sources, tool))
      // Gemini's policy engine splits MCP tool names (mcp_<server>_<tool>) at `_`, so such a server name may be misread
      const underscored =
        tool === 'gemini' ? enabledServerNames(sources, tool).filter((n) => n.includes('_')) : []
      if (underscored.length)
        notes.push(
          `server names with "_" may be misread by Gemini's tool policy rules (mcp_<server>_<tool>): ${underscored.join(', ')}`
        )
      const owned = enabledServerNames(sources, tool)
      const errs = Object.keys(serverErrors).length ? { serverErrors } : {}
      return same
        ? { after, notes, owned, ...errs }
        : { after, notes, owned, ...errs, error: 'keys other than mcpServers changed' }
    }
  }
}

/** ~/.gemini/settings.json */
export const geminiMcp: TargetDef = settingsMcpTarget('geminiMcp', 'gemini')

/** ~/.qwen/settings.json — same mcpServers schema as Gemini; `$version` and every other key are kept */
export const qwenMcp: TargetDef = settingsMcpTarget('qwenMcp', 'qwen')
