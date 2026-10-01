/**
 * ~/.grok/config.toml — Grok's Claude Code compatibility switches. Grok also scans ~/.claude/skills (and commands) and
 * ~/.claude.json for MCP servers, so an item off for Grok but on for Claude still reaches Grok. With config.grokReadsClaude = false
 * the app writes `[compat.claude] skills = false, mcps = false` in its own marker block and Grok gets only the app's copies.
 * ~/.claude/agents has no switch in Grok (1.0.41) — Claude agents keep reaching Grok either way.
 * A [compat.claude] table the user wrote outside the block wins: the block is not written (and is removed if it was).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { readConfig } from '../config'
import {
  blockBodyMulti,
  outsideBlockMulti,
  presentMarkers,
  removeBlockMulti,
  spliceBlockMulti,
  type MarkerPair
} from '../text'
import type { TargetDef } from '../types'
import { LEGACY_TOML_MCP_MARKERS, TOML_MCP_MARKERS } from './codexMcp'

export const GROK_COMPAT_MARKERS: MarkerPair = [
  '# BEGIN illithid compat — DO NOT EDIT: generated from Illithid settings',
  '# END illithid compat'
]

const BODY = '[compat.claude]\nskills = false\nmcps = false'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Writes the block. A new one goes right before the app MCP block: grokMcp always moves its block to the end of the file, so a
 * compat block appended after it would swap places on the next sync
 */
function withBlock(text: string): string {
  if (presentMarkers(text, [GROK_COMPAT_MARKERS]))
    return spliceBlockMulti(text, GROK_COMPAT_MARKERS, [], BODY)
  const mcp = presentMarkers(text, [TOML_MCP_MARKERS, ...LEGACY_TOML_MCP_MARKERS])
  if (!mcp) return spliceBlockMulti(text, GROK_COMPAT_MARKERS, [], BODY)
  const i = text.indexOf(mcp[0])
  return `${text.slice(0, i)}${GROK_COMPAT_MARKERS[0]}\n${BODY}\n${GROK_COMPAT_MARKERS[1]}\n\n${text.slice(i)}`
}

/**
 * What Grok actually does per ~/.grok/config.toml (written by the app or by the user): false where compat.claude.<surface> = false.
 * Env overrides (GROK_CLAUDE_*_ENABLED) live in Grok's own environment and aren't visible here
 */
export function grokClaudeReading(home: string): { skills: boolean; mcps: boolean } {
  try {
    const t = parseToml(readFileSync(join(home, '.grok/config.toml'), 'utf8')) as Json
    const c = isObj(t.compat) && isObj(t.compat.claude) ? t.compat.claude : {}
    return { skills: c.skills !== false, mcps: c.mcps !== false }
  } catch {
    return { skills: true, mcps: true }
  }
}

/** Whether the user's own config (outside the app block) already sets compat.claude */
function userCompat(outside: string): boolean {
  try {
    const t = parseToml(outside) as Json
    return isObj(t.compat) && t.compat.claude !== undefined
  } catch {
    return false
  }
}

export const grokCompat: TargetDef = {
  id: 'grokCompat',
  tool: 'grok',
  rel: '.grok/config.toml',
  optional: false,
  createIfInUse: true,
  region: (text) => blockBodyMulti(text, [GROK_COMPAT_MARKERS]),
  build(before, ctx) {
    const off = !ctx.retiring && !!ctx.home && readConfig(ctx.home).config.grokReadsClaude === false
    // Default with no block: nothing to do (and nothing to validate — grokMcp reports a broken file on its own)
    if (!off && !presentMarkers(before, [GROK_COMPAT_MARKERS]))
      return {
        after: before,
        notes: ['Grok reads Claude Code skills and MCP servers (default) — no compat block']
      }
    const outside = outsideBlockMulti(before, [GROK_COMPAT_MARKERS])
    if (off && userCompat(outside)) {
      return {
        after: removeBlockMulti(before, [GROK_COMPAT_MARKERS]),
        notes: [
          '[compat.claude] is set outside the app block — your values are kept, the app writes none'
        ]
      }
    }
    const after = off ? withBlock(before) : removeBlockMulti(before, [GROK_COMPAT_MARKERS])
    try {
      parseToml(after)
    } catch {
      return {
        after: before,
        notes: [
          'config.toml would not be valid TOML after the change — a compat table outside the app block clashes with [compat.claude]'
        ],
        error: 'invalid TOML result'
      }
    }
    return {
      after,
      notes: [
        off
          ? '[compat.claude] skills = false, mcps = false — Grok reads only the app copies of skills and MCP servers (Claude agents still reach Grok)'
          : 'Grok reads Claude Code skills and MCP servers (default) — no compat block'
      ]
    }
  }
}
