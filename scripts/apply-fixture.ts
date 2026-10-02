/**
 * M4 apply determinism guard (M7d: source first). Writes only inside a temp fixture HOME.
 *
 * - fixture: mkdtemp(700) + copies of the 6 real target files + .agents as a symlink to the import source (legacySource, read-only)
 *   + .illithid as the library (source) filled by initLibrary + importAllFromLegacy
 * - Skill directories use a fake layout (canonical links, links to another source, real directories, missing)
 * - Never prints file contents or tokens. Prints only per-step PASS/FAIL and counts.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parse as parseToml } from 'smol-toml'
import {
  apply,
  applySkillSync,
  canonicalPaths,
  dirContentHash,
  importAllFromLegacy,
  initLibrary,
  leftoverSkillTmps,
  planSkillSync,
  skillBackupPath,
  canonicalSkills,
  mcpEntries,
  plan,
  readSources,
  readState,
  setModel,
  SetModelError,
  statePath,
  statusReport,
  writeState,
  type ApplyResult,
  type SkillSyncItem,
  type TargetId
} from '../src/engine'
import { TARGETS } from '../src/engine/targets'
import { toJsonText } from '../src/engine/text'
import {
  APP_CONFIG_DIR,
  DEFAULT_LIBRARY_DIR,
  libraryRoot,
  workspacesRoot
} from '../src/engine/config'
import { BACKUP_SUFFIX, LEGACY_BACKUP_SUFFIXES } from '../src/engine/write'
import { LEGACY_MD_MARKERS, MD_MARKERS } from '../src/engine/targets/codexAgents'
import { LEGACY_RULES_MARKERS, RULES_END, RULES_MARKERS } from '../src/engine/targets/codexRules'
import {
  LEGACY_TOML_MCP_MARKERS,
  stripCodexManagedTables,
  TOML_MCP_MARKERS
} from '../src/engine/targets/codexMcp'
import { OWNED_PERMISSION_KEYS } from '../src/engine/targets/claudePermissions'
import {
  blockBodyMulti,
  jsonKeyRegion,
  outsideBlockMulti,
  spliceBlockMulti,
  type MarkerPair
} from '../src/engine/text'
import {
  cleanupFixtures,
  cleanupOnSignals,
  copyInto,
  legacyAppProbePaths,
  makeFixture,
  REAL_HOME
} from './lib/fixtureHome'

type Json = Record<string, unknown>
const env = process.env

/** Per target [current marker, legacy markers…] — files copied from the real HOME may have legacy markers */
const MARKERS: Partial<Record<TargetId, MarkerPair[]>> = {
  codexAgents: [MD_MARKERS, ...LEGACY_MD_MARKERS],
  codexRules: [RULES_MARKERS, ...LEGACY_RULES_MARKERS],
  codexMcp: [TOML_MCP_MARKERS, ...LEGACY_TOML_MCP_MARKERS]
}
/** Original mode per target — deliberately varied to check mode preservation */
const MODES: Record<TargetId, number> = {
  codexAgents: 0o644,
  codexRules: 0o600,
  claudePermissions: 0o640,
  claudeMcp: 0o600,
  codexMcp: 0o600,
  opencodeMcp: 0o644,
  opencodeRules: 0o644, // same file as opencodeMcp (not a default target)
  opencodeSkills: 0o644,
  claudeSkillOverrides: 0o640, // same file as claudePermissions
  codexSkillConfig: 0o600, // same file as codexMcp
  opencodeSkillPermissions: 0o644,
  geminiRules: 0o644, // not a default target
  geminiMcp: 0o600, // not a default target
  copilotMcp: 0o600, // not a default target
  grokMcp: 0o600, // not a default target
  grokCompat: 0o600, // same file as grokMcp (not a default target)
  claudeHooks: 0o640, // same file as claudePermissions (not a default target)
  codexHooks: 0o600, // same file as codexMcp (not a default target)
  codexHooksJson: 0o600, // not a default target
  geminiHooks: 0o600, // same file as geminiMcp (not a default target)
  copilotHooks: 0o600, // not a default target
  grokHooks: 0o600, // not a default target
  geminiPolicy: 0o644 // not a default target
}
const rel = (id: TargetId): string => TARGETS.find((t) => t.id === id)!.rel

// ---------- result recording ----------
const rows: { step: string; ok: boolean; detail: string }[] = []
function check(step: string, ok: boolean, detail: string): void {
  rows.push({ step, ok, detail })
}

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')
const read = (p: string): string => readFileSync(p, 'utf8')
const readJson = (p: string): Json => JSON.parse(read(p)) as Json
const writeJson = (p: string, o: Json): void => writeFileSync(p, JSON.stringify(o, null, 2) + '\n')
const mode = (p: string): number => statSync(p).mode & 0o7777

