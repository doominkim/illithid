/**
 * M7 engine determinism guard (M7d: ~/.illithid library, explicit import, source-first). Runs only in temp fixture HOMEs.
 *
 * - fixture F: mkdtemp(700). .agents is a **copy** of the import source (legacySource) (import source legacy),
 *   .illithid is the library (source) filled by initLibrary + importAllFromLegacy.
 * - Target files are copied from the real HOME. Env vars use fake values only (so real tokens never land in fixture files).
 * - Never prints file contents or tokens. Prints only per-step PASS/FAIL and counts.
 * Run: npx tsx scripts/m7-fixture.ts
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import { unzipSync, zipSync } from 'fflate'
import { parse as parseToml } from 'smol-toml'
import {
  applyImport,
  backupStatus,
  connectBackup,
  disconnect,
  history,
  pullOnStart,
  restore,
  snapshot,
  watchLibrary,
  writeConfig,
  importAllFromLegacy,
  applyRuleSync,
  canonicalPaths,
  canonicalSkills,
  claudeRulesPaths,
  createRule,
  createSkill,
  deleteMcpServer,
  createWorkspace,
  switchWorkspace,
  renameWorkspace,
  deleteWorkspace,
  listWorkspaces,
  migrateToWorkspaces,
  planMigrateToWorkspaces,
  exportWorkspace,
  importWorkspace,
  workspaceRoot,
  deleteRule,
  renameRule,
  deleteSkill,
  initLibrary,
  libraryExists,
  libraryPaths,
  libraryRoot,
  LibraryError,
  listImportSources,
  listMcpServers,
  listMemoryFiles,
  listSkillFiles,
  mcpEntries,
  plan,
  planAll,
  planImport,
  planRuleSync,
  planSkillSync,
  readConfig,
  readMcpOrderList,
  readMcpServer,
  readPermissions,
  readRule,
  readSkillFile,
  readSkillDoc,
  writeSkillDoc,
  renameSkill,
  createAgent,
  deleteAgent,
  readAgentDoc,
  renameAgent,
  writeAgentDoc,
  agentToolPath,
  agentBackupPath,
  deletedBackupRoot,
  importedBackupRoot,
  renderAgent,
  dirContentHash,
  parseAgentText,
  listAgents,
  readSources,
  readState,
  setToggle,
  skillBackupPath,
  statusReport,
  summarizeSync,
  syncAll,
  pendingSyncCount,
  previewSwitch,
  upsertMcpServer,
  writePermissions,
  writeRule,
  writeSkillFile,
  writeState,
  memorySecretBackend,
  withLegacySecrets,
  autoRenamePending,
  renamePendingPaths,
  type Allowlist,
  type Env,
  type FileChange,
  type ImportKind,
  type ImportSelection,
  type McpServer
} from '../src/engine'
import { deleteCandidates, mcpRead, mcpSave } from '../src/main/writes'
import {
  indexSessions,
  indexStatus,
  indexAllDocs,
  searchDocs,
  searchAll,
  htmlToText,
  readSessionTranscript,
  scanSessions,
  searchIndexPath,
  searchSessions
} from '../src/engine'
import type { DatabaseSync } from 'node:sqlite'
import {
  claudeProjectSlug,
  moveClaudeMemory,
  promoteClaudeMemory,
  readClaudeMemoryFile,
  scanClaudeMemory,
  scanCodexMemory,
  listCodexRolloutSummaries,
  readCodexMemoryFile,
  trashClaudeMemory
} from '../src/engine/toolMemory'
import { memoryPortability, rulePortability } from '../src/engine/importer'
import { MASK } from '../src/shared/api'
import { TARGETS } from '../src/engine/targets'
import { skills as readsSkills } from '../src/main/reads'
import {
  applyBackupCleanup,
  backupRetention as retentionOf,
  isCleanupTarget,
  planBackupCleanup,
  type CleanupPlan
} from '../src/engine/backupRetention'
import {
  validateConfig,
  APP_CONFIG_DIR,
  DEFAULT_LIBRARY_DIR,
  LEGACY_APP_CONFIG_DIRS,
  LEGACY_APP_LIBRARY_DIRS,
  workspacesRoot
} from '../src/engine/config'
import { CLAUDE_RULES_DIR, LEGACY_CLAUDE_RULES_DIRS } from '../src/engine/ruleSync'
import { LEGACY_MANIFEST_FILES } from '../src/engine/manifest'
import { BACKUP_SUFFIX, LEGACY_BACKUP_SUFFIXES } from '../src/engine/write'
import {
  LEGACY_MD_BEGIN,
  LEGACY_MD_END,
  LEGACY_MD_MARKERS,
  MD_BEGIN,
  MD_END,
  MD_MARKERS
} from '../src/engine/targets/codexAgents'
import { blockBody, blockBodyMulti, outsideBlockMulti } from '../src/engine/text'
import {
  LEGACY_APP_RULES_BEGIN,
  LEGACY_APP_RULES_END,
  LEGACY_HS_RULES_BEGIN,
  LEGACY_HS_RULES_END,
  RULES_BEGIN,
  RULES_END
} from '../src/engine/targets/codexRules'
import {
  LEGACY_APP_TOML_MCP_BEGIN,
  LEGACY_APP_TOML_MCP_END,
  LEGACY_HS_TOML_MCP_BEGIN,
  LEGACY_HS_TOML_MCP_END,
  TOML_MCP_BEGIN,
  TOML_MCP_END
} from '../src/engine/targets/codexMcp'
import {
  LEGACY_APP_MD_BEGIN,
  LEGACY_APP_MD_END,
  LEGACY_HS_MD_BEGIN,
  LEGACY_HS_MD_END
} from '../src/engine/targets/codexAgents'
import {
  applyRename,
  defaultArtifactSources,
  ensureLibrary,
  newManifestCache,
  planRename,
  planSyncAll,
  scanArtifacts
} from '../src/engine'
import { MANIFEST_FILE } from '../src/engine/manifest'
import {
  cleanupFixtures,
  cleanupOnSignals,
  copyInto,
  isSymlink,
  legacyAppProbePaths,
  legacySource,
  makeFixture,
  REAL_HOME,
  TMP
} from './lib/fixtureHome'

type Json = Record<string, unknown>

// ---------- result log ----------
const rows: { step: string; ok: boolean; detail: string }[] = []
function check(step: string, ok: boolean, detail: string): void {
  rows.push({ step, ok, detail })
}

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')
const read = (p: string): string => readFileSync(p, 'utf8')
const readJson = (p: string): Json => JSON.parse(read(p)) as Json
const writeJson = (p: string, o: unknown): void =>
  writeFileSync(p, JSON.stringify(o, null, 2) + '\n')
const mode = (p: string): number => statSync(p).mode & 0o7777
const isRealDir = (p: string): boolean => {
  try {
    const st = lstatSync(p)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}
/** Finds rel in the deletion backups (backups/deleted/<ts>/<rel>) (most recent) */
const deletedBackup = (home: string, rel: string): string | null => {
  const root = deletedBackupRoot(home)
  if (!existsSync(root)) return null
  const hit = readdirSync(root)
    .sort()
    .reverse()
    .map((ts) => join(root, ts, rel))
    .find((p) => existsSync(p))
  return hit ?? null
}
const changedOrError = (cs: FileChange[]): string[] =>
  cs.filter((c) => c.changed || c.error).map((c) => c.id)
const byId = (cs: FileChange[], id: string): FileChange => cs.find((c) => c.id === id)!
const cell = (home: string, env: Env, resource: string, tool: string): string =>
  statusReport(home, env).cells.find((c) => c.resource === resource && c.tool === tool)?.state ??
  '-'

function errCode(fn: () => unknown): string {
  try {
    fn()
    return 'ok'
  } catch (e) {
    return e instanceof LibraryError ? e.code : `other:${(e as Error).name}`
  }
}

function tomlServers(text: string): Json {
  return ((parseToml(text) as Json).mcp_servers as Json) ?? {}
}

// Previous app name generations (LEGACY_* array order: 0 = harnesssync, 1 = agent-console)
const LEGACY_APP_LIBRARY_DIR = LEGACY_APP_LIBRARY_DIRS[1]
const LEGACY_APP_CONFIG_DIR = LEGACY_APP_CONFIG_DIRS[1]
const LEGACY_CLAUDE_RULES_DIR = LEGACY_CLAUDE_RULES_DIRS[1]
const LEGACY_MANIFEST_FILE = LEGACY_MANIFEST_FILES[1]
const LEGACY_BACKUP_SUFFIX = LEGACY_BACKUP_SUFFIXES[1]

// ---------- real HOME watch ----------
function realHomeProbe(): Map<string, string> {
  const m = new Map<string, string>()
  const paths = [
    ...TARGETS.filter((t) => t.id !== 'claudeMcp').map((t) => join(REAL_HOME, t.rel)),
    ...TARGETS.map((t) => join(REAL_HOME, t.rel) + BACKUP_SUFFIX),
    ...LEGACY_BACKUP_SUFFIXES.flatMap((sfx) => TARGETS.map((t) => join(REAL_HOME, t.rel) + sfx)),
    join(REAL_HOME, APP_CONFIG_DIR),
    ...legacyAppProbePaths(),
    join(REAL_HOME, DEFAULT_LIBRARY_DIR),
    join(REAL_HOME, DEFAULT_LIBRARY_DIR, 'rules'),
    workspacesRoot(REAL_HOME),
    libraryRoot(REAL_HOME),
    join(libraryRoot(REAL_HOME), 'rules'),
    join(REAL_HOME, '.agents'),
    join(REAL_HOME, '.agents/.trash'),
    join(REAL_HOME, '.agents/rules'),
    join(REAL_HOME, '.agents/skills'),
    join(REAL_HOME, '.agents/memory'),
    join(REAL_HOME, '.agents/sync'),
    join(REAL_HOME, '.agents/sync/mcp.json'),
    join(REAL_HOME, '.agents/sync/allowlist.json'),
    join(REAL_HOME, '.claude/rules'),
    join(REAL_HOME, '.claude/rules', CLAUDE_RULES_DIR),
    join(REAL_HOME, '.claude/skills'),
    join(REAL_HOME, '.codex/skills'),
    join(REAL_HOME, '.claude/agents'),
    join(REAL_HOME, '.codex/agents'),
    join(REAL_HOME, '.config/opencode/agents'),
    join(REAL_HOME, '.config/opencode/agent')
  ]
  // The app auto-creates the session content index (search.sqlite, -wal, -shm) in this folder — instead of the dir mtime,
  // compare entry names excluding the index files
  const appCfgs = new Set([APP_CONFIG_DIR, ...LEGACY_APP_CONFIG_DIRS].map((d) => join(REAL_HOME, d)))
  for (const p of paths) {
    try {
      const st = lstatSync(p)
      if (appCfgs.has(p) && st.isDirectory()) {
        m.set(p, readdirSync(p).filter((n) => !/^search\.sqlite/.test(n)).sort().join('|'))
        continue
      }
      m.set(p, `${st.mtimeMs}:${st.size}`)
    } catch {
      m.set(p, 'absent')
    }
  }
  return m
}

// ---------- fixture setup ----------
const copyFixtures: string[] = []
const LEGACY_PARTS = ['rules', 'memory', 'sync/allowlist.json', 'sync/mcp.json', 'skills']

/** Makes a copy of the previous library from the import source (legacySource) (symlinks as content, .git excluded) */
function copyLegacyLibrary(to: string): void {
  const from = legacySource()
  for (const part of LEGACY_PARTS) {
    const src = join(from, part)
    if (!existsSync(src)) continue
    cpSync(src, join(to, part), {
      recursive: true,
      dereference: true,
      filter: (s) => !s.includes('/.git/') && !s.endsWith('/.git')
    })
  }
}

/** .agents copy + 6 targets (no library yet — created in the steps) */
function makeLegacyFixture(prefix: string): string {
  const F = makeFixture(prefix)
  const link = join(F, '.agents')
  if (!isSymlink(link)) throw new Error('fixture .agents is not a symlink')
  unlinkSync(link)
  copyLegacyLibrary(link)
  copyFixtures.push(F)
  for (const t of TARGETS) {
    if (!copyInto(REAL_HOME, F, t.rel)) throw new Error(`${t.rel} missing in real HOME`)
  }
  // Rewrite real-HOME absolute path entries (instructions, skills.paths) in the copied opencode.json to fixture paths
  const op = join(F, '.config/opencode/opencode.json')
  const oc = readJson(op)
  const toFixture = (x: unknown): unknown =>
    typeof x === 'string' && x.startsWith(REAL_HOME + '/') ? F + x.slice(REAL_HOME.length) : x
  if (Array.isArray(oc.instructions)) oc.instructions = oc.instructions.map(toFixture)
  const ocSkills = oc.skills as Json | undefined
  if (ocSkills && Array.isArray(ocSkills.paths)) ocSkills.paths = ocSkills.paths.map(toFixture)
  writeJson(op, oc)
  for (const d of ['.claude/skills', '.codex/skills', '.claude/rules']) {
    mkdirSync(join(F, d), { recursive: true, mode: 0o700 })
  }
  return F
}

/** Cleanup: remove the .agents copy first, only if it is inside the fixture (cleanupFixtures only allows symlinks) */
function cleanupCopies(): void {
  for (const F of copyFixtures.splice(0)) {
    const lib = join(F, '.agents')
    if (!F.startsWith(TMP + '/illithid-m7-')) continue
    if (isRealDir(lib)) rmSync(lib, { recursive: true, force: true })
  }
}

/** env with fake values for the ${VAR}s referenced by library server definitions */
function fakeEnv(F: string): Env {
  const text = JSON.stringify(readSources(F).mcp)
  const env: Env = { PATH: process.env.PATH }
  for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) env[m[1]] = 'fixture-value'
  return env
}

/** Server names in legacy mcp.json (in order) */
function legacyServerOrder(F: string): string[] {
  const o = readJson(join(F, '.agents/sync/mcp.json'))
  return Object.keys(o.servers as Json).filter((n) => !n.startsWith('_'))
}

