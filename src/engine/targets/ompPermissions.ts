import { isDeepStrictEqual } from 'node:util'
import { isMap, parseDocument, YAMLError, type Document } from 'yaml'
import { mcpEntries, normalizeEntry } from '../text'
import { allowlistFor, commandLine } from '../permissions'
import { mcpPermissionsOf, type McpDecision } from '../mcpPermissions'
import {
  TargetError,
  type AllowlistEntry,
  type BuildContext,
  type Sources,
  type TargetDef
} from '../types'
import { ompServerNameOk } from './ompMcp'
import { mcpForTool, previouslyOwned } from './toggles'

type Json = Record<string, unknown>
type OmpApproval = 'allow' | 'deny' | 'prompt'
interface BashPattern {
  match: string
  approval: OmpApproval
}

const PATTERNS_PATH = ['bash', 'patterns']
const APPROVAL_PATH = ['tools', 'approval']
const OMP_APPROVAL: Record<McpDecision, OmpApproval> = {
  allow: 'allow',
  ask: 'prompt',
  deny: 'deny'
}
const STRICTNESS: Record<OmpApproval, number> = { allow: 0, prompt: 1, deny: 2 }

// ---------------------------------------------------------------- omp MCP tool names

const MASK64 = (1n << 64n) - 1n
const WYHASH_SECRET = [
  0xa0761d6478bd642fn,
  0xe7037ed1a0b428dbn,
  0x8ebc6af09c88c6e3n,
  0x589965cc75374cc3n
] as const

/** 64×64 → 128-bit multiply, split into [low, high] */
function mum(a: bigint, b: bigint): [bigint, bigint] {
  const x = a * b
  return [x & MASK64, (x >> 64n) & MASK64]
}

function mix(a: bigint, b: bigint): bigint {
  const [lo, hi] = mum(a, b)
  return lo ^ hi
}

/** Little-endian unsigned read of n bytes */
function readLe(buf: Uint8Array, at: number, n: number): bigint {
  let v = 0n
  for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(buf[at + i])
  return v
}

/**
 * Wyhash (final v4, seed 0) as in Zig's std.hash.Wyhash — what `Bun.hash(string)` computes over the UTF-8 bytes. omp runs on Bun
 * and hashes overlong MCP tool names with it, so the same key is minted here
 */
export function bunHash(text: string): bigint {
  const input = new TextEncoder().encode(text)
  const len = input.length
  const s = WYHASH_SECRET
  let state0 = 0n ^ mix(0n ^ s[0], s[1])
  let a: bigint
  let b: bigint
  if (len <= 16) {
    if (len >= 4) {
      const end = len - 4
      const quarter = (len >> 3) << 2
      a = (readLe(input, 0, 4) << 32n) | readLe(input, quarter, 4)
      b = (readLe(input, end, 4) << 32n) | readLe(input, end - quarter, 4)
    } else if (len > 0) {
      a = (BigInt(input[0]) << 16n) | (BigInt(input[len >> 1]) << 8n) | BigInt(input[len - 1])
      b = 0n
    } else {
      a = 0n
      b = 0n
    }
  } else {
    let i = 0
    if (len >= 48) {
      let state1 = state0
      let state2 = state0
      while (i + 48 < len) {
        state0 = mix(readLe(input, i, 8) ^ s[1], readLe(input, i + 8, 8) ^ state0)
        state1 = mix(readLe(input, i + 16, 8) ^ s[2], readLe(input, i + 24, 8) ^ state1)
        state2 = mix(readLe(input, i + 32, 8) ^ s[3], readLe(input, i + 40, 8) ^ state2)
        i += 48
      }
      state0 ^= state1 ^ state2
    }
    for (let j = i; j + 16 < len; j += 16)
      state0 = mix(readLe(input, j, 8) ^ s[1], readLe(input, j + 8, 8) ^ state0)
    a = readLe(input, len - 16, 8)
    b = readLe(input, len - 8, 8)
  }
  ;[a, b] = mum(a ^ s[1], b ^ state0)
  return mix(a ^ s[0] ^ BigInt(len), b ^ s[1])
}

function sanitizeToolNamePart(value: string, fallback: string): string {
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return out || fallback
}

/**
 * The name omp registers an MCP tool under, which is also its `tools.approval` key. Mirrors createMCPToolName in
 * @oh-my-pi/pi-coding-agent 18.4 src/mcp/tool-bridge.ts: both parts lowercased with runs of other than [a-z0-9_] turned into
 * one `_` (trimmed; empty → server/tool), a tool name starting with `<server>_` loses that prefix, joined as
 * `mcp__<server>_<tool>`; a name over 64 characters keeps its first 55 and gains `_` + 8 base-36 characters of Bun.hash
 */