/** fixture tree snapshot (.agents excluded): relative path → file sha or link string */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string, r: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const rp = r ? `${r}/${name}` : name
      if (rp === '.agents') continue
      const st = lstatSync(p)
      if (st.isSymbolicLink()) out.set(rp, `L:${readlinkSync(p)}`)
      else if (st.isDirectory()) walk(p, rp)
      else out.set(rp, `F:${sha(readFileSync(p))}`)
    }
  }
  walk(root, '')
  return out
}

function diffKeys(a: Map<string, string>, b: Map<string, string>): string[] {
  const keys = new Set([...a.keys(), ...b.keys()])
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort()
}

/** Things in the real HOME that must never change (~/.claude.json excluded since the runtime keeps writing it) */
function realHomeProbe(): Map<string, string> {
  const m = new Map<string, string>()
  const paths = [
    ...TARGETS.filter((t) => t.id !== 'claudeMcp').map((t) => join(REAL_HOME, t.rel)),
    ...TARGETS.map((t) => join(REAL_HOME, t.rel) + BACKUP_SUFFIX),
    ...LEGACY_BACKUP_SUFFIXES.flatMap((sfx) => TARGETS.map((t) => join(REAL_HOME, t.rel) + sfx)),
    statePath(REAL_HOME),
    join(REAL_HOME, '.claude/skills'),
    join(REAL_HOME, '.codex/skills'),
    join(REAL_HOME, '.agents/skills'),
    join(REAL_HOME, '.agents/sync/mcp.json'),
    join(REAL_HOME, DEFAULT_LIBRARY_DIR),
    join(REAL_HOME, DEFAULT_LIBRARY_DIR, 'rules'),
    workspacesRoot(REAL_HOME),
    libraryRoot(REAL_HOME),
    join(libraryRoot(REAL_HOME), 'rules'),
    join(REAL_HOME, APP_CONFIG_DIR),
    ...legacyAppProbePaths()
  ]
  for (const p of paths) {
    try {
      const st = lstatSync(p)
      m.set(p, `${st.mtimeMs}:${st.size}`)
    } catch {
      m.set(p, 'absent')
    }
  }
  return m
}

function statusOf(home: string, id: TargetId): string {
  return statusReport(home, env).cells.find((c) => c.target === id)?.state ?? '-'
}

function byId(rs: ApplyResult[], id: TargetId): ApplyResult | undefined {
  return rs.find((r) => r.id === id)
}

// ---------- fixture setup ----------
function setupLibrary(F: string): void {
  initLibrary(F)
  const r = importAllFromLegacy(F)
  const bad = r.results.filter((x) => x.status !== 'imported')
  if (bad.length) throw new Error(`legacy import failed: ${bad.length}`)
}

function setupTargets(F: string): string[] {
  for (const t of TARGETS) {
    if (!copyInto(REAL_HOME, F, t.rel, MODES[t.id]))
      throw new Error(`${t.rel} missing in real HOME`)
  }
  const ssot = mcpEntries(readSources(F).mcp).map(([n]) => n)
  if (!ssot.length) throw new Error('no SSOT servers')

  // Make the owned regions stale on purpose so all 6 are pending apply
  for (const [id, pairs] of Object.entries(MARKERS) as [TargetId, MarkerPair[]][]) {
    const p = join(F, rel(id))
    const text = read(p)
    // Leave as-is if there is no marker (adding the block is the pending apply). Legacy marker blocks get a stale body in place
    if (blockBodyMulti(text, pairs) !== null)
      writeFileSync(p, spliceBlockMulti(text, pairs[0], pairs.slice(1), '# fixture stale'))
  }
  const sp = join(F, rel('claudePermissions'))
  const settings = readJson(sp)
  const perms = (settings.permissions ?? {}) as Json
  settings.permissions = { ...perms, allow: ['Bash(fixture-stale:*)'] }
  writeJson(sp, settings)

  const cp = join(F, rel('claudeMcp'))
  const cj = readJson(cp)
  cj.mcpServers = {
    ...((cj.mcpServers as Json) ?? {}),
    [ssot[0]]: { type: 'stdio', command: 'fixture-stale', args: [] }
  }
  writeJson(cp, cj)

  const op = join(F, rel('opencodeMcp'))
  const oc = readJson(op)
  oc.mcp = {
    ...((oc.mcp as Json) ?? {}),
    [ssot[0]]: { type: 'local', command: ['fixture-stale'], enabled: true },
    'fixture-local': { type: 'local', command: ['fixture-local'], enabled: false }
  }
  writeJson(op, oc)

  // codex config.toml: line for checking comment preservation
  const tp = join(F, '.codex/config.toml')
  writeFileSync(tp, '# fixture: top-level comment preservation check\n' + read(tp))
  return ssot
}