// ---------- main ----------
async function run(): Promise<void> {
  const probe0 = realHomeProbe()

  // ---- a. first run on empty HOME: libraryExists false → initLibrary → empty sync
  {
    const bad: string[] = []
    const E = makeFixture('illithid-m7-E-')
    unlinkSync(join(E, '.agents')) // truly empty HOME (no legacy either)
    const s0 = readSources(E)
    if (s0.libraryExists || s0.rules.length || s0.hasPermissions || mcpEntries(s0.mcp).length)
      bad.push('empty HOME but sources not empty')
    if (readConfig(E).exists) bad.push('config exists')
    const WS = join(E, '.illithid/workspaces/default')
    if (libraryRoot(E) !== WS) bad.push(`libraryRoot ${libraryRoot(E)}`)
    if (libraryExists(E)) bad.push('libraryExists true')
    const srcs = listImportSources(E)
    if (srcs.find((s) => s.id === 'legacy')?.available) bad.push('legacy source available')
    const r0 = syncAll(E, {}, { allowReal: true })
    if (r0.libraryExists || r0.refused !== 'libraryMissing' || r0.results)
      bad.push('sync not refused without library')
    if (readdirSync(E).length) bad.push(`sync created files: ${readdirSync(E).join(',')}`)
    const init = initLibrary(E)
    const expectCreated = ['.', 'workspace.json', 'rules', 'skills', 'mcps', 'memory', '.gitignore']
    if (JSON.stringify(init.created) !== JSON.stringify(expectCreated))
      bad.push(`created ${init.created.join(',')}`)
    if (!read(join(WS, '.gitignore')).includes('.trash/')) bad.push('.gitignore')
    if ((readJson(join(WS, 'workspace.json')) as Json).name !== 'default') bad.push('workspace.json name')
    const init2 = initLibrary(E)
    if (init2.created.length || init2.existed.length !== expectCreated.length) bad.push('not idempotent')
    if (existsSync(join(WS, '.git'))) bad.push('.git created though git defaults to false')
    const s1 = readSources(E)
    if (!s1.libraryExists || s1.rules.length || s1.hasPermissions || mcpEntries(s1.mcp).length)
      bad.push('source state after init')
    const r1 = syncAll(E, {}, { allowReal: true })
    if (!r1.results) bad.push('sync did not run after init')
    else {
      const t = r1.results.targets
      // 5 required targets without files (claude 2, opencode 3) are error skips, codexRules without permissions is unchanged, other codex files are created
      const skipped = t.filter((x) => x.status === 'skipped')
      if (
        skipped.length !== 5 ||
        skipped.some((x) => x.reason !== 'error' || !x.detail?.includes('file not found'))
      )
        bad.push(`skip ${skipped.map((x) => `${x.id}:${x.reason}`).join(',')}`)
      if (t.find((x) => x.id === 'codexRules')?.status !== 'unchanged')
        bad.push('touched codexRules without permissions.json')
      if (existsSync(join(E, '.codex/rules/default.rules'))) bad.push('default.rules created')
      // 0 rules/memory/servers → no empty block
      if (existsSync(join(E, '.codex/AGENTS.md')) && blockBody(read(join(E, '.codex/AGENTS.md')), MD_BEGIN, MD_END) !== null)
        bad.push('AGENTS.md app marker block created for empty library')
      if (existsSync(join(E, '.codex/config.toml')) && read(join(E, '.codex/config.toml')).includes(TOML_MCP_BEGIN))
        bad.push('config.toml mcp block created for empty library')
      if (r1.results.rules.length || r1.results.skills.length) bad.push('has rule/skill items')
    }
    const r2 = syncAll(E, {}, { allowReal: true })
    if (r2.results?.targets.some((x) => x.status === 'written')) bad.push('written on re-sync')
    const st = statusReport(E, {})
    if (st.sourcesError) bad.push(`status sourcesError ${st.sourcesError}`)
    // git option
    const E2 = makeFixture('illithid-m7-E2-')
    unlinkSync(join(E2, '.agents'))
    // deprecated libraryPath is ignored when read
    writeConfig(E2, { version: 1, libraryPath: '~/lib-here' })
    const WS2 = join(E2, '.illithid/workspaces/default')
    const g = initLibrary(E2, { git: true })
    if (g.root !== WS2 || !g.gitInitialized) bad.push('git option')
    if (libraryRoot(E2) !== WS2 || existsSync(join(E2, 'lib-here'))) bad.push('libraryPath not ignored')
    if (!existsSync(join(WS2, '.git'))) bad.push('git init not done')
    check(
      'a. first run on empty HOME — libraryExists false → sync refused → initLibrary → empty sync',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `default location ~/.illithid/workspaces/default, sync refused (libraryMissing), 0 files, init created 7 (incl. workspace.json), idempotent, empty sync: 5 missing required files error-skipped, codexRules unchanged, no empty blocks (AGENTS.md, config.toml), re-sync written 0, libraryPath ignored, --git option OK`
    )
  }

  // ---- b. full legacy import → sync → re-sync changes 0
  const F = makeLegacyFixture('illithid-m7-F-')
  const legacyRules = readdirSync(join(F, '.agents/rules'))
    .filter((f) => f.endsWith('.md'))
    .sort()
  const legacySkills = readdirSync(join(F, '.agents/skills'))
    .filter((n) => !n.startsWith('.'))
    .sort()
  const legacyOrder = legacyServerOrder(F)
  let env: Env = { PATH: process.env.PATH }
  {
    const bad: string[] = []
    if (readSources(F).libraryExists) bad.push('library exists beforehand')
    const src = listImportSources(F).find((s) => s.id === 'legacy')
    if (!src?.available) bad.push('legacy source unavailable')
    const p = planImport(F, 'legacy')
    if (p.rules.length !== legacyRules.length)
      bad.push(`rule candidates ${p.rules.length}/${legacyRules.length}`)
    if (p.skills.length !== legacySkills.length) bad.push(`skill candidates ${p.skills.length}`)
    if (p.mcp.length !== legacyOrder.length) bad.push(`MCP candidates ${p.mcp.length}`)
    if (p.permissions.length !== 1) bad.push('permission candidates')
    if (!p.memory.some((m) => m.name === 'MEMORY.md')) bad.push('memory candidates')
    if (p.rules.some((c) => c.status !== 'new')) bad.push('conflict with empty library')
    // applyImport without library → refused with libraryMissing (init first)
    const pre = applyImport(F, [{ kind: 'rule', name: legacyRules[0] }], 'legacy')
    if (pre[0]?.status !== 'refused' || !pre[0].reason?.startsWith('libraryMissing'))
      bad.push(`import before init ${pre[0]?.status}:${pre[0]?.reason}`)
    initLibrary(F)
    // importing the previous library copies literals as-is without substitution
    const r = importAllFromLegacy(F)
    const failed = r.results.filter((x) => x.status !== 'imported')
    if (failed.length)
      bad.push(`import failed ${failed.map((x) => `${x.kind}/${x.name}:${x.reason}`).join(',')}`)
    if (r.selections.some((s) => s.kind === 'mcp' && !(s.replace && s.replace.length === 0)))
      bad.push('legacy must be replace:[]')
    const lp = libraryPaths(F)
    if (JSON.stringify(readdirSync(lp.rulesDir).sort()) !== JSON.stringify(legacyRules))
      bad.push('rules/ mismatch')
    if (JSON.stringify(canonicalSkills(F)) !== JSON.stringify(legacySkills))
      bad.push('skills/ mismatch')
    if (JSON.stringify(listMcpServers(F)) !== JSON.stringify(legacyOrder))
      bad.push('server order mismatch')
    if (JSON.stringify(readMcpOrderList(F)) !== JSON.stringify(legacyOrder))
      bad.push('_order.json mismatch')
    if (!existsSync(lp.permissions) || !existsSync(lp.memoryIndex))
      bad.push('permissions.json/MEMORY.md missing')
    const legacyAllow = readJson(join(F, '.agents/sync/allowlist.json'))
    const perm = readPermissions(F)!
    if ((perm.bash as unknown[]).length !== (legacyAllow.bash as unknown[]).length)
      bad.push('permissions bash count')
    if (Object.keys(perm).some((k) => k.startsWith('_'))) bad.push('_ meta left in permissions')
    for (const n of legacyOrder) {
      const legacyDef = (readJson(join(F, '.agents/sync/mcp.json')).servers as Json)[n] as Json
      const def = readMcpServer(F, n) as unknown as Json
      if (JSON.stringify(def) !== JSON.stringify(legacyDef))
        bad.push(`mcps/${n}.json definition differs from legacy`)
      if (mode(join(lp.mcpsDir, `${n}.json`)) !== 0o600) bad.push(`mcps/${n}.json mode`)
    }
    if (listMemoryFiles(F).length !== r.results.filter((x) => x.kind === 'memory').length)
      bad.push('memory file count')
    // second import: everything identical, so 0 candidates
    const p2 = planImport(F, 'legacy')
    const left =
      p2.rules.length + p2.memory.length + p2.permissions.length + p2.skills.length + p2.mcp.length
    if (left) bad.push(`re-import candidates ${left}`)

    env = fakeEnv(F)
    const s1 = syncAll(F, env, { allowReal: true })
    if (!s1.results) bad.push(`sync refused ${s1.refused}`)
    else {
      const sk = s1.results.targets.filter((t) => t.status === 'skipped')
      if (sk.length) bad.push(`target skip ${sk.map((t) => `${t.id}:${t.reason}`).join(',')}`)
      // copies of rules + memory index (MEMORY.md)
      const rd = s1.results.rules.filter((t) => t.status === 'done' && t.name !== 'MEMORY.md').length
      if (rd !== legacyRules.length) bad.push(`rule copies ${rd}/${legacyRules.length}`)
      if (!s1.results.rules.some((t) => t.name === 'MEMORY.md' && t.status === 'done')) bad.push('memory index not copied')
      const sd = s1.results.skills.filter((t) => t.status === 'done').length
      if (sd !== legacySkills.length * 2) bad.push(`skill copies ${sd}/${legacySkills.length * 2}`)
    }
    const s2 = syncAll(F, env, { allowReal: true })
    const sum = summarizeSync(s2)
    const wrote = Object.entries(sum).filter(([k]) => k.includes('written') || k.endsWith('.done'))
    if (wrote.length) bad.push(`re-sync changes ${wrote.map(([k, v]) => `${k}=${v}`).join(',')}`)
    if (changedOrError(planAll(F, env)).length) bad.push('re-plan changes')
    const cells = statusReport(F, env).cells.filter(
      (c) => c.state !== 'synced' && c.state !== 'notApplicable'
    )
    if (cells.length)
      bad.push(`status ${cells.map((c) => `${c.resource}/${c.tool}=${c.state}`).join(',')}`)
    // check legacy marker → app marker replacement
    const ag = read(join(F, '.codex/AGENTS.md'))
    if (ag.includes(LEGACY_MD_BEGIN) || blockBody(ag, MD_BEGIN, MD_END) === null)
      bad.push('AGENTS.md marker replacement')
    // opencode instructions: legacy entries → library paths
    const instr =
      (readJson(join(F, '.config/opencode/opencode.json')).instructions as string[]) ?? []
    if (instr.some((x) => x.includes('/.agents/')))
      bad.push('legacy entries left in opencode instructions')
    if (!instr.includes(lp.memoryIndex) || !instr.includes(join(lp.rulesDir, legacyRules[0])))
      bad.push('no library entries in opencode instructions')
    const skp =
      ((readJson(join(F, '.config/opencode/opencode.json')).skills as Json | undefined)
        ?.paths as string[]) ?? []
    if (!skp.includes(lp.skillsDir)) bad.push('no library path in opencode skills.paths')
    check(
      'b. full legacy import (no substitution, order kept) → sync → re-sync changes 0, status all synced',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `rules ${legacyRules.length}, skills ${legacySkills.length}, MCP ${legacyOrder.length} (same definitions, 0600, _order.json), permissions, memory ${listMemoryFiles(F).length}, refused before init, re-import candidates 0, sync copied rules ${legacyRules.length} / skills ${legacySkills.length * 2}, re-sync 0, markers and instructions replaced`
    )
  }

  // ---- c. external edits on the tool side → sync restores from source (no confirmation) + backup
  {
    const bad: string[] = []
    const sp = join(F, '.claude/settings.json')
    const s = readJson(sp)
    ;(s.permissions as Json).allow = [
      ...((s.permissions as Json).allow as string[]),
      'Bash(fixture-manual:*)'
    ]
    writeJson(sp, s)
    const ap = join(F, '.codex/AGENTS.md')
    writeFileSync(ap, read(ap).replace(MD_END, 'fixture manual line\n' + MD_END))
    const { dir } = claudeRulesPaths(F)
    const rp = join(dir, legacyRules[0])
    writeFileSync(rp, read(rp) + '\nfixture rule edit\n')
    const K = legacySkills[0]
    const kp = join(F, '.claude/skills', K, 'SKILL.md')
    writeFileSync(kp, read(kp) + '\nfixture skill edit\n')
    const snaps = { sp: sha(read(sp)), ap: sha(read(ap)), rp: sha(read(rp)), kp: sha(read(kp)) }
    const before = ['permissions/claude', 'rules/codex', 'rules/claude', 'skills/claude'].map(
      (k) => {
        const [r, t] = k.split('/')
        return cell(F, env, r, t)
      }
    )
    if (before.some((x) => x !== 'needsSync')) bad.push(`status before restore ${before.join(',')}`)
    const r = syncAll(F, env, { allowReal: true })
    const t = r.results!.targets
    for (const id of ['claudePermissions', 'codexAgents']) {
      const x = t.find((y) => y.id === id)
      if (x?.status !== 'written' || !x.restored) bad.push(`${id} ${x?.status}/${x?.restored}`)
    }
    if (
      sha(read(sp + '.illithid.bak')) !== snaps.sp ||
      sha(read(ap + '.illithid.bak')) !== snaps.ap
    )
      bad.push('target .bak content')
    if (read(sp).includes('fixture-manual') || read(ap).includes('fixture manual line'))
      bad.push('target not restored')
    const rr = r.results!.rules.find((x) => x.name === legacyRules[0])
    if (
      rr?.status !== 'done' ||
      rr.reason !== 'restored' ||
      !rr.backupPath ||
      sha(read(rr.backupPath)) !== snaps.rp
    )
      bad.push(`rule restore ${rr?.status}/${rr?.reason}`)
    if (read(rp) !== readRule(F, legacyRules[0])) bad.push('rule content not restored')
    const sr = r.results!.skills.find((x) => x.tool === 'claude' && x.name === K)
    const bak = skillBackupPath(F, 'claude', K)
    if (
      sr?.status !== 'done' ||
      sr.reason !== 'restored' ||
      sr.backupPath !== bak ||
      sha(read(join(bak, 'SKILL.md'))) !== snaps.kp
    )
      bad.push(`skill restore ${sr?.status}/${sr?.reason}`)
    if (read(kp) !== read(join(canonicalPaths(F).skills, K, 'SKILL.md')))
      bad.push('skill content not restored')
    const after = ['permissions/claude', 'rules/codex', 'rules/claude', 'skills/claude'].map(
      (k) => {
        const [r2, t2] = k.split('/')
        return cell(F, env, r2, t2)
      }
    )
    if (after.some((x) => x !== 'synced')) bad.push(`status after restore ${after.join(',')}`)
    if (changedOrError(planAll(F, env)).length) bad.push('re-plan changes after restore')
    check(
      'c. external edits on the tool side (permissions, AGENTS.md, rule copy, skill copy) → sync restores from source and backs up',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `4 places needsSync → written+restored / done+restored, .bak and skills backup = edited version, content = source, status synced, re-plan 0`
    )
  }

  // ---- d. add/remove server file → applied to 3 tools, `_` meta kept
  {
    const bad: string[] = []
    const lp = libraryPaths(F)
    const w = upsertMcpServer(F, 'zz-mcp', { transport: 'http', url: 'https://zz.invalid/mcp' })
    if (!w.created || w.path !== join(realpathSync(lp.mcpsDir), 'zz-mcp.json'))
      bad.push('upsert result')
    if (readMcpOrderList(F).at(-1) !== 'zz-mcp' || listMcpServers(F).at(-1) !== 'zz-mcp')
      bad.push('not appended to the end of the order')
    env = fakeEnv(F)
    const p1 = planAll(F, env)
    const pend = p1
      .filter((c) => c.changed)
      .map((c) => c.id)
      .sort()
    if (pend.join() !== 'claudeMcp,codexMcp,opencodeMcp')
      bad.push(`changed targets after add ${pend.join(',')}`)
    const r1 = syncAll(F, env, { allowReal: true })
    if (r1.results!.targets.some((t) => t.status === 'skipped')) bad.push('sync skip after add')
    if (!('zz-mcp' in (readJson(join(F, '.claude.json')).mcpServers as Json)))
      bad.push('missing in claude')
    if (!('zz-mcp' in tomlServers(read(join(F, '.codex/config.toml'))))) bad.push('missing in codex')
    if (!('zz-mcp' in (readJson(join(F, '.config/opencode/opencode.json')).mcp as Json)))
      bad.push('missing in opencode')
    if (changedOrError(planAll(F, env)).length) bad.push('re-plan changes after add')
    // `_` meta: present in the file, dropped from the source, kept on replace
    writeJson(join(lp.mcpsDir, 'zz-meta.json'), {
      transport: 'http',
      url: 'https://m.invalid/mcp',
      _: { note: 'fixture' }
    })
    const meta = readSources(F).mcp.servers['zz-meta'] as unknown as Json
    if (!meta || '_' in meta) bad.push('_ meta left in source')
    upsertMcpServer(F, 'zz-meta', { transport: 'http', url: 'https://m2.invalid/mcp' })
    const metaFile = readMcpServer(F, 'zz-meta') as unknown as Json
    if (
      JSON.stringify(metaFile._) !== JSON.stringify({ note: 'fixture' }) ||
      metaFile.url !== 'https://m2.invalid/mcp'
    )
      bad.push('_ meta not kept on replace')
    // delete → removed from 3 tools (based on app ownership records), .trash, order file
    const t1 = deleteMcpServer(F, 'zz-mcp').trashPath
    deleteMcpServer(F, 'zz-meta')
    if (!existsSync(t1) || !t1.includes('/.trash/') || !t1.endsWith('/mcps/zz-mcp.json'))
      bad.push('delete .trash')
    if (readMcpOrderList(F).includes('zz-mcp')) bad.push('not removed from order file')
    env = fakeEnv(F)
    const r2 = syncAll(F, env, { allowReal: true })
    if (r2.results!.targets.some((t) => t.status === 'skipped')) bad.push('sync skip after delete')
    if ('zz-mcp' in (readJson(join(F, '.claude.json')).mcpServers as Json))
      bad.push('left in claude')
    if ('zz-mcp' in tomlServers(read(join(F, '.codex/config.toml')))) bad.push('left in codex')
    if ('zz-mcp' in (readJson(join(F, '.config/opencode/opencode.json')).mcp as Json))
      bad.push('left in opencode')
    if (changedOrError(planAll(F, env)).length) bad.push('re-plan changes after delete')
    if (JSON.stringify(listMcpServers(F)) !== JSON.stringify(legacyOrder))
      bad.push('order not restored')
    check(
      'd. add/remove server file → applied to 3 tools, _order.json, `_` meta kept',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : 'add mcps/zz-mcp.json → added in claude, codex, opencode, re-plan 0, _ meta excluded from source and kept on replace, delete → removed from 3, .trash, order file cleaned'
    )
  }

  // ---- e. import from tool sources + substitution choice (only chosen keys become ${KEY}, path values kept)
  {
    const bad: string[] = []
    const secretA = 'SuperSecretValue1234567890abcDEF'
    const secretB = 'tok_9f8e7d6c5b4a3210ZYXWVUTSRQ'
    const cjp = join(F, '.claude.json')
    const cj = readJson(cjp)
    ;(cj.mcpServers as Json)['fx-stdio'] = {
      type: 'stdio',
      command: 'npx',
      args: ['fx'],
      env: {
        API_KEY: secretA,
        CONFIG_PATH: '/etc/fx/config.json',
        MODE: 'readonly',
        API_URL: 'https://api.fx.invalid/v1',
        REF: '${FX_REF}'
      }
    }
    writeJson(cjp, cj)
    const tp = join(F, '.codex/config.toml')
    writeFileSync(
      tp,
      read(tp) +
        `\n[mcp_servers.fx_http]\nurl = "https://fx.invalid/mcp"\n\n[mcp_servers.fx_http.http_headers]\nAuthorization = "Bearer ${secretB}"\n`
    )
    const toolHash = (): string => sha(read(cjp)) + sha(read(tp))
    const h0 = toolHash()

    const p = planImport(F, 'tool:claude')
    const js = JSON.stringify(p)
    for (const lit of [secretA, '/etc/fx/config.json', 'readonly', 'https://api.fx.invalid/v1'])
      if (js.includes(lit))
        bad.push(`candidate data contains raw value (${lit === secretA ? 'secret' : lit})`)
    const c = p.mcp.find((x) => x.name === 'fx-stdio')
    const v = c?.variants[0]
    const rep = Object.fromEntries((v?.replaceable ?? []).map((r) => [r.key, r.looksSecret]))
    if (
      JSON.stringify(rep) !==
      JSON.stringify({ API_KEY: true, CONFIG_PATH: false, MODE: false, API_URL: false })
    )
      bad.push(`replaceable ${JSON.stringify(rep)}`)
    if (v?.server.env?.REF !== '${FX_REF}' || v.server.env.API_KEY !== '${API_KEY}')
      bad.push('template value')
    if (p.mcp.some((x) => x.name === 'fx_http')) bad.push('codex server shows up for claude source')
    if (p.mcp.some((x) => legacyOrder.includes(x.name) && x.status === 'new'))
      bad.push('server identical to library is new')
    if (!p.sources.length || p.sources[0].id !== 'tool:claude') bad.push('plan.sources')

    // 1) explicit replace: API_KEY only
    const r1 = applyImport(
      F,
      [{ kind: 'mcp', name: 'fx-stdio', replace: ['API_KEY'] }],
      'tool:claude'
    )[0]
    const e1 = (readMcpServer(F, 'fx-stdio').env ?? {}) as Record<string, string>
    if (r1.status !== 'imported' || JSON.stringify(r1.replaced) !== '["API_KEY"]')
      bad.push(`r1 ${r1.status}/${r1.reason}`)
    if (
      e1.API_KEY !== '${API_KEY}' ||
      e1.CONFIG_PATH !== '/etc/fx/config.json' ||
      e1.MODE !== 'readonly' ||
      e1.API_URL !== 'https://api.fx.invalid/v1' ||
      e1.REF !== '${FX_REF}'
    )
      bad.push('chosen substitution result')
    if (read(libraryPaths(F).mcpsDir + '/fx-stdio.json').includes(secretA))
      bad.push('raw value stored')
    deleteMcpServer(F, 'fx-stdio')
    // 2) replace omitted → looksSecret only
    const r2 = applyImport(F, [{ kind: 'mcp', name: 'fx-stdio' }], 'tool:claude')[0]
    if (JSON.stringify(r2.replaced) !== '["API_KEY"]') bad.push('default substitution is not secret keys only')
    deleteMcpServer(F, 'fx-stdio')
    // 3) including MODE
    const r3 = applyImport(
      F,
      [{ kind: 'mcp', name: 'fx-stdio', replace: ['API_KEY', 'MODE'] }],
      'tool:claude'
    )[0]
    const e3 = (readMcpServer(F, 'fx-stdio').env ?? {}) as Record<string, string>
    if (
      r3.replaced?.length !== 2 ||
      e3.MODE !== '${MODE}' ||
      e3.CONFIG_PATH !== '/etc/fx/config.json'
    )
      bad.push('MODE substitution')
    // 4) servers identical to the library are not candidates / unknown key → refused
    const r4a = applyImport(
      F,
      [{ kind: 'mcp', name: 'fx-stdio', overwrite: true }],
      'tool:claude'
    )[0]
    if (r4a.status !== 'refused' || r4a.reason !== 'notACandidate')
      bad.push(`re-import of identical server ${r4a.status}/${r4a.reason}`)
    deleteMcpServer(F, 'fx-stdio')
    const r4 = applyImport(
      F,
      [{ kind: 'mcp', name: 'fx-stdio', replace: ['NOPE'] }],
      'tool:claude'
    )[0]
    if (r4.status !== 'refused' || !r4.reason?.startsWith('unknownReplaceKey'))
      bad.push(`unknown key ${r4.status}/${r4.reason}`)
    if (existsSync(join(libraryPaths(F).mcpsDir, 'fx-stdio.json'))) bad.push('file created despite refusal')
    // 5) codex headers: default → bearerEnv, replace [] → literal header restored
    const pc = planImport(F, 'tool:codex')
    const vh = pc.mcp.find((x) => x.name === 'fx_http')?.variants[0]
    if (
      vh?.server.bearerEnv !== 'FX_HTTP_TOKEN' ||
      vh.server.headers ||
      vh.replaceable[0]?.looksSecret !== true
    )
      bad.push('codex header template')
    if (JSON.stringify(pc).includes(secretB)) bad.push('raw value in codex candidate')
    const r5 = applyImport(F, [{ kind: 'mcp', name: 'fx_http' }], 'tool:codex')[0]
    const d5 = readMcpServer(F, 'fx_http')
    if (r5.status !== 'imported' || d5.bearerEnv !== 'FX_HTTP_TOKEN' || d5.headers)
      bad.push('default bearerEnv promotion')
    deleteMcpServer(F, 'fx_http')
    const r6 = applyImport(F, [{ kind: 'mcp', name: 'fx_http', replace: [] }], 'tool:codex')[0]
    const d6 = readMcpServer(F, 'fx_http')
    if (
      r6.status !== 'imported' ||
      d6.bearerEnv ||
      d6.headers?.Authorization !== `Bearer ${secretB}`
    )
      bad.push('no substitution → header restored')
    deleteMcpServer(F, 'fx_http')
    // 6) source omitted (compat) → all tools and manager apps
    const pall = planImport(F)
    if (!pall.mcp.some((x) => x.name === 'fx-stdio') || !pall.mcp.some((x) => x.name === 'fx_http'))
      bad.push('source-omitted aggregation')
    if (pall.sources.some((s) => s.kind === 'legacyLibrary')) bad.push('legacy included when source omitted')
    // 7) permission and rule candidates from tool sources
    const perm = planImport(F, 'tool:claude').permissions[0]
    if (!perm || perm.variants[0].counts.bash < 1) bad.push('claude permission candidate')
    if (toolHash() !== h0) bad.push('tool-side files changed')
    check(
      'e. import from tool sources — no raw values, only chosen keys become ${KEY} (path/URL values kept), bearerEnv promote/restore',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `replaceable 4 (1 secret), no raw values or path literals in candidates, explicit/omitted/extra replace, unknown key refused, codex Bearer → bearerEnv, replace [] restores, source-omitted aggregation, tool files unchanged`
    )
  }

  // ---- f. user-owned skill folder untouched (outside management)
  {
    const bad: string[] = []
    createSkill(F, 'zz-user', 'fixture user-owned test')
    const userDir = join(F, '.claude/skills/zz-user')
    mkdirSync(userDir)
    writeFileSync(join(userDir, 'SKILL.md'), '# user owned — different content\n')
    const h = sha(read(join(userDir, 'SKILL.md')))
    const r = syncAll(F, env, { allowReal: true })
    const cl = r.results!.skills.find((x) => x.tool === 'claude' && x.name === 'zz-user')
    const cx = r.results!.skills.find((x) => x.tool === 'codex' && x.name === 'zz-user')
    if (cl?.status !== 'skipped' || cl.reason !== 'userOwned')
      bad.push(`claude ${cl?.status}/${cl?.reason}`)
    if (cx?.status !== 'done') bad.push(`codex ${cx?.status}`)
    if (sha(read(join(userDir, 'SKILL.md'))) !== h) bad.push('user-owned content changed')
    if (cell(F, env, 'skills', 'claude') !== 'synced')
      bad.push(`status ${cell(F, env, 'skills', 'claude')}`)
    if (readState(F).state.skills?.claude?.['zz-user']) bad.push('user-owned recorded in state')
    const cxHash = dirContentHash(join(F, '.codex/skills/zz-user'))
    deleteSkill(F, 'zz-user')
    const r2 = syncAll(F, env, { allowReal: true })
    const dc = r2.results!.skills.find((x) => x.tool === 'codex' && x.name === 'zz-user')
    if (dc?.action !== 'deleteCandidate' || dc.status !== 'done')
      bad.push(`codex copy after source deletion ${dc?.action}/${dc?.status}`)
    if (!isRealDir(userDir) || sha(read(join(userDir, 'SKILL.md'))) !== h)
      bad.push('user-owned changed after source deletion')
    if (r2.results!.skills.some((x) => x.tool === 'claude' && x.name === 'zz-user'))
      bad.push('user-owned is a deletion target')
    if (existsSync(join(F, '.codex/skills/zz-user'))) bad.push('codex copy left')
    const bk = deletedBackup(F, 'skills/codex/zz-user')
    if (!bk || dirContentHash(bk) !== cxHash || dc?.backupPath !== bk) bad.push('deletion backup source bytes')
    if (readState(F).state.skills?.codex?.['zz-user']) bad.push('state left after delete')
    rmSync(userDir, { recursive: true, force: true })
    check(
      'f. user-owned skill folder — sync leaves it alone (skip userOwned), status synced, source deletion → only the app copy is backed up and moved immediately',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : 'claude user-owned skip, content unchanged, not in state, codex copy, source deletion → codex copy moved to backups/deleted immediately (same content), state removed, user-owned unchanged'
    )
  }

  // ---- g. edit API — rules, skills, MCP (per file), permissions
  {
    const bad: string[] = []
    const lib = libraryRoot(F)
    createRule(F, 'zz-fixture.md', '# a\n')
    if (mode(join(lib, 'rules/zz-fixture.md')) !== 0o644) bad.push('new rule mode')
    writeRule(F, 'zz-fixture.md', '# b\n')
    if (readRule(F, 'zz-fixture.md') !== '# b\n') bad.push('rule edit')
    if (errCode(() => createRule(F, 'zz-fixture.md', 'x')) !== 'exists') bad.push('duplicate create allowed')
    if (errCode(() => writeRule(F, 'zz-none.md', 'x')) !== 'notFound') bad.push('edit of missing rule allowed')
    const t1 = deleteRule(F, 'zz-fixture.md').trashPath
    if (existsSync(join(lib, 'rules/zz-fixture.md')) || read(t1) !== '# b\n')
      bad.push('rule delete (move to .trash)')
    if (!t1.startsWith(realpathSync(lib) + '/.trash/')) bad.push('trash location')
    for (const n of ['Bad.md', '../x.md', 'x.txt', '.hidden.md', 'a/b.md', ''])
      if (errCode(() => createRule(F, n, 'x')) !== 'invalidName')
        bad.push(`name allowed: ${JSON.stringify(n)}`)
    const outside = join(F, 'outside.md')
    writeFileSync(outside, 'outside\n')
    symlinkSync(outside, join(lib, 'rules/zz-evil.md'))
    if (errCode(() => writeRule(F, 'zz-evil.md', 'pwn')) !== 'outsideLibrary')
      bad.push('write through outside symlink allowed')
    if (read(outside) !== 'outside\n') bad.push('outside file changed')
    unlinkSync(join(lib, 'rules/zz-evil.md'))
    // skills
    createSkill(F, 'zz-skill', 'Fixture: "quoted" skill')
    const fm = matter(readSkillFile(F, 'zz-skill', 'SKILL.md'))
    if (fm.data.name !== 'zz-skill' || fm.data.description !== 'Fixture: "quoted" skill')
      bad.push('SKILL.md frontmatter')
    writeSkillFile(F, 'zz-skill', 'refs/note.md', 'n\n')
    if (
      JSON.stringify(listSkillFiles(F, 'zz-skill')) !== JSON.stringify(['SKILL.md', 'refs/note.md'])
    )
      bad.push('listSkillFiles')
    for (const rel of ['../x.md', '/etc/hosts', 'a/../../x', '.', ''])
      if (errCode(() => writeSkillFile(F, 'zz-skill', rel, 'x')) !== 'outsideLibrary')
        bad.push(`path outside skill allowed: ${JSON.stringify(rel)}`)
    symlinkSync(F, join(lib, 'skills/zz-skill/esc'))
    if (errCode(() => writeSkillFile(F, 'zz-skill', 'esc/pwn.md', 'x')) !== 'outsideLibrary')
      bad.push('escape via symlink inside skill allowed')
    unlinkSync(join(lib, 'skills/zz-skill/esc'))
    const t2 = deleteSkill(F, 'zz-skill').trashPath
    if (existsSync(join(lib, 'skills/zz-skill')) || !existsSync(join(t2, 'SKILL.md')))
      bad.push('skill delete')
    // MCP (per file)
    const invalid: [string, unknown][] = [
      ['stdio command missing', { transport: 'stdio', args: [] }],
      ['http url missing', { transport: 'http' }],
      ['transport error', { transport: 'ws', url: 'wss://x' }],
      ['env value type', { transport: 'stdio', command: 'x', env: { A: 1 } }],
      ['url format', { transport: 'http', url: 'not a url' }]
    ]
    for (const [label, def] of invalid)
      if (errCode(() => upsertMcpServer(F, 'zz-mcp', def as McpServer)) !== 'invalidSchema')
        bad.push(`validation passed: ${label}`)
    if (
      errCode(() =>
        upsertMcpServer(F, 'Bad Name', { transport: 'http', url: 'https://x.invalid' })
      ) !== 'invalidName'
    )
      bad.push('server name validation')
    const secret = 'AbCdEfGh1234567890XyZw9876'
    const w1 = upsertMcpServer(F, 'zz-mcp', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
      env: { API_KEY: secret, MODE: 'readonly' }
    })
    if (!w1.created || w1.warnings.length !== 1 || !w1.warnings[0].includes('env.API_KEY'))
      bad.push(`secret warnings ${w1.warnings.length}`)
    if (w1.warnings.some((w) => w.includes(secret))) bad.push('warning contains raw value')
    const w2 = upsertMcpServer(F, 'zz-mcp', {
      transport: 'http',
      url: 'https://example.invalid/mcp',
      headers: { Authorization: 'Bearer ${ZZ_TOKEN}' }
    })
    if (w2.created || w2.warnings.length) bad.push('replace / reference value warning')
    const fileText = read(join(lib, 'mcps/zz-mcp.json'))
    if (fileText !== JSON.stringify(JSON.parse(fileText), null, 2) + '\n')
      bad.push('indent is not 2 spaces')
    if (errCode(() => readMcpServer(F, 'zz-none')) !== 'notFound') bad.push('read of missing server')
    if (errCode(() => deleteMcpServer(F, 'zz-none')) !== 'notFound') bad.push('delete of missing server')
    const t3 = deleteMcpServer(F, 'zz-mcp').trashPath
    if (existsSync(join(lib, 'mcps/zz-mcp.json')) || mode(t3) !== 0o600)
      bad.push('server delete (.trash 0600)')
    if (JSON.stringify(listMcpServers(F)) !== JSON.stringify(legacyOrder)) bad.push('list after delete')
    // permissions
    const perm0 = readPermissions(F)!
    const badPerms: [string, unknown][] = [
      ['not an object', []],
      ['bash type', { bash: 'x', claudeOnly: { allow: [], deny: [] } }],
      ['empty argv array', { bash: [[]], claudeOnly: { allow: [], deny: [] } }],
      ['claudeOnly missing', { bash: [] }],
      ['deny type', { bash: [], claudeOnly: { allow: [], deny: 'x' } }]
    ]
    for (const [label, v] of badPerms)
      if (errCode(() => writePermissions(F, v as Allowlist)) !== 'invalidSchema')
        bad.push(`permission validation passed: ${label}`)
    if (JSON.stringify(readPermissions(F)) !== JSON.stringify(perm0))
      bad.push('refused write changed the file')
    const next: Allowlist = { ...perm0, bash: [...perm0.bash, ['fixture-cmd', 'sub']] }
    writePermissions(F, next)
    if (readPermissions(F)!.bash.length !== perm0.bash.length + 1) bad.push('permission write')
    env = fakeEnv(F)
    const pc = plan(F, env)
    if (!byId(pc, 'claudePermissions').after.includes('Bash(fixture-cmd sub:*)'))
      bad.push('permission change not in claude plan')
    if (!byId(pc, 'codexRules').after.includes('"fixture-cmd", "sub"'))
      bad.push('permission change not in codex plan')
    writePermissions(F, perm0)
    if (changedOrError(plan(F, env)).length) bad.push('re-plan changes after permission restore')
    check(
      'g. edit API — rules, skills, MCP (mcps/<name>.json), permissions (permissions.json) validation and trash',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : 'rule create/edit/delete (.trash), 6 bad names and outside symlink refused, skill create, subfiles, 5 escapes + symlink refused, delete, 5 invalid MCPs + name refused, secret warning (keys only), replace, 2-space indent, delete 0600, missing server refused, 5 invalid permissions refused, write → reflected in claude/codex plan, restored'
    )
  }

  // ---- h. toggles — MCP/rule/skill on/off, opencodeRules legacy entries, shared link approval gate
  const R = legacyRules[legacyRules.length - 1]
  {
    const bad: string[] = []
    // MCP: S codex off
    const servers = mcpEntries(readSources(F).mcp)
    const S =
      servers.find(([, s]) => s.transport === 'http' && !s.headers && !s.bearerEnv)?.[0] ??
      servers[0][0]
    const claudeBefore = read(join(F, '.claude.json'))
    setToggle(F, 'mcp', S, 'codex', false)
    const p1 = planAll(F, env)
    if (S in tomlServers(byId(p1, 'codexMcp').after)) bad.push('server left in codex after')
    for (const id of ['claudeMcp', 'opencodeMcp', 'opencodeRules', 'codexAgents'])
      if (byId(p1, id).changed) bad.push(`${id} changed`)
    syncAll(F, env, { allowReal: true })
    if (changedOrError(planAll(F, env)).length) bad.push('re-plan changes after mcp off')
    if (read(join(F, '.claude.json')) !== claudeBefore) bad.push('claude file changed')
    if (cell(F, env, 'mcp', 'codex') !== 'synced')
      bad.push(`status mcp/codex ${cell(F, env, 'mcp', 'codex')}`)
    setToggle(F, 'mcp', S, 'codex', true)
    syncAll(F, env, { allowReal: true })
    if (!(S in tomlServers(read(join(F, '.codex/config.toml'))))) bad.push('codex not restored')
    // rules: codex off → excluded from block, claude off → app copy backed up and moved immediately, opencode off → excluded from instructions
    setToggle(F, 'rules', R, 'codex', false)
    setToggle(F, 'rules', R, 'claude', false)
    setToggle(F, 'rules', R, 'opencode', false)
    const p2 = planAll(F, env)
    const body = blockBody(byId(p2, 'codexAgents').after, MD_BEGIN, MD_END) ?? ''
    if (body.includes(`<!-- rules/${R} -->`) || !body.includes(`<!-- rules/${legacyRules[0]} -->`))
      bad.push('codex rule exclusion')
    const instr = (JSON.parse(byId(p2, 'opencodeRules').after) as Json).instructions as string[]
    if (instr.includes(join(libraryPaths(F).rulesDir, R))) bad.push('opencode rule exclusion')
    const ruleBytes = read(join(claudeRulesPaths(F).dir, R))
    const rs = syncAll(F, env, { allowReal: true })
    const dc = rs.results!.rules.find((x) => x.name === R)
    if (
      dc?.action !== 'deleteCandidate' ||
      dc.status !== 'done' ||
      existsSync(join(claudeRulesPaths(F).dir, R))
    )
      bad.push(`claude off copy ${dc?.action}/${dc?.status}`)
    const rbk = deletedBackup(F, `rules/${R}`)
    if (!rbk || read(rbk) !== ruleBytes) bad.push('rule deletion backup bytes')
    if (readState(F).state.rules?.[R]) bad.push('state left after rule delete')
    if (changedOrError(planAll(F, env)).length) bad.push('re-plan changes after rule off')
    for (const t of ['codex', 'claude', 'opencode'] as const) setToggle(F, 'rules', R, t, true)
    syncAll(F, env, { allowReal: true })
    if (
      changedOrError(planAll(F, env)).length ||
      planRuleSync(F, env).some((x) => x.action !== 'inSync')
    )
      bad.push('rule back on')
    // skills: claude off → deleteCandidate, codex kept, opencode toggle refused
    const K = legacySkills[0]
    setToggle(F, 'skills', K, 'claude', false)
    const ps = planSkillSync(F, env)
    if (ps.find((x) => x.tool === 'claude' && x.name === K)?.action !== 'deleteCandidate')
      bad.push('skill claude off')
    if (ps.find((x) => x.tool === 'codex' && x.name === K)?.action !== 'inSync')
      bad.push('skill affects codex')
    if (errCode(() => setToggle(F, 'skills', K, 'opencode', false)) === 'ok')
      bad.push('opencode skill toggle allowed')
    setToggle(F, 'skills', K, 'claude', true)
    if (planSkillSync(F, env).some((x) => x.action !== 'inSync')) bad.push('skill back on')
    // opencodeRules: legacy ~/.agents entries (glob, MEMORY.md) replaced with library entries, non-owned kept
    const st0 = readState(F).state
    delete st0.applied.opencodeRules
    if (st0.owned) delete st0.owned.opencodeRules
    writeState(F, st0)
    const op = join(F, '.config/opencode/opencode.json')
    const oc = readJson(op)
    oc.instructions = [
      '/fixture/first.md',
      join(F, '.agents/rules/*.md'),
      '~/.agents/memory/MEMORY.md',
      '/fixture/other.md'
    ]
    writeJson(op, oc)
    const lp = libraryPaths(F)
    const expected = [
      '/fixture/first.md',
      ...legacyRules.map((n) => join(lp.rulesDir, n)),
      lp.memoryIndex,
      '/fixture/other.md'
    ]
    const oc1 = byId(planAll(F, env), 'opencodeRules')
    if (JSON.stringify((JSON.parse(oc1.after) as Json).instructions) !== JSON.stringify(expected))
      bad.push('legacy entry replacement result')
    if (!oc1.notes.some((n) => n.includes('legacy'))) bad.push('no legacy replacement note')
    syncAll(F, env, { allowReal: true })
    if (JSON.stringify(readJson(op).instructions) !== JSON.stringify(expected))
      bad.push('file instructions')
    if (changedOrError(planAll(F, env)).length) bad.push('re-plan changes after opencodeRules applied')
    // shared symlink: approval gate
    const { legacyLink } = claudeRulesPaths(F)
    symlinkSync(join(F, '.agents/rules'), legacyLink)
    const rl = syncAll(F, env, { allowReal: true })
    const link = rl.results!.rules.find((x) => x.action === 'replaceLink')
    if (link?.status !== 'pendingApproval' || !isSymlink(legacyLink))
      bad.push('link handled without approval')
    if (cell(F, env, 'rules', 'claude') !== 'needsSync')
      bad.push(`status with link left ${cell(F, env, 'rules', 'claude')}`)
    const rl2 = syncAll(F, env, { allowReal: true, allowLinkRemoval: true })
    if (
      rl2.results!.rules.find((x) => x.action === 'replaceLink')?.status !== 'done' ||
      isSymlink(legacyLink) ||
      !existsSync(join(F, '.agents/rules', R))
    )
      bad.push('link removal failed after approval or link target damaged')
    if (cell(F, env, 'rules', 'claude') !== 'synced')
      bad.push(`status after link removal ${cell(F, env, 'rules', 'claude')}`)
    const a2 = applyRuleSync(F, env, planRuleSync(F, env))
    if (a2.some((x) => x.status !== 'unchanged')) bad.push('rule changes after link removal')
    check(
      'h. toggles — MCP/rule/skill on/off, opencodeRules legacy ~/.agents entries replaced, shared link approval gate',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `MCP codex off/on, rules off in 3 tools (codex block, opencode list excluded, claude deleteCandidate display only)/on, skill claude off, opencode refused, legacy glob and ~/.agents/memory entries → rules ${legacyRules.length} + memory 1 (2 non-owned kept), link pendingApproval → removed after approval`
    )
  }

  // ---- i. legacy sync.mjs marker recognized → replaced with app marker, content outside markers kept
  {
    const bad: string[] = []
    const ap = join(F, '.codex/AGENTS.md')
    const legacyText = `# Codex-only preamble\n\n${LEGACY_MD_BEGIN}\nstale legacy body\n${LEGACY_MD_END}\n\ntrailer\n`
    writeFileSync(ap, legacyText)
    const c = byId(plan(F, env), 'codexAgents')
    if (c.error || !c.changed) bad.push(`plan ${c.error ?? 'unchanged'}`)
    if (c.beforeRegionHash === null) bad.push('legacy block not recognized as owned region')
    if (c.after.includes(LEGACY_MD_BEGIN) || c.after.includes(LEGACY_MD_END))
      bad.push('legacy marker left')
    if (blockBody(c.after, MD_BEGIN, MD_END) === null) bad.push('no app marker block')
    if (!c.after.startsWith('# Codex-only preamble\n\n') || !c.after.endsWith('\n\ntrailer\n'))
      bad.push('content outside markers damaged')
    if (!c.notes.some((n) => n.includes('legacy'))) bad.push('no replacement note')
    if (blockBodyMulti(legacyText, [MD_MARKERS, ...LEGACY_MD_MARKERS]) !== '\nstale legacy body\n')
      bad.push('blockBodyMulti')
    syncAll(F, env, { allowReal: true })
    if (changedOrError(planAll(F, env)).length) bad.push('re-plan changes after replacement')
    check(
      'i. legacy sync.mjs marker block recognized → replaced with app marker, content outside markers kept',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : 'legacy block = owned region, after replacement legacy markers 0 / app marker 1, preamble and trailer kept, re-plan 0'
    )
  }

  // ---- k. backup — bare remote: connect → snapshot → another device → pullOnStart → diverged → restore → disconnect
  {
    const bad: string[] = []
    const R = makeFixture('illithid-m7-R-')
    unlinkSync(join(R, '.agents'))
    const remote = join(R, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', remote], {
      stdio: 'ignore'
    })
    const lib = libraryRoot(F)
    const ruleA = legacyRules[0]
    const ruleB = legacyRules[1]
    const original = readRule(F, ruleA)
    const s0 = await backupStatus(F)
    if (s0.initialized || !s0.libraryExists || s0.dirty) bad.push('status before connect')
    writeConfig(F, { ...readConfig(F).config, deviceName: 'device-a' })
    if ((await backupStatus(F)).deviceName !== 'device-a') bad.push('deviceName setting')
    if ((await connectBackup(F, 'not a url')).ok || (await connectBackup(F, 'ftp://x/y')).ok)
      bad.push('invalid URL allowed')
    const c1 = await connectBackup(F, remote)
    if (!c1.ok || !c1.initialized || c1.remoteUrl !== remote)
      bad.push(`connect ${c1.ok ? '' : c1.reason}`)
    const gi = read(join(lib, '.gitignore'))
    if (!gi.includes('.trash/') || !gi.includes('artifacts/') || !gi.includes('.DS_Store'))
      bad.push('.gitignore ensured')
    mkdirSync(join(lib, '.trash/keep'), { recursive: true })
    writeFileSync(join(lib, '.trash/keep/x.md'), 'trash\n')
    mkdirSync(join(lib, 'artifacts/keep'), { recursive: true })
    writeFileSync(join(lib, 'artifacts/keep/a.md'), 'artifact\n')
    const sn1 = await snapshot(F, 'first snapshot')
    if (!sn1.ok || !sn1.committed || !sn1.pushed) bad.push(`snapshot1 ${sn1.ok ? '' : sn1.reason}`)
    const firstHash = sn1.ok ? sn1.hash : ''
    const h1 = await history(F, 10)
    if (
      h1.length !== 1 ||
      h1[0].device !== 'device-a' ||
      h1[0].message !== 'first snapshot' ||
      h1[0].hash !== firstHash
    )
      bad.push('history 1')
    const tracked = execFileSync('git', ['-C', lib, 'ls-files'], { encoding: 'utf8' })
    if (tracked.includes('.trash/')) bad.push('.trash committed')
    if (tracked.includes('artifacts/')) bad.push('artifacts committed')
    if (
      !tracked.includes(`rules/${ruleA}`) ||
      !tracked.includes('permissions.json') ||
      !tracked.includes('mcps/_order.json')
    )
      bad.push('library files missing')
    const s1 = await backupStatus(F)
    if (
      !s1.initialized ||
      s1.remoteUrl !== remote ||
      s1.branch !== 'main' ||
      s1.dirty ||
      s1.ahead ||
      s1.behind ||
      s1.lastSnapshot?.hash !== firstHash
    )
      bad.push(`status1 ${JSON.stringify({ ...s1, root: undefined, lastSnapshot: undefined })}`)
    const sn1b = await snapshot(F)
    if (!sn1b.ok || sn1b.committed) bad.push('snapshot without changes committed')
    // another device B: clone → change → snapshot
    const B = makeFixture('illithid-m7-B-')
    unlinkSync(join(B, '.agents'))
    execFileSync('git', ['clone', '-q', remote, libraryRoot(B)], { stdio: 'ignore' })
    writeConfig(B, { version: 1, deviceName: 'device-b' })
    const cb = await connectBackup(B, remote)
    if (!cb.ok || cb.initialized) bad.push('B connect')
    writeRule(B, ruleA, original + '\n<!-- from device-b -->\n')
    const snB = await snapshot(B, 'from b')
    if (!snB.ok || !snB.pushed) bad.push(`B snapshot ${snB.ok ? '' : snB.reason}`)
    // A: pullOnStart → B's change comes in
    const pl = await pullOnStart(F)
    if (!pl.ok || pl.skipped) bad.push(`pullOnStart ${pl.ok ? pl.skipped : pl.reason}`)
    if (readRule(F, ruleA) !== original + '\n<!-- from device-b -->\n') bad.push('content after pull')
    if ((await history(F, 1))[0]?.device !== 'device-b') bad.push('history device after pull')
    // divergence: B pushes again and A has local changes → A snapshot is diverged
    writeRule(B, ruleB, readRule(B, ruleB) + '\n<!-- b2 -->\n')
    const snB2 = await snapshot(B, 'b2')
    if (!snB2.ok) bad.push('B snapshot2')
    writeRule(F, ruleA, original + '\n<!-- from device-a -->\n')
    const snA = await snapshot(F, 'a conflicting')
    if (snA.ok || snA.reason !== 'diverged') bad.push(`diverged check ${snA.ok ? 'ok' : snA.reason}`)
    const sd = await backupStatus(F)
    if (sd.ahead !== 1 || sd.behind !== 1)
      bad.push(`diverged status ahead ${sd.ahead} behind ${sd.behind}`)
    if (readRule(F, ruleA) !== original + '\n<!-- from device-a -->\n')
      bad.push('local content changed after diverged')
    const plD = await pullOnStart(F)
    if (plD.ok || plD.reason !== 'diverged') bad.push('diverged pullOnStart is not diverged')
    const remoteHead = execFileSync('git', ['-C', remote, 'rev-parse', 'main'], {
      encoding: 'utf8'
    }).trim()
    if (remoteHead !== (snB2.ok ? snB2.hash : '')) bad.push('remote force-changed')
    // restore: a new commit that reverts to the first snapshot state
    const before = (await history(F, 20)).length
    const rs = await restore(F, firstHash)
    if (!rs.ok || !rs.committed || rs.changed < 1) bad.push(`restore ${rs.ok ? '' : rs.reason}`)
    if (readRule(F, ruleA) !== original) bad.push('restored content')
    const h2 = await history(F, 20)
    if (
      h2.length !== before + 1 ||
      !h2.some((x) => x.hash === firstHash) ||
      !h2[0].message.startsWith('restore ')
    )
      bad.push('restore destroyed history or made no commit')
    if (!existsSync(join(lib, '.trash/keep/x.md'))) bad.push('restore removed .trash')
    if ((await restore(F, 'deadbeef')).ok || (await restore(F, '../x')).ok)
      bad.push('restore of missing hash allowed')
    const rs2 = await restore(F, firstHash)
    if (!rs2.ok || rs2.committed) bad.push('re-restore of same snapshot committed')
    // disconnect: remote settings only
    const dc = await disconnect(F)
    const sdc = await backupStatus(F)
    if (!dc.ok || sdc.remoteUrl || !sdc.initialized || !existsSync(join(lib, 'rules', ruleA)))
      bad.push('disconnect')
    if (
      (await pullOnStart(F)).ok !== true ||
      ((await pullOnStart(F)) as { skipped?: string }).skipped !== 'noRemote'
    )
      bad.push('pullOnStart after disconnect')
    if (
      execFileSync('git', ['-C', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim() !==
      remoteHead
    )
      bad.push('disconnect changed the remote')
    writeRule(F, ruleA, original)
    writeRule(F, ruleB, readRule(B, ruleB).replace('\n<!-- b2 -->\n', ''))
    check(
      'k. backup — bare remote connect → snapshot → device B change → pullOnStart → diverged → restore (new commit) → disconnect',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : 'URL validation, .gitignore (.trash/, OS), first snapshot push, device recorded, .trash not committed, no-change re-snapshot commits 0, B clone change → A ff pull, divergence → diverged, remote unchanged, local kept, restore = new commit (history kept, .trash kept), missing hash refused, disconnect touches remote settings only'
    )
  }

  // ---- l. watchLibrary — one debounced notification, .trash/.git ignored, unsubscribe
  {
    const bad: string[] = []
    const lib = libraryRoot(F)
    const calls: string[][] = []
    const stop = watchLibrary(lib, (c) => calls.push(c.paths), { debounceMs: 200 })
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    await sleep(100)
    writeFileSync(join(lib, 'rules/zz-watch.md'), '# w\n')
    writeFileSync(join(lib, '.trash/keep/y.md'), 'trash\n')
    writeFileSync(join(lib, 'mcps/.tmp.illithid-1-abcd.tmp'), '{}')
    await sleep(80)
    writeFileSync(join(lib, 'rules/zz-watch.md'), '# w2\n')
    await sleep(700)
    if (calls.length !== 1) bad.push(`notifications ${calls.length}`)
    const paths = calls[0] ?? []
    if (!paths.some((p) => p.startsWith('rules/zz-watch.md'))) bad.push(`paths ${paths.join(',')}`)
    if (paths.some((p) => p.startsWith('.trash') || p.startsWith('.git') || p.endsWith('.tmp')))
      bad.push('ignored paths included')
    stop()
    writeFileSync(join(lib, 'rules/zz-watch.md'), '# w3\n')
    await sleep(500)
    if (calls.length !== 1) bad.push('notification after unsubscribe')
    rmSync(join(lib, 'rules/zz-watch.md'))
    rmSync(join(lib, 'mcps/.tmp.illithid-1-abcd.tmp'))
    const noop = watchLibrary(join(F, 'nope-dir'), () => bad.push('notification from missing root'))
    noop()
    check(
      'l. watchLibrary — one debounced notification, .trash/tmp ignored, unsubscribe, missing root no-op',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : '3 changes (2 rule, 2 ignored) → 1 notification rules/zz-watch.md, 0 after unsubscribe'
    )
  }

  // ---- m. opencodeSkills — library path in skills.paths, non-owned entries and other subkeys kept, old path replaced when the library moves
  {
    const bad: string[] = []
    const op = join(F, '.config/opencode/opencode.json')
    const lp = libraryPaths(F)
    const oc = readJson(op)
    oc.skills = { paths: ['/fixture/other-skills', lp.skillsDir, '~/more-skills'], custom: true }
    writeJson(op, oc)
    const p0 = planAll(F, env)
    if (byId(p0, 'opencodeSkills').changed) bad.push('existing path treated as a change')
    // remove the app-owned path → re-inserted at the front. Non-owned and custom kept
    oc.skills = { paths: ['/fixture/other-skills', '~/more-skills'], custom: true }
    writeJson(op, oc)
    const c1 = byId(planAll(F, env), 'opencodeSkills')
    const sk1 = (JSON.parse(c1.after) as Json).skills as Json
    if (
      JSON.stringify(sk1.paths) !==
        JSON.stringify([lp.skillsDir, '/fixture/other-skills', '~/more-skills']) ||
      sk1.custom !== true
    )
      bad.push('paths re-insert/keep')
    if (cell(F, env, 'skills', 'opencode') !== 'needsSync')
      bad.push(`status ${cell(F, env, 'skills', 'opencode')}`)
    const r1 = syncAll(F, env, { allowReal: true })
    if (r1.results!.targets.find((t) => t.id === 'opencodeSkills')?.status !== 'written')
      bad.push('not applied')
    if (changedOrError(planAll(F, env)).length) bad.push('re-plan changes')
    if (cell(F, env, 'skills', 'opencode') !== 'synced') bad.push('status after apply')
    // file without a skills key → created. Other top-level keys unchanged
    const oc2 = readJson(op)
    delete oc2.skills
    writeJson(op, oc2)
    const c2 = byId(planAll(F, env), 'opencodeSkills')
    const after2 = JSON.parse(c2.after) as Json
    if (JSON.stringify((after2.skills as Json).paths) !== JSON.stringify([lp.skillsDir]))
      bad.push('skills key creation')
    const keys = Object.keys(oc2).sort().join()
    if (
      Object.keys(after2)
        .filter((k) => k !== 'skills')
        .sort()
        .join() !== keys
    )
      bad.push('other keys changed')
    syncAll(F, env, { allowReal: true })
    // workspace switch (library location change) → old path (previously owned) replaced with the new path
    const mw = createWorkspace(F, 'fx-moved', { from: 'current' })
    switchWorkspace(F, mw.id)
    const moved = libraryRoot(F)
    const env2 = fakeEnv(F)
    const c3 = byId(planAll(F, env2), 'opencodeSkills')
    const paths3 = ((JSON.parse(c3.after) as Json).skills as Json).paths as string[]
    if (paths3.includes(lp.skillsDir) || !paths3.includes(join(moved, 'skills')))
      bad.push('old path left after move')
    switchWorkspace(F, 'default')
    if (moved.startsWith(F + '/.illithid/workspaces/')) rmSync(moved, { recursive: true, force: true })
    if (changedOrError(planAll(F, env)).length) bad.push('re-plan changes after switching back')
    check(
      'm. opencodeSkills — skills.paths library path, non-owned and custom kept, key creation, replaced when the library moves',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : 'path present → 0 changes, removed → re-inserted at front, 2 non-owned + custom kept, synced after apply, re-plan 0, skills key created, old path replaced on workspace switch'
    )
  }

  // ---- n. auto-create library on app start (ensureLibrary): missing → create, idempotent; only previous-name paths → no create
  {
    const bad: string[] = []
    const E = makeFixture('illithid-m7-N1-')
    unlinkSync(join(E, '.agents'))
    const r1 = ensureLibrary(E)
    const WSN = join(E, DEFAULT_LIBRARY_DIR, 'workspaces/default')
    if (r1.status !== 'created' || r1.root !== WSN) bad.push(`empty HOME ${r1.status}`)
    for (const d of ['rules', 'skills', 'mcps', 'memory'])
      if (!isRealDir(join(WSN, d))) bad.push(`${d} missing`)
    if (readConfig(E).exists) bad.push('config created')
    if (ensureLibrary(E).status !== 'exists') bad.push('second call is not exists')
    const E2 = makeFixture('illithid-m7-N2-')
    unlinkSync(join(E2, '.agents'))
    mkdirSync(join(E2, LEGACY_APP_LIBRARY_DIR, 'rules'), { recursive: true })
    const r2 = ensureLibrary(E2)
    if (r2.status !== 'renamePending') bad.push(`only previous name present ${r2.status}`)
    if (existsSync(join(E2, DEFAULT_LIBRARY_DIR))) bad.push('new library created though only the previous name exists')
    const E3 = makeFixture('illithid-m7-N3-')
    unlinkSync(join(E3, '.agents'))
    mkdirSync(join(E3, LEGACY_APP_CONFIG_DIR), { recursive: true })
    if (ensureLibrary(E3).status !== 'renamePending' || existsSync(join(E3, DEFAULT_LIBRARY_DIR)))
      bad.push('created though only the previous-name config dir exists')
    check(
      'n. auto-create library on start — missing → create, idempotent; only previous-name paths → no create',
      !bad.length,
      bad.length ? bad.join('; ') : 'empty HOME created (4 dirs, no config) → exists, previous library only / previous config only → renamePending, not created'
    )
  }

  // ---- o. rename migration: previous-name layout → applyRename (CLI) → sync → new paths, markers, rule folder, re-sync 0
  {
    const bad: string[] = []
    const N = makeLegacyFixture('illithid-m7-O-')
    initLibrary(N)
    if (importAllFromLegacy(N).results.some((x) => x.status !== 'imported')) bad.push('import failed')
    const envN = fakeEnv(N)
    const offServer = listMcpServers(N)[0]
    setToggle(N, 'mcp', offServer, 'codex', false)
    const first = syncAll(N, envN, { allowReal: true })
    if (!first.results) bad.push('initial sync did not run')
    const ruleNames = readdirSync(join(libraryRoot(N), 'rules')).filter((f) => f.endsWith('.md'))
    // switch to the previous-name layout (mimics state from the previous app — root-style ~/.agent-console)
    const lib = (d: string): string => join(N, d)
    const newLib = libraryRoot(N)
    renameSync(newLib, lib(LEGACY_APP_LIBRARY_DIR))
    rmdirSync(join(N, DEFAULT_LIBRARY_DIR, 'workspaces'))
    rmdirSync(join(N, DEFAULT_LIBRARY_DIR))
    renameSync(lib(APP_CONFIG_DIR), lib(LEGACY_APP_CONFIG_DIR))
    renameSync(join(N, '.claude/rules', CLAUDE_RULES_DIR), join(N, '.claude/rules', LEGACY_CLAUDE_RULES_DIR))
    renameSync(join(lib(LEGACY_APP_LIBRARY_DIR), MANIFEST_FILE), join(lib(LEGACY_APP_LIBRARY_DIR), LEGACY_MANIFEST_FILE))
    const cfgP = join(lib(LEGACY_APP_CONFIG_DIR), 'config.json')
    writeJson(cfgP, { ...(existsSync(cfgP) ? readJson(cfgP) : { version: 1 }), libraryPath: '~/' + LEGACY_APP_LIBRARY_DIR })
    const swap = (rel: string, pairs: [string, string][]): void => {
      let t = read(join(N, rel))
      for (const [a, b] of pairs) t = t.split(a).join(b)
      writeFileSync(join(N, rel), t)
    }
    const oldLib = join(N, LEGACY_APP_LIBRARY_DIR)
    swap('.codex/AGENTS.md', [[MD_BEGIN, LEGACY_APP_MD_BEGIN], [MD_END, LEGACY_APP_MD_END]])
    swap('.codex/rules/default.rules', [[RULES_BEGIN, LEGACY_APP_RULES_BEGIN], [RULES_END, LEGACY_APP_RULES_END]])
    swap('.codex/config.toml', [[TOML_MCP_BEGIN, LEGACY_APP_TOML_MCP_BEGIN], [TOML_MCP_END, LEGACY_APP_TOML_MCP_END]])
    swap('.config/opencode/opencode.json', [[newLib + '/', oldLib + '/']])
    swap(join(LEGACY_APP_CONFIG_DIR, 'state.json'), [[newLib + '/', oldLib + '/']])
    const oldRulesDir = join(N, '.claude/rules', LEGACY_CLAUDE_RULES_DIR)
    writeFileSync(join(oldRulesDir, ruleNames[0] + LEGACY_BACKUP_SUFFIX), 'old backup\n')
    // an empty skeleton was created under the new name before the rename (app was running)
    const pre = ensureLibrary(N)
    if (pre.status !== 'renamePending') bad.push(`ensureLibrary on previous-name layout ${pre.status}`)
    initLibrary(N) // no config, so default location → empty skeleton
    if (ensureLibrary(N).status !== 'renamePending') bad.push('not renamePending after empty skeleton')
    const pl = planRename(N)
    if (pl.blocked.length) bad.push(`plan blocked ${pl.blocked.join('|')}`)
    if (pl.moves.length !== 2 || !pl.moves.find((m) => m.what === 'library')?.replaceEmptySkeleton)
      bad.push(`plan moves ${pl.moves.length}`)
    if (!pl.dropLibraryPath || pl.manifests.length !== 1 || pl.stateRewrites < 1 || pl.followUps.length !== 1 || pl.snapshot)
      bad.push(`plan drop ${pl.dropLibraryPath} manifest ${pl.manifests.length} state ${pl.stateRewrites} follow ${pl.followUps.length} snapshot ${pl.snapshot}`)
    const cli = (args: string[]): number =>
      spawnSync('npx', ['tsx', 'src/cli/index.ts', ...args], { encoding: 'utf8', env: process.env }).status ?? -1
    if (cli(['rename-migrate', '--home', N]) !== 0) bad.push('CLI plan failed')
    if (!existsSync(oldLib)) bad.push('moved on plan only')
    if (cli(['rename-migrate', '--home', N, '--apply']) !== 0) bad.push('CLI --apply failed')
    if (existsSync(oldLib) || existsSync(lib(LEGACY_APP_CONFIG_DIR))) bad.push('previous paths left')
    if (!existsSync(join(newLib, 'rules', ruleNames[0])) || !existsSync(join(lib(APP_CONFIG_DIR), 'state.json')))
      bad.push('no content at new paths')
    if (readConfig(N).config.libraryPath !== undefined) bad.push('libraryPath left')
    if (!existsSync(join(newLib, MANIFEST_FILE)) || existsSync(join(newLib, LEGACY_MANIFEST_FILE)))
      bad.push('manifest name')
    if (read(join(lib(APP_CONFIG_DIR), 'state.json')).includes(oldLib)) bad.push('previous path in state')
    if (ensureLibrary(N).status !== 'exists') bad.push('ensureLibrary after move')
    if (applyRename(N).plan.needed) bad.push('work left on re-run')
    // sync
    const r = syncAll(N, envN, { allowReal: true })
    if (!r.results) bad.push('sync did not run')
    else {
      const mig = r.results.rules.find((x) => x.action === 'migrateLegacyDir')
      if (mig?.status !== 'done') bad.push(`rule folder migration ${mig?.status}`)
      if (r.results.rules.some((x) => x.status === 'failed' || x.status === 'refused'))
        bad.push('rules failed/refused')
      if (r.results.targets.some((x) => x.status === 'skipped' && x.reason !== 'error'))
        bad.push(`target skip ${r.results.targets.filter((x) => x.status === 'skipped').map((x) => x.id).join(',')}`)
    }
    const agents = read(join(N, '.codex/AGENTS.md'))
    const rules = read(join(N, '.codex/rules/default.rules'))
    const toml = read(join(N, '.codex/config.toml'))
    const oc = read(join(N, '.config/opencode/opencode.json'))
    if (!agents.includes(MD_BEGIN) || agents.includes(LEGACY_APP_MD_BEGIN) || agents.includes(LEGACY_APP_MD_END))
      bad.push('AGENTS.md marker')
    if (!rules.includes(RULES_BEGIN) || rules.includes(LEGACY_APP_RULES_BEGIN)) bad.push('default.rules marker')
    if (!toml.includes(TOML_MCP_BEGIN) || toml.includes(LEGACY_APP_TOML_MCP_BEGIN)) bad.push('config.toml marker')
    if (oc.includes(oldLib) || !oc.includes(newLib + '/rules/') || !oc.includes(newLib + '/skills'))
      bad.push('opencode.json paths')
    if (toml.includes(`[mcp_servers.${offServer}]`) || toml.includes(`[mcp_servers."${offServer}"]`))
      bad.push('manifest toggles lost')
    const newRulesDir = join(N, '.claude/rules', CLAUDE_RULES_DIR)
    if (existsSync(oldRulesDir)) bad.push('previous rule folder left')
    const newRuleFiles = readdirSync(newRulesDir)
    if (ruleNames.some((n) => !newRuleFiles.includes(n))) bad.push('rules missing in new rule folder')
    if (!newRuleFiles.includes(ruleNames[0] + BACKUP_SUFFIX)) bad.push('backup migration missing')
    const again = planSyncAll(N, envN)
    const left = [
      ...changedOrError(again.targets),
      ...again.rules.filter((x) => x.action !== 'inSync').map((x) => `rule:${x.name}:${x.action}`),
      ...again.skills.filter((x) => x.action !== 'inSync').map((x) => `skill:${x.name}:${x.action}`)
    ]
    if (left.length) bad.push(`changes left on re-sync ${left.join(',')}`)
    // previous rule folder mixed with user files → left alone
    mkdirSync(oldRulesDir)
    writeFileSync(join(oldRulesDir, ruleNames[0]), 'copy\n')
    writeFileSync(join(oldRulesDir, 'mine.md'), 'mine\n')
    const pu = planRuleSync(N, envN).find((x) => x.name === LEGACY_CLAUDE_RULES_DIR)
    if (pu?.action !== 'skip' || pu.reason !== 'legacyDirUserFiles') bad.push(`plan with mixed user files ${pu?.action}`)
    syncAll(N, envN, { allowReal: true })
    if (!existsSync(join(oldRulesDir, 'mine.md')) || !existsSync(join(oldRulesDir, ruleNames[0])))
      bad.push('touched folder mixed with user files')
    check(
      'o. rename — previous-name layout → rename-migrate (replace empty skeleton) → sync → new paths, markers, rule folder, re-sync 0',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `2 moves (empty skeleton replaced), libraryPath removed, manifest, state ${pl.stateRewrites}, 3 markers and opencode paths replaced, rules ${ruleNames.length} + bak migrated, previous folder removed, toggles kept, re-sync 0, previous folder with user files skipped`
    )
  }

  // ---- o2. rename HarnessSync → Illithid: real-world harnesssync generation layout → auto-migrate on start → sync
  {
    const bad: string[] = []
    const H = makeLegacyFixture('illithid-m7-OH-')
    initLibrary(H)
    if (importAllFromLegacy(H).results.some((x) => x.status !== 'imported')) bad.push('import failed')
    const envH = fakeEnv(H)
    const offServer = listMcpServers(H)[0]
    setToggle(H, 'mcp', offServer, 'codex', false)
    createWorkspace(H, 'work', { from: 'current' })
    const newRoot = join(H, DEFAULT_LIBRARY_DIR)
    const newCfg = join(H, APP_CONFIG_DIR)
    // opencode user entries (to check they are kept)
    const op = join(H, '.config/opencode/opencode.json')
    const oc0 = readJson(op)
    oc0.instructions = [...((oc0.instructions as unknown[]) ?? []), '~/my-notes.md']
    writeJson(op, oc0)
    if (!syncAll(H, envH, { allowReal: true }).results) bad.push('initial sync did not run')
    const oc1 = readJson(op)
    oc1.skills = { ...((oc1.skills as Json) ?? {}), paths: [...(((oc1.skills as Json)?.paths as string[]) ?? []), '/opt/my-skills'] }
    writeJson(op, oc1)
    const ruleNames = readdirSync(join(libraryRoot(H), 'rules')).filter((f) => f.endsWith('.md'))
    // artifacts in the app data root, and index/rollback/backups in the config folder
    mkdirSync(join(newRoot, 'artifacts/logo'), { recursive: true })
    writeFileSync(join(newRoot, 'artifacts/logo/a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    writeFileSync(join(newRoot, 'artifacts/manifest.json'), '{"tool":"Claude Code"}\n')
    writeFileSync(join(newCfg, 'search.sqlite'), Buffer.alloc(4096, 7))
    writeFileSync(join(newCfg, 'search.sqlite-wal'), '')
    mkdirSync(join(newCfg, 'rollback'), { recursive: true })
    writeFileSync(join(newCfg, 'rollback/pre-workspaces-20260924-000000.tar'), 'old tar\n')
    mkdirSync(join(newCfg, 'backups/deleted/x'), { recursive: true })
    writeFileSync(join(newCfg, 'backups/deleted/x/r.md'), 'deleted\n')

    // switch to the previous-name (harnesssync) layout — same shape as the real HOME
    const HS = { lib: '.harnesssync', cfg: '.config/harnesssync', rules: 'harnesssync', manifest: 'harnesssync.json', bak: '.harnesssync.bak' }
    const oldRoot = join(H, HS.lib)
    const oldCfg = join(H, HS.cfg)
    renameSync(newRoot, oldRoot)
    renameSync(newCfg, oldCfg)
    const wsIds = readdirSync(join(oldRoot, 'workspaces')).sort()
    for (const id of wsIds) {
      const m = join(oldRoot, 'workspaces', id, MANIFEST_FILE)
      if (existsSync(m)) renameSync(m, join(oldRoot, 'workspaces', id, HS.manifest))
    }
    const oldRulesDir = join(H, '.claude/rules', HS.rules)
    renameSync(join(H, '.claude/rules', CLAUDE_RULES_DIR), oldRulesDir)
    writeFileSync(join(oldRulesDir, ruleNames[0] + HS.bak), 'old backup\n')
    const swap = (rel: string, pairs: [string, string][]): void => {
      let t = read(join(H, rel))
      for (const [a, b] of pairs) t = t.split(a).join(b)
      writeFileSync(join(H, rel), t)
    }
    swap('.codex/AGENTS.md', [[MD_BEGIN, LEGACY_HS_MD_BEGIN], [MD_END, LEGACY_HS_MD_END], ['Illithid', 'HarnessSync']])
    swap('.codex/rules/default.rules', [[RULES_BEGIN, LEGACY_HS_RULES_BEGIN], [RULES_END, LEGACY_HS_RULES_END]])
    swap('.codex/config.toml', [[TOML_MCP_BEGIN, LEGACY_HS_TOML_MCP_BEGIN], [TOML_MCP_END, LEGACY_HS_TOML_MCP_END]])
    swap('.config/opencode/opencode.json', [[newRoot + '/', oldRoot + '/']])
    swap(join(HS.cfg, 'state.json'), [[newRoot + '/', oldRoot + '/']])
    // previous-name backups next to tool files (must stay as-is)
    const toolBaks = ['.codex/AGENTS.md', '.codex/config.toml'].map((r) => join(H, r + HS.bak))
    for (const b of toolBaks) writeFileSync(b, 'previous\n')
    const oc2 = read(op)
    if (!oc2.includes(oldRoot + '/workspaces/default/rules/') || !oc2.includes(oldRoot + '/workspaces/default/skills'))
      bad.push('setup: no previous opencode path')
    const stateOld = read(join(oldCfg, 'state.json'))
    const stateOldRefs = stateOld.split(oldRoot + '/').length - 1

    // byte table before migration (relative names based on the new paths)
    const bytes = (root: string): Map<string, string> => {
      const out = new Map<string, string>()
      const walk = (d: string, rel: string): void => {
        for (const n of readdirSync(d)) {
          const p = join(d, n)
          const r = rel ? `${rel}/${n}` : n
          const st = lstatSync(p)
          if (st.isSymbolicLink()) out.set(r, 'link:' + readlinkSync(p))
          else if (st.isDirectory()) walk(p, r)
          else out.set(r, sha(readFileSync(p)))
        }
      }
      if (existsSync(root)) walk(root, '')
      return out
    }
    const beforeLib = bytes(oldRoot)
    const beforeCfg = bytes(oldCfg)

    // plan (read-only)
    const pend = renamePendingPaths(H)
    if (!pend.includes(oldRoot) || !pend.includes(oldCfg)) bad.push(`pending ${pend.join(',')}`)
    if (!autoRenamePending(H)) bad.push('autoRenamePending false')
    const pl = planRename(H)
    if (pl.generation !== 'harnesssync' || pl.blocked.length || pl.moves.length !== 2 || pl.moves.some((m) => m.replaceEmptySkeleton))
      bad.push(`plan ${JSON.stringify({ g: pl.generation, b: pl.blocked, m: pl.moves.length })}`)
    if (pl.manifests.length !== wsIds.length || pl.stateRewrites !== stateOldRefs || !pl.snapshot || pl.followUps.length !== 1)
      bad.push(`plan manifest ${pl.manifests.length}/${wsIds.length} state ${pl.stateRewrites}/${stateOldRefs} snap ${!!pl.snapshot} follow ${pl.followUps.length}`)
    if (!existsSync(oldRoot) || existsSync(newRoot)) bad.push('moved on plan only')

    // auto-migrate on start (ensureLibrary)
    const en = ensureLibrary(H)
    if (en.status !== 'exists' || en.renamed?.length !== 2) bad.push(`ensureLibrary ${JSON.stringify(en)}`)
    if (existsSync(oldRoot) || existsSync(oldCfg)) bad.push('previous paths left')
    // bytes kept: on/off files renamed only, state.json rewritten, a new snapshot tar added
    const afterLib = bytes(newRoot)
    const afterCfg = bytes(newCfg)
    const libDiff: string[] = []
    for (const [k, v] of beforeLib) {
      const k2 = k.endsWith('/' + HS.manifest) ? k.slice(0, -HS.manifest.length) + MANIFEST_FILE : k
      if (afterLib.get(k2) !== v) libDiff.push(k)
    }
    if (afterLib.size !== beforeLib.size) libDiff.push(`count ${beforeLib.size}→${afterLib.size}`)
    if (libDiff.length) bad.push(`library bytes ${libDiff.slice(0, 5).join(',')}`)
    const cfgDiff = [...beforeCfg].filter(([k, v]) => k !== 'state.json' && afterCfg.get(k) !== v).map(([k]) => k)
    const snaps = [...afterCfg.keys()].filter((k) => /^rollback\/pre-illithid-.*\.tar$/.test(k))
    if (cfgDiff.length || snaps.length !== 1 || afterCfg.size !== beforeCfg.size + 1)
      bad.push(`config bytes ${cfgDiff.join(',')} snap ${snaps.length} count ${beforeCfg.size}→${afterCfg.size}`)
    for (const id of wsIds)
      if (existsSync(join(newRoot, 'workspaces', id, HS.manifest)) || !existsSync(join(newRoot, 'workspaces', id, MANIFEST_FILE)))
        bad.push(`${id} on/off file name`)
    const stateNew = read(join(newCfg, 'state.json'))
    if (stateNew.includes(HS.lib) || stateNew.split(newRoot + '/').length - 1 < stateOldRefs) bad.push('state path rewrite')
    // snapshot content: both folders, search.sqlite* and rollback/ excluded
    const tarList = snaps.length
      ? execFileSync('tar', ['-tf', join(newCfg, snaps[0])], { encoding: 'utf8' }).split('\n').filter(Boolean)
      : []
    if (!tarList.some((x) => x.startsWith(HS.lib + '/workspaces/default/rules/')) || !tarList.some((x) => x === HS.cfg + '/state.json'))
      bad.push('previous folders missing in snapshot')
    if (tarList.some((x) => x.includes('search.sqlite') || x.includes(HS.cfg + '/rollback')))
      bad.push('index/rollback included in snapshot')
    // tool files still unchanged (migration moves app paths only)
    if (!read(join(H, '.codex/AGENTS.md')).includes(LEGACY_HS_MD_BEGIN)) bad.push('AGENTS.md changed by migration alone')

    // first sync: markers, opencode paths, Claude rule folder
    const r = syncAll(H, envH, { allowReal: true })
    if (!r.results) bad.push('sync did not run')
    else {
      const mig = r.results.rules.find((x) => x.action === 'migrateLegacyDir')
      if (mig?.status !== 'done' || mig.name !== HS.rules) bad.push(`rule folder migration ${mig?.name}:${mig?.status}`)
      if (r.results.rules.some((x) => x.status === 'failed' || x.status === 'refused')) bad.push('rules failed/refused')
      if (r.results.targets.some((x) => x.status === 'skipped' && x.reason !== 'error'))
        bad.push(`target skip ${r.results.targets.filter((x) => x.status === 'skipped').map((x) => x.id).join(',')}`)
    }
    const agents = read(join(H, '.codex/AGENTS.md'))
    const rules = read(join(H, '.codex/rules/default.rules'))
    const toml = read(join(H, '.codex/config.toml'))
    for (const [n, t] of [['AGENTS.md', agents], ['default.rules', rules], ['config.toml', toml]] as const)
      if (/(BEGIN|END) harnesssync/.test(t)) bad.push(`${n} harnesssync block left`)
    if (!agents.includes(MD_BEGIN) || !agents.includes(MD_END)) bad.push('AGENTS.md new marker')
    if (!rules.includes(RULES_BEGIN) || !toml.includes(TOML_MCP_BEGIN)) bad.push('default.rules/config.toml new marker')
    if (toml.includes(`[mcp_servers.${offServer}]`) || toml.includes(`[mcp_servers."${offServer}"]`)) bad.push('manifest toggles lost')
    const oc = readJson(op)
    const instr = (oc.instructions as unknown[]).map(String)
    const skp = (((oc.skills as Json)?.paths as unknown[]) ?? []).map(String)
    if ([...instr, ...skp].some((x) => x.includes(HS.lib))) bad.push(`previous opencode paths left ${[...instr, ...skp].filter((x) => x.includes(HS.lib)).join(',')}`)
    if (!instr.some((x) => x.startsWith(newRoot + '/workspaces/default/rules/')) || !skp.includes(newRoot + '/workspaces/default/skills'))
      bad.push('no new opencode paths')
    if (!instr.includes('~/my-notes.md') || !skp.includes('/opt/my-skills')) bad.push('opencode user entries lost')
    const newRulesDir = join(H, '.claude/rules', CLAUDE_RULES_DIR)
    if (existsSync(oldRulesDir)) bad.push('previous rule folder left')
    const newRuleFiles = existsSync(newRulesDir) ? readdirSync(newRulesDir) : []
    if (ruleNames.some((n) => !newRuleFiles.includes(n))) bad.push('rules missing in new rule folder')
    if (!newRuleFiles.includes(ruleNames[0] + BACKUP_SUFFIX)) bad.push('rule backup migration missing')
    if (toolBaks.some((b) => read(b) !== 'previous\n')) bad.push('previous-name .bak next to tool file changed')
    const again = planSyncAll(H, envH)
    const left = [
      ...changedOrError(again.targets),
      ...again.rules.filter((x) => x.action !== 'inSync').map((x) => `rule:${x.name}:${x.action}`),
      ...again.skills.filter((x) => x.action !== 'inSync').map((x) => `skill:${x.name}:${x.action}`)
    ]
    if (left.length) bad.push(`changes left on re-sync ${left.join(',')}`)
    // idempotent
    if (autoRenamePending(H) || renamePendingPaths(H).length) bad.push('pending left after migration')
    if (applyRename(H).plan.needed) bad.push('work left on re-run')
    const en2 = ensureLibrary(H)
    if (en2.status !== 'exists' || en2.renamed) bad.push(`ensureLibrary on re-run ${JSON.stringify(en2)}`)
    if ([...bytes(newCfg).keys()].filter((k) => k.startsWith('rollback/pre-illithid-')).length !== 1) bad.push('re-run added a snapshot')

    // new path pre-exists: if both the previous and new folders exist, move nothing and migrateFailed
    const C = makeFixture('illithid-m7-OC-')
    unlinkSync(join(C, '.agents'))
    mkdirSync(join(C, HS.lib, 'workspaces/default/rules'), { recursive: true })
    writeFileSync(join(C, HS.lib, 'workspaces/default/rules/a.md'), 'a\n')
    mkdirSync(join(C, DEFAULT_LIBRARY_DIR, 'workspaces/default/rules'), { recursive: true })
    writeFileSync(join(C, DEFAULT_LIBRARY_DIR, 'workspaces/default/rules/b.md'), 'b\n')
    const ec = ensureLibrary(C)
    if (ec.status !== 'migrateFailed') bad.push(`conflict ensureLibrary ${ec.status}`)
    if (!existsSync(join(C, HS.lib, 'workspaces/default/rules/a.md')) || !existsSync(join(C, DEFAULT_LIBRARY_DIR, 'workspaces/default/rules/b.md')))
      bad.push('moved despite conflict')
    if (existsSync(join(C, APP_CONFIG_DIR, 'rollback')) || existsSync(join(C, HS.cfg))) bad.push('snapshot despite conflict')
    // if the new path is an empty skeleton, clear it and move
    const C2 = makeFixture('illithid-m7-OS-')
    unlinkSync(join(C2, '.agents'))
    initLibrary(C2)
    renameSync(join(C2, DEFAULT_LIBRARY_DIR), join(C2, HS.lib))
    writeFileSync(join(C2, HS.lib, 'workspaces/default/rules/a.md'), 'a\n')
    initLibrary(C2)
    const pl2 = planRename(C2)
    if (!pl2.moves.find((m) => m.what === 'library')?.replaceEmptySkeleton) bad.push('no empty-skeleton replacement plan')
    if (ensureLibrary(C2).status !== 'exists' || read(join(C2, DEFAULT_LIBRARY_DIR, 'workspaces/default/rules/a.md')) !== 'a\n' || existsSync(join(C2, HS.lib)))
      bad.push('empty-skeleton replacement migration')

    // keychain: if missing in the new service, read the previous service's value; writes go to the new service
    const acct = 'srv/env/TOKEN'
    const oldSvc = memorySecretBackend({ [acct]: 'old-value' })
    const newSvc = memorySecretBackend()
    const kb = withLegacySecrets(newSvc, [oldSvc])
    if (kb.get(acct) !== 'old-value') bad.push('keychain fallback read')
    kb.set(acct, 'new-value')
    if (newSvc.get(acct) !== 'new-value' || oldSvc.get(acct) !== 'old-value' || kb.get(acct) !== 'new-value') bad.push('keychain write')
    if (!kb.delete(acct) || kb.get(acct) !== null) bad.push('fallback revived after keychain delete')

    // import a previous-name zip (.harnesssync.zip containing harnesssync.json) → illithid.json
    const zipOld = zipSync({
      [HS.manifest]: new TextEncoder().encode(JSON.stringify({ version: 1, rules: {}, skills: {}, mcp: {}, agents: {} }) + '\n'),
      'rules/z.md': new TextEncoder().encode('z\n')
    })
    const zi = importWorkspace(H, zipOld, { name: 'old-zip' })
    const ziRoot = workspaceRoot(H, zi.id)
    if (!existsSync(join(ziRoot, MANIFEST_FILE)) || existsSync(join(ziRoot, HS.manifest))) bad.push('previous zip on/off file name')

    check(
      'o2. rename HarnessSync → Illithid — auto-migrate on start (snapshot), bytes kept, state rewritten → sync replaces markers, opencode paths, rule folder; idempotent, stops on conflict',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `workspaces ${wsIds.length}, library ${afterLib.size} files, config ${beforeCfg.size} files byte-identical, ${wsIds.length} on/off files renamed, state ${pl.stateRewrites}, tar ${tarList.length} entries (index/rollback excluded), Codex harnesssync blocks 0, previous opencode paths 0, 2 user entries kept, rules ${ruleNames.length} + bak migrated, re-sync 0, idempotent, stops on pre-existing conflict, empty skeleton replaced, keychain fallback, previous zip import`
    )
  }

  // ---- p. tools' own skill-disable settings — remove only off/false/deny for skills enabled in the library, keep the rest, re-sync 0
  {
    const bad: string[] = []
    const names = canonicalSkills(F)
    if (names.length < 2) bad.push(`library skills ${names.length} — need at least 2`)
    const [on, offInLib] = names
    setToggle(F, 'skills', on, 'claude', true)
    setToggle(F, 'skills', on, 'codex', true)
    setToggle(F, 'skills', offInLib, 'claude', false)
    setToggle(F, 'skills', offInLib, 'codex', false)
    syncAll(F, env, { allowReal: true })
    if (changedOrError(planAll(F, env)).length)
      bad.push(`plan changes after setup ${changedOrError(planAll(F, env)).join(',')}`)

    // Claude settings.json
    const sp = join(F, '.claude/settings.json')
    const st0 = readJson(sp)
    st0.skillOverrides = {
      [on]: 'off',
      [offInLib]: 'off',
      'not-in-library': 'off',
      [`${on}-x`]: 'off'
    }
    writeJson(sp, st0)
    // Codex config.toml
    const cp = join(F, '.codex/config.toml')
    const cx0 = read(cp)
    const codexHome = join(F, '.codex/skills')
    writeFileSync(
      cp,
      cx0.trimEnd() +
        '\n\n[[skills.config]]\nname = ' +
        JSON.stringify(on) +
        '\nenabled = false\n' +
        '\n[[skills.config]]\nname = "not-in-library"\nenabled = false\n' +
        '\n[[skills.config]]\npath = ' +
        JSON.stringify(join(codexHome, on, 'SKILL.md')) +
        '\nenabled = false\n' +
        '\n[[skills.config]]\nname = ' +
        JSON.stringify(offInLib) +
        '\nenabled = false\n'
    )
    // OpenCode opencode.json
    const op = join(F, '.config/opencode/opencode.json')
    const oc0 = readJson(op)
    const perm0 = (oc0.permission as Json | undefined) ?? {}
    oc0.permission = {
      ...perm0,
      skill: { '*': 'allow', [on]: 'deny', 'not-in-library': 'deny', [offInLib]: 'ask' }
    }
    writeJson(op, oc0)

    const other = (o: Json, key: string): string =>
      JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== key)))
    const otherToml = (t: string): string => {
      const o = parseToml(t) as Json
      const sk = { ...((o.skills as Json | undefined) ?? {}) }
      delete sk.config
      if (Object.keys(sk).length) o.skills = sk
      else delete o.skills
      return JSON.stringify(o)
    }
    const stBefore = readJson(sp)
    const cxBefore = read(cp)
    const ocBefore = readJson(op)

    const p1 = planAll(F, env)
    for (const id of ['claudeSkillOverrides', 'codexSkillConfig', 'opencodeSkillPermissions'])
      if (!byId(p1, id)?.changed || byId(p1, id)?.error) bad.push(`${id} plan no change/error`)
    for (const tool of ['claude', 'codex', 'opencode'])
      if (cell(F, env, 'skills', tool) !== 'needsSync')
        bad.push(`status skills.${tool} ${cell(F, env, 'skills', tool)}`)
    const sk1 = readsSkills(F, env)
    if (sk1.state[on]?.claude !== 'needsSync') bad.push(`pill claude ${sk1.state[on]?.claude}`)
    if (sk1.state[on]?.codex !== 'needsSync') bad.push(`pill codex ${sk1.state[on]?.codex}`)
    if (sk1.state[on]?.opencode !== 'needsSync')
      bad.push(`pill opencode ${sk1.state[on]?.opencode}`)

    const r1 = syncAll(F, env, { allowReal: true })
    for (const id of ['claudeSkillOverrides', 'codexSkillConfig', 'opencodeSkillPermissions'])
      if (r1.results!.targets.find((t) => t.id === id)?.status !== 'written')
        bad.push(`${id} not applied`)

    const stAfter = readJson(sp)
    const so = stAfter.skillOverrides as Json | undefined
    if (!so || so[on] !== undefined) bad.push('claude: library skill key left')
    if (so?.[offInLib] !== 'off' || so?.['not-in-library'] !== 'off' || so?.[`${on}-x`] !== 'off')
      bad.push('claude: kept entries gone')
    if (other(stAfter, 'skillOverrides') !== other(stBefore, 'skillOverrides'))
      bad.push('claude: other keys changed')

    const cxAfter = read(cp)
    const list = (((parseToml(cxAfter) as Json).skills as Json | undefined)?.config ?? []) as Json[]
    const keptNames = list.map((e) => (e.name ?? e.path) as string)
    if (keptNames.includes(on) || list.some((e) => typeof e.path === 'string'))
      bad.push('codex: library skill entry left')
    if (!keptNames.includes('not-in-library') || !keptNames.includes(offInLib))
      bad.push('codex: kept entries gone')
    if (otherToml(cxAfter) !== otherToml(cxBefore)) bad.push('codex: other content changed')
    if (!cxAfter.includes(TOML_MCP_BEGIN)) bad.push('codex: mcp marker gone')

    const ocAfter = readJson(op)
    const rule = (ocAfter.permission as Json).skill as Json
    if (rule[on] !== undefined) bad.push('opencode: library skill deny left')
    if (rule['*'] !== 'allow' || rule['not-in-library'] !== 'deny' || rule[offInLib] !== 'ask')
      bad.push('opencode: kept entries gone')
    if (other(ocAfter, 'permission') !== other(ocBefore, 'permission'))
      bad.push('opencode: other keys changed')
    if (other(ocAfter.permission as Json, 'skill') !== other(ocBefore.permission as Json, 'skill'))
      bad.push('opencode: other permission subkeys changed')

    if (changedOrError(planAll(F, env)).length)
      bad.push(`re-plan changes ${changedOrError(planAll(F, env)).join(',')}`)
    const r2 = syncAll(F, env, { allowReal: true })
    const written2 = r2.results!.targets.filter((t) => t.status === 'written').map((t) => t.id)
    if (written2.length) bad.push(`re-sync writes ${written2.join(',')}`)
    // copies of skills turned off in the library are deleteCandidate (display only), so claude/codex cells stay needsSync — only check the skill-disable part
    const rep = statusReport(F, env)
    for (const tool of ['claude', 'codex', 'opencode']) {
      const c = rep.cells.find((x) => x.resource === 'skills' && x.tool === tool)!
      if (c.detail.includes(' · ~/')) bad.push(`status after apply skills.${tool} ${c.detail}`)
    }
    if (cell(F, env, 'skills', 'opencode') !== 'synced') bad.push('status after apply skills.opencode')
    const sk2 = readsSkills(F, env)
    if (sk2.state[on]?.claude !== 'synced' || sk2.state[on]?.codex !== 'synced')
      bad.push('pill after apply')

    // only library skill keys present → the skillOverrides key itself is removed
    const st3 = readJson(sp)
    st3.skillOverrides = { [on]: 'off' }
    writeJson(sp, st3)
    syncAll(F, env, { allowReal: true })
    if ('skillOverrides' in readJson(sp)) bad.push('claude: empty skillOverrides key left')
    // partial disable values are kept
    const st4 = readJson(sp)
    st4.skillOverrides = { [on]: 'name-only' }
    writeJson(sp, st4)
    if (byId(planAll(F, env), 'claudeSkillOverrides').changed)
      bad.push('claude: name-only treated as a change')
    delete st4.skillOverrides
    writeJson(sp, st4)
    setToggle(F, 'skills', offInLib, 'claude', true)
    setToggle(F, 'skills', offInLib, 'codex', true)
    syncAll(F, env, { allowReal: true })

    check(
      'p. tool skill-disable settings — remove only off/false/deny for skills enabled in the library, keep non-library, disabled skills and partial values, re-sync 0',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : 'claude off 1 removed / 3 kept, codex name/path 2 removed / 2 kept, opencode deny 1 removed / 3 kept, other keys unchanged, status and pill needsSync→synced, re-sync writes 0, empty key removed, name-only kept'
    )
  }

  // ---- q. MCP secrets — memory backend (no real keychain): plaintext → reference, sync literals, error only for missing servers, entry removed on delete, ${VAR} unchanged
  {
    const bad: string[] = []
    const mem = memorySecretBackend()
    const lp = libraryPaths(F)
    // fake values (never printed)
    const H1 = 'fxsecHdrOne-AbCdEf0123456789XyZ'
    const H2 = 'fxsecHdrTwo-QwErTy9876543210AsD'
    const B1 = 'fxsecBearer-ZxCvBn1357924680QaZ'
    const E1 = 'fxsecEnvOne-PoIuYt2468013579LkJ'
    const I1 = 'fxsecImport-MnBvCx1122334455GfD'
    const ALL = [H1, H2, B1, E1, I1]
    const leaks = (text: string): number => ALL.filter((v) => text.includes(v)).length
    const libText = (): string =>
      readdirSync(lp.mcpsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => read(join(lp.mcpsDir, f)))
        .join('\n')
    const claudeS = (): Json => readJson(join(F, '.claude.json')).mcpServers as Json
    const codexS = (): Json => tomlServers(read(join(F, '.codex/config.toml')))
    const ocS = (): Json => readJson(join(F, '.config/opencode/opencode.json')).mcp as Json
    const get = (o: Json, ...path: string[]): unknown =>
      path.reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Json)[k] : undefined), o)

    // 1) upsert: plaintext → backend, library holds references only
    const u1 = upsertMcpServer(
      F,
      'zz-sec-http',
      {
        transport: 'http',
        url: 'https://sec.invalid/mcp',
        headers: { 'X-Api-Key': H1 },
        bearerToken: `Bearer ${B1}`
      },
      { secrets: mem }
    )
    upsertMcpServer(
      F,
      'zz-sec-stdio',
      { transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { API_KEY: E1, MODE: '${ZZ_MODE}' } },
      { secrets: mem }
    )
    upsertMcpServer(
      F,
      'zz-sec-env',
      { transport: 'http', url: 'https://env.invalid/mcp', headers: { 'X-Key': '${ZZ_KEY}' }, bearerEnv: 'ZZ_BEARER' },
      { secrets: mem }
    )
    if (leaks(libText())) bad.push('plaintext in library file')
    if (leaks(JSON.stringify(u1))) bad.push('plaintext in upsert result')
    const sh = readMcpServer(F, 'zz-sec-http')
    if (sh.headers?.['X-Api-Key'] !== 'secret:zz-sec-http/headers/X-Api-Key') bad.push('header reference format')
    if (sh.bearerToken !== 'secret:zz-sec-http/headers/Authorization') bad.push('bearer reference format')
    const ss = readMcpServer(F, 'zz-sec-stdio')
    if (ss.env?.API_KEY !== 'secret:zz-sec-stdio/env/API_KEY' || ss.env?.MODE !== '${ZZ_MODE}')
      bad.push('env reference / ${VAR} kept')
    const se = readMcpServer(F, 'zz-sec-env')
    if (se.headers?.['X-Key'] !== '${ZZ_KEY}' || se.bearerEnv !== 'ZZ_BEARER' || se.bearerToken)
      bad.push('${VAR} server altered')
    const ent = mem.entries()
    if (
      Object.keys(ent).sort().join() !==
        'zz-sec-http/headers/Authorization,zz-sec-http/headers/X-Api-Key,zz-sec-stdio/env/API_KEY' ||
      ent['zz-sec-http/headers/Authorization'] !== B1
    )
      bad.push(`backend entries ${Object.keys(ent).length}`)
    // validation: malformed references, references to other servers, duplicate bearer refused
    if (errCode(() => upsertMcpServer(F, 'zz-sec-bad', { transport: 'http', url: 'https://b.invalid', headers: { A: 'secret:nope' } })) !== 'invalidSchema')
      bad.push('malformed reference allowed')
    if (errCode(() => upsertMcpServer(F, 'zz-sec-bad', { transport: 'http', url: 'https://b.invalid', headers: { 'X-Api-Key': 'secret:zz-sec-http/headers/X-Api-Key' } })) !== 'invalidSchema')
      bad.push('reference to other server allowed')
    if (errCode(() => upsertMcpServer(F, 'zz-sec-bad', { transport: 'http', url: 'https://b.invalid', bearerToken: 'x', bearerEnv: 'Y' }, { secrets: mem })) !== 'invalidSchema')
      bad.push('bearerToken+bearerEnv allowed')
    if (existsSync(join(lp.mcpsDir, 'zz-sec-bad.json'))) bad.push('refused server file created')

    // 2) edit form path (main): read with MASK and saving unchanged keeps it; new plaintext replaces
    const view = mcpRead(F, 'zz-sec-http')
    if (leaks(JSON.stringify(view))) bad.push('plaintext in mcpRead response')
    if (view.def.headers?.['X-Api-Key'] !== MASK || view.def.bearerToken !== MASK) bad.push('mcpRead MASK')
    const ro = mcpRead(F, 'zz-sec-env')
    if (ro.def.headers?.['X-Key'] !== '${ZZ_KEY}') bad.push('${VAR} masked')
    mcpSave(F, 'zz-sec-http', view.def, mem)
    if (readMcpServer(F, 'zz-sec-http').headers?.['X-Api-Key'] !== sh.headers?.['X-Api-Key'] || mem.get('zz-sec-http/headers/X-Api-Key') !== H1)
      bad.push('not kept when saving MASK')

    // 3) sync → literals in 3 tools
    env = fakeEnv(F)
    const r1 = syncAll(F, env, { allowReal: true, secrets: mem })
    if (r1.results!.targets.some((t) => t.status === 'skipped' || t.serverErrors)) bad.push('sync skip / server error')
    const c = claudeS()
    if (get(c, 'zz-sec-http', 'headers', 'X-Api-Key') !== H1 || get(c, 'zz-sec-http', 'headers', 'Authorization') !== `Bearer ${B1}`)
      bad.push('claude http literal')
    if (get(c, 'zz-sec-stdio', 'env', 'API_KEY') !== E1 || get(c, 'zz-sec-stdio', 'env', 'MODE') !== '${ZZ_MODE}')
      bad.push('claude stdio env')
    if (get(c, 'zz-sec-env', 'headers', 'X-Key') !== '${ZZ_KEY}' || get(c, 'zz-sec-env', 'headers', 'Authorization') !== 'Bearer ${ZZ_BEARER}')
      bad.push('claude ${VAR} server')
    const x = codexS()
    if (get(x, 'zz-sec-http', 'http_headers', 'X-Api-Key') !== H1 || get(x, 'zz-sec-http', 'http_headers', 'Authorization') !== `Bearer ${B1}`)
      bad.push('codex http_headers literal')
    if (get(x, 'zz-sec-http', 'bearer_token') !== undefined || get(x, 'zz-sec-http', 'bearer_token_env_var') !== undefined)
      bad.push('codex bearer key misuse')
    if (get(x, 'zz-sec-stdio', 'env', 'API_KEY') !== E1 || get(x, 'zz-sec-stdio', 'env', 'MODE') !== 'fixture-value')
      bad.push('codex stdio env')
    if (get(x, 'zz-sec-env', 'env_http_headers', 'X-Key') !== 'ZZ_KEY' || get(x, 'zz-sec-env', 'bearer_token_env_var') !== 'ZZ_BEARER' || get(x, 'zz-sec-env', 'http_headers') !== undefined)
      bad.push('codex ${VAR} server')
    const o = ocS()
    if (get(o, 'zz-sec-http', 'headers', 'X-Api-Key') !== H1 || get(o, 'zz-sec-http', 'headers', 'Authorization') !== `Bearer ${B1}`)
      bad.push('opencode http literal')
    if (get(o, 'zz-sec-stdio', 'environment', 'API_KEY') !== E1 || get(o, 'zz-sec-stdio', 'environment', 'MODE') !== '{env:ZZ_MODE}')
      bad.push('opencode stdio env')
    if (get(o, 'zz-sec-env', 'headers', 'X-Key') !== '{env:ZZ_KEY}' || get(o, 'zz-sec-env', 'headers', 'Authorization') !== 'Bearer {env:ZZ_BEARER}')
      bad.push('opencode ${VAR} server')
    const p1 = planAll(F, env, mem)
    if (changedOrError(p1).length || p1.some((ch) => ch.serverErrors)) bad.push('re-plan changes after sync')
    // no plaintext in results, summary, status, or plan metadata (notes, errors)
    const exposed = JSON.stringify({
      results: r1.results,
      summary: summarizeSync(r1),
      status: statusReport(F, env, mem),
      meta: p1.map((ch) => ({ id: ch.id, notes: ch.notes, error: ch.error, serverErrors: ch.serverErrors }))
    })
    if (leaks(exposed)) bad.push('plaintext in results/status')

    // 4) missing value → error only for that server (previous entry kept), other servers still applied
    mem.delete('zz-sec-stdio/env/API_KEY')
    upsertMcpServer(F, 'zz-sec-http', { ...readMcpServer(F, 'zz-sec-http'), headers: { 'X-Api-Key': H2 } }, { secrets: mem })
    if (leaks(libText())) bad.push('library plaintext after replace')
    const r2 = syncAll(F, env, { allowReal: true, secrets: mem })
    const errs = r2.results!.targets.filter((t) => t.serverErrors)
    if (
      errs.map((t) => t.id).sort().join() !== 'claudeMcp,codexMcp,opencodeMcp' ||
      errs.some((t) => Object.keys(t.serverErrors!).join() !== 'zz-sec-stdio' || t.status !== 'written')
    )
      bad.push(`missing-value error targets ${errs.map((t) => t.id).join(',')}`)
    if (summarizeSync(r2)['target.serverError'] !== 3) bad.push('summary serverError')
    if (!errs.every((t) => t.serverErrors!['zz-sec-stdio'].includes('zz-sec-stdio/env/API_KEY'))) bad.push('account missing in error message')
    if (leaks(JSON.stringify(r2.results) + JSON.stringify(statusReport(F, env, mem).cells))) bad.push('plaintext in missing-value results')
    if (get(claudeS(), 'zz-sec-http', 'headers', 'X-Api-Key') !== H2 || get(codexS(), 'zz-sec-http', 'http_headers', 'X-Api-Key') !== H2 || get(ocS(), 'zz-sec-http', 'headers', 'X-Api-Key') !== H2)
      bad.push('other server not applied')
    if (get(claudeS(), 'zz-sec-stdio', 'env', 'API_KEY') !== E1 || get(codexS(), 'zz-sec-stdio', 'env', 'API_KEY') !== E1 || get(ocS(), 'zz-sec-stdio', 'environment', 'API_KEY') !== E1)
      bad.push('previous entry of missing server not kept')
    const mcpCells = statusReport(F, env, mem).cells.filter((cc) => cc.resource === 'mcp')
    if (!mcpCells.length || mcpCells.some((cc) => cc.state !== 'error')) bad.push('status not error when missing')
    mem.set('zz-sec-stdio/env/API_KEY', E1)
    syncAll(F, env, { allowReal: true, secrets: mem })
    if (changedOrError(planAll(F, env, mem)).length) bad.push('re-plan changes after value restored')
    if (mem.get('zz-sec-http/headers/X-Api-Key') !== H2) bad.push('replacement value stored')

    // 5) import: tool literals → backend + reference, no raw values in plan/results
    const cj = readJson(join(F, '.claude.json'))
    ;(cj.mcpServers as Json)['zz-imp'] = { type: 'http', url: 'https://imp.invalid/mcp', headers: { 'X-Token': I1 } }
    writeJson(join(F, '.claude.json'), cj)
    const ip = planImport(F, 'tool:claude')
    if (leaks(JSON.stringify(ip))) bad.push('plaintext in import plan')
    const ir = applyImport(F, [{ kind: 'mcp', name: 'zz-imp' }], 'tool:claude', { secrets: mem })[0]
    if (ir.status !== 'imported' || leaks(JSON.stringify(ir))) bad.push(`import ${ir.status}`)
    if (readMcpServer(F, 'zz-imp').headers?.['X-Token'] !== 'secret:zz-imp/headers/X-Token' || mem.get('zz-imp/headers/X-Token') !== I1)
      bad.push('import reference / backend')
    if (leaks(libText())) bad.push('library plaintext after import')
    syncAll(F, env, { allowReal: true, secrets: mem })
    if (get(codexS(), 'zz-imp', 'http_headers', 'X-Token') !== I1) bad.push('imported server codex literal')

    // 6) delete → backend entries removed, removed from tools
    const d1 = deleteMcpServer(F, 'zz-sec-http', { secrets: mem })
    const d2 = deleteMcpServer(F, 'zz-sec-stdio', { secrets: mem })
    const d3 = deleteMcpServer(F, 'zz-imp', { secrets: mem })
    deleteMcpServer(F, 'zz-sec-env', { secrets: mem })
    if (d1.secretsDeleted !== 2 || d2.secretsDeleted !== 1 || d3.secretsDeleted !== 1) bad.push('delete count')
    if (Object.keys(mem.entries()).length) bad.push(`backend left after delete ${Object.keys(mem.entries()).length}`)
    if (leaks(read(d1.trashPath))) bad.push('plaintext in trash file')
    syncAll(F, env, { allowReal: true, secrets: mem })
    for (const n of ['zz-sec-http', 'zz-sec-stdio', 'zz-sec-env', 'zz-imp'])
      if (n in claudeS() || n in codexS() || n in ocS()) bad.push(`${n} left in tools`)
    if (changedOrError(planAll(F, env)).length) bad.push('re-plan changes after delete')
    if (JSON.stringify(listMcpServers(F)) !== JSON.stringify(legacyOrder)) bad.push('order not restored')

    check(
      'q. MCP secrets — memory backend: upsert plaintext → secret: reference, sync literals to 3 tools (codex http_headers), error only for missing servers with previous entry kept, import and delete, ${VAR} unchanged',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : 'plaintext 0 in library, results, status, mcpRead, import plan; 3 backend entries, reference format, MASK save kept, claude/codex/opencode literal and ${VAR} rules, missing serverError 3 (other servers applied), import reference, backend 0 after delete, re-plan 0'
    )
  }

  // ---- r. import portability — tool-only items marked toolOnly in candidates and refused by applyImport, regular items import normally
  {
    const bad: string[] = []
    const G = makeFixture('illithid-m7-R-')
    initLibrary(G)
    // fake Codex config
    mkdirSync(join(G, '.codex/skills'), { recursive: true })
    writeFileSync(
      join(G, '.codex/config.toml'),
      [
        '[plugins."zz-plugin@fx-market"]',
        'enabled = true',
        '',
        '[mcp_servers.zz-rel]',
        'command = "./Fake Tool.app/Contents/MacOS/fx"',
        'args = ["mcp"]',
        '',
        '[mcp_servers.zz-bundle]',
        'command = "/Applications/Fake.app/Contents/Resources/bin/fx"',
        '',
        '[mcp_servers.zz-toolcfg]',
        `command = "${G}/.codex/bin/fx"`,
        '',
        '[mcp_servers.zz-plugin]',
        'command = "npx"',
        'args = ["-y", "zz-plugin-mcp"]',
        '',
        '[mcp_servers.zz-local]',
        'command = "node"',
        `args = ["${G}/work/fx/server.js"]`,
        '',
        '[mcp_servers.zz-brew]',
        'command = "/opt/homebrew/bin/fx"',
        '',
        '[mcp_servers.zz-path]',
        'command = "fxcmd"',
        'args = ["serve"]',
        '',
        '[mcp_servers.zz-http]',
        'url = "https://zz.invalid/mcp"',
        ''
      ].join('\n')
    )
    writeFileSync(
      join(G, '.codex/AGENTS.md'),
      `Codex-only text\n\n${MD_BEGIN}\nbody\n${MD_END}\n`
    )
    const skill = (dir: string, body = 'regular skill'): void => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: x\ndescription: x\n---\n${body}\n`)
    }
    skill(join(G, '.codex/skills/.zz-hidden'))
    skill(join(G, '.codex/skills/synced'))
    skill(join(G, '.codex/skills/zz-plain'))
    skill(join(G, '.codex/skills/zz-chrome'), 'open with mcp__claude-in-chrome__navigate')
    skill(join(G, '.codex/plugins/cache/fx-market/zz-plugin/1.0.0/skills/zz-plug'))
    symlinkSync(
      join(G, '.codex/plugins/cache/fx-market/zz-plugin/1.0.0/skills/zz-plug'),
      join(G, '.codex/skills/zz-plug')
    )
    skill(join(G, '.claude/skills/fx:ns-skill'))
    const toolHash = (): string =>
      sha(read(join(G, '.codex/config.toml'))) + sha(read(join(G, '.codex/AGENTS.md')))
    const h0 = toolHash()

    const pc = planImport(G, 'tool:codex')
    const mcpJ = Object.fromEntries(pc.mcp.map((c) => [c.name, `${c.portability}:${c.reasons.join('+')}`]))
    const expectMcp: Record<string, string> = {
      'zz-rel': 'toolOnly:relativeCommand',
      'zz-bundle': 'toolOnly:appBundle',
      'zz-toolcfg': 'toolOnly:toolConfigDir+localPath',
      'zz-plugin': 'toolOnly:pluginManaged',
      'zz-local': 'warn:localPath',
      'zz-brew': 'warn:localPath',
      'zz-path': 'ok:',
      'zz-http': 'ok:'
    }
    for (const [n, want] of Object.entries(expectMcp))
      if (mcpJ[n] !== want) bad.push(`mcp ${n} ${mcpJ[n]} ≠ ${want}`)
    const skJ = Object.fromEntries(pc.skills.map((c) => [c.name, `${c.portability}:${c.reasons.join('+')}`]))
    const expectSkill: Record<string, string> = {
      '.zz-hidden': 'toolOnly:hiddenDir',
      synced: 'toolOnly:toolInternalDir',
      'zz-plug': 'toolOnly:pluginSkill',
      'zz-chrome': 'warn:toolSpecificTools',
      'zz-plain': 'ok:'
    }
    for (const [n, want] of Object.entries(expectSkill))
      if (skJ[n] !== want) bad.push(`skill ${n} ${skJ[n]} ≠ ${want}`)
    const ca = pc.rules.find((c) => c.name === 'codex-agents.md')
    if (ca?.portability !== 'toolOnly' || ca.reasons.join() !== 'toolInstructions')
      bad.push(`codex-agents.md ${ca?.portability}`)
    if (pc.skills.some((c) => c.variants.some((v) => v.portability !== c.portability)))
      bad.push('variant / candidate classification mismatch')
    const pcl = planImport(G, 'tool:claude')
    const ns = pcl.skills.find((c) => c.name === 'fx:ns-skill')
    if (ns?.portability !== 'toolOnly' || !ns.reasons.includes('pluginSkill'))
      bad.push(`claude plugin skill ${ns?.portability}`)
    // classifier functions — paths not scanned yet (memory, instructions)
    const ctx = { home: G, codexPlugins: new Set<string>() }
    if (memoryPortability(ctx, join(G, '.claude/projects/-x/memory/a.md')).portability !== 'toolOnly')
      bad.push('claude auto memory')
    if (memoryPortability(ctx, join(G, '.codex/memories/a.md')).portability !== 'toolOnly')
      bad.push('codex memory')
    if (memoryPortability(ctx, join(G, '.agents/memory/a.md')).portability !== 'ok')
      bad.push('library memory')
    if (rulePortability(ctx, 'CLAUDE.md', join(G, '.claude/CLAUDE.md')).reasons.join() !== 'toolInstructions')
      bad.push('CLAUDE.md')
    if (rulePortability(ctx, 'AGENTS.md', join(G, 'repo/AGENTS.md')).reasons.join() !== 'projectScoped')
      bad.push('project AGENTS.md')
    if (rulePortability(ctx, '30-safety.md', join(G, '.claude/rules/30-safety.md')).portability !== 'ok')
      bad.push('regular rule')

    // choosing toolOnly → refused, nothing created in the library
    const lp = libraryPaths(G)
    const refused = applyImport(
      G,
      [
        { kind: 'mcp', name: 'zz-rel' },
        { kind: 'mcp', name: 'zz-bundle' },
        { kind: 'mcp', name: 'zz-plugin' },
        { kind: 'skill', name: 'zz-plug' },
        { kind: 'rule', name: 'codex-agents.md' }
      ],
      'tool:codex'
    )
    for (const r of refused)
      if (r.status !== 'refused' || r.reason !== 'toolOnly') bad.push(`${r.name} ${r.status}/${r.reason}`)
    for (const f of ['zz-rel.json', 'zz-bundle.json', 'zz-plugin.json'])
      if (existsSync(join(lp.mcpsDir, f))) bad.push(`${f} created`)
    if (existsSync(join(lp.skillsDir, 'zz-plug'))) bad.push('plugin skill copied')
    if (existsSync(join(lp.rulesDir, 'codex-agents.md'))) bad.push('codex-agents.md created')
    // regular and warn items → normal
    const okRes = applyImport(
      G,
      [
        { kind: 'mcp', name: 'zz-http' },
        { kind: 'mcp', name: 'zz-path' },
        { kind: 'mcp', name: 'zz-local' },
        { kind: 'skill', name: 'zz-plain' },
        { kind: 'skill', name: 'zz-chrome' }
      ],
      'tool:codex'
    )
    for (const r of okRes) if (r.status !== 'imported') bad.push(`${r.name} ${r.status}/${r.reason}`)
    if (readMcpServer(G, 'zz-http').url !== 'https://zz.invalid/mcp') bad.push('zz-http content')
    if (!existsSync(join(lp.skillsDir, 'zz-plain/SKILL.md'))) bad.push('zz-plain not copied')
    if (toolHash() !== h0) bad.push('tool-side files changed')
    check(
      'r. import portability — MCP/skill/rule/memory toolOnly/warn/ok classification, toolOnly refused by applyImport, regular and warn normal',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `MCP ${Object.keys(expectMcp).length}, skills ${Object.keys(expectSkill).length + 1}, rule/memory classification match, 5 toolOnly refused (toolOnly) and not created in library, 5 regular/warn imported, tool files unchanged`
    )
  }

  // ---- s. skill detail — SKILL.md description/body saved separately (other frontmatter keys kept), rename
  {
    const bad: string[] = []
    const skillsDir = libraryPaths(F).skillsDir
    const A = 'zz-doc'
    const B = 'zz-doc-renamed'
    const md = (n: string): string => join(skillsDir, n, 'SKILL.md')
    createSkill(F, A, 'tmp')
    const orig =
      `---\nname: ${A}\n# keep comment\ndescription: >\n  folded\n  text\n` +
      'allowed-tools: [Read, Bash]\nmetadata:\n  version: 2\n  tags: [a, b]\nlicense: MIT\n---\n\n# zz-doc\n\nbody\n'
    writeFileSync(md(A), orig)
    const d0 = readSkillDoc(F, A)
    const extraKeys = ['allowed-tools', 'metadata', 'license']
    if (d0.frontmatterName !== A || d0.description !== 'folded text\n') bad.push('read name/description')
    if (JSON.stringify(Object.keys(d0.extra)) !== JSON.stringify(extraKeys)) bad.push('read extra keys')
    if (d0.body !== '# zz-doc\n\nbody\n') bad.push('read body')
    // saving the same values → bytes unchanged
    writeSkillDoc(F, A, { description: d0.description, body: d0.body })
    if (read(md(A)) !== orig) bad.push('saving same values changed the file')
    // multi-line description round trip + body change, other keys, order and comments kept
    const multi = 'Use when: "quoted"\n\n  indented # not comment\nlast line'
    writeSkillDoc(F, A, { description: multi, body: '# zz-doc\n\nchanged\n' })
    const t1 = read(md(A))
    const d1 = readSkillDoc(F, A)
    if (d1.description !== multi) bad.push('multi-line description round trip')
    if (d1.body !== '# zz-doc\n\nchanged\n') bad.push('body save')
    if (JSON.stringify(d1.extra) !== JSON.stringify(d0.extra)) bad.push('extra values changed')
    if (
      JSON.stringify(Object.keys(matter(t1).data)) !==
      JSON.stringify(['name', 'description', ...extraKeys])
    )
      bad.push('frontmatter key order')
    for (const line of ['# keep comment', 'allowed-tools: [Read, Bash]', '  tags: [a, b]', 'license: MIT'])
      if (!t1.split('\n').includes(line)) bad.push(`original line kept: ${line}`)
    // single-line special value round trip (YAML reserved words, numbers, colons, surrounding spaces, Unicode)
    for (const v of ['yes', '123', 'a: b', ' spaced ', '\uD55C\uAE00 \uC124\uBA85 — \uB300\uC2DC', 'x #y', '- dash', '"q"'])
      try {
        writeSkillDoc(F, A, { description: v, body: d1.body })
        if (readSkillDoc(F, A).description !== v) bad.push(`single-line round trip ${JSON.stringify(v)}`)
      } catch (e) {
        bad.push(`single-line save error ${JSON.stringify(v)}: ${(e as Error).message}`)
      }
    if (errCode(() => writeSkillDoc(F, A, { description: '  ', body: 'x' })) !== 'invalidSchema')
      bad.push('empty description allowed')
    writeSkillDoc(F, A, { description: multi, body: d1.body })
    // before rename: app copies in two tools + codex off (to check the manifest key move)
    syncAll(F, env, { allowReal: true })
    const st0 = readState(F).state
    if (!st0.skills?.claude?.[A] || !st0.skills?.codex?.[A]) bad.push('no app copy record before rename')
    setToggle(F, 'skills', A, 'codex', false)
    const stBefore = JSON.stringify(readState(F).state.skills)
    // refused: same name, existing name, format, missing skill
    createSkill(F, 'zz-doc-other', 'other')
    if (errCode(() => renameSkill(F, A, 'zz-doc-other')) !== 'exists') bad.push('existing target allowed')
    if (errCode(() => renameSkill(F, A, A)) !== 'invalidName') bad.push('same name allowed')
    if (errCode(() => renameSkill(F, A, 'Bad/Name')) !== 'invalidName') bad.push('name format allowed')
    if (errCode(() => renameSkill(F, 'zz-none', B)) !== 'notFound') bad.push('missing skill allowed')
    if (!existsSync(md(A)) || read(md('zz-doc-other')).includes(multi)) bad.push('changed after refusal')
    deleteSkill(F, 'zz-doc-other')
    const before = read(md(A))
    const r = renameSkill(F, A, B)
    if (r.name !== B) bad.push('returned name')
    if (existsSync(join(skillsDir, A)) || !existsSync(md(B))) bad.push('folder move')
    const d2 = readSkillDoc(F, B)
    if (d2.frontmatterName !== B || d2.description !== multi || d2.body !== d1.body) bad.push('frontmatter name')
    if (JSON.stringify(d2.extra) !== JSON.stringify(d0.extra)) bad.push('extra after rename')
    if (read(md(B)) !== before.replace(`name: ${A}\n`, `name: ${B}\n`)) bad.push('changes beyond the name line')
    const mf = readJson(join(libraryRoot(F), MANIFEST_FILE)) as { skills: Json }
    if (A in mf.skills || JSON.stringify(mf.skills[B]) !== '{"codex":false}') bad.push('manifest key move')
    if (JSON.stringify(readState(F).state.skills) !== stBefore) bad.push('rename changed state')
    // sync: new name claude copy, codex is off so no copy, old-name app copies are deleteCandidate (display only) in both tools
    const rs = syncAll(F, env, { allowReal: true })
    const item = (tool: string, n: string): { action?: string; status?: string } =>
      rs.results!.skills.find((x) => x.tool === tool && x.name === n) ?? {}
    if (item('claude', B).action !== 'copy' || item('claude', B).status !== 'done')
      bad.push(`new name claude ${item('claude', B).action}/${item('claude', B).status}`)
    if (existsSync(join(F, '.codex/skills', B))) bad.push('new name copied to disabled codex')
    for (const tool of ['claude', 'codex'])
      if (item(tool, A).action !== 'deleteCandidate' || item(tool, A).status !== 'done')
        bad.push(`old name ${tool} ${item(tool, A).action}/${item(tool, A).status}`)
    if (existsSync(join(F, '.claude/skills', A)) || existsSync(join(F, '.codex/skills', A)))
      bad.push('old copy left')
    if (!deletedBackup(F, `skills/claude/${A}`) || !deletedBackup(F, `skills/codex/${A}`))
      bad.push('no backup of old copy')
    if (!existsSync(join(F, '.claude/skills', B, 'SKILL.md'))) bad.push('no new copy')
    // cleanup
    for (const tool of ['claude', 'codex']) {
      for (const n of [A, B]) rmSync(join(F, `.${tool}/skills`, n), { recursive: true, force: true })
    }
    const st = readState(F).state
    for (const tool of ['claude', 'codex'] as const)
      for (const n of [A, B]) if (st.skills?.[tool]) delete st.skills[tool]![n]
    writeState(F, st)
    setToggle(F, 'skills', B, 'codex', true)
    deleteSkill(F, B)
    check(
      's. skill detail — description/body saved separately (frontmatter keys, order, comments kept), rename (folder, name, manifest), sync copies new name and immediately backs up/moves the old name',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : 'same-value save keeps bytes, 8 multi-line/special value round trips, 3 extra keys kept, 4 refusals, after rename only the name line changes, manifest {codex:false} moved, state unchanged, sync claude copy + old name deleted immediately in 2 tools (backups/deleted)'
    )
  }

  // ---- t. tool memory cleanup — promote, move, trash Claude auto memory (one index line each, no byte changes outside targets, paths refused)
  {
    const bad: string[] = []
    const realProjects = join(REAL_HOME, '.claude/projects')
    const realStat = (): string => {
      try {
        const st = lstatSync(realProjects)
        return `${st.mtimeMs}:${st.size}`
      } catch {
        return 'absent'
      }
    }
    const real0 = realStat()
    const P = join(F, '.claude/projects')
    const SA = '-fixture-mem-a'
    const SB = '-fixture-mem-b'
    const SC = '-fixture-mem-c'
    const SD = '-fixture-mem-d'
    const mem = (s: string, f = ''): string => join(P, s, 'memory', f)
    const fm = (name: string, type: string): string =>
      `---\nname: ${name}\ndescription: ${name} \uC124\uBA85\nmetadata:\n  type: ${type}\n---\n\n${name} \uBCF8\uBB38\n`
    for (const s of [SA, SB, SC, SD]) mkdirSync(join(P, s), { recursive: true, mode: 0o700 })
    for (const s of [SA, SB, SD]) mkdirSync(mem(s), { mode: 0o700 })
    writeFileSync(
      mem(SA, 'MEMORY.md'),
      '# Memory Index\n\n- [\uC5D0\uC774\uC6D0](a1.md) — \uD558\uB098\n- [\uC5D0\uC774\uD22C](a2.md) — \uB458\n- [\uC5D0\uC774\uC4F0\uB9AC](a3.md) — \uC14B\n- [\uC0AC\uB77C\uC9D0](gone.md) — \uC5C6\uC74C\n'
    )
    for (const [f, ty] of [['a1.md', 'feedback'], ['a2.md', 'project'], ['a3.md', 'user'], ['a4.md', 'reference']])
      writeFileSync(mem(SA, f), fm(f.replace('.md', ''), ty))
    writeFileSync(
      join(P, SA, 's1.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/private/tmp/illithid-none-xyz', sessionId: 's1' }) + '\n'
    )
    writeFileSync(mem(SB, 'MEMORY.md'), '- [\uBE44\uC6D0](b1.md) — \uBE44\n')
    writeFileSync(mem(SB, 'b1.md'), fm('b1', 'feedback'))
    writeFileSync(mem(SB, 'a3.md'), fm('a3-other', 'user'))
    writeFileSync(mem(SD, 'MEMORY.md'), '# Memory Index\n\n- [\uB514\uC6D0](d1.md) — \uB514\n')
    writeFileSync(mem(SD, 'd1.md'), fm('d1', 'project'))
    // slug symlink pointing to an outside directory
    const outside = join(F, 'outside-proj')
    mkdirSync(join(outside, 'memory'), { recursive: true })
    writeFileSync(join(outside, 'memory', 'x.md'), 'x\n')
    symlinkSync(outside, join(P, '-fixture-link'))

    const walk = (root: string): Map<string, string> => {
      const m = new Map<string, string>()
      const go = (d: string): void => {
        if (!existsSync(d)) return
        for (const n of readdirSync(d)) {
          const p = join(d, n)
          const st = lstatSync(p)
          if (st.isDirectory()) go(p)
          else m.set(p, st.isSymbolicLink() ? 'link' : sha(readFileSync(p)))
        }
      }
      go(root)
      return m
    }
    const libMem = libraryPaths(F).memoryDir
    const snap = (): Map<string, string> => new Map([...walk(P), ...walk(libMem), ...walk(outside)])
    /** paths changed (added, removed, modified) between before→after */
    const diff = (a: Map<string, string>, b: Map<string, string>): string[] =>
      [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort()
    const expectOnly = (label: string, a: Map<string, string>, b: Map<string, string>, want: string[]): void => {
      const got = diff(a, b)
      const w = [...want].sort()
      if (JSON.stringify(got) !== JSON.stringify(w))
        bad.push(`${label} changed paths ${got.map((p) => p.replace(F, '')).join(',')} ≠ ${w.map((p) => p.replace(F, '')).join(',')}`)
    }
    const lines = (p: string): string[] => (existsSync(p) ? read(p).split('\n').filter(Boolean) : [])
    const count = (p: string, tag: string): number => lines(p).filter((l) => l.includes(tag)).length

    // scan
    const sc = scanClaudeMemory(F)
    const pa = sc.projects.find((x) => x.slug === SA)
    if (!pa) bad.push('scan A missing')
    else {
      if (pa.files.length !== 4) bad.push(`scan A files ${pa.files.length}`)
      if (pa.cwd !== '/private/tmp/illithid-none-xyz' || !pa.temp || !pa.missing) bad.push('scan A cwd/temp/missing')
      if (JSON.stringify(pa.index.broken) !== '["gone.md"]') bad.push(`scan broken ${pa.index.broken}`)
      const a1 = pa.files.find((f) => f.file === 'a1.md')
      const a4 = pa.files.find((f) => f.file === 'a4.md')
      if (a1?.title !== '\uC5D0\uC774\uC6D0' || a1.type !== 'feedback' || !a1.inIndex) bad.push('scan a1')
      if (a4?.title !== 'a4' || a4.inIndex || a4.type !== 'reference') bad.push('scan a4')
    }
    if (sc.projects.some((x) => x.slug === SC || x.slug === '-fixture-link')) bad.push('empty slot or symlink slot in scan')
    if (!sc.shared || sc.limits.lines !== 200) bad.push('scan shared/limits')
    if (readClaudeMemoryFile(F, SA, 'MEMORY.md') !== read(mem(SA, 'MEMORY.md'))) bad.push('read MEMORY.md')
    if (claudeProjectSlug('/Users/x/Work space/.claude/\uD55C') !== '-Users-x-Work-space--claude--')
      bad.push(`slug conversion ${claudeProjectSlug('/Users/x/Work space/.claude/\uD55C')}`)

    // refused (all bytes unchanged)
    const s0 = snap()
    const rejects: [string, () => unknown, string][] = [
      ['slug ../', () => trashClaudeMemory(F, '../x', 'a1.md'), 'invalidName'],
      ['slug ..', () => trashClaudeMemory(F, '..', 'a1.md'), 'invalidName'],
      ['slug a/b', () => trashClaudeMemory(F, `${SA}/memory`, 'a1.md'), 'invalidName'],
      ['slug missing', () => trashClaudeMemory(F, '-fixture-none', 'a1.md'), 'notFound'],
      ['slug symlink', () => trashClaudeMemory(F, '-fixture-link', 'x.md'), 'notFound'],
      ['file ../', () => trashClaudeMemory(F, SA, '../a1.md'), 'invalidName'],
      ['file subpath', () => trashClaudeMemory(F, SA, 'x/a1.md'), 'invalidName'],
      ['file .txt', () => trashClaudeMemory(F, SA, 'a1.txt'), 'invalidName'],
      ['read ../', () => readClaudeMemoryFile(F, SA, '../s1.jsonl'), 'invalidName'],
      ['MEMORY.md trash', () => trashClaudeMemory(F, SA, 'MEMORY.md'), 'invalidName'],
      ['MEMORY.md move', () => moveClaudeMemory(F, SA, 'MEMORY.md', SB), 'invalidName'],
      ['MEMORY.md promote', () => promoteClaudeMemory(F, SA, 'MEMORY.md', 'feedback'), 'invalidName'],
      ['type', () => promoteClaudeMemory(F, SA, 'a1.md', 'misc'), 'invalidName'],
      ['move target ../', () => moveClaudeMemory(F, SA, 'a1.md', '../x'), 'invalidName'],
      ['move same slot', () => moveClaudeMemory(F, SA, 'a1.md', SA), 'invalidName'],
      ['move same name', () => moveClaudeMemory(F, SA, 'a3.md', SB), 'exists']
    ]
    for (const [label, fn, want] of rejects) {
      const got = errCode(fn)
      if (got !== want) bad.push(`refused ${label}: ${got}`)
    }
    expectOnly('refused', s0, snap(), [])

    // promote a1 → feedback/a1.md
    const sharedIdx = join(libMem, 'MEMORY.md')
    const a1Bytes = read(mem(SA, 'a1.md'))
    const s1 = snap()
    const sharedN = lines(sharedIdx).length
    const aN = lines(mem(SA, 'MEMORY.md')).length
    const r1 = promoteClaudeMemory(F, SA, 'a1.md', 'feedback')
    const libA1 = join(libMem, 'feedback/a1.md')
    if (!existsSync(libA1) || read(libA1) !== a1Bytes) bad.push('promote body')
    if (lines(sharedIdx).length !== sharedN + 1 || count(sharedIdx, '](feedback/a1.md)') !== 1) bad.push('promote shared index +1')
    if (!lines(sharedIdx).includes('- [\uC5D0\uC774\uC6D0](feedback/a1.md) — \uD558\uB098')) bad.push('promote line link')
    if (lines(mem(SA, 'MEMORY.md')).length !== aN - 1 || count(mem(SA, 'MEMORY.md'), '](a1.md)')) bad.push('promote source index -1')
    if (existsSync(mem(SA, 'a1.md')) || !r1.trashPath || read(r1.trashPath) !== a1Bytes) bad.push('promote source trash')
    if (!r1.trashPath?.includes(`/.trash/`) || !r1.trashPath.endsWith(`/tool-memory/claude/${SA}/a1.md`)) bad.push('promote trash path')
    expectOnly('promote', s1, snap(), [mem(SA, 'a1.md'), mem(SA, 'MEMORY.md'), libA1, sharedIdx])
    // promoting the same path again → refused
    writeFileSync(mem(SA, 'a1.md'), fm('a1-again', 'feedback'))
    const s1b = snap()
    if (errCode(() => promoteClaudeMemory(F, SA, 'a1.md', 'feedback')) !== 'exists') bad.push('promote to same path allowed')
    expectOnly('promote refused', s1b, snap(), [])

    // move a2 → C (no memory folder → created)
    const s2 = snap()
    const aN2 = lines(mem(SA, 'MEMORY.md')).length
    const a2Bytes = read(mem(SA, 'a2.md'))
    moveClaudeMemory(F, SA, 'a2.md', SC)
    if (read(mem(SC, 'a2.md')) !== a2Bytes || existsSync(mem(SA, 'a2.md'))) bad.push('move file')
    if (JSON.stringify(lines(mem(SC, 'MEMORY.md'))) !== JSON.stringify(['- [\uC5D0\uC774\uD22C](a2.md) — \uB458'])) bad.push('move target index')
    if (lines(mem(SA, 'MEMORY.md')).length !== aN2 - 1 || count(mem(SA, 'MEMORY.md'), '](a2.md)')) bad.push('move source index -1')
    expectOnly('move', s2, snap(), [mem(SA, 'a2.md'), mem(SA, 'MEMORY.md'), mem(SC, 'a2.md'), mem(SC, 'MEMORY.md')])
    // move a4 (not in index) → B: source index unchanged, frontmatter line in target
    const s2b = snap()
    const r2b = moveClaudeMemory(F, SA, 'a4.md', SB)
    if (r2b.removedLines !== 0 || count(mem(SB, 'MEMORY.md'), '- [a4](a4.md) — a4 \uC124\uBA85') !== 1) bad.push('move frontmatter line')
    expectOnly('move a4', s2b, snap(), [mem(SA, 'a4.md'), mem(SB, 'a4.md'), mem(SB, 'MEMORY.md')])

    // trash a3 (a recreated a1 remains in A, so the index stays)
    const s3 = snap()
    const aN3 = lines(mem(SA, 'MEMORY.md')).length
    const r3 = trashClaudeMemory(F, SA, 'a3.md')
    if (existsSync(mem(SA, 'a3.md')) || !existsSync(r3.path)) bad.push('trash move')
    if (lines(mem(SA, 'MEMORY.md')).length !== aN3 - 1 || r3.indexTrashPath) bad.push('trash index -1')
    expectOnly('trash', s3, snap(), [mem(SA, 'a3.md'), mem(SA, 'MEMORY.md')])
    // trash d1 → slot becomes empty, so the index is trashed too
    const s4 = snap()
    const r4 = trashClaudeMemory(F, SD, 'd1.md')
    if (!r4.indexTrashPath || existsSync(mem(SD, 'MEMORY.md')) || !existsSync(r4.indexTrashPath)) bad.push('empty-slot index trash')
    expectOnly('trash empty slot', s4, snap(), [mem(SD, 'd1.md'), mem(SD, 'MEMORY.md')])

    // Codex scan (read)
    mkdirSync(join(F, '.codex/memories/rollout_summaries'), { recursive: true })
    writeFileSync(join(F, '.codex/memories/MEMORY.md'), 'a\nb\n')
    writeFileSync(join(F, '.codex/memories/rollout_summaries/r.md'), 'x\n')
    const cx = scanCodexMemory(F)
    const cm = cx.find((e) => e.name === 'MEMORY.md')
    const cr = cx.find((e) => e.name === 'rollout_summaries')
    if (cm?.lines !== 2 || cm.kind !== 'file' || cr?.kind !== 'dir' || cr.files !== 1) bad.push('codex scan')
    // fixed order and non-memory excluded, rollouts newest first, continued reads, paths refused
    const CXR = join(F, '.codex/memories')
    writeFileSync(join(CXR, 'memory_summary.md'), 's\n')
    mkdirSync(join(CXR, 'skills'), { recursive: true })
    writeFileSync(join(CXR, 'skills/x.md'), 'x\n')
    writeFileSync(join(CXR, 'rollout_summaries/.hidden.md'), 'h\n')
    writeFileSync(join(CXR, 'rollout_summaries/old.md'), 'o\n')
    utimesSync(join(CXR, 'rollout_summaries/old.md'), 1000, 1000)
    const order = scanCodexMemory(F).map((e) => e.name).join(',')
    if (order !== 'memory_summary.md,MEMORY.md,rollout_summaries') bad.push(`codex order ${order}`)
    const ro = listCodexRolloutSummaries(F).map((e) => e.name).join(',')
    if (ro !== 'r.md,old.md') bad.push(`rollout list ${ro}`)
    const big = Array.from({ length: 3000 }, (_, i) => `- \uC904 ${i} \uD55C\uAE00 ✓ ${'x'.repeat(i % 50)}`).join('\n') + '\n'
    writeFileSync(join(CXR, 'raw_memories.md'), big)
    let acc = ''
    let off: number | undefined = 0
    let chunks = 0
    while (off !== undefined && chunks < 50) {
      const c = readCodexMemoryFile(F, 'raw_memories.md', off, 16 * 1024)
      if (c.truncated !== (c.nextOffset !== undefined) || (c.truncated && !c.text.endsWith('\n'))) bad.push('continued read boundary')
      acc += c.text
      off = c.nextOffset
      chunks++
    }
    if (acc !== big || chunks < 4) bad.push(`continued read concatenation mismatch (${chunks})`)
    if (readCodexMemoryFile(F, 'rollout_summaries/r.md').text !== 'x\n') bad.push('rollout read')
    symlinkSync(join(outside, 'memory', 'x.md'), join(CXR, 'link.md'))
    const cxRejects: [string, string][] = [
      ['../x.md', 'invalidName'],
      ['/etc/hosts.md', 'invalidName'],
      ['rollout_summaries/../../x.md', 'invalidName'],
      ['.hidden.md', 'invalidName'],
      ['rollout_summaries/.hidden.md', 'invalidName'],
      ['a/b/c.md', 'invalidName'],
      ['skills', 'invalidName'],
      ['link.md', 'notFound'],
      ['none.md', 'notFound']
    ]
    for (const [r, want] of cxRejects) {
      const got = errCode(() => readCodexMemoryFile(F, r))
      if (got !== want) bad.push(`codex refused ${r}: ${got}`)
    }

    // cleanup (inside fixture only)
    rmSync(join(P, '-fixture-link'))
    for (const s of [SA, SB, SC, SD]) rmSync(join(P, s), { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    rmSync(join(F, '.codex/memories'), { recursive: true, force: true })
    if (realStat() !== real0) bad.push('real ~/.claude/projects changed')
    check(
      't. tool memory cleanup — promote, move, trash one index line each, no byte changes outside targets, paths and names refused',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `scan (temp, missing, broken, title) OK, ${rejects.length} refusals with bytes unchanged, promote (shared +1 / source -1 / trash), 2 moves, 2 trashes (incl. empty-slot index) with exact changed paths, codex scan, order, continued read, ${cxRejects.length} refusals`
    )
  }

  // ---- u. agents — library source → rendered to 3 tools, re-sync 0, user files unchanged, tool off → delete candidate approval, rename, refusals
  {
    const bad: string[] = []
    const A = 'zz-agent'
    const A2 = 'zz-agent2'
    const U = 'zz-user'
    const lib = (n: string): string => join(libraryPaths(F).agentsDir, `${n}.md`)
    const desc = 'Reviews "code" diffs: strict # not comment'
    const body = 'Review the diff.\n\nBe strict.\n'
    const tools = {
      claude: { model: 'opus', effort: 'high' },
      codex: { model: 'gpt-6-astra', effort: 'xhigh' },
      opencode: { model: 'openai/gpt-5.5' }
    }
    const agentSum = (r: ReturnType<typeof syncAll>): Record<string, number> =>
      Object.fromEntries(Object.entries(summarizeSync(r)).filter(([k]) => k.startsWith('agent.')))
    if (existsSync(libraryPaths(F).agentsDir)) bad.push('agents/ exists beforehand')
    createAgent(F, A, 'tmp')
    writeAgentDoc(F, A, { description: desc, body, tools })
    const d0 = readAgentDoc(F, A)
    if (d0.description !== desc || d0.body !== body || JSON.stringify(d0.tools) !== JSON.stringify(tools))
      bad.push('source round trip')
    // saving the same values → bytes unchanged
    const libText = read(lib(A))
    writeAgentDoc(F, A, { description: desc, body, tools })
    if (read(lib(A)) !== libText) bad.push('saving same values changed the file')

    const s1 = syncAll(F, env, { allowReal: true })
    const done1 = (s1.results?.agents ?? []).filter((x) => x.status === 'done').length
    if (done1 !== 3) bad.push(`first sync agents done ${done1}/3`)
    const pc = agentToolPath(F, 'claude', A)
    const px = agentToolPath(F, 'codex', A)
    const po = agentToolPath(F, 'opencode', A)
    if (![pc, px, po].every((p) => existsSync(p))) bad.push('files missing in 3 tools')
    else {
      const c = matter(read(pc))
      if (
        c.data.name !== A || c.data.description !== desc || c.data.model !== 'opus' ||
        c.data.effort !== 'high' || c.content.trim() !== body.trim()
      )
        bad.push('Claude render values')
      const x = parseToml(read(px)) as Json
      if (
        x.name !== A || x.description !== desc || x.model !== 'gpt-6-astra' ||
        x.model_reasoning_effort !== 'xhigh' || x.developer_instructions !== body.trim()
      )
        bad.push('Codex TOML values')
      const o = matter(read(po))
      if (
        o.data.description !== desc || o.data.mode !== 'subagent' || o.data.model !== 'openai/gpt-5.5' ||
        'reasoningEffort' in o.data || 'name' in o.data || o.content.trim() !== body.trim()
      )
        bad.push('OpenCode render values')
      if (mode(pc) !== 0o644) bad.push('Claude file mode')
    }
    const st1 = readState(F).state.agents
    if (!(['claude', 'codex', 'opencode'] as const).every((t) => st1?.[t]?.[A])) bad.push('state.agents record')
    // second sync writes 0, status synced
    const s2 = syncAll(F, env, { allowReal: true })
    const w2 = Object.entries(summarizeSync(s2)).filter(([k]) => k.includes('written') || k.endsWith('.done'))
    if (w2.length) bad.push(`re-sync changes ${w2.map(([k, v]) => `${k}=${v}`).join(',')}`)
    for (const t of ['claude', 'codex', 'opencode'])
      if (cell(F, env, 'agents', t) !== 'synced') bad.push(`status agents/${t}=${cell(F, env, 'agents', t)}`)

    // tool-side edit → restored from source, backup outside the agents folder
    writeFileSync(pc, read(pc) + '\nlocal edit\n')
    const s3 = syncAll(F, env, { allowReal: true })
    const up = s3.results?.agents.find((x) => x.tool === 'claude' && x.name === A)
    if (up?.status !== 'done' || up.reason !== 'restored') bad.push(`drift restore ${up?.status}:${up?.reason}`)
    const bak = agentBackupPath(F, 'claude', `${A}.md`)
    if (!existsSync(bak) || !read(bak).includes('local edit')) bad.push('drift backup')
    if (readdirSync(join(F, '.claude/agents')).some((n) => n !== `${A}.md`)) bad.push('backup/tmp left in agents folder')

    // same-name user file without a record → userOwned skip for claude only, bytes unchanged
    const userText = '---\nname: zz-user\ndescription: mine\n---\n\nuser owned\n'
    writeFileSync(agentToolPath(F, 'claude', U), userText)
    createAgent(F, U, 'library version')
    const s4 = syncAll(F, env, { allowReal: true })
    const u4 = (s4.results?.agents ?? []).filter((x) => x.name === U)
    const uc = s4.plan.agents.find((x) => x.name === U && x.tool === 'claude')
    if (uc?.action !== 'skip' || uc.reason !== 'userOwned') bad.push(`user file ${uc?.action}:${uc?.reason}`)
    if (u4.filter((x) => x.status === 'done').length !== 2) bad.push('other tools copied next to user file')
    if (read(agentToolPath(F, 'claude', U)) !== userText) bad.push('user file bytes changed')
    if (readState(F).state.agents?.claude?.[U]) bad.push('user file recorded in state')

    // codex off → only codex is a deletion target → sync backs up and moves right away → state removed (incl. a drift copy edited on the tool side)
    writeFileSync(px, read(px) + '# local edit\n')
    const pxBytes = read(px)
    setToggle(F, 'agents', A, 'codex', false)
    const s5 = syncAll(F, env, { allowReal: true })
    const cands = s5.plan.agents.filter((x) => x.action === 'deleteCandidate')
    if (cands.length !== 1 || cands[0].tool !== 'codex' || cands[0].name !== A || cands[0].reason !== 'disabled')
      bad.push(`off candidates ${cands.map((x) => `${x.tool}/${x.name}:${x.reason}`).join(',')}`)
    const d5 = s5.results?.agents.find((x) => x.action === 'deleteCandidate')
    if (d5?.status !== 'done' || existsSync(px)) bad.push(`off delete ${d5?.status}:${d5?.reason}`)
    const xbk = deletedBackup(F, `agents/codex/${A}.toml`)
    if (!xbk || read(xbk) !== pxBytes) bad.push('drift copy backup bytes')
    if (readState(F).state.agents?.codex?.[A]) bad.push('state left after delete')
    if (!existsSync(pc) || !existsSync(po)) bad.push('other tool files deleted')
    // manual delete requests (IPC) have no candidates, so all are refused — including path tricks and user files
    const rj = deleteCandidates(F, env, [
      { kind: 'agent', tool: 'codex', name: A, path: join(F, '.codex/agents/../AGENTS.md') },
      { kind: 'agent', tool: 'claude', name: A, path: pc, currentHash: 'x' },
      { kind: 'agent', tool: 'claude', name: U, path: agentToolPath(F, 'claude', U) }
    ])
    if (rj.some((x) => x.status !== 'refused')) bad.push(`manual delete refusal ${rj.map((x) => `${x.status}:${x.reason}`).join(',')}`)
    if (read(agentToolPath(F, 'claude', U)) !== userText || !existsSync(pc)) bad.push('refused request changed files')
    const s6 = syncAll(F, env, { allowReal: true })
    if (Object.keys(agentSum(s6)).some((k) => k.endsWith('.done') || k.endsWith('.pendingApproval')))
      bad.push(`sync after delete ${JSON.stringify(agentSum(s6))}`)

    // rename: file, name, manifest moved; old-name app files become delete candidates
    renameAgent(F, A, A2)
    if (existsSync(lib(A)) || readAgentDoc(F, A2).description !== desc) bad.push('rename file')
    if (!read(lib(A2)).includes(`name: ${A2}`)) bad.push('rename frontmatter name')
    const mf = readJson(join(libraryRoot(F), MANIFEST_FILE)) as { agents?: Json }
    if (JSON.stringify(mf.agents?.[A2]) !== '{"codex":false}' || mf.agents?.[A]) bad.push('rename manifest')
    const s7 = syncAll(F, env, { allowReal: true })
    const new7 = (s7.results?.agents ?? []).filter((x) => x.name === A2 && x.status === 'done').map((x) => x.tool).sort()
    const old7 = (s7.results?.agents ?? []).filter((x) => x.name === A && x.action === 'deleteCandidate').map((x) => `${x.tool}:${x.status}`).sort()
    if (new7.join(',') !== 'claude,opencode') bad.push(`new name copy ${new7}`)
    if (old7.join(',') !== 'claude:done,opencode:done') bad.push(`old name delete ${old7}`)
    if (existsSync(pc) || existsSync(po)) bad.push('old name files left')

    // invalid names, path escapes, format refused
    const rejects = [
      errCode(() => createAgent(F, '../x', 'd')),
      errCode(() => createAgent(F, 'Bad Name', 'd')),
      errCode(() => readAgentDoc(F, '../../etc/passwd')),
      errCode(() => createAgent(F, A2, 'd')),
      errCode(() => createAgent(F, 'zz-empty', ' ')),
      errCode(() => renameAgent(F, A2, U)),
      errCode(() => renameAgent(F, A2, '../../x')),
      errCode(() => writeAgentDoc(F, A2, { description: desc, body, tools: { claude: { model: 'a\nb' } } })),
      errCode(() => writeAgentDoc(F, A2, { description: desc, body, tools: { foo: {} } as never }))
    ]
    const want = 'invalidName,invalidName,invalidName,exists,invalidSchema,exists,invalidName,invalidSchema,invalidSchema'
    if (rejects.join(',') !== want) bad.push(`refused ${rejects.join(',')}`)

    // cleanup: delete from library → approve candidate deletion → remove user file
    deleteAgent(F, A2)
    deleteAgent(F, U)
    const s8 = syncAll(F, env, { allowReal: true })
    const d8 = (s8.results?.agents ?? []).filter((x) => x.action === 'deleteCandidate')
    if (!d8.length || d8.some((x) => x.status !== 'done')) bad.push('cleanup delete failed')
    if (read(agentToolPath(F, 'claude', U)) !== userText) bad.push('user file changed during cleanup')
    unlinkSync(agentToolPath(F, 'claude', U))
    const st9 = readState(F).state.agents ?? {}
    if (Object.values(st9).some((m) => m && Object.keys(m).length)) bad.push('state left after cleanup')
    if (setToggle(F, 'agents', A2, 'codex', true).agents[A2]) bad.push('cleanup toggle')
    check(
      'u. agents — rendered to 3 tools (incl. Codex TOML) with matching values, re-sync 0, drift restored with backup outside folder, user files unchanged, tool off → that tool only backed up and moved immediately, rename, refusals',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `3-tool copy, values match, re-sync 0, status synced, drift restored (backup outside), userOwned skip with bytes unchanged, codex off (drift) → backed up and moved immediately (bytes kept), state removed, 3 manual requests refused, rename: new copied to 2 tools and old deleted immediately in 2 tools, ${rejects.length} refusals, cleanup ${d8.length}`
    )
  }

  // ---- v. agent import — scan/convert 3 tools, exclude app-owned, primary and built-in toolOnly, tool-specific key warnings, apply, adopt, rescan 0
  {
    const bad: string[] = []
    const agentsOf = (id: string): ReturnType<typeof planImport>['agents'] => planImport(F, id).agents
    const lib2 = (n: string): string => join(libraryPaths(F).agentsDir, `${n}.md`)
    const summary = (id: string): string =>
      agentsOf(id)
        .map((c) => `${c.name}:${c.portability}`)
        .join(',')
    // prepare app-owned copies (pending deletion): create in the library, sync, then delete from the library
    createAgent(F, 'zz-owned', 'owned')
    syncAll(F, env, { allowReal: true })
    deleteAgent(F, 'zz-owned')
    // Claude: one with tool-specific keys + one identical to the render result
    const cDir = join(F, '.claude/agents')
    const impText =
      '---\nname: zz-imp\ndescription: Imported agent\nmodel: sonnet\neffort: high\ntools: Read, Grep\npermissionMode: plan\n---\n\nCheck things.\n'
    const sameText = '---\nname: zz-same\ndescription: Same\nmodel: opus\n---\n\nDo same.\n'
    writeFileSync(join(cDir, 'zz-imp.md'), impText)
    writeFileSync(join(cDir, 'zz-same.md'), sameText)
    writeFileSync(join(cDir, 'Bad Name.md'), '---\ndescription: x\n---\n\nx\n')
    // Codex: model outside the catalog + other keys
    writeFileSync(
      join(F, '.codex/agents/zz-cx.toml'),
      'name = "zz-cx"\ndescription = "Codex agent"\nmodel = "gpt-unknown-9"\nmodel_reasoning_effort = "max"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nDo codex.\n"""\n'
    )
    // OpenCode: agents/ subagent, agent/ primary, opencode.json inline (regular and built-in)
    mkdirSync(join(F, '.config/opencode/agent'), { recursive: true })
    writeFileSync(
      join(F, '.config/opencode/agents/zz-oc.md'),
      '---\ndescription: OC agent\nmode: subagent\nmodel: openai/gpt-5.5\nreasoningEffort: high\ntemperature: 0.1\n---\n\nDo oc.\n'
    )
    writeFileSync(join(F, '.config/opencode/agent/zz-prim.md'), '---\ndescription: Primary\nmode: primary\n---\n\nMain.\n')
    const singText = '---\ndescription: Singular dir\nmode: subagent\n---\n\nSing.\n'
    writeFileSync(join(F, '.config/opencode/agent/zz-sing.md'), singText)
    const cxText = read(join(F, '.codex/agents/zz-cx.toml'))
    const ocAgentText = read(join(F, '.config/opencode/agents/zz-oc.md'))
    /** most recent of backups/imported/<ts>/<rel> */
    const importedBackup = (rel: string): string | null => {
      const root = importedBackupRoot(F)
      if (!existsSync(root)) return null
      return (
        readdirSync(root)
          .sort()
          .reverse()
          .map((ts) => join(root, ts, rel))
          .find((x) => existsSync(x)) ?? null
      )
    }
    const ocPath = join(F, '.config/opencode/opencode.json')
    const ocOrig = read(ocPath)
    const oc = readJson(ocPath)
    oc.agent = {
      'zz-inline': { description: 'Inline', model: 'openai/gpt-5.5', prompt: 'Inline prompt' },
      build: { model: 'openai/gpt-5.5' }
    }
    writeJson(ocPath, oc)
    const ocWithAgents = read(ocPath)

    const pc = agentsOf('tool:claude')
    if (summary('tool:claude') !== 'Bad Name:ok,zz-imp:warn,zz-same:ok') bad.push(`claude candidates ${summary('tool:claude')}`)
    if (!pc.find((c) => c.name === 'Bad Name')?.conflicts.includes('invalidName')) bad.push('invalid name invalidName')
    const imp = pc.find((c) => c.name === 'zz-imp')?.variants[0]
    if (
      !imp ||
      imp.model !== 'sonnet' ||
      imp.effort !== 'high' ||
      imp.description !== 'Imported agent' ||
      JSON.stringify(imp.warnings) !== '["permissionMode","tools"]' ||
      JSON.stringify(imp.reasons) !== '["toolSpecificKeys"]'
    )
      bad.push('claude converted values/warnings')
    else {
      const d = parseAgentText('zz-imp', imp.text)
      if (JSON.stringify(d.tools) !== '{"claude":{"model":"sonnet","effort":"high"}}' || d.body !== 'Check things.\n')
        bad.push('claude library format')
    }
    if (pc.some((c) => c.name === 'zz-owned') || agentsOf('tool:codex').some((c) => c.name === 'zz-owned') || agentsOf('tool:opencode').some((c) => c.name === 'zz-owned'))
      bad.push('app-owned copy is a candidate')
    const cx = agentsOf('tool:codex').find((c) => c.name === 'zz-cx')?.variants[0]
    if (!cx || cx.model !== 'gpt-unknown-9' || cx.effort !== 'max' || JSON.stringify(cx.warnings) !== '["sandbox_mode"]')
      bad.push('codex converted values/warnings')
    else if (parseAgentText('zz-cx', cx.text).body !== 'Do codex.\n') bad.push('codex developer_instructions → body')
    const po = agentsOf('tool:opencode')
    if (summary('tool:opencode') !== 'build:toolOnly,zz-inline:ok,zz-oc:warn,zz-prim:toolOnly,zz-sing:ok')
      bad.push(`opencode candidates ${summary('tool:opencode')}`)
    if (JSON.stringify(po.find((c) => c.name === 'zz-prim')?.reasons) !== '["primaryAgent"]') bad.push('primary reason')
    if (JSON.stringify(po.find((c) => c.name === 'build')?.reasons) !== '["builtinAgent"]') bad.push('built-in reason')
    const ocv = po.find((c) => c.name === 'zz-oc')?.variants[0]
    if (!ocv || ocv.effort !== 'high' || JSON.stringify(ocv.warnings) !== '["temperature"]') bad.push('opencode converted values/warnings')
    const inl = po.find((c) => c.name === 'zz-inline')?.variants[0]
    if (!inl || parseAgentText('zz-inline', inl.text).body !== 'Inline prompt\n' || inl.model !== 'openai/gpt-5.5')
      bad.push('opencode inline prompt → body')

    // apply: 2 claude (different bytes → back up, move and convert 1; same bytes → adopt 1), invalid name and primary refused
    const r1 = applyImport(F, [
      { kind: 'agent', name: 'zz-imp' },
      { kind: 'agent', name: 'zz-same' },
      { kind: 'agent', name: 'Bad Name' }
    ], 'tool:claude')
    const res = (x: (typeof r1)[number]): string =>
      `${x.name}:${x.status}:${x.reason ?? ''}:${(x.converted ?? []).join('+')}:${(x.adopted ?? []).join('+')}:${(x.userOwned ?? []).join('+')}:${x.inlineRemains ? 'inline' : ''}`
    const r1s = r1.map(res).join(',')
    if (r1s !== 'zz-imp:imported::claude:::,zz-same:imported:::claude::,Bad Name:refused:invalidName::::')
      bad.push(`claude apply ${r1s}`)
    const rp = applyImport(F, [{ kind: 'agent', name: 'zz-prim' }], 'tool:opencode')
    if (rp[0]?.reason !== 'toolOnly') bad.push(`primary apply ${rp[0]?.status}:${rp[0]?.reason}`)
    if (JSON.stringify(listAgents(F)) !== '["zz-imp","zz-same"]') bad.push(`library ${listAgents(F)}`)
    if (read(lib2('zz-imp')) !== imp?.text) bad.push('library file = candidate text')
    const ib = importedBackup('claude/agents/zz-imp.md')
    if (!ib || read(ib) !== impText || existsSync(join(cDir, 'zz-imp.md'))) bad.push('conversion backup source bytes')
    if (read(join(cDir, 'zz-same.md')) !== sameText || !readState(F).state.agents?.claude?.['zz-same'])
      bad.push('adopt (bytes unchanged, state)')
    const sy = syncAll(F, env, { allowReal: true })
    const act = (n: string, t: string): string => sy.plan.agents.find((x) => x.name === n && x.tool === t)?.action ?? '-'
    if (act('zz-same', 'claude') !== 'inSync' || act('zz-imp', 'claude') !== 'copy') bad.push(`sync after apply ${act('zz-same', 'claude')}/${act('zz-imp', 'claude')}`)
    const acts2 = planSyncAll(F, env).agents.filter((x) => x.name === 'zz-imp').map((x) => x.action)
    if (acts2.some((a) => a !== 'inSync')) bad.push(`not inSync after conversion ${acts2}`)
    if (read(join(cDir, 'zz-imp.md')) !== renderAgent('claude', readAgentDoc(F, 'zz-imp'))) bad.push('render result after conversion')
    // codex and opencode apply: agents/ converted, agent/ (singular) backed up and moved, inline leaves opencode.json unchanged + warning
    const r2 = [
      ...applyImport(F, [{ kind: 'agent', name: 'zz-cx' }], 'tool:codex'),
      ...applyImport(F, [{ kind: 'agent', name: 'zz-oc' }, { kind: 'agent', name: 'zz-inline' }, { kind: 'agent', name: 'zz-sing' }], 'tool:opencode')
    ]
    const r2s = r2.map(res).join(',')
    if (r2s !== 'zz-cx:imported::codex:::,zz-oc:imported::opencode:::,zz-inline:imported:::::inline,zz-sing:imported::opencode:::')
      bad.push(`codex/opencode apply ${r2s}`)
    const xb = importedBackup('codex/agents/zz-cx.toml')
    const ob = importedBackup('opencode/agents/zz-oc.md')
    const sb = importedBackup('opencode/agent/zz-sing.md')
    if (!xb || read(xb) !== cxText || !ob || read(ob) !== ocAgentText || !sb || read(sb) !== singText)
      bad.push('codex/opencode backup source bytes')
    if (existsSync(join(F, '.config/opencode/agent/zz-sing.md'))) bad.push('agent/ source left')
    if (read(ocPath) !== ocWithAgents) bad.push('opencode.json bytes changed')
    syncAll(F, env, { allowReal: true })
    const notIn = planSyncAll(F, env).agents.filter((x) => x.action !== 'inSync').map((x) => `${x.tool}/${x.name}:${x.action}`)
    if (notIn.length) bad.push(`sync after conversion ${notIn}`)
    if (!existsSync(agentToolPath(F, 'opencode', 'zz-sing'))) bad.push('import from agent/ not applied to agents/')
    // rescan: imported items have 0 candidates (only invalid names and toolOnly remain)
    const left = ['tool:claude', 'tool:codex', 'tool:opencode'].flatMap((id) => agentsOf(id).map((c) => c.name)).sort()
    if (JSON.stringify(left) !== '["Bad Name","build","zz-prim"]') bad.push(`rescan candidates ${left}`)
    // user file different from the library → existsInLibrary; refused without overwrite, trashed with it
    writeFileSync(join(F, '.config/opencode/agent/zz-imp.md'), '---\ndescription: Imported agent\n---\n\nCheck more.\n')
    const ex = agentsOf('tool:opencode').find((c) => c.name === 'zz-imp')
    if (!ex?.conflicts.includes('existsInLibrary')) bad.push('existsInLibrary')
    const r3 = applyImport(F, [{ kind: 'agent', name: 'zz-imp' }], 'tool:opencode')
    const r4 = applyImport(F, [{ kind: 'agent', name: 'zz-imp', overwrite: true }], 'tool:opencode')
    if (r3[0]?.reason !== 'existsInLibrary' || r4[0]?.status !== 'imported' || !r4[0].trashPath) bad.push('overwrite')
    if (readAgentDoc(F, 'zz-imp').body !== 'Check more.\n') bad.push('overwritten body')

    // cleanup
    for (const n of listAgents(F)) deleteAgent(F, n)
    syncAll(F, env, { allowReal: true })
    for (const p of [
      join(cDir, 'zz-imp.md'),
      join(cDir, 'zz-same.md'),
      join(cDir, 'Bad Name.md'),
      join(F, '.codex/agents/zz-cx.toml'),
      join(F, '.config/opencode/agents/zz-oc.md'),
      join(F, '.config/opencode/agent/zz-prim.md'),
      join(F, '.config/opencode/agent/zz-sing.md'),
      join(F, '.config/opencode/agent/zz-imp.md')
    ])
      if (existsSync(p)) unlinkSync(p)
    writeFileSync(ocPath, ocOrig)
    const st9 = readState(F).state.agents ?? {}
    if (Object.values(st9).some((m) => m && Object.keys(m).length)) bad.push('state left after cleanup')
    const rest = ['.claude/agents', '.codex/agents', '.config/opencode/agents'].flatMap((d) => readdirSync(join(F, d)))
    if (rest.length) bad.push(`tool files after cleanup ${rest}`)
    check(
      'v. agent import — 3-tool scan and converted values, app-owned excluded, primary and built-in toolOnly, tool-specific key warnings, source files backed up and moved then converted (inSync), same bytes adopted, inline unchanged + warning, rescan 0, overwrite',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : 'candidates claude 3, codex 1, opencode 5 (agent/, agents/, inline), app copies pending deletion excluded, warning key names only, model outside catalog kept, 4 tool files converted (source bytes kept in backups/imported, incl. singular agent/) → all inSync after sync, 1 adopted with same bytes, inline opencode.json bytes unchanged + inlineRemains, toolOnly and invalidName refused, remaining rescan candidates = 3 refused, existsInLibrary refused, overwrite trashes'
    )
  }

  // ---- w. workspaces — root-style migration (bytes kept, idempotent, stops on conflict), switch (tool copies replaced, backed up, no old opencode path), zip round trip, malicious zip refused, shared secret protection
  {
    const bad: string[] = []
    const W = makeLegacyFixture('illithid-m7-W-')
    const wsDefault = join(W, '.illithid/workspaces/default')
    const flat = join(W, '.illithid')
    const hashTree = (dir: string, skipTop: string[] = []): Map<string, string> => {
      const m = new Map<string, string>()
      const walk = (abs: string, rel: string): void => {
        for (const e of readdirSync(abs)) {
          const r = rel ? `${rel}/${e}` : e
          if (!rel && skipTop.includes(e)) continue
          const a = join(abs, e)
          const st = lstatSync(a)
          if (st.isSymbolicLink()) m.set(r, 'link:' + readlinkSync(a))
          else if (st.isDirectory()) walk(a, r)
          else m.set(r, sha(readFileSync(a)))
        }
      }
      walk(dir, '')
      return m
    }
    // 1) build with the new layout and sync → revert to the root-style layout (mimics previous app state)
    initLibrary(W)
    if (importAllFromLegacy(W).results.some((x) => x.status !== 'imported')) bad.push('import failed')
    const envW = fakeEnv(W)
    syncAll(W, envW, { allowReal: true })
    const git = (...a: string[]): string =>
      execFileSync('git', ['-C', wsDefault, '-c', 'user.name=fx', '-c', 'user.email=fx@invalid', ...a], { encoding: 'utf8' })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-qm', 'fx')
    const head0 = git('rev-parse', 'HEAD').trim()
    mkdirSync(join(wsDefault, '.trash/x'), { recursive: true })
    writeFileSync(join(wsDefault, '.trash/x/old.md'), 'trashed\n')
    mkdirSync(join(wsDefault, 'artifacts/p'), { recursive: true })
    writeFileSync(join(wsDefault, 'artifacts/p/a.txt'), 'artifact\n')
    unlinkSync(join(wsDefault, 'workspace.json'))
    for (const e of readdirSync(wsDefault)) renameSync(join(wsDefault, e), join(flat, e))
    rmdirSync(wsDefault)
    rmdirSync(join(flat, 'workspaces'))
    const toFlat = (rel: string): void => {
      const p = join(W, rel)
      writeFileSync(p, read(p).split(wsDefault + '/').join(flat + '/'))
    }
    toFlat('.config/opencode/opencode.json')
    toFlat('.config/illithid/state.json')
    const before = hashTree(flat)
    const pm = planMigrateToWorkspaces(W)
    for (const e of ['.git', '.trash', 'artifacts', 'rules', 'mcps', 'memory', '.gitignore'])
      if (!pm.entries.includes(e)) bad.push(`${e} missing from migration targets`)
    if (!pm.needed || pm.conflicts.length || pm.stateRewrites < 1) bad.push(`plan ${JSON.stringify({ n: pm.needed, c: pm.conflicts, s: pm.stateRewrites })}`)
    const en = ensureLibrary(W)
    if (en.status !== 'exists' || !en.migrated?.length) bad.push(`ensureLibrary ${en.status}`)
    const after = hashTree(wsDefault, ['workspace.json'])
    const diff = [...before.keys()].filter((k) => before.get(k) !== after.get(k))
    if (diff.length || after.size !== before.size) bad.push(`bytes not kept ${diff.length}/${after.size}-${before.size}`)
    if (JSON.stringify(readdirSync(flat)) !== JSON.stringify(['workspaces'])) bad.push(`entries left at root ${readdirSync(flat).join(',')}`)
    if (git('rev-parse', 'HEAD').trim() !== head0) bad.push('.git HEAD')
    const rb = join(W, '.config/illithid/rollback')
    const snaps = existsSync(rb) ? readdirSync(rb).filter((f) => f.startsWith('pre-workspaces-') && f.endsWith('.tar')) : []
    if (snaps.length !== 1) bad.push('no snapshot tar')
    const stTxt = read(join(W, '.config/illithid/state.json'))
    if (stTxt.includes(flat + '/rules') || stTxt.includes(flat + '/skills')) bad.push('root-style paths in state')
    const again = migrateToWorkspaces(W)
    if (!again.ok || again.moved.length || again.plan.needed) bad.push('re-run not idempotent')
    const rs = syncAll(W, envW, { allowReal: true })
    if (!rs.results) bad.push('sync did not run after migration')
    const ocAfterMig = read(join(W, '.config/opencode/opencode.json'))
    if (ocAfterMig.includes(flat + '/rules') || ocAfterMig.includes(flat + '/skills"') || !ocAfterMig.includes(wsDefault + '/rules/'))
      bad.push('opencode.json paths after migration')
    if (changedOrError(planAll(W, envW)).length) bad.push('re-plan changes after migration')
    // stop on conflict
    const WC = makeFixture('illithid-m7-WC-')
    unlinkSync(join(WC, '.agents'))
    mkdirSync(join(WC, '.illithid/rules'), { recursive: true })
    writeFileSync(join(WC, '.illithid/rules/a.md'), 'a\n')
    mkdirSync(join(WC, '.illithid/workspaces/default/rules'), { recursive: true })
    const cr = migrateToWorkspaces(WC)
    if (cr.ok || cr.moved.length || !existsSync(join(WC, '.illithid/rules/a.md'))) bad.push('proceeded despite conflict')
    if (ensureLibrary(WC).status !== 'migrateFailed') bad.push('conflict ensureLibrary')
    const migDetail = `migrated ${pm.entries.length} entries (incl. .git, .trash, artifacts), ${after.size} files byte-identical, HEAD identical, state ${pm.stateRewrites}, tar 1, idempotent, stops on conflict`

    // 2) switch — rules and memory in a new (empty) workspace → switch sync
    const claudeRules = join(W, '.claude/rules', CLAUDE_RULES_DIR)
    const defaultRules = readdirSync(join(wsDefault, 'rules')).filter((f) => f.endsWith('.md'))
    const userSkill = join(W, '.claude/skills/zz-user-own')
    mkdirSync(userSkill, { recursive: true })
    writeFileSync(join(userSkill, 'SKILL.md'), '---\nname: zz-user-own\ndescription: user\n---\n')
    const opP = join(W, '.config/opencode/opencode.json')
    const oc0 = readJson(opP)
    oc0.instructions = [...((oc0.instructions as string[]) ?? []), '/fixture/user-own.md']
    writeJson(opP, oc0)
    syncAll(W, envW, { allowReal: true })
    const userBefore = sha(read(join(userSkill, 'SKILL.md')))
    const ws2 = createWorkspace(W, '\uD68C\uC0AC', { from: 'empty' })
    if (ws2.id !== 'workspace' || listWorkspaces(W).length !== 2) bad.push(`created id ${ws2.id}`)
    if (errCode(() => createWorkspace(W, '\uD68C\uC0AC')) === 'ok') bad.push('same-name create allowed')
    switchWorkspace(W, ws2.id)
    const ws2Root = libraryRoot(W)
    createRule(W, 'zz-company.md', '# company\n')
    writeFileSync(join(ws2Root, 'memory/MEMORY.md'), '# mem\n- [a](feedback/a.md)\n- [w](https://x.invalid/a.md)\n')
    const sw = syncAll(W, {}, { allowReal: true })
    if (!sw.results) bad.push('switch sync did not run')
    const now = readdirSync(claudeRules)
    if (!now.includes('zz-company.md') || !now.includes('MEMORY.md')) bad.push('new workspace rules/memory missing')
    if (defaultRules.some((n) => now.includes(n))) bad.push('previous workspace rules left')
    if (!defaultRules.every((n) => deletedBackup(W, `rules/${n}`))) bad.push('no backup of previous rules')
    const memCopy = read(join(claudeRules, 'MEMORY.md'))
    if (!memCopy.includes(`](${join(ws2Root, 'memory/feedback/a.md')})`) || !memCopy.includes('](https://x.invalid/a.md)'))
      bad.push('memory link conversion')
    const oc1 = read(opP)
    if (oc1.includes(wsDefault + '/') || !oc1.includes('/fixture/user-own.md') || !oc1.includes(ws2Root + '/rules/zz-company.md'))
      bad.push('opencode.json switch paths')
    if (sha(read(join(userSkill, 'SKILL.md'))) !== userBefore) bad.push('user skill changed')
    // memory delete → copy deletion applied immediately
    unlinkSync(join(ws2Root, 'memory/MEMORY.md'))
    syncAll(W, {}, { allowReal: true })
    if (existsSync(join(claudeRules, 'MEMORY.md')) || !deletedBackup(W, 'rules/MEMORY.md')) bad.push('copy left without memory')
    switchWorkspace(W, 'default')
    syncAll(W, envW, { allowReal: true })
    const back = readdirSync(claudeRules)
    if (!defaultRules.every((n) => back.includes(n)) || back.includes('zz-company.md')) bad.push('rules after switching back')
    if (read(opP).includes(ws2Root + '/')) bad.push('switch path in opencode after switching back')
    if (changedOrError(planAll(W, envW)).length) bad.push('re-plan changes after switching back')

    // 3) zip round trip
    const mem = memorySecretBackend()
    const PLAIN = 'fxsecWsZip-Qa1Ws2Ed3Rf4Tg5Yh6'
    upsertMcpServer(W, 'zz-wsec', { transport: 'stdio', command: 'x', env: { TOKEN: PLAIN } }, { secrets: mem })
    const ex = exportWorkspace(W, { appVersion: '0.0.0-fx' })
    const unz = unzipSync(ex.data)
    const names = Object.keys(unz)
    if (names.some((n) => /^(\.git|\.trash|artifacts)\//.test(n) || n.endsWith('.DS_Store'))) bad.push('excluded entries in zip')
    if (Buffer.from(ex.data).includes(PLAIN) || Object.values(unz).some((b) => Buffer.from(b).includes(PLAIN))) bad.push('plaintext secret in zip')
    const meta = JSON.parse(Buffer.from(unz['workspace.json']).toString()) as Json
    if (meta.name !== 'default' || meta.appVersion !== '0.0.0-fx' || typeof meta.exportedAt !== 'string') bad.push('workspace.json metadata')
    const imp = importWorkspace(W, ex.data, { secrets: memorySecretBackend() })
    if (imp.name !== 'default-2' || listWorkspaces(W).find((x) => x.active)?.id !== 'default') bad.push(`import name / switch ${imp.name}`)
    if (!imp.missingSecrets.includes('zz-wsec/env/TOKEN')) bad.push('missing secrets list')
    const src = hashTree(wsDefault, ['.git', '.trash', 'artifacts', 'workspace.json'])
    const dst = hashTree(workspaceRoot(W, imp.id), ['workspace.json'])
    const zdiff = [...src.keys()].filter((k) => src.get(k) !== dst.get(k))
    if (zdiff.length || src.size !== dst.size) bad.push(`round trip content diff ${zdiff.slice(0, 3).join(',')} ${src.size}/${dst.size}`)
    if (existsSync(join(workspaceRoot(W, imp.id), '.git'))) bad.push('.git in imported workspace')

    // 4) 5 malicious zips
    const count0 = listWorkspaces(W).length
    const evil: [string, Uint8Array][] = [
      ['parent path', zipSync({ 'rules/a.md': new Uint8Array(1), '../evil.md': new Uint8Array(1) })],
      ['absolute path', zipSync({ '/abs/evil.md': new Uint8Array(1) })],
      ['symlink', zipSync({ 'rules/link.md': [new TextEncoder().encode('/etc/passwd'), { os: 3, attrs: 0o120777 * 65536 }] })],
      ['disallowed top level', zipSync({ 'evil/x.md': new Uint8Array(1) })],
      ['too large', zipSync({ 'rules/big.md': new Uint8Array(51 * 1024 * 1024) }, { level: 1 })]
    ]
    const rej: string[] = []
    for (const [label, z] of evil) {
      const code = (() => {
        try {
          importWorkspace(W, z)
          return 'ok'
        } catch (e) {
          return (e as { code?: string }).code ?? 'other'
        }
      })()
      if (code === 'ok' || code === 'other') bad.push(`malicious zip passed: ${label}`)
      else rej.push(`${label}:${code}`)
    }
    if (listWorkspaces(W).length !== count0) bad.push('malicious zip created a workspace')
    if (readdirSync(join(W, '.illithid/workspaces')).some((n) => n.startsWith('.'))) bad.push('temp folder left')
    if (existsSync(join(W, 'evil.md')) || existsSync(join(W, '.illithid/evil.md'))) bad.push('file created at parent path')

    // 5) shared secret protection
    upsertMcpServer(W, 'zz-share', { transport: 'stdio', command: 'x', env: { K: 'fxsecShare-Zx9Cv8Bn7' } }, { secrets: mem })
    const cl = createWorkspace(W, 'fx-clone', { from: 'current' })
    if (existsSync(join(workspaceRoot(W, cl.id), '.git')) || existsSync(join(workspaceRoot(W, cl.id), '.trash'))) bad.push('.git/.trash in clone')
    deleteMcpServer(W, 'zz-share', { secrets: mem })
    if (mem.get('zz-share/env/K') === null) bad.push('secret used by another workspace deleted')
    switchWorkspace(W, cl.id)
    deleteMcpServer(W, 'zz-share', { secrets: mem })
    if (mem.get('zz-share/env/K') !== null) bad.push('secret left after last reference deleted')
    switchWorkspace(W, 'default')

    // 6) rename and delete
    const wsCode = (fn: () => unknown): string => {
      try {
        fn()
        return 'ok'
      } catch (e) {
        return (e as { code?: string }).code ?? 'other'
      }
    }
    if (wsCode(() => renameWorkspace(W, ws2.id, 'default')) !== 'nameExists') bad.push('duplicate-name rename allowed')
    if (wsCode(() => renameWorkspace(W, ws2.id, '  ')) !== 'invalidName') bad.push('empty-name rename allowed')
    const rn = renameWorkspace(W, ws2.id, '\uD68C\uC0AC2')
    if (rn.id !== ws2.id || !existsSync(workspaceRoot(W, ws2.id)) || listWorkspaces(W).find((x) => x.id === ws2.id)?.name !== '\uD68C\uC0AC2')
      bad.push('rename')
    if (renameWorkspace(W, ws2.id, '\uD68C\uC0AC2').name !== '\uD68C\uC0AC2') bad.push('same-name re-save')
    const secretsBefore = ['zz-wsec/env/TOKEN'].map((a) => mem.get(a))
    if (wsCode(() => deleteWorkspace(W, 'default')) !== 'defaultWorkspace') bad.push('default delete allowed')
    switchWorkspace(W, ws2.id)
    if (wsCode(() => deleteWorkspace(W, ws2.id)) !== 'activeWorkspace') bad.push('active delete allowed')
    switchWorkspace(W, 'default')
    const delTree = hashTree(workspaceRoot(W, ws2.id))
    const dr = deleteWorkspace(W, ws2.id)
    if (existsSync(workspaceRoot(W, ws2.id)) || listWorkspaces(W).some((x) => x.id === ws2.id)) bad.push('still listed after delete')
    if (!dr.backupPath.startsWith(join(W, '.config/illithid/backups/workspaces') + '/')) bad.push('backup location')
    const bt = hashTree(dr.backupPath)
    if (bt.size !== delTree.size || [...delTree].some(([k, v]) => bt.get(k) !== v)) bad.push('deletion backup byte diff')
    if (JSON.stringify(['zz-wsec/env/TOKEN'].map((a) => mem.get(a))) !== JSON.stringify(secretsBefore)) bad.push('delete touched the keychain')
    const WL = makeFixture('illithid-m7-WL-')
    unlinkSync(join(WL, '.agents'))
    mkdirSync(join(WL, '.illithid/workspaces/solo/rules'), { recursive: true })
    if (wsCode(() => deleteWorkspace(WL, 'solo')) !== 'lastWorkspace' || !existsSync(join(WL, '.illithid/workspaces/solo/rules')))
      bad.push('deleting the last one allowed')
    if (wsCode(() => deleteWorkspace(W, 'nope')) !== 'notFound') bad.push('missing workspace delete')

    check(
      'w. workspaces — migration, switch, zip round trip, malicious zip, shared secrets, rename, delete',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `${migDetail} / switch: rules and memory replaced, ${defaultRules.length} previous rules in backups/deleted, old opencode paths 0, user entries kept, memory delete applied, switch-back re-plan 0 / zip ${ex.files} files round trip identical, excluded entries and plaintext 0, missing secrets ${imp.missingSecrets.length} / malicious refused ${rej.join(' ')} / shared secret protection / rename (duplicate and empty refused, id kept), delete (active, last, missing refused, backup ${bt.size} files byte-identical, keychain unchanged)`
    )
  }

  // ---- x. rule rename — file and manifest moved, sync copies new name, old name to backups/deleted, opencode path replaced, Codex block, refusals
  {
    const bad: string[] = []
    const A = 'zz-rule-a.md'
    const B = 'zz-rule-b.md'
    const rules = libraryPaths(F).rulesDir
    const cdir = claudeRulesPaths(F).dir
    const ocOf = (): string[] => (readJson(join(F, '.config/opencode/opencode.json')).instructions as string[]) ?? []
    const codexBody = (): string => blockBody(read(join(F, '.codex/AGENTS.md')), MD_BEGIN, MD_END) ?? ''
    createRule(F, A, '# zz rule\n\nbody\n')
    syncAll(F, env, { allowReal: true })
    if (!existsSync(join(cdir, A)) || !ocOf().includes(join(rules, A)) || !codexBody().includes(`<!-- rules/${A} -->`))
      bad.push('not in 3 tools before rename')
    setToggle(F, 'rules', A, 'codex', false)
    const aBytes = read(join(cdir, A))
    const stBefore = JSON.stringify(readState(F).state.rules)
    // refused: same name, existing name, format, path escape, MEMORY.md, missing rule
    createRule(F, 'zz-rule-other.md', '# other\n')
    const rej: [string, () => unknown, string][] = [
      ['same name', () => renameRule(F, A, A), 'invalidName'],
      ['same name without .md', () => renameRule(F, A, 'zz-rule-a'), 'invalidName'],
      ['existing name', () => renameRule(F, A, 'zz-rule-other'), 'exists'],
      ['format', () => renameRule(F, A, 'Bad Name'), 'invalidName'],
      ['path escape', () => renameRule(F, A, '../../x.md'), 'invalidName'],
      ['subpath', () => renameRule(F, A, 'a/b.md'), 'invalidName'],
      ['MEMORY.md', () => renameRule(F, A, 'MEMORY.md'), 'invalidName'],
      ['memory.md', () => renameRule(F, A, 'memory'), 'invalidName'],
      ['missing rule', () => renameRule(F, 'zz-none.md', B), 'notFound'],
      ['from escape', () => renameRule(F, '../illithid.json', B), 'invalidName']
    ]
    for (const [label, fn, code] of rej) if (errCode(fn) !== code) bad.push(`refused ${label}: ${errCode(fn)}`)
    if (!existsSync(join(rules, A)) || existsSync(join(rules, B))) bad.push('files changed after refusal')
    deleteRule(F, 'zz-rule-other.md')
    // input without .md → appended, manifest {codex:false} moved, state unchanged
    const r = renameRule(F, A, 'zz-rule-b')
    if (r.name !== B) bad.push(`returned name ${r.name}`)
    if (existsSync(join(rules, A)) || read(join(rules, B)) !== '# zz rule\n\nbody\n') bad.push('file move')
    const mf = readJson(join(libraryRoot(F), MANIFEST_FILE)) as { rules: Json }
    if (A in mf.rules || JSON.stringify(mf.rules[B]) !== '{"codex":false}') bad.push('manifest key move')
    if (JSON.stringify(readState(F).state.rules) !== stBefore) bad.push('rename changed state')
    // sync: claude copies new name and moves old name to backups/deleted immediately, opencode path replaced, codex is off so not in block
    const rs = syncAll(F, env, { allowReal: true })
    const item = (n: string): { action?: string; status?: string } => rs.results!.rules.find((x) => x.name === n) ?? {}
    if (item(B).action !== 'copy' || item(B).status !== 'done') bad.push(`new name ${item(B).action}/${item(B).status}`)
    if (item(A).action !== 'deleteCandidate' || item(A).status !== 'done') bad.push(`old name ${item(A).action}/${item(A).status}`)
    if (existsSync(join(cdir, A)) || read(join(cdir, B)) !== read(join(rules, B))) bad.push('claude copy')
    const bk = deletedBackup(F, `rules/${A}`)
    if (!bk || read(bk) !== aBytes) bad.push('old name backup bytes')
    const oc = ocOf()
    if (oc.includes(join(rules, A)) || !oc.includes(join(rules, B))) bad.push('opencode instructions path')
    if (codexBody().includes(`<!-- rules/${A} -->`) || codexBody().includes(`<!-- rules/${B} -->`)) bad.push('codex off block')
    // turning codex on puts the new name in the block, re-plan 0
    setToggle(F, 'rules', B, 'codex', true)
    syncAll(F, env, { allowReal: true })
    if (!codexBody().includes(`<!-- rules/${B} -->`) || codexBody().includes(`<!-- rules/${A} -->`)) bad.push('codex block new name')
    if (changedOrError(planAll(F, env)).length || planRuleSync(F, env).some((x) => x.action !== 'inSync'))
      bad.push('re-plan changes after rename')
    // cleanup
    deleteRule(F, B)
    syncAll(F, env, { allowReal: true })
    if (existsSync(join(cdir, B)) || ocOf().includes(join(rules, B))) bad.push('left after cleanup')
    check(
      'x. rule rename — file and manifest moved, sync copies new name, old name to backups/deleted, opencode path replaced, Codex block, refusals',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `${rej.length} refusals (same, existing, format, escape, MEMORY.md, missing), .md omitted → appended, manifest {codex:false} moved, state unchanged, sync claude copy + old name to backups/deleted immediately (byte-identical), opencode path replaced, codex off excluded → on puts new name in block, re-plan 0`
    )
  }

  // ---- y. pending sync count — library change with allowRealApply=false → pending>0, tools unchanged; one-time approved apply → pending 0; pendingSyncCount writes nothing
  {
    const bad: string[] = []
    const cfg0 = readConfig(F).config
    writeConfig(F, { ...cfg0, allowRealApply: false })
    // (mtime, size, content) of every file and link under F — checks that pendingSyncCount and plan sync write nothing
    const snap = (): string => {
      const out: string[] = []
      const walk = (d: string): void => {
        for (const n of readdirSync(d).sort()) {
          const p = join(d, n)
          const st = lstatSync(p)
          if (st.isSymbolicLink()) out.push(`${p} -> ${readlinkSync(p)}`)
          else if (st.isDirectory()) walk(p)
          else out.push(`${p} ${st.mtimeMs} ${st.size} ${sha(readFileSync(p))}`)
        }
      }
      walk(F)
      return sha(out.join('\n'))
    }
    const base = pendingSyncCount(F, env)
    const R = 'zz-pending.md'
    const cdir = claudeRulesPaths(F).dir
    createRule(F, R, '# zz pending\n')
    const s0 = snap()
    const p1 = pendingSyncCount(F, env)
    const p1b = pendingSyncCount(F, env)
    if (snap() !== s0) bad.push('pendingSyncCount changed files')
    if (!(p1 > base) || p1 !== p1b) bad.push(`pending ${base} → ${p1}/${p1b}`)
    const planOnly = syncAll(F, env, { allowReal: false })
    if (planOnly.results || snap() !== s0 || existsSync(join(cdir, R))) bad.push('allowReal=false sync changed tools')
    if (pendingSyncCount(F, env) !== p1) bad.push('pending changed after plan sync')
    // sidebar button = syncNow(approvedOnce) → syncAll({ allowReal: true, approvedOnce: true })
    const once = syncAll(F, env, { allowReal: true, approvedOnce: true })
    const p2 = pendingSyncCount(F, env)
    if (!once.results) bad.push(`one-time apply refused ${once.refused ?? ''}`)
    if (p2 !== 0) bad.push(`pending after one-time apply ${p2}`)
    if (!existsSync(join(cdir, R)) || read(join(cdir, R)) !== '# zz pending\n') bad.push('no claude copy')
    if (readConfig(F).config.allowRealApply !== false) bad.push('one-time apply changed settings')
    const s1 = snap()
    pendingSyncCount(F, env)
    if (snap() !== s1) bad.push('computing pending 0 changed files')
    // cleanup
    deleteRule(F, R)
    if (pendingSyncCount(F, env) < 1) bad.push('pending 0 after delete')
    syncAll(F, env, { allowReal: true, approvedOnce: true })
    if (existsSync(join(cdir, R)) || pendingSyncCount(F, env) !== 0) bad.push('left after cleanup')
    writeConfig(F, cfg0)
    check(
      'y. pending sync count — change with allowRealApply=false → pending>0, tools unchanged; one-time approved apply → pending 0, settings unchanged; pendingSyncCount writes nothing',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `pending ${base} → ${p1} (1 rule added), F mtime and content unchanged before/after computing and plan sync, one-time apply → ${p2}, allowRealApply stays false, delete → delete candidate applied → 0`
    )
  }

  // ---- z. new user first run — empty HOME with existing tool settings (synthetic, fake secrets): first run → pending count → Sync → import all → turn off → switch to empty workspace and back
  //      Expected: user items kept before import. Imported items become app-owned (source moved to backups/imported = 'moved') — no duplicates.
  //      switch preview (previewSwitch) = what actually left the tools; user items not imported are kept across the switch too
  {
    const Z = makeFixture('illithid-m7-Z-')
    unlinkSync(join(Z, '.agents')) // a new user has no ~/.agents
    const memZ = memorySecretBackend()
    const envZ: Env = { PATH: process.env.PATH }
    const FAKE_TOKEN = 'ghp_fxFAKEnotAtoken000000000000'
    const put = (rel: string, s: string): void => {
      mkdirSync(join(Z, rel, '..'), { recursive: true })
      writeFileSync(join(Z, rel), s)
    }
    const U = {
      claudeJson: {
        numStartups: 7,
        userID: 'fx-user',
        projects: { '/fx/proj': { allowedTools: [], hasTrustDialogAccepted: true } },
        mcpServers: {
          'u-gh': { type: 'stdio', command: 'npx', args: ['-y', 'fx-gh'], env: { GITHUB_TOKEN: FAKE_TOKEN } },
          'u-http': { type: 'http', url: 'https://mcp.fx.invalid/mcp' }
        }
      },
      settings: {
        model: 'opus',
        permissions: { allow: ['Bash(npm test:*)', 'Read(~/fx)'], deny: ['Bash(rm:*)'], defaultMode: 'acceptEdits' },
        hooks: { Stop: [] },
        env: { FX: '1' }
      },
      claudeMd: '# My global instructions\n- user body\n',
      rule: '# my rule\nuser rule\n',
      skill: '---\nname: my-skill\ndescription: user skill\n---\nbody\n',
      agent: '---\nname: my-agent\ndescription: user agent\n---\nagent body\n',
      codexToml:
        'model = "gpt-5"\napproval_policy = "on-request"\n\n[mcp_servers.x]\ncommand = "npx"\nargs = ["-y", "fx-x"]\n\n[tui]\nnotifications = true\n\n[projects."/fx/proj"]\ntrust_level = "trusted"\n',
      agentsMd: '# My Codex instructions\nuser body\n',
      cSkill: '---\nname: c-skill\ndescription: codex skill\n---\nbody\n',
      cAgent: 'name = "c-agent"\ndescription = "codex agent"\ndeveloper_instructions = "do x"\n',
      oAgent: '---\ndescription: oc agent\n---\nOC body\n'
    }
    // instructions: a real file (import candidate oc.md) + a glob (not a candidate, kept to the end)
    const ocUserInstr = join(Z, 'notes/oc.md')
    const ocKeep = join(Z, 'notes/keep/*.md')
    const ocRuleText = '# oc rule\nuser OpenCode instructions\n'
    const ocJson = {
      $schema: 'https://opencode.ai/config.json',
      model: 'anthropic/claude-fx',
      instructions: [ocUserInstr, ocKeep],
      mcp: { 'o-srv': { type: 'local', command: ['npx', '-y', 'fx-o'], enabled: true } }
    }
    writeJson(join(Z, '.claude.json'), U.claudeJson)
    mkdirSync(join(Z, '.claude'), { recursive: true })
    writeJson(join(Z, '.claude/settings.json'), U.settings)
    put('.claude/CLAUDE.md', U.claudeMd)
    put('.claude/rules/my-rule.md', U.rule)
    put('.claude/skills/my-skill/SKILL.md', U.skill)
    put('.claude/agents/my-agent.md', U.agent)
    put('.codex/config.toml', U.codexToml)
    put('.codex/AGENTS.md', U.agentsMd)
    put('.codex/skills/c-skill/SKILL.md', U.cSkill)
    put('.codex/agents/c-agent.toml', U.cAgent)
    mkdirSync(join(Z, '.config/opencode'), { recursive: true })
    writeJson(join(Z, '.config/opencode/opencode.json'), ocJson)
    put('.config/opencode/agents/o-agent.md', U.oAgent)
    put('notes/oc.md', ocRuleText)

    // ---- per-item verdict: kept | moved (source bytes are in backups/imported — converted to app-owned by import) | changed | deleted | duplicate
    type St = 'kept' | 'moved' | 'changed' | 'deleted' | 'duplicate'
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
    const tryJson = (rel: string): Json | null => {
      try {
        return readJson(join(Z, rel))
      } catch {
        return null
      }
    }
    const tryToml = (): Json | null => {
      try {
        return parseToml(read(join(Z, '.codex/config.toml'))) as Json
      } catch {
        return null
      }
    }
    /** source moved to backups/imported/<ts>/<tool>/… (rel: `.claude/x` → `claude/x`, `.config/opencode/x` → `opencode/x`) */
    const importedCopy = (rel: string): string | null => {
      const root = importedBackupRoot(Z)
      if (!existsSync(root)) return null
      const suffix = rel.replace(/^\.config\/opencode\//, 'opencode/').replace(/^\./, '')
      for (const ts of readdirSync(root).sort().reverse()) if (existsSync(join(root, ts, suffix))) return read(join(root, ts, suffix))
      return null
    }
    const bytes = (rel: string, orig: string): St =>
      existsSync(join(Z, rel)) && read(join(Z, rel)) === orig
        ? 'kept'
        : importedCopy(rel) === orig
          ? 'moved'
          : !existsSync(join(Z, rel))
            ? 'deleted'
            : 'changed'
    const sub = (v: unknown, orig: unknown): St => (v === undefined ? 'deleted' : same(v, orig) ? 'kept' : 'changed')
    const omit = (o: Json | null, k: string): Json | null => {
      if (!o) return null
      const { [k]: _x, ...rest } = o
      void _x
      return rest
    }
    const { mcpServers: _cm, ...claudeOther } = U.claudeJson
    void _cm
    const ITEMS: [string, () => St][] = [
      ['claude.json mcpServers.u-gh', () => sub((tryJson('.claude.json')?.mcpServers as Json | undefined)?.['u-gh'], U.claudeJson.mcpServers['u-gh'])],
      ['claude.json mcpServers.u-http', () => sub((tryJson('.claude.json')?.mcpServers as Json | undefined)?.['u-http'], U.claudeJson.mcpServers['u-http'])],
      ['claude.json other keys', () => sub(omit(tryJson('.claude.json'), 'mcpServers') ?? undefined, claudeOther)],
      ['settings.json whole', () => sub(tryJson('.claude/settings.json') ?? undefined, U.settings)],
      ['CLAUDE.md', () => bytes('.claude/CLAUDE.md', U.claudeMd)],
      [
        'claude rules/my-rule.md',
        () => {
          const s = bytes('.claude/rules/my-rule.md', U.rule)
          return s === 'kept' && existsSync(join(Z, '.claude/rules', CLAUDE_RULES_DIR, 'my-rule.md')) ? 'duplicate' : s
        }
      ],
      ['claude skills/my-skill', () => bytes('.claude/skills/my-skill/SKILL.md', U.skill)],
      ['claude agents/my-agent.md', () => bytes('.claude/agents/my-agent.md', U.agent)],
      ['codex config.toml mcp_servers.x', () => sub((tryToml()?.mcp_servers as Json | undefined)?.x, (parseToml(U.codexToml) as Json & { mcp_servers: Json }).mcp_servers.x)],
      ['codex config.toml other keys', () => sub(omit(tryToml(), 'mcp_servers') ?? undefined, omit(parseToml(U.codexToml) as Json, 'mcp_servers'))],
      [
        'codex AGENTS.md user body',
        () =>
          !existsSync(join(Z, '.codex/AGENTS.md'))
            ? 'deleted'
            : outsideBlockMulti(read(join(Z, '.codex/AGENTS.md')), [MD_MARKERS, ...LEGACY_MD_MARKERS]).trim() === U.agentsMd.trim()
              ? 'kept'
              : 'changed'
      ],
      ['codex skills/c-skill', () => bytes('.codex/skills/c-skill/SKILL.md', U.cSkill)],
      ['codex agents/c-agent.toml', () => bytes('.codex/agents/c-agent.toml', U.cAgent)],
      ['opencode.json mcp.o-srv', () => sub((tryJson('.config/opencode/opencode.json')?.mcp as Json | undefined)?.['o-srv'], ocJson.mcp['o-srv'])],
      [
        'opencode.json other keys',
        () => {
          const o = tryJson('.config/opencode/opencode.json')
          if (!o) return 'deleted'
          return o.model === ocJson.model && o.$schema === ocJson.$schema && (o.instructions as string[] | undefined)?.includes(ocKeep)
            ? 'kept'
            : 'changed'
        }
      ],
      ['opencode agents/o-agent.md', () => bytes('.config/opencode/agents/o-agent.md', U.oAgent)]
    ]
    const table: Record<string, Record<string, St>> = {}
    const judge = (stage: string): string[] => {
      const off: string[] = []
      for (const [k, f] of ITEMS) {
        const s = f()
        ;(table[k] ??= {})[stage] = s
        if (s !== 'kept') off.push(`${k}=${s}`)
      }
      return off
    }
    const tree = (): Map<string, string> => {
      const m = new Map<string, string>()
      const walk = (d: string, rel: string): void => {
        for (const n of readdirSync(d).sort()) {
          const p = join(d, n)
          const r = rel ? `${rel}/${n}` : n
          const st = lstatSync(p)
          if (st.isSymbolicLink()) m.set(r, 'link:' + readlinkSync(p))
          else if (st.isDirectory()) walk(p, r)
          else m.set(r, sha(readFileSync(p)))
        }
      }
      walk(Z, '')
      return m
    }
    const added = (a: Map<string, string>, b: Map<string, string>): string[] => [...b.keys()].filter((k) => !a.has(k))
    const removed = (a: Map<string, string>, b: Map<string, string>): string[] => [...a.keys()].filter((k) => !b.has(k))
    const modified = (a: Map<string, string>, b: Map<string, string>): string[] =>
      [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k))
    const isApp = (k: string): boolean => k.startsWith('.illithid/') || k.startsWith(APP_CONFIG_DIR + '/') || k.endsWith(BACKUP_SUFFIX)
    const planDesc = (): string[] => {
      const p = planSyncAll(Z, envZ, memZ)
      return [
        ...p.targets.filter((c) => c.changed || c.error).map((c) => `target:${c.id}${c.error ? '(error)' : ''}`),
        ...p.rules.filter((x) => x.action !== 'inSync').map((x) => `rule:${x.name}:${x.action}`),
        ...p.skills.filter((x) => x.action !== 'inSync').map((x) => `skill:${x.tool}/${x.name}:${x.action}${x.reason ? `(${x.reason})` : ''}`),
        ...p.agents.filter((x) => x.action !== 'inSync').map((x) => `agent:${x.tool}/${x.name}:${x.action}${x.reason ? `(${x.reason})` : ''}`),
        ...p.errors.map((e) => `error:${e.split(':')[0]}`)
      ]
    }
    const once = (): SyncAllResultZ => syncAll(Z, envZ, { allowReal: true, approvedOnce: true, secrets: memZ })
    type SyncAllResultZ = ReturnType<typeof syncAll>

    // z1. first run — ensureLibrary → library skeleton only, plan sync (allowReal=false) writes nothing
    {
      const bad: string[] = []
      const t0 = tree()
      const en = ensureLibrary(Z)
      const t1 = tree()
      const made = added(t0, t1)
      if (en.status !== 'created') bad.push(`ensureLibrary ${en.status}`)
      if (made.some((k) => !k.startsWith('.illithid/workspaces/default/'))) bad.push(`created outside library ${made.join(',')}`)
      if (modified(t0, t1).length || removed(t0, t1).length) bad.push('ensureLibrary changed existing files')
      if (readConfig(Z).exists || readConfig(Z).config.allowRealApply) bad.push('config created / allowRealApply on')
      const r = syncAll(Z, envZ, { allowReal: false, secrets: memZ })
      const t2 = tree()
      if (r.results || modified(t1, t2).length || added(t1, t2).length) bad.push('allowReal=false sync wrote')
      const off = judge('1')
      bad.push(...off)
      check(
        'z1. new user first run — ensureLibrary creates skeleton only, allowReal=false sync writes nothing, 16 user items kept',
        !bad.length,
        bad.length ? bad.join('; ') : `created ${made.length} (${made.map((k) => k.split('/').pop()).join(', ')}), no config.json, plan sync writes 0, kept ${ITEMS.length}/${ITEMS.length}`
      )
    }

    // z2. pending count — the number shown on the Sync button for an empty library and the plan breakdown (computing writes nothing)
    let pendingZ = 0
    let planZ: string[] = []
    {
      const bad: string[] = []
      const t0 = tree()
      pendingZ = pendingSyncCount(Z, envZ, memZ)
      planZ = planDesc()
      if (tree().size !== t0.size || modified(t0, tree()).length) bad.push('computing changed files')
      if (planZ.length !== pendingZ) bad.push(`pending ${pendingZ} ≠ plan ${planZ.length}`)
      // 0 rules/memory/servers/skills → no empty block or skills.paths written, so pending 0
      if (pendingZ !== 0) bad.push(`pending ${pendingZ} for empty library: ${planZ.join(',')}`)
      bad.push(...judge('2'))
      check(
        'z2. empty library pending count 0 — no empty block or skills.paths planned, computing writes nothing',
        !bad.length,
        bad.length ? bad.join('; ') : `pending ${pendingZ}, files unchanged before/after computing`
      )
    }

    // z3. one Sync (approvedOnce) — user items kept; only marker blocks, skills.paths and app backups/state are added
    {
      const bad: string[] = []
      const t0 = tree()
      const r = once()
      const t1 = tree()
      if (!r.results) bad.push(`refused ${r.refused ?? ''}`)
      const userMod = modified(t0, t1).filter((k) => !isApp(k))
      const userAdd = added(t0, t1).filter((k) => !isApp(k))
      if (removed(t0, t1).length) bad.push(`deleted ${removed(t0, t1).join(',')}`)
      if (userMod.length) bad.push(`empty-library Sync changed tool files ${userMod.join(',')}`)
      if (pendingSyncCount(Z, envZ, memZ) !== 0) bad.push('pending ≠ 0 after Sync')
      if (userAdd.length) bad.push(`new files on the tool side ${userAdd.join(',')}`)
      bad.push(...judge('3'))
      check(
        'z3. one empty-library Sync — tool file changes 0 (no empty block or skills.paths), user items kept, re-pending 0',
        !bad.length,
        bad.length
          ? bad.join('; ')
          : `kept ${ITEMS.length}/${ITEMS.length}, tool files changed/created 0, app files ${added(t0, t1).filter(isApp).length} (state)`
      )
    }

    // z4. import all (except toolOnly) → Sync → user items kept, no duplicates → re-run idempotent
    let postImport = new Map<string, string>()
    let claudeAfterImport: Json = {}
    {
      const bad: string[] = []
      const pi = planImport(Z)
      const kinds: [ImportKind, { name: string; portability: string; variants: { id: string }[] }[]][] = [
        ['rule', pi.rules],
        ['memory', pi.memory],
        ['permissions', pi.permissions],
        ['skill', pi.skills],
        ['mcp', pi.mcp],
        ['agent', pi.agents]
      ]
      const cands = kinds.flatMap(([k, arr]) => arr.map((c) => `${k}:${c.name}${c.portability === 'toolOnly' ? '(toolOnly)' : ''}`))
      const sels: ImportSelection[] = kinds.flatMap(([k, arr]) =>
        arr
          .filter((c) => c.portability !== 'toolOnly')
          .map((c) => ({ kind: k, name: c.name, ...(c.variants.length > 1 ? { variant: c.variants[0].id } : {}) }))
      )
      const ir = applyImport(Z, sels, undefined, { secrets: memZ })
      const notImported = ir.filter((x) => x.status !== 'imported')
      if (notImported.length) bad.push(`import failed ${notImported.map((x) => `${x.name}:${x.reason}`).join(',')}`)
      const converted = ir.filter((x) => x.converted?.length).map((x) => `${x.name}→${x.converted!.join('/')}`)
      const adopted = ir.filter((x) => x.adopted?.length).map((x) => `${x.name}→${x.adopted!.join('/')}`)
      const t0 = tree()
      const r = once()
      const t1 = tree()
      if (!r.results) bad.push('Sync refused')
      const newTool = added(t0, t1).filter((k) => !isApp(k))
      // duplicates: same-name MCP server twice in one tool (Codex shows it as a TOML parse failure), same rule in Claude as user file + app copy
      if (!tryToml()) bad.push('codex config.toml parse failed (duplicate table)')
      // imported items may only be kept or moved (source in backups/imported) — no duplicates, losses, or changes without backup
      bad.push(...judge('4').filter((x) => !x.endsWith('=moved')))
      // no double-loaded rules: the user source is moved and only the app copy remains
      if (existsSync(join(Z, '.claude/rules/my-rule.md')) || !existsSync(join(Z, '.claude/rules', CLAUDE_RULES_DIR, 'my-rule.md')))
        bad.push('Claude rule source / app copy state')
      // skills: same bytes → adopted (recorded in state), otherwise the source is moved — the tool has only one app-owned copy
      const stS = readState(Z).state.skills ?? {}
      if (!stS.claude?.['my-skill'] || !stS.codex?.['c-skill']) bad.push('user skill not adopted as app-owned')
      // OpenCode instructions: only the imported rule's original path entry is removed; other entries and key order kept, original file bytes unchanged
      const oc4 = readJson(join(Z, '.config/opencode/opencode.json'))
      const ins4 = (oc4.instructions as string[] | undefined) ?? []
      if (ins4.includes(ocUserInstr)) bad.push('imported rule original path left in instructions')
      if (!ins4.includes(ocKeep)) bad.push('other instructions entries lost')
      if (JSON.stringify(Object.keys(oc4).filter((k) => k in ocJson)) !== JSON.stringify(Object.keys(ocJson))) bad.push('opencode.json key order changed')
      if (read(join(Z, 'notes/oc.md')) !== ocRuleText) bad.push('original rule file bytes changed')
      if (ir.find((x) => x.name === 'oc.md')?.warnings?.includes('opencodeInstructionRemains')) bad.push('instructions removal failure warning')
      if (ir.some((x) => x.userOwned?.length)) bad.push(`userOwned left ${ir.filter((x) => x.userOwned?.length).map((x) => x.name).join(',')}`)
      // re-run idempotent
      const pi2 = planImport(Z)
      const left = [...pi2.rules, ...pi2.memory, ...pi2.permissions, ...pi2.skills, ...pi2.mcp, ...pi2.agents].filter((c) => c.portability !== 'toolOnly')
      const ir2 = applyImport(Z, sels, undefined, { secrets: memZ })
      const t2 = tree()
      const r2 = once()
      const s2 = summarizeSync(r2)
      const t3 = tree()
      if (left.length) bad.push(`rescan candidates ${left.map((c) => c.name).join(',')}`)
      if (ir2.some((x) => x.status === 'imported')) bad.push('re-import imported again')
      if (modified(t2, t3).filter((k) => !k.startsWith(APP_CONFIG_DIR + '/')).length || s2['target.written']) bad.push('re-Sync wrote')
      if (pendingSyncCount(Z, envZ, memZ) !== 0) bad.push('re-pending ≠ 0')
      postImport = t3
      // raw token of the imported MCP does not remain as plaintext in the library (workspaces) (goes to the secret backend)
      if ([...t3.keys()].filter((k) => k.startsWith('.illithid/')).some((k) => read(join(Z, k)).includes(FAKE_TOKEN)))
        bad.push('raw token in library')
      claudeAfterImport = readJson(join(Z, '.claude.json'))
      check(
        'z4. import all → Sync — converted to app-owned (source kept or moved to backups/imported), no duplicates (no double-loaded rules), re-import and re-Sync idempotent',
        !bad.length,
        `${bad.length ? 'FAIL: ' + bad.join('; ') + ' | ' : ''}candidates ${cands.join(', ')}; imported ${ir.length - notImported.length}, source moved (converted) ${converted.join(',') || '-'}, adopted ${adopted.join(',') || '-'}; new tool-side files ${newTool.length}; re-import ${ir2.map((x) => x.reason).filter((v, i, a) => a.indexOf(v) === i).join(',')}`
      )
    }

    // z5. allowRealApply=true, turn off imported skill and MCP → removed from tools (skill to backups/deleted, MCP definition to backups/deleted/<ts>/mcp) → turning back on restores
    {
      const bad: string[] = []
      writeConfig(Z, { ...readConfig(Z).config, allowRealApply: true })
      setToggle(Z, 'skills', 'my-skill', 'claude', false)
      setToggle(Z, 'mcp', 'u-gh', 'claude', false)
      const plan5 = planDesc()
      const t0 = tree()
      const r = syncAll(Z, envZ, { allowReal: true, secrets: memZ })
      const t1 = tree()
      if (!r.results) bad.push('Sync refused')
      const gone = removed(t0, t1).filter((k) => !isApp(k))
      judge('5')
      const expectOff = new Set(['claude.json mcpServers.u-gh', 'claude skills/my-skill'])
      for (const k of expectOff) if (table[k]['5'] !== 'deleted') bad.push(`off ${k} = ${table[k]['5']}`)
      const newOff = ITEMS.map(([k]) => k).filter((k) => table[k]['5'] !== table[k]['4'] && !expectOff.has(k))
      bad.push(...newOff.map((k) => `${k}=${table[k]['5']}`))
      const skillBak = deletedBackup(Z, 'skills/claude/my-skill/SKILL.md')
      if (!skillBak || read(skillBak) !== U.skill) bad.push('skill deletion backup missing / bytes differ')
      const mcpBak = deletedBackup(Z, 'mcp/claude/u-gh.json')
      if (!mcpBak) bad.push('no MCP definition backup before removal')
      else {
        if (mode(mcpBak) !== 0o600) bad.push(`MCP backup mode ${mode(mcpBak).toString(8)}`)
        if (!same(readJson(mcpBak)['u-gh'], U.claudeJson.mcpServers['u-gh'])) bad.push('MCP backup definition differs')
      }
      setToggle(Z, 'skills', 'my-skill', 'claude', true)
      setToggle(Z, 'mcp', 'u-gh', 'claude', true)
      syncAll(Z, envZ, { allowReal: true, secrets: memZ })
      const back = (readJson(join(Z, '.claude.json')).mcpServers as Json)['u-gh']
      if (!same(back, U.claudeJson.mcpServers['u-gh'])) bad.push('re-enabled u-gh differs from original definition')
      if (!existsSync(join(Z, '.claude/skills/my-skill/SKILL.md')) || read(join(Z, '.claude/skills/my-skill/SKILL.md')) !== U.skill)
        bad.push('re-enabled my-skill missing / content differs')
      if (pendingSyncCount(Z, envZ, memZ) !== 0) bad.push('pending ≠ 0 after restore')
      check(
        'z5. turn off imported skill and MCP with allowRealApply=true — removed from tools and backed up (skill backups/deleted, MCP definition 0600), turning back on restores',
        !bad.length,
        `${bad.length ? 'FAIL: ' + bad.join('; ') + ' | ' : ''}plan ${plan5.join(', ') || '-'}; removed files ${gone.join(',') || '-'}; MCP definition backup ${mcpBak ? 'O(0600)' : 'X'}; re-enable → u-gh and my-skill original content`
      )
    }

    // z6. create and switch to an empty workspace + Sync → previewSwitch list = what actually left, user items not imported kept → switching back to default restores
    {
      const bad: string[] = []
      // items the user added separately after import (not imported — user-owned)
      const lateSrv = { type: 'stdio', command: 'fx-late', args: [] as string[] }
      const cj = readJson(join(Z, '.claude.json'))
      ;(cj.mcpServers as Json)['late-srv'] = lateSrv
      writeJson(join(Z, '.claude.json'), cj)
      put('.claude/skills/late-skill/SKILL.md', '---\nname: late-skill\ndescription: late\n---\n')
      put('.claude/rules/late-rule.md', '# late\n')
      const lateTree = (): string[] =>
        ['.claude/skills/late-skill/SKILL.md', '.claude/rules/late-rule.md'].map((k) => (existsSync(join(Z, k)) ? sha(read(join(Z, k))) : 'absent'))
      const late0 = lateTree()
      const txt = (rel: string): string => (existsSync(join(Z, rel)) ? read(join(Z, rel)) : '')
      const texts = (): Record<string, string> => ({
        claude: txt('.claude.json'),
        toml: txt('.codex/config.toml'),
        agents: txt('.codex/AGENTS.md'),
        oc: txt('.config/opencode/opencode.json')
      })
      const t0 = tree()
      const b = texts()
      const ws = createWorkspace(Z, '\uBE48 \uC791\uC5C5\uACF5\uAC04', { from: 'empty' })
      const preview = previewSwitch(Z, envZ, ws.id, memZ).map((x) => `${x.kind}:${x.tool}:${x.name}`)
      if (tree().size !== t0.size + 2) bad.push('preview wrote files') // + 2 skeleton entries for the new workspace
      switchWorkspace(Z, ws.id)
      const r = once()
      const t1 = tree()
      const a = texts()
      if (!r.results) bad.push('switch Sync refused')
      // what actually left (computed independently from files and settings)
      const actual = new Set<string>()
      for (const k of removed(t0, t1)) {
        let m: RegExpExecArray | null
        if ((m = /^\.claude\/rules\/illithid\/([^/]+)$/.exec(k))) actual.add(`${m[1] === 'MEMORY.md' ? 'memory' : 'rule'}:claude:${m[1]}`)
        else if ((m = /^\.(claude|codex)\/skills\/([^/]+)\//.exec(k))) actual.add(`skill:${m[1]}:${m[2]}`)
        else if ((m = /^\.claude\/agents\/([^/]+)\.md$/.exec(k))) actual.add(`agent:claude:${m[1]}`)
        else if ((m = /^\.codex\/agents\/([^/]+)\.toml$/.exec(k))) actual.add(`agent:codex:${m[1]}`)
        else if ((m = /^\.config\/opencode\/agents\/([^/]+)\.md$/.exec(k))) actual.add(`agent:opencode:${m[1]}`)
      }
      const jsonKeys = (t: string, key: string): string[] => {
        try {
          return Object.keys(((JSON.parse(t) as Json)[key] as Json | undefined) ?? {})
        } catch {
          return []
        }
      }
      const tomlKeys = (t: string): string[] => {
        try {
          return Object.keys(((parseToml(t) as Json).mcp_servers as Json | undefined) ?? {})
        } catch {
          return []
        }
      }
      for (const n of jsonKeys(b.claude, 'mcpServers')) if (!jsonKeys(a.claude, 'mcpServers').includes(n)) actual.add(`mcp:claude:${n}`)
      for (const n of tomlKeys(b.toml)) if (!tomlKeys(a.toml).includes(n)) actual.add(`mcp:codex:${n}`)
      for (const n of jsonKeys(b.oc, 'mcp')) if (!jsonKeys(a.oc, 'mcp').includes(n)) actual.add(`mcp:opencode:${n}`)
      const blockRules = (t: string): string[] =>
        [...(blockBodyMulti(t, [MD_MARKERS, ...LEGACY_MD_MARKERS]) ?? '').matchAll(/^<!-- (rules|memory)\/(.+?) -->$/gm)].map((m) => `${m[1] === 'memory' ? 'memory' : 'rule'}:codex:${m[2]}`)
      for (const x of blockRules(b.agents)) if (!blockRules(a.agents).includes(x)) actual.add(x)
      const ocList = (t: string, f: (o: Json) => unknown): string[] => {
        try {
          const v = f(JSON.parse(t) as Json)
          return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
        } catch {
          return []
        }
      }
      const instr = (t: string): string[] => ocList(t, (o) => o.instructions).map((x) => x.split('/').pop()!)
      for (const n of instr(b.oc)) if (!instr(a.oc).includes(n)) actual.add(`${n === 'MEMORY.md' ? 'memory' : 'rule'}:opencode:${n}`)
      const skillsIn = (t: string): string[] =>
        ocList(t, (o) => (o.skills as Json | undefined)?.paths).flatMap((d) =>
          existsSync(d) ? readdirSync(d).filter((n) => existsSync(join(d, n, 'SKILL.md'))) : []
        )
      for (const n of skillsIn(b.oc)) if (!skillsIn(a.oc).includes(n)) actual.add(`skill:opencode:${n}`)
      const act = [...actual].sort()
      const pre = [...preview].sort()
      if (JSON.stringify(act) !== JSON.stringify(pre))
        bad.push(`preview≠actual — preview only ${pre.filter((x) => !act.includes(x)).join(',') || '-'} / actual only ${act.filter((x) => !pre.includes(x)).join(',') || '-'}`)
      judge('6')
      // user items not imported are kept (CLAUDE.md, settings, other keys, AGENTS.md body + late-* added after import)
      const notImported = ['claude.json other keys', 'settings.json whole', 'CLAUDE.md', 'codex config.toml other keys', 'codex AGENTS.md user body', 'opencode.json other keys']
      for (const k of notImported) if (table[k]['6'] !== 'kept') bad.push(`empty workspace: ${k}=${table[k]['6']}`)
      if (JSON.stringify(lateTree()) !== JSON.stringify(late0)) bad.push('non-imported late skill/rule changed')
      if (!same((readJson(join(Z, '.claude.json')).mcpServers as Json)['late-srv'], lateSrv)) bad.push('non-imported late-srv changed')
      switchWorkspace(Z, 'default')
      const r2 = once()
      const t2 = tree()
      if (!r2.results) bad.push('switch-back Sync refused')
      const notRestored = [...postImport.keys()].filter((k) => !isApp(k) && k !== '.claude.json' && postImport.get(k) !== t2.get(k))
      if (notRestored.length) bad.push(`not restored after switching back ${notRestored.join(',')}`)
      // server order may change after turning off and switching (compare semantically)
      const canon = (v: unknown): unknown =>
        Array.isArray(v)
          ? v.map(canon)
          : v && typeof v === 'object'
            ? Object.fromEntries(Object.keys(v as Json).sort().map((k) => [k, canon((v as Json)[k])]))
            : v
      const cBack = readJson(join(Z, '.claude.json'))
      const { 'late-srv': lateBack, ...restSrv } = cBack.mcpServers as Json
      if (!same(lateBack, lateSrv)) bad.push('late-srv differs after switching back')
      if (!same(canon({ ...cBack, mcpServers: restSrv }), canon(claudeAfterImport))) bad.push('claude.json content differs after switching back')
      if (JSON.stringify(lateTree()) !== JSON.stringify(late0)) bad.push('late skill/rule changed after switching back')
      if (pendingSyncCount(Z, envZ, memZ) !== 0) bad.push('pending ≠ 0 after switching back')
      judge('6back')
      check(
        'z6. switch to empty workspace — previewSwitch list = what actually left, user items not imported kept, switching back to default restores the post-import state',
        !bad.length,
        `${bad.length ? 'FAIL: ' + bad.join('; ') + ' | ' : ''}preview ${pre.length} = actual ${act.length} (${pre.join(', ')}); ${notImported.length + 3} non-imported items kept; restored after switching back ${notRestored.length ? 'X' : 'O'}`
      )
    }

    // table (rows = user items, columns = stages)
    const cols = ['1', '2', '3', '4', '5', '6', '6back']
    check(
      'z-table. user items × stages (kept/moved/changed/deleted/duplicate)',
      true,
      ['item | ' + cols.join(' | '), ...ITEMS.map(([k]) => `${k} | ${cols.map((c) => table[k]?.[c] ?? '-').join(' | ')}`)].join('\n      ')
    )
  }

  // ---- ab. artifact tool detection — collection location rules → nearest manifest.json (read once per directory) → unknown, ~/.codex/generated_images collected
  {
    const K = makeFixture('illithid-m7-K-')
    const put = (rel: string, body = 'x'): void => {
      mkdirSync(join(K, rel, '..'), { recursive: true })
      writeFileSync(join(K, rel), body)
    }
    const lib = '.illithid/workspaces/default/artifacts'
    put('.claude/plans/p1.md', '# Claude plan\n')
    put('.codex/generated_images/s1/img1.png')
    put('.codex/generated_images/s1/img2.png')
    put('.omx/plans/o.md', '# omx\n')
    put('.cursor/plans/c.md', '# cursor\n')
    put('.sisyphus/plans/s.md', '# sis\n') // not collected
    // location rules take precedence over manifest: a manifest inside claude plans says codex but it's still claude
    put('.claude/plans/sub/manifest.json', JSON.stringify({ tool: 'built-in image_gen' }))
    put('.claude/plans/sub/q.md', '# q\n')
    // library: per-project manifest
    put(`${lib}/projA/manifest.json`, JSON.stringify({ tool: 'Claude Code (python-generated SVG)' }))
    put(`${lib}/projA/a1.svg`)
    put(`${lib}/projA/deep/x/a2.md`, '# a2\n') // inherits manifest from above
    put(`${lib}/projA/deep/x/a3.md`, '# a3\n')
    put(`${lib}/projB/manifest.json`, JSON.stringify({ tool: 'built-in image_gen' }))
    put(`${lib}/projB/b1.png`)
    put(`${lib}/projB/inner/manifest.json`, JSON.stringify({ tool: 'OpenCode' })) // closer manifest wins
    put(`${lib}/projB/inner/b2.md`, '# b2\n')
    put(`${lib}/projC/manifest.json`, JSON.stringify({ tool: 'Cursor Agent' }))
    put(`${lib}/projC/c1.md`, '# c1\n')
    put(`${lib}/projD/manifest.json`, JSON.stringify({ tool: 'photoshop' })) // no rule match
    put(`${lib}/projD/d1.md`, '# d1\n')
    put(`${lib}/projE/manifest.json`, '{not json') // broken manifest
    put(`${lib}/projE/e1.md`, '# e1\n')
    put(`${lib}/projF/f1.md`, '# f1\n') // no manifest
    put(`${lib}/manifest.json`, JSON.stringify({ note: 'no tool' })) // root manifest: no tool
    put(`${lib}/loose.md`, '# loose\n')

    const bad: string[] = []
    const srcs = defaultArtifactSources(K)
    const gi = srcs.find((x) => x.label === '~/.codex/generated_images')
    if (!gi || gi.project !== 'first-segment') bad.push('generated_images collection location missing')
    const cache = newManifestCache()
    const items = scanArtifacts(K, srcs, cache)
    const toolAt = (rel: string): string => items.find((a) => a.path === join(K, rel))?.tool ?? 'missing'
    const expect: [string, string][] = [
      ['.claude/plans/p1.md', 'claude'],
      ['.claude/plans/sub/q.md', 'claude'],
      ['.codex/generated_images/s1/img1.png', 'codex'],
      ['.omx/plans/o.md', 'codex'],
      ['.cursor/plans/c.md', 'cursor'],
      ['.sisyphus/plans/s.md', 'missing'],
      [`${lib}/projA/a1.svg`, 'claude'],
      [`${lib}/projA/deep/x/a2.md`, 'claude'],
      [`${lib}/projB/b1.png`, 'codex'],
      [`${lib}/projB/inner/b2.md`, 'opencode'],
      [`${lib}/projC/c1.md`, 'cursor'],
      [`${lib}/projD/d1.md`, 'unknown'],
      [`${lib}/projE/e1.md`, 'unknown'],
      [`${lib}/projF/f1.md`, 'unknown'],
      [`${lib}/loose.md`, 'unknown']
    ]
    for (const [rel, want] of expect) {
      const got = toolAt(rel)
      if (got !== want) bad.push(`${rel}: ${got} ≠ ${want}`)
    }
    if (srcs.some((x) => x.root.includes('.sisyphus'))) bad.push('.sisyphus collected')
    const listedManifests = items.filter((a) => a.path.endsWith('/manifest.json')).length
    if (listedManifests) bad.push(`manifest.json exposed in list ${listedManifests}`)
    const img = items.find((a) => a.path === join(K, '.codex/generated_images/s1/img1.png'))
    if (img?.project !== 's1') bad.push(`generated_images project ${img?.project}`)
    // library manifest.json 6 (projA, B, B/inner, C, D, E) + 1 root = 7 — once per directory regardless of file count
    const libManifests = 7
    if (cache.reads !== libManifests) bad.push(`manifest reads ${cache.reads} ≠ ${libManifests}`)
    // rescan with the same cache → 0 extra reads
    scanArtifacts(K, srcs, cache)
    if (cache.reads !== libManifests) bad.push(`rescan extra manifest reads ${cache.reads - libManifests}`)
    const byTool = new Map<string, number>()
    for (const a of items) byTool.set(a.tool, (byTool.get(a.tool) ?? 0) + 1)
    check(
      'ab. artifact tool detection — location rules, nearest manifest, cache, unknown, generated_images collected, .sisyphus excluded, manifest.json hidden',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `${expect.length} detections match, manifest reads ${cache.reads} (rescan +0), per tool ${[...byTool].map(([k, n]) => `${k} ${n}`).join(' · ')}`
    )
  }

  // ---- ac. session content index/search — synthetic Claude/Codex JSONL + OpenCode db, incremental/delete/idempotent, tool output not indexed, idx match
  {
    const bad: string[] = []
    const S = makeFixture('illithid-m7-S-')
    const cid = '11111111-aaaa-4bbb-8ccc-000000000001'
    const xid = '22222222-aaaa-4bbb-8ccc-000000000002'
    const claudeFile = join(S, '.claude/projects/-tmp-proj', `${cid}.jsonl`)
    mkdirSync(join(S, '.claude/projects/-tmp-proj'), { recursive: true })
    const jl = (xs: unknown[]): string => xs.map((x) => JSON.stringify(x)).join('\n') + '\n'
    const cu = (text: string, ts: string): Json => ({ type: 'user', sessionId: cid, cwd: '/tmp/proj', timestamp: ts, message: { role: 'user', content: text } })
    writeFileSync(
      claudeFile,
      jl([
        cu('\uD55C\uAE00 \uD615\uD0DC\uC18C\uBD84\uC11D\uAE30 \uC9C8\uBB38\uC785\uB2C8\uB2E4', '2026-09-20T00:00:00Z'),
        {
          type: 'assistant', sessionId: cid, timestamp: '2026-09-20T00:00:01Z',
          message: { role: 'assistant', content: [{ type: 'text', text: '\uB2F5\uBCC0 English Keyword alpha' }, { type: 'tool_use', name: 'Bash', input: { command: 'echo TOOLONLYSECRET' } }] }
        },
        { type: 'user', sessionId: cid, timestamp: '2026-09-20T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'TOOLRESULTTEXT' }] } },
        { type: 'assistant', sessionId: cid, timestamp: '2026-09-20T00:00:03Z', message: { role: 'assistant', content: [{ type: 'text', text: '\uB450\uBC88\uC9F8 \uB2F5\uBCC0 \uAC00\uB098' }] } }
      ])
    )
    const codexDir = join(S, '.codex/sessions/2026/09/21')
    mkdirSync(codexDir, { recursive: true })
    const codexFile = join(codexDir, `rollout-2026-09-21T00-00-00-${xid}.jsonl`)
    const ri = (payload: Json, ts: string): Json => ({ type: 'response_item', timestamp: ts, payload })
    writeFileSync(
      codexFile,
      jl([
        { type: 'session_meta', timestamp: '2026-09-21T00:00:00Z', payload: { id: xid, cwd: '/tmp/cx', timestamp: '2026-09-21T00:00:00Z' } },
        ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '\uCF54\uB371\uC2A4 \uC9C8\uBB38 \uBCA1\uD130\uAC80\uC0C9 \uD55C' }] }, '2026-09-21T00:00:01Z'),
        ri({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['echo', 'CODEXTOOLOUT'] }) }, '2026-09-21T00:00:02Z'),
        ri({ type: 'function_call_output', output: 'CODEXTOOLRESULT' }, '2026-09-21T00:00:03Z'),
        ri({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '\uCF54\uB371\uC2A4 \uB2F5\uBCC0 Zeta' }] }, '2026-09-21T00:00:04Z')
      ])
    )
    // OpenCode: session, message, part (only the needed columns)
    const ocDir = join(S, '.local/share/opencode')
    mkdirSync(ocDir, { recursive: true })
    const { DatabaseSync: Db } = process.getBuiltinModule('node:sqlite') as { DatabaseSync: typeof DatabaseSync }
    const oc = new Db(join(ocDir, 'opencode.db'))
    oc.exec(`create table session(id text primary key, title text, directory text, parent_id text, time_created integer, time_updated integer);
      create table message(id text primary key, session_id text, time_created integer, data text);
      create table part(id text primary key, message_id text, time_created integer, data text);`)
    const T0 = Date.parse('2026-09-22T00:00:00Z')
    oc.prepare('insert into session values (?, ?, ?, null, ?, ?)').run('ses_oc1', '\uC624\uD508\uCF54\uB4DC \uC138\uC158', '/tmp/oc', T0, T0 + 3)
    const ocMsg = (id: string, role: string, t: number, parts: Json[]): void => {
      oc.prepare('insert into message values (?, ?, ?, ?)').run(id, 'ses_oc1', t, JSON.stringify({ role, time: { created: t } }))
      parts.forEach((p, i) => oc.prepare('insert into part values (?, ?, ?, ?)').run(`${id}_p${i}`, id, t + i, JSON.stringify(p)))
    }
    ocMsg('msg_1', 'user', T0 + 1, [{ type: 'text', text: '\uC624\uD508\uCF54\uB4DC \uC9C8\uBB38 \uD55C\uAE00' }])
    ocMsg('msg_2', 'assistant', T0 + 2, [
      { type: 'text', text: '\uC624\uD508\uCF54\uB4DC \uB2F5\uBCC0 omega' },
      { type: 'tool', tool: 'bash', state: { title: 'OCTOOLTITLE', input: { command: 'x' }, output: 'OCTOOLOUT' } }
    ])
    oc.close()

    const scan = (): ReturnType<typeof scanSessions>['sessions'] => scanSessions(S).sessions
    const dbFile = searchIndexPath(S)
    if (!dbFile.startsWith(S + '/.config/illithid/')) bad.push(`index path ${dbFile}`)
    const r1 = await indexSessions(S, scan())
    if (r1.indexed !== 3 || r1.failed) bad.push(`first index ${r1.indexed}/${r1.sessions} failed ${r1.failed}`)

    const transcripts = new Map<string, Awaited<ReturnType<typeof readSessionTranscript>>>()
    const verify = async (q: string, want: string[], label: string): Promise<number> => {
      transcripts.clear() // sources change between steps
      const r = searchSessions(S, q)
      const got = r.results.map((x) => `${x.tool}:${x.id}`).sort()
      if (got.join() !== [...want].sort().join()) bad.push(`${label} "${q}" → [${got.join(',')}]`)
      let hits = 0
      for (const x of r.results) {
        const k = `${x.tool}:${x.id}`
        if (!transcripts.has(k)) transcripts.set(k, await readSessionTranscript(S, x.tool, x.id, { limit: 100000 }))
        for (const h of x.hits) {
          hits++
          const m = transcripts.get(k)!.messages.find((mm) => mm.index === h.idx)
          if (!m || !m.text.toLowerCase().includes(q.toLowerCase()) || m.role !== h.role) bad.push(`${label} "${q}" idx ${h.idx} mismatch`)
          if (!h.marks.length || h.marks.some(([a, b]) => h.snippet.slice(a, b).toLowerCase() !== q.toLowerCase()))
            bad.push(`${label} "${q}" highlight range mismatch`)
        }
      }
      return hits
    }
    const C = `claude:${cid}`
    const X = `codex:${xid}`
    const O = 'opencode:ses_oc1'
    let hitN = 0
    hitN += await verify('\uD615\uD0DC\uC18C\uBD84\uC11D\uAE30', [C], 'Korean 3+ chars')
    hitN += await verify('keyword', [C], 'English case-insensitive')
    hitN += await verify('\uAC00\uB098', [C], '2 chars')
    hitN += await verify('\uD55C', [C, X, O], '1 char')
    hitN += await verify('\uB2F5\uBCC0', [C, X, O], '2 chars shared')
    if (searchSessions(S, '\uAC00\uB098').mode !== 'like' || searchSessions(S, '\uD615\uD0DC\uC18C').mode !== 'fts') bad.push('mode detection')
    for (const q of ['TOOLONLYSECRET', 'TOOLRESULTTEXT', 'CODEXTOOLOUT', 'CODEXTOOLRESULT', 'OCTOOLTITLE', 'OCTOOLOUT', 'echo'])
      if (searchSessions(S, q).results.length) bad.push(`tool output indexed: ${q}`)
    // quotes and special characters don't cause FTS syntax errors
    for (const q of ['"\uB2F5\uBCC0', 'a"b"c', 'AND OR', '100%', '_x'])
      try {
        searchSessions(S, q)
      } catch (e) {
        bad.push(`search exception "${q}": ${(e as Error).message}`)
      }
    // filters
    const fTool = searchSessions(S, '\uB2F5\uBCC0', { tool: 'codex' }).results.map((x) => x.tool)
    if (fTool.join() !== 'codex') bad.push(`tool filter ${fTool.join()}`)
    const fRole = searchSessions(S, '\uB2F5\uBCC0', { role: 'user' }).results.length
    if (fRole !== 0) bad.push(`role filter user → ${fRole}`)
    const fProj = searchSessions(S, '\uB2F5\uBCC0', { project: 'cx' }).results.map((x) => x.tool)
    if (fProj.join() !== 'codex') bad.push(`project filter ${fProj.join()}`)

    // idempotent: no changes → 0 writes
    const h0 = sha(readFileSync(dbFile))
    const r2 = await indexSessions(S, scan())
    if (r2.indexed || r2.removed || r2.changes || sha(readFileSync(dbFile)) !== h0) bad.push(`re-run writes ${r2.changes} reindexed ${r2.indexed}`)

    // edit: one line appended to the Claude file → only that session
    writeFileSync(claudeFile, read(claudeFile) + jl([cu('\uCD94\uAC00\uB41C \uBB38\uC7A5 \uB378\uD0C0', '2026-09-23T00:00:00Z')]))
    const r3 = await indexSessions(S, scan())
    if (r3.indexed !== 1 || r3.removed) bad.push(`reindex after edit ${r3.indexed}, removed ${r3.removed}`)
    hitN += await verify('\uCD94\uAC00\uB41C \uBB38\uC7A5', [C], 'edit applied')
    // OpenCode: message added + time_updated
    const oc2 = new Db(join(ocDir, 'opencode.db'))
    oc2.prepare('insert into message values (?, ?, ?, ?)').run('msg_3', 'ses_oc1', T0 + 10, JSON.stringify({ role: 'user', time: { created: T0 + 10 } }))
    oc2.prepare('insert into part values (?, ?, ?, ?)').run('msg_3_p0', 'msg_3', T0 + 10, JSON.stringify({ type: 'text', text: '\uC624\uD508\uCF54\uB4DC \uD6C4\uC18D \uC2DC\uADF8\uB9C8' }))
    oc2.prepare('update session set time_updated = ? where id = ?').run(T0 + 11, 'ses_oc1')
    oc2.close()
    const r4 = await indexSessions(S, scan())
    if (r4.indexed !== 1) bad.push(`OpenCode change reindex ${r4.indexed}`)
    hitN += await verify('\uD6C4\uC18D \uC2DC\uADF8\uB9C8', [O], 'OpenCode applied')
    // tools whose scan failed (incomplete list) are not removed
    const r5 = await indexSessions(S, scan().filter((x) => x.tool !== 'opencode'), { completeTools: ['claude', 'codex'] })
    if (r5.removed || !searchSessions(S, '\uC2DC\uADF8\uB9C8').results.length) bad.push('OpenCode removed from incomplete list')
    // delete: Codex file → removed from the index
    unlinkSync(codexFile)
    const r6 = await indexSessions(S, scan())
    if (r6.removed !== 1 || r6.indexed) bad.push(`delete removed ${r6.removed}, reindexed ${r6.indexed}`)
    if (searchSessions(S, '\uBCA1\uD130\uAC80\uC0C9').results.length) bad.push('deleted session found by search')
    const r7 = await indexSessions(S, scan())
    if (r7.changes) bad.push(`re-run writes after delete ${r7.changes}`)

    check(
      'ac. session content index — Korean, English, 1–2 char search, tool output not indexed, incremental (edit, OpenCode, delete), re-run writes 0, hit idx = transcript index',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `sessions 3, messages ${r1.inserted}, ${hitN} verified hits with idx and highlight match, 7 tool strings 0 hits, re-run changes 0 and file hash identical, edit 1, OpenCode 1, delete 1 applied`
    )
  }

  // ---- ad. backup retention — targets by age/count, newest kept, nothing outside backups/ and rollback/, injected mover
  {
    const bad: string[] = []
    const B = makeFixture('illithid-m7-B-')
    const cfg = join(B, APP_CONFIG_DIR)
    const now = Date.parse('2026-09-27T12:00:00Z')
    const iso = (daysAgo: number): string => new Date(now - daysAgo * 86_400_000).toISOString().replace(/[:.]/g, '-')
    const put = (p: string, bytes = 10): void => {
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, 'x'.repeat(bytes))
    }
    const outside = join(B, 'outside')
    put(join(outside, 'keep.txt'))
    put(join(outside, iso(90), 'keep.txt'))
    // aged folders: old (target) / recent (kept) / non-timestamp name (kept)
    put(join(cfg, 'backups/deleted', iso(40), 'a/file.md'), 100)
    put(join(cfg, 'backups/deleted', iso(31), 'b.md'), 50)
    put(join(cfg, 'backups/deleted', iso(5), 'c.md'))
    put(join(cfg, 'backups/deleted/notes/old.md'))
    symlinkSync(join(outside, iso(90)), join(cfg, 'backups/deleted', iso(60))) // stamped symlink → only the link is a target
    put(join(cfg, 'backups/imported', iso(45), 'x.md'), 20)
    put(join(cfg, 'backups/imported', iso(1), 'y.md'))
    put(join(cfg, 'backups/workspaces', iso(100), 'w/rules/r.md'), 30)
    // skills: 5 stamped entries → oldest 2 are targets; single-copy layout (no timestamps) → kept
    for (let i = 0; i < 5; i++) put(join(cfg, 'backups/skills/claude/foo', iso(i * 10 + 1), 'SKILL.md'), 7)
    put(join(cfg, 'backups/skills/codex/bar/SKILL.md'))
    // agents backups are outside the rules → never targets
    put(join(cfg, 'backups/agents/claude', iso(200)))
    // rollback: 5 tars by mtime → oldest 2 are targets; non-tar kept
    const tars = ['g1-20260901-000000.tar', 'pre-dev-20260902-000000.tar', 'pre-x-20260903-000000.tar', 'pre-y-20260904-000000.tar', 'pre-z-20260905-000000.tar']
    tars.forEach((n, i) => {
      put(join(cfg, 'rollback', n), 1000)
      const t = new Date(now - (10 - i) * 86_400_000)
      utimesSync(join(cfg, 'rollback', n), t, t)
    })
    put(join(cfg, 'rollback/notes.txt'))

    const plan = planBackupCleanup(B, { now })
    const rel = (p: string): string => p.slice(cfg.length + 1)
    const got = plan.items.map((i) => rel(i.path)).sort()
    const want = [
      `backups/deleted/${iso(40)}`,
      `backups/deleted/${iso(31)}`,
      `backups/deleted/${iso(60)}`,
      `backups/imported/${iso(45)}`,
      `backups/workspaces/${iso(100)}`,
      `backups/skills/claude/foo/${iso(31)}`,
      `backups/skills/claude/foo/${iso(41)}`,
      `rollback/${tars[0]}`,
      `rollback/${tars[1]}`
    ].sort()
    if (got.join() !== want.join()) bad.push(`targets [${got.join(', ')}]`)
    if (plan.items.some((i) => !i.path.startsWith(join(cfg, 'backups') + '/') && !i.path.startsWith(join(cfg, 'rollback') + '/')))
      bad.push('target outside backups/rollback')
    const sizeOf = (r: string): number => plan.items.find((i) => rel(i.path) === r)?.size ?? -1
    if (sizeOf(`backups/deleted/${iso(40)}`) !== 100 || sizeOf(`rollback/${tars[0]}`) !== 1000) bad.push('sizes')
    if (plan.count !== want.length || plan.bytes !== plan.items.reduce((n, i) => n + i.size, 0)) bad.push('count/bytes')
    // overrides: shorter age, fewer rollbacks kept
    const p3 = planBackupCleanup(B, { now, days: 3, keepRollback: 1 })
    if (!p3.items.some((i) => rel(i.path) === `backups/deleted/${iso(5)}`) || p3.items.filter((i) => i.kind === 'rollback').length !== 4)
      bad.push('days/keepRollback override')
    // config defaults and validation
    const d = retentionOf({ version: 1 })
    if (d.enabled !== true || d.days !== 30 || d.keepRollback !== 3) bad.push('defaults')
    if (validateConfig({ version: 1, backupRetention: { enabled: true, days: 30, keepRollback: 3 } }).length) bad.push('valid config rejected')
    for (const br of [{ enabled: 'y', days: 30, keepRollback: 3 }, { enabled: true, days: 0, keepRollback: 3 }, { enabled: true, days: 30, keepRollback: 1.5 }, []])
      if (!validateConfig({ version: 1, backupRetention: br }).length) bad.push(`invalid config accepted ${JSON.stringify(br)}`)
    // forged targets are refused (path escape, wrong shape)
    const forged: [Parameters<typeof isCleanupTarget>[1], string][] = [
      ['deleted', join(outside, iso(90))],
      ['deleted', join(cfg, 'backups/deleted', '..', '..', 'config.json')],
      ['deleted', join(cfg, 'backups/deleted/notes')],
      ['rollback', join(cfg, 'state.json')],
      ['skills', join(cfg, 'backups/skills/codex/bar')],
      ['workspaces', join(cfg, 'backups/deleted', iso(40))]
    ]
    for (const [k, p] of forged) if (isCleanupTarget(B, k, p)) bad.push(`forged target accepted ${p.replace(B, '')}`)

    // apply with an injected mover (temp move instead of the Trash)
    const trash = join(B, 'trash-sim')
    mkdirSync(trash)
    let n = 0
    const mover = (p: string): void => renameSync(p, join(trash, `${n++}-${p.split('/').pop()}`))
    const evil: CleanupPlan = {
      items: [...plan.items, { kind: 'deleted', path: join(outside, iso(90)), size: 0, at: '' }],
      count: plan.count + 1,
      bytes: plan.bytes
    }
    const r = await applyBackupCleanup(B, evil, mover)
    if (r.moved !== plan.count || r.bytes !== plan.bytes) bad.push(`moved ${r.moved}/${plan.count}`)
    if (r.failed.length !== 1 || r.failed[0].reason !== 'outsideBackups') bad.push(`failed ${JSON.stringify(r.failed.map((f) => f.reason))}`)
    if (plan.items.some((i) => existsSync(i.path))) bad.push('target still present')
    if (readdirSync(trash).length !== plan.count) bad.push('trash count')
    if (!existsSync(join(outside, iso(90), 'keep.txt')) || !existsSync(join(outside, 'keep.txt'))) bad.push('outside content touched')
    for (const k of [`backups/deleted/${iso(5)}`, 'backups/deleted/notes', `backups/imported/${iso(1)}`, 'backups/skills/codex/bar/SKILL.md', `backups/agents/claude/${iso(200)}`, `rollback/${tars[4]}`, `rollback/${tars[2]}`, 'rollback/notes.txt'])
      if (!existsSync(join(cfg, k))) bad.push(`kept entry gone: ${k}`)
    if (planBackupCleanup(B, { now }).count) bad.push('second plan not empty')
    // missing item → failed, mover not called
    let called = 0
    const r2 = await applyBackupCleanup(B, { items: [plan.items[0]], count: 1, bytes: 0 }, () => void called++)
    if (called || r2.failed[0]?.reason !== 'missing') bad.push('missing item moved')
    // symlinked backups root is never scanned
    const L = makeFixture('illithid-m7-B2-')
    put(join(L, 'elsewhere', iso(90), 'z.md'))
    mkdirSync(join(L, APP_CONFIG_DIR, 'backups'), { recursive: true })
    symlinkSync(join(L, 'elsewhere'), join(L, APP_CONFIG_DIR, 'backups/deleted'))
    if (planBackupCleanup(L, { now }).count) bad.push('symlinked root scanned')

    check(
      'ad. backup retention — age/count rules, newest kept, forged/escaping targets refused, symlinked root skipped, injected mover',
      !bad.length,
      bad.length ? bad.join('; ') : `${plan.count} targets (${plan.bytes} B) moved, ${forged.length} forged refused, 8 kept entries intact, re-plan 0`
    )
  }

  // ---- ae. document index — artifacts (md, html tags stripped, txt, json; no images/svg/>1MB) + library, MCP secrets never indexed
  {
    const bad: string[] = []
    const D = makeFixture('illithid-m7-D-')
    initLibrary(D)
    const lib = libraryRoot(D)
    const put = (rel: string, text: string | Buffer): string => {
      const p = join(lib, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, text)
      return p
    }
    put('rules/r1.md', '# rule\n\uD615\uD0DC\uC18C rule body alphaRule\n')
    put('rules/notes.txt', 'rules non-md NOTINDEXEDRULE')
    put('agents/ag1.md', '---\nname: ag1\n---\nagent instructions agentBravo\n')
    put('memory/feedback/m1.md', 'memory note memCharlie \uAC00\uB098\n')
    put('skills/sk1/SKILL.md', '---\nname: sk1\n---\nskill doc skillDelta\n')
    const skScript = put('skills/sk1/scripts/run.py', 'print("skillScriptEcho")\n')
    put('skills/sk1/bin.pyc', Buffer.from([0, 1, 2, 3]))
    put('skills/sk1/weird.md', Buffer.concat([Buffer.from('BINARYMDTEXT'), Buffer.from([0, 0, 0])]))
    put('mcps/srv.json', JSON.stringify({ transport: 'http', url: 'https://example.invalid/?token=URLSECRETTOKEN', headers: { Authorization: 'secret:srv/headers/Authorization' }, env: { K: 'ENVSECRETVAL' }, bearerEnv: 'BEARERENVNAME', _: 'mcp description omegaMcp' }))
    put('mcps/_order.json', '["srv"]')
    put('artifacts/proj/manifest.json', JSON.stringify({ tool: 'Claude Code' }))
    put('artifacts/proj/a.md', '# Artifact A\nartifact markdown alphaRule shared\n')
    put('artifacts/proj/b.html', '<html><head><title>B</title><style>.clsStyleX{color:red}</style><script>var SCRIPTSECRET=1</script></head><body><!-- COMMENTX --><p>Hello &amp; <b>bold</b>word &#x41;&#66;</p></body></html>')
    put('artifacts/proj/c.txt', 'plain text txtFoxtrot')
    put('artifacts/proj/d.json', '{"k": "jsonGolf"}')
    put('artifacts/proj/e.svg', '<svg><text>SVGTEXTHOTEL</text></svg>')
    put('artifacts/proj/f.csv', 'csvIndia,1')
    put('artifacts/proj/big.md', 'BIGDOCJULIET ' + 'x'.repeat(1024 * 1024))

    const r1 = indexAllDocs(D)
    // rule, agent, memory, skill×2 (SKILL.md, run.py; weird.md binary skipped), mcp, artifacts a/b/c/d
    if (r1.docs !== 11 || r1.indexed !== 10 || r1.skipped !== 1) bad.push(`first index docs ${r1.docs} indexed ${r1.indexed} skipped ${r1.skipped}`)
    const keys = (q: string, o: Parameters<typeof searchDocs>[2] = {}): string[] =>
      searchDocs(D, q, o).results.map((x) => `${x.kind}:${x.key.replace(/^.*\/artifacts\//, '')}`).sort()
    const expect = (q: string, want: string[], o: Parameters<typeof searchDocs>[2] = {}): void => {
      const got = keys(q, o)
      if (got.join() !== [...want].sort().join()) bad.push(`"${q}" → [${got.join(', ')}]`)
    }
    const artKey = (name: string): string => {
      const hit = searchDocs(D, name === 'a.md' ? 'artifact markdown' : name === 'b.html' ? 'Hello' : name === 'c.txt' ? 'txtFoxtrot' : 'jsonGolf').results[0]
      return hit ? `artifact:${hit.key.replace(/^.*\/artifacts\//, '')}` : `artifact:?${name}`
    }
    const A = artKey('a.md')
    expect('alphaRule', ['rule:r1.md', A])
    expect('alphaRule', ['rule:r1.md'], { kind: 'rule' })
    expect('agentBravo', ['agent:ag1'])
    expect('memCharlie', ['memory:feedback/m1.md'])
    expect('skillDelta', ['skill:sk1/SKILL.md'])
    expect('skillScriptEcho', ['skill:sk1/scripts/run.py'])
    expect('omegaMcp', ['mcp:srv'])
    expect('txtFoxtrot', [artKey('c.txt')])
    expect('jsonGolf', [artKey('d.json')])
    expect('Hello & bold word AB', [artKey('b.html')])
    expect('\uD615\uD0DC\uC18C', ['rule:r1.md'])
    expect('\uAC00\uB098', ['memory:feedback/m1.md'])
    if (searchDocs(D, '\uAC00\uB098').mode !== 'like' || searchDocs(D, 'alphaRule').mode !== 'fts') bad.push('mode detection')
    for (const q of ['URLSECRETTOKEN', 'ENVSECRETVAL', 'secret:srv', 'Authorization', 'BEARERENVNAME', 'example.invalid', 'SCRIPTSECRET', 'clsStyleX', 'COMMENTX', '<b>', '&amp;', 'SVGTEXTHOTEL', 'csvIndia', 'BIGDOCJULIET', 'BINARYMDTEXT', 'NOTINDEXEDRULE'])
      if (searchDocs(D, q).results.length) bad.push(`not-indexed text found: ${q}`)
    const title = searchDocs(D, 'artifact markdown').results[0]
    if (title?.title !== 'Artifact A' || title.tool !== 'claude') bad.push(`artifact title/tool ${title?.title}/${title?.tool}`)
    for (const q of ['alphaRule', '\uAC00\uB098'])
      for (const h of searchDocs(D, q).results)
        if (!h.marks.length || h.marks.some(([a, b]) => h.snippet.slice(a, b).toLowerCase() !== q.toLowerCase())) bad.push(`highlight "${q}" ${h.kind}`)
    expect('alphaRule', [A], { tool: 'claude' })
    expect('alphaRule', [], { tool: 'codex' })
    for (const q of ['"x', 'a"b"c', 'AND OR', '100%', '_x'])
      try {
        searchDocs(D, q)
      } catch (e) {
        bad.push(`search exception "${q}": ${(e as Error).message}`)
      }
    if (htmlToText('<p>a&lt;b&gt;&quot;c&quot;&nbsp;&#169;</p>') !== 'a<b>"c" ©') bad.push(`htmlToText ${htmlToText('<p>a&lt;b&gt;&quot;c&quot;&nbsp;&#169;</p>')}`)

    // searchAll: grouped by kind, sessions share the file
    await indexSessions(D, [])
    const all = searchAll(D, 'alphaRule')
    if (all.docs.rule.length !== 1 || all.docs.artifact.length !== 1 || all.docs.skill.length || all.sessions.results.length) bad.push('searchAll groups')
    if (indexStatus(D).docs !== 10) bad.push(`indexStatus docs ${indexStatus(D).docs}`)

    // idempotent
    const dbFile = searchIndexPath(D)
    const h0 = sha(readFileSync(dbFile))
    const r2 = indexAllDocs(D)
    if (r2.indexed || r2.removed || r2.changes || sha(readFileSync(dbFile)) !== h0) bad.push(`re-run writes ${r2.changes} indexed ${r2.indexed}`)
    // edit → only that doc; old text gone
    const t1 = new Date(Date.now() + 5000)
    put('rules/r1.md', '# rule\nreplaced body kiloEdit\n')
    utimesSync(join(lib, 'rules/r1.md'), t1, t1)
    const r3 = indexAllDocs(D)
    if (r3.indexed !== 1 || r3.removed) bad.push(`edit indexed ${r3.indexed} removed ${r3.removed}`)
    expect('kiloEdit', ['rule:r1.md'])
    expect('alphaRule', [A])
    // delete → removed
    unlinkSync(skScript)
    const r4 = indexAllDocs(D)
    if (r4.removed !== 1 || r4.indexed) bad.push(`delete removed ${r4.removed} indexed ${r4.indexed}`)
    expect('skillScriptEcho', [])
    // an indexed file becoming too large is dropped
    put('artifacts/proj/c.txt', 'txtFoxtrot ' + 'y'.repeat(1024 * 1024))
    indexAllDocs(D)
    expect('txtFoxtrot', [])
    if (indexAllDocs(D).changes) bad.push('re-run writes after delete')

    check(
      'ae. document index — artifacts md/html/txt/json + library rules/skills/memory/agents/mcp, html tags stripped, secrets/images/svg/>1MB/binary not indexed, incremental (edit, delete, size), searchAll groups',
      !bad.length,
      bad.length ? bad.join('; ') : `${r1.indexed} docs indexed, 16 excluded strings 0 hits, re-run changes 0 and file hash identical, edit 1, delete 1, oversize dropped`
    )
  }

  // ---- j. real HOME unchanged + CLI guard
  {
    const bad: string[] = []
    const cli = (args: string[]): number =>
      spawnSync('npx', ['tsx', 'src/cli/index.ts', ...args], { encoding: 'utf8', env: process.env })
        .status ?? -1
    if (cli(['init']) !== 1) bad.push('init without --home allowed')
    if (cli(['init', '--home', REAL_HOME]) !== 1) bad.push('real HOME init allowed')
    if (cli(['sync', '--apply']) !== 1) bad.push('sync --apply without --home allowed')
    if (cli(['sync', '--apply', '--home', REAL_HOME]) !== 1) bad.push('real HOME sync --apply allowed')
    if (cli(['import', 'legacy', '--apply']) !== 1) bad.push('import --apply without --home allowed')
    if (cli(['toggle', 'mcp', 'x', 'codex', 'off']) !== 1) bad.push('toggle without --home allowed')
    if (cli(['rename-migrate', '--apply']) !== 1)
      bad.push('real HOME rename-migrate --apply without --i-understand allowed')
    // fixture (symlink) whose library (active workspace) resolves inside a real app data root (whichever of ~/.illithid
    // or the previous name ~/.harnesssync exists) → refused
    const G = makeFixture('illithid-m7-G-')
    const gLink = join(G, '.illithid/workspaces/default')
    mkdirSync(join(G, '.illithid/workspaces'), { recursive: true })
    const realRoots = [DEFAULT_LIBRARY_DIR, ...LEGACY_APP_LIBRARY_DIRS]
      .map((d) => join(REAL_HOME, d))
      .filter((p) => existsSync(p))
    if (!realRoots.length) bad.push('no real app data root — cannot verify guard')
    for (const real of realRoots) {
      symlinkSync(real, gLink)
      if (cli(['init', '--home', G]) !== 1)
        bad.push(`fixture init pointing the library inside real ${real.replace(REAL_HOME, '~')} allowed`)
      if (cli(['import', 'legacy', '--apply', '--home', G]) !== 1)
        bad.push(`real ${real.replace(REAL_HOME, '~')} library import allowed`)
      unlinkSync(gLink)
    }
    if (cli(['init', '--home', G, '--library', '~/x']) !== 1) bad.push('deprecated --library allowed')
    // works in the fixture
    if (cli(['sync', '--home', F]) !== 0) bad.push('fixture sync (plan) failed')
    if (cli(['import-sources', '--home', F]) !== 0) bad.push('import-sources failed')
    if (cli(['import', 'legacy', '--home', F]) !== 0) bad.push('import legacy (plan) failed')
    const H = makeFixture('illithid-m7-H-')
    if (cli(['init', '--home', H]) !== 0 || !existsSync(join(H, '.illithid/workspaces/default/mcps')))
      bad.push('fixture init failed')
    if (
      cli(['import', 'legacy', '--apply', '--home', H]) !== 0 ||
      listMcpServers(H).length !== legacyOrder.length
    )
      bad.push('fixture import legacy --apply failed')
    const probe1 = realHomeProbe()
    const changed = [...probe0.keys()].filter((k) => probe0.get(k) !== probe1.get(k))
    if (changed.length)
      bad.push(
        `real HOME changed ${changed.length}: ${changed.map((p) => p.replace(REAL_HOME, '~')).join(', ')}`
      )
    check(
      'j. real HOME, ~/.agents, app paths (current and previous names) unchanged, CLI write guard',
      !bad.length,
      bad.length
        ? bad.join('; ')
        : `${probe0.size} paths unchanged, 10 CLI refusals, fixture init, import legacy --apply, sync plan OK`
    )
  }
}

cleanupOnSignals()

async function main(): Promise<void> {
  let crashed = false
  try {
    await run()
  } catch (e) {
    crashed = true
    // only name, code and first message line, so no raw content leaks
    const err = e as NodeJS.ErrnoException
    console.error(
      `aborted: ${err.name}${err.code ? ` (${err.code})` : ''}: ${String(err.message).split('\n')[0].slice(0, 200)}`
    )
    console.error(
      String(err.stack ?? '')
        .split('\n')
        .slice(1, 4)
        .join('\n')
    )
  } finally {
    cleanupCopies()
    cleanupFixtures()
  }

  for (const r of rows) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}`)
    console.log(`      ${r.detail}`)
  }
  const failed = rows.filter((r) => !r.ok).length + (crashed ? 1 : 0)
  console.log(
    `\nm7-fixture ${rows.length - rows.filter((r) => !r.ok).length}/${rows.length} PASS${crashed ? ' (aborted)' : ''}`
  )
  process.exit(failed ? 1 : 0)
}

void main()