export function ompMcpToolName(server: string, tool: string): string {
  const s = sanitizeToolNamePart(server, 'server')
  const t = sanitizeToolNamePart(tool, 'tool')
  const name = `mcp__${s}_${t.startsWith(`${s}_`) ? t.slice(s.length + 1) : t}`
  if (name.length <= 64) return name
  const hash = bunHash(name).toString(36).slice(0, 8)
  return `${name.slice(0, 64 - hash.length - 1)}_${hash}`
}

// ---------------------------------------------------------------- Rules → config.yml values

/**
 * Library command rules → omp bash.patterns, deny first, then prompt, then allow (omp uses the first match). A rule matches the
 * command and anything after it (`git status`, `git status *`); an exact rule only the command. `*` is omp's one wildcard, so a
 * rule containing it can't be written literally: such rules go to skipped
 */
export function ompBashPatterns(
  lists: { deny?: AllowlistEntry[]; ask?: AllowlistEntry[]; allow?: AllowlistEntry[] },
  skipped: string[] = []
): BashPattern[] {
  const out: BashPattern[] = []
  const seen = new Set<string>()
  const add = (match: string, approval: OmpApproval): void => {
    if (seen.has(match)) return
    seen.add(match)
    out.push({ match, approval })
  }
  for (const [d, list] of [
    ['deny', lists.deny],
    ['prompt', lists.ask],
    ['allow', lists.allow]
  ] as const)
    for (const e of list ?? []) {
      const { argv, claudeExact } = normalizeEntry(e)
      const cmd = commandLine(argv)
      if (!cmd) continue
      if (cmd.includes('*')) {
        skipped.push(cmd)
        continue
      }
      add(cmd, d)
      if (!claudeExact) add(`${cmd} *`, d)
    }
  return out
}

/** Library MCP tool decisions → tools.approval entries. Server defaults omp can't express go to defaults; key clashes to clashes */
function ompApprovals(
  sources: Sources,
  defaults: string[] = [],
  clashes: string[] = []
): Record<string, OmpApproval> {
  const out: Record<string, OmpApproval> = {}
  for (const [server, s] of mcpEntries(mcpForTool(sources, 'omp'))) {
    if (!ompServerNameOk(server)) continue
    const p = mcpPermissionsOf(s)
    if (p.default) defaults.push(`${server} (${p.default})`)
    for (const [tool, d] of Object.entries(p.tools ?? {}).sort(([x], [y]) => x.localeCompare(y))) {
      const key = ompMcpToolName(server, tool)
      const want = OMP_APPROVAL[d]
      const had = out[key]
      if (had && had !== want) clashes.push(key)
      if (!had || STRICTNESS[want] > STRICTNESS[had]) out[key] = want
    }
  }
  return out
}

/** tools.approval keys the app owns: the library's now, plus the ones it wrote before (removed when no longer wanted) */
function ownedApprovalKeys(sources: Sources, ctx: BuildContext | undefined): string[] {
  return [
    ...new Set([...Object.keys(ompApprovals(sources)), ...previouslyOwned(ctx, 'ompPermissions')])
  ].sort()
}

// ---------------------------------------------------------------- config.yml

/** config.yml → Document. TargetError when omp couldn't read it either (omp moves such a file aside), or the top is no mapping */
function readConfigYml(text: string): Document {
  const doc = parseDocument(text)
  const err = doc.errors[0]
  if (err) {
    const at = err instanceof YAMLError ? err.linePos?.[0] : undefined
    throw new TargetError(
      `config.yml is not valid YAML${at ? ` (line ${at.line}, column ${at.col})` : ''} — not written`
    )
  }
  if (doc.contents !== null && !isMap(doc.contents))
    throw new TargetError('config.yml top level is not a mapping — not written')
  return doc
}

function plain(doc: Document): Json {
  const v = doc.toJS() as unknown
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}
}

function getIn(obj: Json, path: string[]): unknown {
  let cur: unknown = obj
  for (const k of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Json)[k]
  }
  return cur
}

/** The parsed value with the owned parts removed (for the "everything else unchanged" check) */
function withoutOwned(obj: Json, patterns: boolean, keys: string[]): Json {
  const c = structuredClone(obj)
  const bash = c.bash
  if (patterns && bash && typeof bash === 'object' && !Array.isArray(bash)) {
    delete (bash as Json).patterns
    if (!Object.keys(bash).length) delete c.bash
  }
  const approval = getIn(c, APPROVAL_PATH)
  if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
    for (const k of keys) delete (approval as Json)[k]
    const tools = c.tools as Json
    if (!Object.keys(approval).length) delete tools.approval
    if (!Object.keys(tools).length) delete c.tools
  }
  return c
}

/** A parent that must be a mapping to hold the owned key */
function assertMapAt(doc: Document, path: string[]): void {
  for (let i = 1; i <= path.length; i++) {
    const node = doc.getIn(path.slice(0, i), true)
    if (node !== undefined && node !== null && !isMap(node))
      throw new TargetError(
        `config.yml ${path.slice(0, i).join('.')} is not a mapping — not written`
      )
  }
}