function setupSkills(F: string): string[] {
  const canon = canonicalSkills(F)
  if (canon.length < 3) throw new Error(`fewer than 3 canonical skills (${canon.length})`)
  const canonDir = canonicalPaths(F).skills
  const other = join(F, 'other-source')
  const cs = join(F, '.claude/skills')
  const xs = join(F, '.codex/skills')
  for (const d of [other, cs, xs]) mkdirSync(d, { recursive: true, mode: 0o700 })
  for (const n of canon.slice(0, 2)) {
    mkdirSync(join(other, n))
    writeFileSync(join(other, n, 'SKILL.md'), '# other source\n')
  }
  symlinkSync(join(canonDir, canon[0]), join(cs, canon[0])) // linked
  symlinkSync(join(other, canon[1]), join(cs, canon[1])) // otherSource → relink
  mkdirSync(join(cs, canon[2])) // real directory → copy(skip)
  writeFileSync(join(cs, canon[2], 'SKILL.md'), '# real dir\n')
  mkdirSync(join(cs, 'fixture-extra')) // outside canonical → extra (untouched)
  writeFileSync(join(cs, 'fixture-extra', 'SKILL.md'), '# extra\n')
  mkdirSync(join(cs, '.fixture-hidden')) // hidden (untouched)
  writeFileSync(join(cs, '.fixture-hidden', 'SKILL.md'), '# hidden\n')
  symlinkSync(join(other, canon[0]), join(xs, canon[0])) // codex otherSource → relink
  return canon
}