/** Delete path, then its parents left empty by that */
function deleteWithEmptyParents(doc: Document, path: string[]): void {
  doc.deleteIn(path)
  for (let i = path.length - 1; i > 0; i--) {
    const parent = doc.getIn(path.slice(0, i), true)
    if (isMap(parent) && parent.items.length === 0) doc.deleteIn(path.slice(0, i))
    else break
  }
}

/**
 * ~/.omp/agent/config.yml — omp's command approval rules (bash.patterns, the whole list owned by the library: rules only omp had
 * are replaced) and the library's MCP tool decisions (tools.approval.<omp tool name>; only those keys). Every other key, comment
 * and the file's layout are kept (YAML Document API). Without a library permissions.json bash.patterns is left alone
 */
export const ompPermissions: TargetDef = {
  id: 'ompPermissions',
  tool: 'omp',
  rel: '.omp/agent/config.yml',
  optional: false,
  createIfInUse: true,
  seed: '',
  // Parsed values, not text: omp rewrites config.yml with its own YAML writer
  region(text, sources, ctx) {
    let obj: Json
    try {
      obj = plain(readConfigYml(text))
    } catch {
      return null
    }
    const picked: Json = {}
    const patterns = getIn(obj, PATTERNS_PATH)
    if (sources.hasPermissions && patterns !== undefined) picked.patterns = patterns
    const approval = getIn(obj, APPROVAL_PATH)
    if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
      const owned: Json = {}
      for (const k of ownedApprovalKeys(sources, ctx))
        if ((approval as Json)[k] !== undefined) owned[k] = (approval as Json)[k]
      if (Object.keys(owned).length) picked.approval = owned
    }
    return Object.keys(picked).length ? JSON.stringify(picked) : null
  },
  build(before, ctx) {
    const { sources } = ctx
    if (ctx.retiring)
      return { after: before, notes: ['omp is being turned off — permissions are left untouched'] }
    const doc = readConfigYml(before)
    const prev = plain(doc)
    const notes: string[] = []
    let changed = false

    // bash.patterns: the library's command rules
    if (sources.hasPermissions) {
      const a = allowlistFor(sources.allowlist, 'omp')
      const skipped: string[] = []
      const patterns = ompBashPatterns({ deny: a.bashDeny, ask: a.bashAsk, allow: a.bash }, skipped)
      if (skipped.length)
        notes.push(
          `rules containing * can't be written for omp (its only wildcard): ${skipped.join(', ')}`
        )
      const was = getIn(prev, PATTERNS_PATH)
      if (!isDeepStrictEqual(was ?? [], patterns)) {
        assertMapAt(doc, ['bash'])
        if (patterns.length) doc.setIn(PATTERNS_PATH, doc.createNode(patterns))
        else deleteWithEmptyParents(doc, PATTERNS_PATH)
        changed = true
      }
      const dropped = (Array.isArray(was) ? was : [])
        .filter((r) => !patterns.some((p) => isDeepStrictEqual(p, r)))
        .map((r) => (r && typeof r === 'object' ? String((r as Json).match) : String(r)))
      if (dropped.length)
        notes.push(
          `omp rules not in the library are replaced (import them to keep): ${dropped.join(', ')}`
        )
    } else notes.push('library has no permissions.json — bash.patterns is left untouched')

    // tools.approval: the library's MCP tool decisions
    const defaults: string[] = []
    const clashes: string[] = []
    const want = ompApprovals(sources, defaults, clashes)
    const keys = ownedApprovalKeys(sources, ctx)
    const have = getIn(prev, APPROVAL_PATH)
    for (const k of keys) {
      const cur = have && typeof have === 'object' ? (have as Json)[k] : undefined
      if (want[k] !== undefined && cur !== want[k]) {
        assertMapAt(doc, APPROVAL_PATH)
        doc.setIn([...APPROVAL_PATH, k], want[k])
        changed = true
      } else if (want[k] === undefined && cur !== undefined) {
        deleteWithEmptyParents(doc, [...APPROVAL_PATH, k])
        changed = true
      }
    }
    if (defaults.length)
      notes.push(`omp has no server-wide MCP decision — not written: ${defaults.join(', ')}`)
    if (clashes.length)
      notes.push(`MCP tools sharing one omp name get the strictest decision: ${clashes.join(', ')}`)

    const after = changed ? doc.toString() : before
    const next = plain(readConfigYml(after))
    const same = isDeepStrictEqual(
      withoutOwned(prev, sources.hasPermissions, keys),
      withoutOwned(next, sources.hasPermissions, keys)
    )
    notes.unshift(
      `keys other than bash.patterns and tools.approval unchanged: ${same ? 'OK' : 'broken!'}`
    )
    const owned = Object.keys(want).sort()
    return same
      ? { after, notes, owned }
      : { after, notes, owned, error: 'keys other than bash.patterns and tools.approval changed' }
  }
}