// ---------- steps ----------
function run(): void {
  const realBefore = realHomeProbe()
  const F = makeFixture('illithid-apply-')
  setupLibrary(F)
  const ssot = setupTargets(F)
  const canon = setupSkills(F)
  const ids = TARGETS.map((t) => t.id)

  const baseline = new Map(ids.map((id) => [id, read(join(F, rel(id)))]))
  const snapBefore = snapshot(F)

  // a. pending → apply → re-plan changed 0
  {
    const pending = ids.filter((id) => statusOf(F, id) === 'needsSync')
    const res = apply(F, env)
    const written = res.filter((r) => r.status === 'written').length
    const again = plan(F, env)
    const left = again.filter((c) => c.changed || c.error).length
    check(
      'a. needsSync → apply → re-plan changes 0',
      pending.length === 6 && written === 6 && left === 0,
      `needsSync ${pending.length}/6, written ${written}/6, re-plan changes/errors ${left}`
    )

    // c. .bak and mode
    const bad: string[] = []
    for (const id of ids) {
      const p = join(F, rel(id))
      const r = byId(res, id)
      const bak = p + '.illithid.bak'
      if (r?.backupPath !== bak || !existsSync(bak)) bad.push(`${id}:bak missing`)
      else {
        if (sha(read(bak)) !== sha(baseline.get(id)!)) bad.push(`${id}:bak content`)
        if (mode(bak) !== MODES[id]) bad.push(`${id}:bak mode`)
      }
      if (mode(p) !== MODES[id]) bad.push(`${id}:original mode`)
    }
    check(
      'c. .bak created, original mode preserved',
      bad.length === 0,
      bad.length ? bad.join(', ') : '6 targets bak=previous content, mode same'
    )
  }

  // b. nothing outside the owned regions changes
  {
    const bad: string[] = []
    const jsonOwned: Partial<Record<TargetId, { key: string; sub: readonly string[] }>> = {
      claudePermissions: { key: 'permissions', sub: OWNED_PERMISSION_KEYS },
      claudeMcp: { key: 'mcpServers', sub: ssot },
      opencodeMcp: { key: 'mcp', sub: ssot }
    }
    for (const id of ids) {
      const before = baseline.get(id)!
      const after = read(join(F, rel(id)))
      const m = MARKERS[id]
      if (m && id === 'codexMcp') {
        // SSOT server tables left outside the block are owned, so they get removed — all other text must be identical
        const expectOutside = stripCodexManagedTables(outsideBlockMulti(before, m), ssot)
        if (outsideBlockMulti(after, m).trimEnd() !== expectOutside.trimEnd())
          bad.push(`${id}:outside block`)
        // Semantic compare: top-level keys other than mcp_servers and servers outside the SSOT are identical
        const B = parseToml(before) as Json
        const A = parseToml(after) as Json
        const top = new Set([...Object.keys(B), ...Object.keys(A)])
        top.delete('mcp_servers')
        for (const k of top) if (!isDeepStrictEqual(B[k], A[k])) bad.push(`${id}:${k}`)
        const bs = (B.mcp_servers ?? {}) as Json
        const as = (A.mcp_servers ?? {}) as Json
        for (const k of new Set([...Object.keys(bs), ...Object.keys(as)])) {
          if (!ssot.includes(k) && !isDeepStrictEqual(bs[k], as[k])) bad.push(`${id}:mcp_servers.*`)
        }
        continue
      }
      if (m) {
        if (outsideBlockMulti(before, m) !== outsideBlockMulti(after, m))
          bad.push(`${id}:outside block`)
        continue
      }
      const o = jsonOwned[id]!
      const B = JSON.parse(before) as Json
      const A = JSON.parse(after) as Json
      const top = new Set([...Object.keys(B), ...Object.keys(A)])
      top.delete(o.key)
      for (const k of top) if (!isDeepStrictEqual(B[k], A[k])) bad.push(`${id}:${k}`)
      const b2 = (B[o.key] ?? {}) as Json
      const a2 = (A[o.key] ?? {}) as Json
      const subs = new Set([...Object.keys(b2), ...Object.keys(a2)])
      for (const s of o.sub) subs.delete(s)
      for (const k of subs) if (!isDeepStrictEqual(b2[k], a2[k])) bad.push(`${id}:${o.key}.*`)
    }
    const allowed = new Set([
      ...ids.map((id) => rel(id)),
      ...ids.map((id) => rel(id) + '.illithid.bak'),
      '.config/illithid/state.json'
    ])
    const touched = diffKeys(snapBefore, snapshot(F))
    const stray = touched.filter((k) => !allowed.has(k))
    if (stray.length) bad.push(`unexpected file changes: ${stray.length}`)
    check(
      'b. nothing outside owned regions changes',
      bad.length === 0,
      bad.length
        ? bad.join(', ')
        : `3 JSON non-owned keys/subentries identical, 3 marker files identical outside blocks, ${touched.length} changed files all on the allowlist`
    )
  }

  // d. state recorded → inSync
  {
    const st = readState(F)
    const n = Object.keys(st.state.applied).length
    const states = ids.map((id) => statusOf(F, id))
    const allIn = states.every((s) => s === 'synced')
    check(
      'd. state.json recorded → status synced',
      n === 6 && allIn && !st.error,
      `baselines ${n}/6, synced ${states.filter((s) => s === 'synced').length}/6`
    )
  }

  // e. tool-side change in owned region → needsSync → apply restores from source (no confirmation) + backup
  {
    const sp = join(F, rel('claudePermissions'))
    const s = readJson(sp)
    const p = s.permissions as Json
    p.allow = [...(p.allow as string[]), 'Bash(fixture-manual:*)']
    writeJson(sp, s)
    const rp = join(F, rel('codexRules'))
    const rt = read(rp)
    writeFileSync(rp, rt.replace(RULES_END, '# fixture manual line\n' + RULES_END))
    const before = (['claudePermissions', 'codexRules'] as TargetId[]).map((id) => statusOf(F, id))
    const snapManual = [sha(read(sp)), sha(read(rp))]
    const res = apply(F, env)
    const restored = (['claudePermissions', 'codexRules'] as TargetId[]).every(
      (id) => byId(res, id)?.status === 'written' && byId(res, id)?.restored === true
    )
    const backed =
      sha(read(sp + '.illithid.bak')) === snapManual[0] &&
      sha(read(rp + '.illithid.bak')) === snapManual[1]
    const gone = !read(sp).includes('fixture-manual') && !read(rp).includes('fixture manual line')
    const others = res
      .filter((r) => r.id !== 'claudePermissions' && r.id !== 'codexRules')
      .every((r) => r.status === 'unchanged')
    const after = (['claudePermissions', 'codexRules'] as TargetId[]).map((id) => statusOf(F, id))
    check(
      'e. tool-side change in owned region → needsSync → apply restores from source (backup)',
      before.every((x) => x === 'needsSync') &&
        restored &&
        backed &&
        gone &&
        others &&
        after.every((x) => x === 'synced'),
      `status [${before.join(',')}] → written+restored ${restored ? 'OK' : 'X'}, tool-side change kept in .bak ${backed ? 'OK' : 'X'}, restored from source ${gone ? 'OK' : 'X'}, rest unchanged ${others ? 'OK' : 'X'} → [${after.join(',')}]`
    )
  }

  // f. change outside owned region → not drift
  {
    const cp = join(F, rel('claudeMcp'))
    const cj = readJson(cp)
    const oldRegion = jsonKeyRegion(read(cp), 'mcpServers')
    cj.mcpServers = {
      ...(cj.mcpServers as Json),
      'fixture-extra': { type: 'stdio', command: 'fixture', args: [] }
    }
    writeJson(cp, cj)
    const sp = join(F, rel('claudePermissions'))
    const s = readJson(sp)
    const oldPerm = jsonKeyRegion(read(sp), 'permissions')
    ;(s.permissions as Json).defaultMode = 'fixture-mode'
    writeJson(sp, s)
    const op = join(F, rel('opencodeMcp'))
    const oc = readJson(op)
    const oldOc = jsonKeyRegion(read(op), 'mcp')
    ;(oc.mcp as Json)['fixture-local'] = {
      type: 'local',
      command: ['fixture-local-2'],
      enabled: false
    }
    writeJson(op, oc)
    const ap = join(F, rel('codexAgents'))
    writeFileSync(ap, read(ap) + '\nfixture: hand-written text outside the block\n')

    const oldWouldDrift = [
      oldRegion !== jsonKeyRegion(read(cp), 'mcpServers'),
      oldPerm !== jsonKeyRegion(read(sp), 'permissions'),
      oldOc !== jsonKeyRegion(read(op), 'mcp')
    ].filter(Boolean).length
    const states = ids.map((id) => statusOf(F, id))
    const snaps = [cp, sp, op, ap].map((p) => sha(read(p)))
    const res = apply(F, env)
    const allUnchanged = res.every((r) => r.status === 'unchanged')
    const preserved = [cp, sp, op, ap].every((p, i) => sha(read(p)) === snaps[i])
    check(
      'f. change outside owned region → unmanaged (stays synced, preserved)',
      states.every((x) => x === 'synced') && allUnchanged && preserved,
      `status synced ${states.filter((x) => x === 'synced').length}/6 (would be detected as changed with whole-key regions ${oldWouldDrift}/3), apply all unchanged ${allUnchanged ? 'OK' : 'X'}, hand edit preserved ${preserved ? 'OK' : 'X'}`
    )
  }

  // g. file changed after check → changedSinceCheck
  {
    // g1: changed after the check-time hash (expectedBefore)
    const sp = join(F, rel('claudePermissions'))
    const s = readJson(sp)
    ;(s.permissions as Json).allow = ['Bash(fixture-stale2:*)']
    writeJson(sp, s)
    const st = readState(F).state
    delete st.applied.claudePermissions
    writeState(F, st)
    const pendingBefore = statusOf(F, 'claudePermissions')
    const checked = plan(F, env).find((c) => c.id === 'claudePermissions')!
    const expectedBefore = { claudePermissions: sha(checked.before) }
    const s2 = readJson(sp)
    s2.fixtureAfterCheck = true
    writeJson(sp, s2)
    const snap = sha(read(sp))
    const r1 = apply(F, env, ['claudePermissions'], { expectedBefore })[0]
    const g1 =
      pendingBefore === 'needsSync' &&
      r1.status === 'skipped' &&
      r1.reason === 'changedSinceCheck' &&
      sha(read(sp)) === snap

    // g2: ~/.claude.json re-check right before rename
    const cp = join(F, rel('claudeMcp'))
    const cj = readJson(cp)
    ;(cj.mcpServers as Json)[ssot[0]] = { type: 'stdio', command: 'fixture-stale3', args: [] }
    writeJson(cp, cj)
    const st2 = readState(F).state
    delete st2.applied.claudeMcp
    writeState(F, st2)
    let raced = ''
    const r2 = apply(F, env, ['claudeMcp'], {
      beforeCommit: (id) => {
        if (id !== 'claudeMcp') return
        const o = readJson(cp)
        o.fixtureRuntimeWrite = Date.now()
        writeJson(cp, o)
        raced = sha(read(cp))
      }
    })[0]
    const tmpLeft = readdirSync(F).filter(
      (n) => n.includes('.illithid-') && n.endsWith('.tmp')
    ).length
    const g2 =
      r2.status === 'skipped' &&
      r2.reason === 'changedSinceCheck' &&
      raced !== '' &&
      sha(read(cp)) === raced &&
      tmpLeft === 0
    check(
      'g. changed after check → changedSinceCheck',
      g1 && g2,
      `changed after check skipped/preserved ${g1 ? 'OK' : 'X'} (${r1.status}/${r1.reason ?? '-'}), ~/.claude.json race right before rename skipped/preserved/tmp cleaned ${g2 ? 'OK' : 'X'} (${r2.status}/${r2.reason ?? '-'})`
    )
  }

  // h. setModel
  {
    const bad: string[] = []
    const jsonCase = (tool: 'claude' | 'opencode', key: string): void => {
      const p =
        tool === 'claude'
          ? join(F, '.claude/settings.json')
          : join(F, '.config/opencode/opencode.json')
      const beforeText = read(p)
      const B = JSON.parse(beforeText) as Json
      const r = setModel(F, tool, key, `fixture-${tool}-${key}`)
      const afterText = read(p)
      const A = JSON.parse(afterText) as Json
      if (r.status !== 'written' || A[key] !== `fixture-${tool}-${key}`)
        bad.push(`${tool}.${key}:value`)
      const keys = new Set([...Object.keys(A), ...Object.keys(B)])
      keys.delete(key)
      for (const k of keys)
        if (!isDeepStrictEqual(A[k], B[k])) bad.push(`${tool}.${key}:${k} changed`)
      if (!/^\{\n {2}"/.test(afterText) || afterText.endsWith('\n') !== beforeText.endsWith('\n'))
        bad.push(`${tool}.${key}:format`)
      if (!r.backupPath || !existsSync(r.backupPath) || sha(read(r.backupPath)) !== sha(beforeText))
        bad.push(`${tool}.${key}:bak`)
    }
    jsonCase('claude', 'model')
    jsonCase('claude', 'effortLevel')
    jsonCase('opencode', 'small_model')

    // codex TOML: model is replaced (inline comment kept), model_reasoning_effort is removed then inserted
    const tp = join(F, '.codex/config.toml')
    let text = read(tp)
    const lines0 = text.split('\n')
    const top = lines0.findIndex((l) => /^\s*\[/.test(l))
    const topEnd = top === -1 ? lines0.length : top
    const mi = lines0.slice(0, topEnd).findIndex((l) => /^\s*model\s*=/.test(l))
    if (mi !== -1) lines0[mi] = lines0[mi].replace(/\s*(#.*)?$/, '') + ' # fixture inline'
    const lines1 = lines0.filter(
      (l, i) => !(i < topEnd && /^\s*model_reasoning_effort\s*=/.test(l))
    )
    text = lines1.join('\n')
    writeFileSync(tp, text)

    const before1 = read(tp).split('\n')
    const r1 = setModel(F, 'codex', 'model', 'fixture-codex-model')
    const after1 = read(tp).split('\n')
    if (mi !== -1) {
      const diff = before1.map((l, i) => (l === after1[i] ? -1 : i)).filter((i) => i !== -1)
      if (after1.length !== before1.length || diff.length !== 1)
        bad.push('codex.model:other lines changed')
      else if (!/^model = "fixture-codex-model" # fixture inline$/.test(after1[diff[0]]))
        bad.push('codex.model:line format')
    } else if (after1.length !== before1.length + 1) bad.push('codex.model:insert')
    if (r1.status !== 'written') bad.push('codex.model:status')

    const before2 = read(tp).split('\n')
    const r2 = setModel(F, 'codex', 'model_reasoning_effort', 'high')
    const after2 = read(tp).split('\n')
    const ins = after2.findIndex((l) => l === 'model_reasoning_effort = "high"')
    const without = after2.filter((_, i) => i !== ins)
    if (r2.status !== 'written' || ins === -1 || !isDeepStrictEqual(without, before2))
      bad.push('codex.effort:insert')
    const hdr = after2.findIndex((l) => /^\s*\[/.test(l))
    if (hdr !== -1 && ins > hdr) bad.push('codex.effort:inserted inside a table')
    if (after2[0] !== '# fixture: top-level comment preservation check') bad.push('codex:comment')

    // whitelist
    const sp = join(F, '.claude/settings.json')
    const snap = sha(read(sp))
    let refused = false
    try {
      setModel(F, 'claude', 'permissions', 'x')
    } catch (e) {
      refused = e instanceof SetModelError
    }
    if (!refused || sha(read(sp)) !== snap) bad.push('whitelist')
    check(
      'h. setModel for 3 tools — only that key changes',
      bad.length === 0,
      bad.length
        ? bad.join(', ')
        : 'claude model/effortLevel, opencode small_model, codex model (replaced, inline comment kept)/model_reasoning_effort (inserted before first table), other keys/lines/comments identical, disallowed keys refused'
    )
  }

  // i. skill copy sync (planSkillSync, applySkillSync)
  {
    const bad: string[] = []
    const cs = join(F, '.claude/skills')
    const xs = join(F, '.codex/skills')
    const canonDir = canonicalPaths(F).skills
    const srcHash = (n: string): string => dirContentHash(join(canonDir, n))
    const isRealDir = (p: string): boolean => {
      const st = lstatSync(p)
      return st.isDirectory() && !st.isSymbolicLink()
    }
    const userDir = join(cs, canon[2])
    const userHash = dirContentHash(userDir)
    const untouched = [join(cs, 'fixture-extra'), join(cs, '.fixture-hidden')]
    const untouchedHash = untouched.map((p) => dirContentHash(p))
    const count = (items: SkillSyncItem[], a: string): number =>
      items.filter((x) => x.action === a).length

    // i1. plan: 3 symlinks → replaceLink, 1 user real directory → skip, rest copy
    const p1 = planSkillSync(F, env)
    const nCopy = canon.length * 2 - 3 - 1
    if (count(p1, 'replaceLink') !== 3) bad.push(`replaceLink plan ${count(p1, 'replaceLink')}`)
    if (count(p1, 'copy') !== nCopy) bad.push(`copy plan ${count(p1, 'copy')}/${nCopy}`)
    const sk = p1.find((x) => x.tool === 'claude' && x.name === canon[2])
    if (sk?.action !== 'skip' || sk.reason !== 'userOwned') bad.push('user-owned not skipped')
    if (p1.some((x) => x.name.startsWith('.') || x.name === 'fixture-extra'))
      bad.push('hidden/non-canonical entries in plan')

    // i2. apply: symlinks become real directories, content hash = canonical, link string recorded
    const r1 = applySkillSync(F, env, p1)
    const done = r1.filter((x) => x.status === 'done').length
    if (done !== 3 + nCopy) bad.push(`done ${done}/${3 + nCopy}`)
    for (const [dir, n] of [
      [cs, canon[0]],
      [cs, canon[1]],
      [xs, canon[0]]
    ] as const) {
      const p = join(dir, n)
      if (!isRealDir(p)) bad.push(`${n}: not a real directory`)
      else if (dirContentHash(p) !== srcHash(n)) bad.push(`${n}: hash mismatch`)
    }
    const rl = r1.filter((x) => x.action === 'replaceLink')
    if (rl.some((x) => !x.previousLink)) bad.push('previousLink missing')
    const stSkills = readState(F).state.skills ?? {}
    if (!stSkills.claude?.[canon[1]]?.previousLink?.includes('/other-source/'))
      bad.push('state previousLink missing')
    const copiesOk = p1
      .filter((x) => x.action === 'copy')
      .every((x) => isRealDir(x.path) && dirContentHash(x.path) === x.sourceHash)
    if (!copiesOk) bad.push('copy result hash mismatch')
    if (!existsSync(join(F, 'other-source', canon[1], 'SKILL.md')))
      bad.push('previous link target damaged')
    if (dirContentHash(userDir) !== userHash) bad.push('user-owned directory changed')
    if (untouched.some((p, i) => dirContentHash(p) !== untouchedHash[i]))
      bad.push('hidden/extra changed')
    if (leftoverSkillTmps(F).length) bad.push('tmp left over')

    // i3. rerun idempotent + status
    const snapA = snapshot(F)
    const p2 = planSkillSync(F, env)
    const r2 = applySkillSync(F, env, p2)
    const idem =
      p2.every((x) => x.action === 'inSync' || (x.action === 'skip' && x.name === canon[2])) &&
      r2.every((x) => x.status === 'unchanged' || x.status === 'skipped') &&
      diffKeys(snapA, snapshot(F)).length === 0
    if (!idem) bad.push('rerun not idempotent')
    const cell = (tool: string): string =>
      statusReport(F, env).cells.find((c) => c.resource === 'skills' && c.tool === tool)?.state ??
      '-'
    const codexCell = cell('codex')
    const claudeCell = cell('claude') // user-owned real directory is unmanaged — synced
    if (codexCell !== 'synced' || claudeCell !== 'synced')
      bad.push(`status codex ${codexCell}, claude ${claudeCell}`)

    // i4. tool-side edit → needsSync → apply restores from source (backup outside skill directories)
    const edited = join(cs, canon[0], 'SKILL.md')
    writeFileSync(edited, read(edited) + '\nfixture tool-side edit\n')
    const editedHash = sha(read(edited))
    const p3 = planSkillSync(F, env)
    const d = p3.find((x) => x.tool === 'claude' && x.name === canon[0])
    const driftCell = cell('claude')
    const r3 = applySkillSync(F, env, p3)
    const r3d = r3.find((x) => x.tool === 'claude' && x.name === canon[0])
    const bak = skillBackupPath(F, 'claude', canon[0])
    const restoredOk =
      d?.action === 'update' &&
      d.drift === true &&
      driftCell === 'needsSync' &&
      r3d?.status === 'done' &&
      r3d.reason === 'restored' &&
      r3d.backupPath === bak &&
      sha(read(join(bak, 'SKILL.md'))) === editedHash &&
      dirContentHash(join(cs, canon[0])) === srcHash(canon[0])
    if (!restoredOk) bad.push('tool-side edit → restore/backup failed')
    if (bak.startsWith(cs + '/') || bak.startsWith(xs + '/'))
      bad.push('backup inside skill directory')
    if (cell('claude') !== 'synced') bad.push(`status after restore ${cell('claude')}`)

    // i5. old app-written copy (canonical changed) → update without drift
    const e2 = join(xs, canon[1], 'SKILL.md')
    writeFileSync(e2, read(e2) + '\nfixture older version\n')
    const st5 = readState(F).state
    st5.skills!.codex![canon[1]].contentHash = dirContentHash(join(xs, canon[1]))
    writeState(F, st5)
    const p5 = planSkillSync(F, env)
    const u = p5.find((x) => x.tool === 'codex' && x.name === canon[1])
    const r5 = applySkillSync(F, env, p5).find((x) => x.tool === 'codex' && x.name === canon[1])
    if (
      u?.action !== 'update' ||
      u.drift ||
      r5?.status !== 'done' ||
      dirContentHash(join(xs, canon[1])) !== srcHash(canon[1])
    )
      bad.push('update (non-drift) failed')

    // i6. app-owned copy gone from canonical → only flagged as delete candidate
    const gone = join(cs, 'fixture-gone')
    mkdirSync(gone)
    writeFileSync(join(gone, 'SKILL.md'), '# gone\n')
    const st6 = readState(F).state
    st6.skills!.claude!['fixture-gone'] = {
      contentHash: dirContentHash(gone),
      at: new Date().toISOString()
    }
    writeState(F, st6)
    const p6 = planSkillSync(F, env)
    const r6 = applySkillSync(F, env, p6).find((x) => x.name === 'fixture-gone')
    if (
      !p6.some((x) => x.action === 'deleteCandidate' && x.name === 'fixture-gone') ||
      r6?.status !== 'pendingApproval' ||
      !existsSync(join(gone, 'SKILL.md'))
    )
      bad.push('delete candidate handling failed')

    // i7. forged requests refused: copy onto a user-owned directory, out-of-scope path
    const forged = applySkillSync(F, env, [
      {
        tool: 'claude',
        name: canon[2],
        action: 'copy',
        path: userDir,
        source: join(canonDir, canon[2])
      },
      {
        tool: 'codex',
        name: 'x',
        action: 'copy',
        path: join(F, 'elsewhere/x'),
        source: join(canonDir, canon[0])
      }
    ])
    if (
      forged[0]?.reason !== 'changedSinceCheck' ||
      forged[1]?.reason !== 'outOfScope' ||
      dirContentHash(userDir) !== userHash
    )
      bad.push('forged request not refused')

    check(
      'i. skill copy sync (replaceLink, copy, restore from source, user-owned, idempotent)',
      bad.length === 0,
      bad.length
        ? bad.join(', ')
        : `replaceLink 3 (link→real directory, link string recorded), copy ${nCopy}, hash=canonical, user-owned/hidden/extra unchanged, rerun inSync with no tree change, tool-side edit→restored from source (backup outside skill directories), update and delete candidates flagged, forgeries refused`
    )
  }

  // j. real HOME unchanged
  {
    const realAfter = realHomeProbe()
    const changed = [...realBefore.keys()].filter((k) => realBefore.get(k) !== realAfter.get(k))
    check(
      'j. real HOME target mtimes unchanged (except ~/.claude.json)',
      changed.length === 0,
      changed.length
        ? `changed ${changed.length}: ${changed.map((p) => p.replace(REAL_HOME, '~')).join(', ')}`
        : `${realBefore.size} paths (5 targets, 6 bak, state, 3 skill dirs, mcp.json, ~/.illithid, app config dir) unchanged`
    )
  }

  // k. JSON targets follow the file on disk: same content keeps the bytes, no trailing newline stays without one
  {
    const doc = { mcpServers: { a: { command: 'x' } }, projects: { p: 1 } }
    const compact = JSON.stringify(doc)
    const noNl = JSON.stringify(doc, null, 2)
    const changed = { ...doc, mcpServers: { a: { command: 'y' } } }
    const ok =
      toJsonText(doc, compact) === compact &&
      toJsonText(doc, noNl) === noNl &&
      toJsonText(changed, noNl) === JSON.stringify(changed, null, 2) &&
      toJsonText(changed, noNl + '\n') === JSON.stringify(changed, null, 2) + '\n' &&
      toJsonText(changed) === JSON.stringify(changed, null, 2) + '\n'
    check(
      "k. JSON targets keep unchanged text and the file's trailing-newline style",
      ok,
      ok ? 'ok' : 'mismatch'
    )
  }
}

cleanupOnSignals()
let crashed: string | undefined
try {
  run()
} catch (e) {
  // JSON parse error messages may contain raw content fragments — keep only the name
  const err = e as Error
  crashed = err instanceof SyntaxError ? err.name : `${err.name}: ${err.message}`
} finally {
  cleanupFixtures()
}

for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}\n      ${r.detail}`)
if (crashed) console.log(`FAIL  run aborted — ${crashed}`)
const failed = rows.filter((r) => !r.ok).length + (crashed ? 1 : 0)
console.log(
  `\napply-fixture ${rows.length - rows.filter((r) => !r.ok).length}/${rows.length} PASS${crashed ? ' (aborted)' : ''}`
)
process.exit(failed ? 1 : 0)
