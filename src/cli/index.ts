import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  defaultSecretBackend,
  secretRefsOf,
  type SecretBackend,
  apply,
  applyImport,
  importAllFromLegacy,
  initLibrary,
  libraryExists,
  libraryRoot,
  listImportSources,
  planImport,
  readConfig,
  summarizeSync,
  syncAll,
  DEFAULT_LIBRARY_DIR,
  LEGACY_LIBRARY_DIR,
  LEGACY_APP_LIBRARY_DIRS,
  LEGACY_APP_CONFIG_DIRS,
  APP_CONFIG_DIR,
  MANIFEST_FILE,
  planRename,
  applyRename,
  type RenamePlan,
  type ImportSelection,
  readManifest,
  setToggle,
  MANIFEST_KINDS,
  MANIFEST_TOOLS,
  type ManifestKind,
  type ToolId,
  gitLog,
  gitStatus,
  mcpEntries,
  plan,
  readSources,
  rosterPairing,
  scanArtifacts,
  scanSessions,
  statusReport,
  tilde,
  tools,
  RESOURCES,
  TOOL_IDS,
  ALL_TARGET_IDS,
  type FileChange,
  type TargetId,
  type GitCommitInfo,
  type GitStatus,
  type StatusReport
} from '../engine'

const USAGE = `Usage: illithid <command> [options]

Library (source of truth) = ~/${DEFAULT_LIBRARY_DIR} (change with config.libraryPath). ~/.agents is the import source 'legacy'.

commands
  init             Create the library skeleton (rules/ skills/ mcps/ memory/ .gitignore). --home fixture only
                   --library <path> sets the location (saved to config), --git also runs git init
  import-sources   List import sources (legacy, tool:claude, tool:codex, tool:opencode, tool:gemini, manager:*) — read-only
  import [source]  Show import candidates from one source (rules·memory·permissions·MCP·skills). Omit for all tools and managers.
                   --apply adds conflict-free candidates to the library (--home fixture only).
                   source=legacy --apply moves all of ~/.agents at once (importAllFromLegacy)
  sync             Plan source → all targets (7 targets + Claude rule copies + skill copies). --apply writes (--home only)
  check            Non-destructively compare the source with the 6 targets
  status           Summary of resource×tool state, skill links, default models, agent roster (read-only)
  artifacts        Scan plan·artifact files (count per source location + latest 10)
  sessions         Scan Claude·Codex·OpenCode sessions (count per tool + latest 10)
  apply            Apply the source to target files (currently only works under the fixture root given by --home.
                   Applying to the real HOME is blocked until approval gate G1)
  git              Show library repo status (branch, ahead/behind, changed files, latest 5 commits)
                   Read-only. Does not fetch, so ahead/behind is as of the last fetch
  config           Show app config (~/${APP_CONFIG_DIR}/config.json)·library location·on/off summary
  toggle <kind> <name> <tool> on|off
                   Save on/off to the library ${MANIFEST_FILE} (--home fixture only; apply writes to tools)
                   kind: rules|skills|mcp|agents, tool: claude|codex|opencode|gemini
  rename-migrate   Plan moving old app-name paths (${LEGACY_APP_LIBRARY_DIRS.map((d) => '~/' + d).join(', ')},
                   ${LEGACY_APP_CONFIG_DIRS.map((d) => '~/' + d).join(', ')}) → new paths.
                   Run with --apply. On the real HOME it runs only together with --i-understand

options
  --json           Output JSON (check: sha256·line count instead of content / status: instruction length only /
                   artifacts·sessions: full list)
  --raw            Include raw file content in check --json (may contain tokens)
  --home <dir>     Root to use instead of HOME (for fixture verification)
  --repo <dir>     Repo for git (default: library root)
  --only <id,...>  Limit apply targets (${ALL_TARGET_IDS.join(', ')}. Default: first 6)
  --force          (compat) Ignored — the source always wins
  --apply          Actually write in import·sync·rename-migrate
  --replace <K,..> Keys to replace with \${KEY} in import --apply (omitted: all looksSecret keys, empty: no replacement)
  --library <path> Library location for init
  --git            Also run git init for init
  --i-understand   Run rename-migrate --apply on the real HOME`

function parseArgs(argv: string[]): {
  command?: string
  positionals: string[]
  applyFlag: boolean
  json: boolean
  raw: boolean
  home: string
  repo?: string
  homeExplicit: boolean
  only?: TargetId[]
  force: boolean
  replace?: string[]
  library?: string
  git: boolean
  iUnderstand: boolean
} {
  let command: string | undefined
  let json = false
  let raw = false
  let home = homedir()
  let repo: string | undefined
  let homeExplicit = false
  let only: TargetId[] | undefined
  let force = false
  let applyFlag = false
  let replace: string[] | undefined
  let library: string | undefined
  let git = false
  let iUnderstand = false
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') json = true
    else if (a === '--apply') applyFlag = true
    else if (a === '--raw') raw = true
    else if (a === '--home') {
      const v = argv[++i]
      if (!v) throw new Error('--home requires a path')
      home = resolve(v)
      homeExplicit = true
    } else if (a === '--force') force = true
    else if (a === '--only') {
      const known = new Set<string>(ALL_TARGET_IDS)
      const list = (argv[++i] ?? '').split(',').filter(Boolean)
      const bad = list.filter((x) => !known.has(x))
      if (!list.length || bad.length)
        throw new Error(`invalid --only targets: ${bad.join(', ') || '(empty)'}`)
      only = list as TargetId[]
    } else if (a === '--repo') repo = resolve(argv[++i] ?? '')
    else if (a === '--replace') replace = (argv[++i] ?? '').split(',').filter(Boolean)
    else if (a === '--library') {
      library = argv[++i]
      if (!library) throw new Error('--library requires a path')
    } else if (a === '--git') git = true
    else if (a === '--i-understand') iUnderstand = true
    else if (!a.startsWith('-') && !command) command = a
    else if (!a.startsWith('-') && (command === 'toggle' || command === 'import'))
      positionals.push(a)
    else throw new Error(`unknown argument: ${a}`)
  }
  if (raw && !json) throw new Error('--raw requires --json')
  if (applyFlag && command !== 'import' && command !== 'sync' && command !== 'rename-migrate')
    throw new Error('--apply is only for import·sync·rename-migrate')
  if (iUnderstand && command !== 'rename-migrate')
    throw new Error('--i-understand is only for rename-migrate')
  if (replace && command !== 'import') throw new Error('--replace is only for import')
  if ((library || git) && command !== 'init') throw new Error('--library·--git are only for init')
  return {
    command,
    positionals,
    applyFlag,
    json,
    raw,
    home,
    repo,
    homeExplicit,
    only,
    force,
    replace,
    library,
    git,
    iUnderstand
  }
}

function lineCount(text: string): number {
  return text.split('\n').length
}

/** Replace file content with sha256·line count. Raw content is emitted only with --raw. */
function redact(c: FileChange): object {
  const digest = (text: string): { sha256: string; lines: number } => ({
    sha256: createHash('sha256').update(text).digest('hex'),
    lines: lineCount(text)
  })
  return { ...c, before: digest(c.before), after: digest(c.after) }
}

const MASK = '•••'

/**
 * For --raw output: mask secrets (keychain values) written into tool files. Values are found via library secret: refs.
 * Refs that failed to read are skipped: that server stays in error, so no new value reached the file.
 */
function maskSecretValues(home: string, changes: FileChange[], secrets: SecretBackend): FileChange[] {
  const values = new Set<string>()
  for (const [, s] of mcpEntries(readSources(home).mcp))
    for (const r of secretRefsOf(s)) {
      try {
        const v = secrets.get(r.account)
        if (v) values.add(v)
      } catch {
        // server in error
      }
    }
  if (!values.size) return changes
  const sorted = [...values].sort((a, b) => b.length - a.length)
  const hide = (t: string): string => sorted.reduce((acc, v) => acc.split(v).join(MASK), t)
  return changes.map((c) => ({ ...c, before: hide(c.before), after: hide(c.after) }))
}

function printCheck(home: string, changes: FileChange[]): void {
  const s = readSources(home)
  console.log('[check] non-destructive check')
  console.log(
    `  source: rules ${s.rules.length}, allowlist bash ${s.allowlist.bash.length}, ` +
      `mcp servers ${mcpEntries(s.mcp).length}\n`
  )
  for (const c of changes) {
    if (c.error) console.log(`  !  ${c.label} — error: ${c.error}`)
    else if (c.changed) {
      console.log(`  ~  ${c.label} — ${lineCount(c.before)} lines → ${lineCount(c.after)} lines`)
    } else console.log(`  =  ${c.label} — unchanged`)
    for (const m of Object.values(c.serverErrors ?? {})) console.log(`  !  ${c.label} — ${m}`)
    for (const n of c.notes) console.log(`     ${n}`)
  }
  const errors = changes.filter((c) => c.error).length
  const changed = changes.filter((c) => c.changed && !c.error).length
  console.log(
    errors
      ? `\n${errors} error(s) — those targets cannot be applied.`
      : changed
        ? `\nDifferences — ${changed} target(s).`
        : '\nEverything is up to date.'
  )
}

/** Keep only the length of roster instructions */
function redactStatus(r: StatusReport): object {
  return {
    ...r,
    roster: {
      ...r.roster,
      rows: r.roster.rows.map((row) => ({
        name: row.name,
        entries: Object.fromEntries(
          Object.entries(row.entries).map(([tool, e]) => {
            const { instructions, ...rest } = e!
            return [tool, { ...rest, instructionsLength: instructions.length }]
          })
        )
      }))
    }
  }
}

function pad(s: string, n: number): string {
  // Table cells hold ASCII state ids only, so length is enough
  return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length)
}

function printStatus(home: string, r: StatusReport): void {
  const t = (p: string): string => tilde(home, p)
  const names = Object.fromEntries(tools(home).map((x) => [x.id, x.displayName]))
  console.log('[status] read-only')
  console.log(
    `  library: ${t(libraryRoot(home))}${libraryExists(home) ? '' : ' (missing — run init or import first)'}`
  )
  console.log(
    `  state: ${t(r.state.path)} ${r.state.exists ? (r.state.error ? `error(${r.state.error})` : `${Object.keys(r.state.state.applied).length} baselines`) : 'none'}`
  )
  if (r.sourcesError) console.log(`  !  ${r.sourcesError}`)
  console.log('')

  const W0 = 13
  const W = 14
  console.log('  ' + pad('resource', W0) + TOOL_IDS.map((id) => pad(id, W)).join(''))
  for (const res of RESOURCES) {
    const row = TOOL_IDS.map((tool) => {
      const c = r.cells.find((x) => x.resource === res && x.tool === tool)
      return pad(c?.state ?? '-', W)
    })
    console.log('  ' + pad(res, W0) + row.join(''))
  }
  console.log('  (synced up to date · needsSync needs sync · error error · notApplicable not a target)')

  const notable = r.cells.filter((c) => c.state !== 'synced' && c.state !== 'notApplicable')
  if (notable.length) {
    console.log('\nDetails')
    for (const c of notable) console.log(`  ${c.resource}/${c.tool}  ${c.state}  ${c.detail}`)
  }

  console.log(`\nSkills (canonical ${t(r.skills.canonicalDir)}: ${r.skills.canonical.length})`)
  for (const ts of r.skills.tools) {
    const where =
      ts.mode === 'symlinkDir'
        ? t(ts.dir ?? '')
        : `auto scan: ${(ts.roots ?? []).map(t).join(', ')}`
    const counts = Object.entries(ts.counts)
      .filter(([, n]) => n)
      .map(([k, n]) => `${k} ${n}`)
      .join(' · ')
    console.log(`  ${names[ts.tool]} (${where})`)
    console.log(`    ${counts || 'no entries'}${ts.error ? `  error: ${ts.error}` : ''}`)
    for (const e of ts.entries) {
      if (e.state === 'otherSource') {
        console.log(
          `    otherSource  ${e.name} → ${t(e.target ?? '')}${e.broken ? ' (target missing)' : ''}${e.inCanonical ? '' : ' [not in canonical]'}`
        )
      } else if (e.state === 'missing') {
        console.log(`    missing      ${e.name}`)
      } else if (e.state === 'copy') {
        console.log(
          `    copy         ${e.name} (${e.managed ? 'app-owned' : 'user-owned'}, ${e.sameContent ? 'same as canonical' : 'differs from canonical'})`
        )
      } else if (e.state === 'extra') {
        const bits = [
          e.kind,
          e.hidden ? 'hidden' : '',
          e.skillFiles ? `${e.skillFiles} SKILL.md loaded` : ''
        ]
          .filter(Boolean)
          .join(', ')
        const via = ts.mode === 'autoScan' && e.via ? ` @${t(e.via)}` : ''
        console.log(`    extra        ${e.name} (${bits})${via}`)
      }
    }
    for (const n of ts.notes) console.log(`    * ${n}`)
  }

  console.log('\nDefault models')
  for (const m of r.models) {
    const vals = m.values.map((v) => `${v.key}=${v.value ?? '(unset)'}`).join('  ')
    console.log(`  ${pad(names[m.tool], 12)}${m.error ? `error: ${m.error}` : vals}  (${t(m.path)})`)
  }

  const { paired, partial } = rosterPairing(r.roster)
  console.log('\nAgent roster')
  console.log(
    '  ' +
      r.roster.tools
        .map((x) => `${names[x.tool]} ${x.count}${x.errors ? ` (${x.errors} parse failures)` : ''}`)
        .join(' · ') +
      `  → ${r.roster.rows.length} rows, paired across all tools ${paired}${partial.length ? `, partial ${partial.length} (${partial.join(', ')})` : ''}`
  )
}

function countBy<T>(items: T[], key: (t: T) => string): [string, number][] {
  const m = new Map<string, number>()
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1)
  return [...m.entries()]
}

function localTime(iso: string | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function runArtifacts(home: string, json: boolean): number {
  const t0 = performance.now()
  const items = scanArtifacts(home)
  const ms = Math.round(performance.now() - t0)
  if (json) {
    process.stdout.write(JSON.stringify(items, null, 2) + '\n')
    return 0
  }
  console.log(`[artifacts] ${items.length} (${ms}ms)\n`)
  for (const [src, n] of countBy(items, (a) => a.source))
    console.log(`  ${String(n).padStart(5)}  ${src}`)
  console.log('\nBy tool')
  for (const [tool, n] of countBy(items, (a) => a.tool)) console.log(`  ${String(n).padStart(5)}  ${tool}`)
  console.log('\nLatest 10')
  for (const a of items.slice(0, 10)) {
    console.log(`  ${localTime(a.mtime)}  ${a.title}`)
    console.log(`                    ${tilde(home, a.path)}`)
  }
  return 0
}

function runSessions(home: string, json: boolean): number {
  const t0 = performance.now()
  const { sessions, errors } = scanSessions(home)
  const ms = Math.round(performance.now() - t0)
  if (json) {
    process.stdout.write(JSON.stringify({ sessions, errors }, null, 2) + '\n')
    return errors.length ? 2 : 0
  }
  console.log(`[sessions] ${sessions.length} (${ms}ms)\n`)
  for (const [tool, n] of countBy(sessions, (s) => s.tool)) {
    const sub = sessions.filter((s) => s.tool === tool && s.parentId).length
    console.log(`  ${String(n).padStart(5)}  ${tool}${sub ? ` (subagents·forks ${sub})` : ''}`)
  }
  for (const e of errors) console.log(`  !  ${e.tool} — error: ${e.message}`)
  console.log('\nLatest 10')
  for (const s of sessions.slice(0, 10)) {
    // title is part of user input, so default output truncates it to 40 chars.
    const title = s.title.length > 40 ? s.title.slice(0, 40) + '…' : s.title
    console.log(`  ${localTime(s.updatedAt)}  ${s.tool.padEnd(8)} ${title || '(untitled)'}`)
    console.log(`                    ${s.project ?? '-'}  ${tilde(home, s.path)}`)
  }
  return errors.length ? 2 : 0
}

const STATE_LABEL: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'conflict',
  T: 'typechange',
  '?': 'untracked'
}

function fileState(index: string, workingDir: string): string {
  const side = (c: string): string => STATE_LABEL[c] ?? c
  if (index === '?' && workingDir === '?') return 'untracked'
  const parts: string[] = []
  if (index.trim()) parts.push(`staged ${side(index)}`)
  if (workingDir.trim()) parts.push(side(workingDir))
  return parts.join(', ')
}

function printGit(repo: string, s: GitStatus, log: GitCommitInfo[]): void {
  console.log(`[git] ${repo} (read-only, no fetch)`)
  const track = s.upstream
    ? `ahead ${s.ahead} · behind ${s.behind} vs ${s.upstream}`
    : 'no upstream'
  console.log(`  branch: ${s.branch ?? '(detached)'} — ${track}`)
  if (s.conflicted.length) console.log(`  conflicts: ${s.conflicted.join(', ')}`)
  if (s.clean) console.log('  changed files: none')
  else {
    console.log(`  changed files: ${s.files.length}`)
    for (const f of s.files)
      console.log(`    ${f.index}${f.workingDir}  ${f.path}  (${fileState(f.index, f.workingDir)})`)
  }
  console.log(`\n  latest ${log.length} commits`)
  for (const c of log)
    console.log(`    ${c.hash.slice(0, 7)}  ${c.date.slice(0, 10)}  ${c.message}  — ${c.author}`)
}

async function runGit(repo: string, json: boolean): Promise<number> {
  const [s, log] = await Promise.all([gitStatus(repo), gitLog(repo, 5)])
  if (json) process.stdout.write(JSON.stringify({ repo, status: s, log }, null, 2) + '\n')
  else printGit(repo, s, log)
  return 0
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return resolve(a) === resolve(b)
  }
}

/** Real path of the nearest existing ancestor + the rest (symlinks resolved) */
function realish(p: string): string {
  let cur = resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse())
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return resolve(p)
      rest.push(basename(cur))
      cur = parent
    }
  }
}

/** Whether p equals or is inside root (by real path) */
function insideDir(p: string, root: string): boolean {
  const a = realish(p)
  const r = realish(root)
  return a === r || a.startsWith(r + sep)
}

/**
 * Write-command guard: a non-real-HOME root must be given with --home, and it is refused if
 * that root's library resolves to the real library (~/.illithid·old names·~/.agents), e.g. via a fixture symlink.
 */
function writeGuard(home: string, homeExplicit: boolean, what: string): string | null {
  if (!homeExplicit || sameDir(home, homedir())) {
    return (
      `Refused: ${what} is currently fixture-only. Pass --home <temp dir>.\n` +
      '      Writing to the real HOME opens after approval gate G1. No real HOME file was written.'
    )
  }
  for (const real of [
    join(homedir(), DEFAULT_LIBRARY_DIR),
    ...LEGACY_APP_LIBRARY_DIRS.map((d) => join(homedir(), d)),
    join(homedir(), LEGACY_LIBRARY_DIR)
  ]) {
    if (insideDir(libraryRoot(home), real)) {
      return `Refused: the ${what} target library resolves to the real ${tilde(homedir(), real)}. Nothing was written.`
    }
  }
  return null
}

function runConfig(home: string, json: boolean): number {
  const c = readConfig(home)
  const lib = libraryRoot(home)
  let manifest: object
  try {
    const m = readManifest(home)
    const offCount = (k: ManifestKind): number =>
      Object.values(m.manifest[k]).reduce(
        (n, t) => n + Object.values(t).filter((v) => v === false).length,
        0
      )
    manifest = {
      path: m.path,
      exists: m.exists,
      ...(m.error ? { error: m.error } : {}),
      off: Object.fromEntries(MANIFEST_KINDS.map((k) => [k, offCount(k)]))
    }
  } catch (e) {
    manifest = { error: (e as Error).name }
  }
  const out = { config: c, libraryRoot: lib, manifest }
  if (json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    return c.error ? 2 : 0
  }
  console.log('[config] read-only')
  console.log(
    `  config: ${tilde(home, c.path)} ${c.exists ? (c.error ? `error(${c.error}) — using defaults` : 'present') : 'missing — defaults'}`
  )
  console.log(`  library: ${tilde(home, lib)}${c.config.libraryPath ? ' (configured)' : ' (default)'}`)
  console.log(`  allow real apply: ${c.config.allowRealApply ? 'on' : 'off'}`)
  console.log(
    `  artifact sources: ${c.config.artifactSources ? `${c.config.artifactSources.length} (configured)` : 'default'}`
  )
  const m = manifest as {
    path?: string
    exists?: boolean
    error?: string
    off?: Record<string, number>
  }
  console.log(
    `  on/off: ${m.path ? tilde(home, m.path) : '-'} ${
      m.error
        ? `error(${m.error})`
        : m.exists
          ? `off ${Object.entries(m.off ?? {})
              .map(([k, n]) => `${k} ${n}`)
              .join(' · ')}`
          : 'none — all on'
    }`
  )
  return c.error ? 2 : 0
}

function runImportSources(home: string, json: boolean): number {
  const list = listImportSources(home)
  if (json) {
    process.stdout.write(JSON.stringify(list, null, 2) + '\n')
    return 0
  }
  console.log('[import-sources] import sources (read-only)\n')
  for (const s of list)
    console.log(
      `  ${s.available ? '+' : '-'}  ${s.id.padEnd(24)} ${tilde(home, s.path).padEnd(28)} ${s.kinds.join(',')}${s.available ? '' : `  (unavailable${s.note ? `: ${s.note}` : ''})`}`
    )
  return 0
}

function runImport(
  home: string,
  homeExplicit: boolean,
  json: boolean,
  doApply: boolean,
  sourceId: string | undefined,
  replace: string[] | undefined
): number {
  if (doApply) {
    const refused = writeGuard(home, homeExplicit, 'import --apply')
    if (refused) {
      console.error(refused)
      return 1
    }
  }
  if (doApply && sourceId === 'legacy') {
    const r = importAllFromLegacy(home, { replaceSecrets: !!replace?.length })
    if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n')
    else {
      console.log(`[import legacy --apply] ${home} — ${r.selections.length} selected\n`)
      for (const x of r.results)
        console.log(
          `  ${x.status === 'imported' ? '+' : '!'}  ${x.kind} ${x.name} ${x.status}${x.reason ? ` — ${x.reason}` : ''}`
        )
    }
    return r.results.some((x) => x.status !== 'imported') ? 2 : 0
  }
  const p = planImport(home, sourceId)
  if (!doApply) {
    if (json) {
      process.stdout.write(JSON.stringify(p, null, 2) + '\n')
      return 0
    }
    console.log(
      `[import${sourceId ? ` ${sourceId}` : ''}] import candidates (read-only) — sources: ${p.sources.map((s) => `${s.id}${s.available ? '' : '(unavailable)'}`).join(', ')}\n`
    )
    const mark = (c: { status: string }): string => (c.status === 'new' ? '+' : '!')
    console.log(`  rules ${p.rules.length}`)
    for (const c of p.rules)
      console.log(
        `    ${mark(c)}  ${c.name}  [${[...new Set(c.variants.flatMap((v) => v.sources.map((x) => x.label)))].join(', ')}]${c.conflicts.length ? `  conflicts: ${c.conflicts.join(', ')}` : ''}`
      )
    console.log(`\n  memory ${p.memory.length}`)
    for (const c of p.memory)
      console.log(
        `    ${mark(c)}  ${c.name}${c.conflicts.length ? `  conflicts: ${c.conflicts.join(', ')}` : ''}`
      )
    console.log(`\n  permissions ${p.permissions.length}`)
    for (const c of p.permissions)
      for (const v of c.variants)
        console.log(
          `    ${mark(c)}  bash ${v.counts.bash} · allow ${v.counts.allow} · deny ${v.counts.deny} · ask ${v.counts.ask}  [${v.sources.map((x) => x.label).join(', ')}]${c.conflicts.length ? `  conflicts: ${c.conflicts.join(', ')}` : ''}`
        )
    console.log(`\n  skills ${p.skills.length}`)
    for (const c of p.skills) {
      const src = c.variants.flatMap((v) => v.sources.map((x) => x.label))
      console.log(
        `    ${mark(c)}  ${c.name}  [${[...new Set(src)].join(', ')}]${c.conflicts.length ? `  conflicts: ${c.conflicts.join(', ')}` : ''}`
      )
    }
    console.log(`\n  agents ${p.agents.length}`)
    for (const c of p.agents) {
      const src = c.variants.flatMap((v) => v.sources.map((x) => x.label))
      console.log(
        `    ${mark(c)}  ${c.name}  [${[...new Set(src)].join(', ')}]${c.portability !== 'ok' ? `  ${c.portability}: ${c.reasons.join(', ')}` : ''}${c.conflicts.length ? `  conflicts: ${c.conflicts.join(', ')}` : ''}`
      )
    }
    console.log(`\n  MCP servers ${p.mcp.length}`)
    for (const c of p.mcp) {
      const tools = [...new Set(c.variants.flatMap((v) => v.tools))]
      const rep = c.variants.flatMap((v) => v.replaceable)
      const secret = rep.filter((x) => x.looksSecret).length
      console.log(
        `    ${mark(c)}  ${c.name}  [${tools.join(', ') || 'legacy'}]${rep.length ? `  ${rep.length} replacement candidates (secret ${secret}: ${rep.map((x) => `${x.key}${x.looksSecret ? '*' : ''}`).join(' ')})` : ''}${c.conflicts.length ? `  conflicts: ${c.conflicts.join(', ')}` : ''}`
      )
    }
    for (const n of p.notes) console.log(`  * ${n}`)
    return 0
  }
  const selections: ImportSelection[] = [
    ...[...p.rules, ...p.memory, ...p.permissions, ...p.skills, ...p.agents]
      .filter((c) => c.status === 'new')
      .map((c) => ({ kind: c.kind, name: c.name })),
    ...p.mcp
      .filter((c) => c.status === 'new')
      .map((c) => ({ kind: 'mcp' as const, name: c.name, ...(replace ? { replace } : {}) }))
  ]
  const results = applyImport(home, selections, sourceId, { secrets: defaultSecretBackend() })
  if (json) process.stdout.write(JSON.stringify(results, null, 2) + '\n')
  else {
    console.log(`[import --apply] ${home} — ${selections.length} conflict-free candidates\n`)
    for (const r of results)
      console.log(
        `  ${r.status === 'imported' ? '+' : '!'}  ${r.kind} ${r.name} ${r.status}${r.reason ? ` — ${r.reason}` : ''}${r.replaced?.length ? `  replaced ${r.replaced.join(',')}` : ''}`
      )
  }
  return results.some((r) => r.status !== 'imported') ? 2 : 0
}

function runInit(
  home: string,
  homeExplicit: boolean,
  json: boolean,
  library: string | undefined,
  git: boolean
): number {
  const refused = writeGuard(home, homeExplicit, 'init')
  if (refused) {
    console.error(refused)
    return 1
  }
  if (library) {
    console.error('Refused: --library is deprecated (the library is ~/.illithid/workspaces/<id>). Nothing was written.')
    return 1
  }
  const r = initLibrary(home, { git })
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n')
  else
    console.log(
      `[init] ${tilde(home, r.root)} — created ${r.created.length} (${r.created.join(', ') || 'none'}), already existed ${r.existed.length}${r.gitInitialized ? ', git init' : ''}`
    )
  return 0
}

function runSync(home: string, homeExplicit: boolean, json: boolean, doApply: boolean): number {
  if (doApply) {
    const refused = writeGuard(home, homeExplicit, 'sync --apply')
    if (refused) {
      console.error(refused)
      return 1
    }
  }
  const r = syncAll(home, process.env, { allowReal: doApply })
  const summary = summarizeSync(r)
  if (json) {
    // Do not emit raw target content
    const out = {
      libraryExists: r.libraryExists,
      refused: r.refused,
      plan: {
        targets: r.plan.targets.map(redact),
        rules: r.plan.rules,
        skills: r.plan.skills,
        agents: r.plan.agents,
        errors: r.plan.errors
      },
      results: r.results,
      summary
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  } else {
    console.log(`[sync${doApply ? ' --apply' : ''}] ${home}`)
    if (!r.libraryExists) console.log('  no library — run init or import legacy --apply first')
    if (r.refused) console.log(`  refused: ${r.refused}`)
    for (const [k, v] of Object.entries(summary).sort()) console.log(`  ${k.padEnd(28)} ${v}`)
    for (const e of r.plan.errors) console.log(`  !  ${e}`)
  }
  if (r.refused) return 1
  if (!r.results) return 0
  const bad =
    r.results.targets.some((t) => t.status === 'skipped' || t.serverErrors) ||
    r.results.rules.some((t) => t.status === 'failed' || t.status === 'refused') ||
    r.results.skills.some((t) => t.status === 'failed' || t.status === 'refused') ||
    r.results.agents.some((t) => t.status === 'failed' || t.status === 'refused')
  return bad ? 2 : 0
}

function printRenamePlan(home: string, p: RenamePlan): void {
  for (const m of p.moves)
    console.log(
      `  move ${m.what.padEnd(8)} ${tilde(home, m.from)} → ${tilde(home, m.to)}${m.replaceEmptySkeleton ? ' (replace empty skeleton)' : ''}`
    )
  if (p.generation) console.log(`  generation ${p.generation}`)
  if (p.snapshot) console.log(`  snapshot ${tilde(home, p.snapshot)}`)
  if (p.dropLibraryPath) console.log('  remove config.libraryPath (old default location)')
  for (const m of p.manifests)
    console.log(`  on/off file ${tilde(home, m.from)} → ${tilde(home, m.to)}`)
  if (p.stateRewrites) console.log(`  update ${p.stateRewrites} path strings in state.json`)
  for (const b of p.blocked) console.log(`  !  ${b}`)
  for (const f of p.followUps) console.log(`  next sync: ${f.split(home).join('~')}`)
  if (!p.needed && !p.blocked.length) console.log('  nothing to do')
}

/**
 * Rename migration. Planning works anywhere; --apply only on a fixture (--home) or the real HOME with --i-understand.
 * Moving library paths must not overlap a running app, so run it with the app closed.
 */
function runRenameMigrate(
  home: string,
  homeExplicit: boolean,
  json: boolean,
  doApply: boolean,
  iUnderstand: boolean
): number {
  const realHome = !homeExplicit || sameDir(home, homedir())
  if (!doApply) {
    const p = planRename(home)
    if (json) process.stdout.write(JSON.stringify(p, null, 2) + '\n')
    else {
      console.log(`[rename-migrate] ${realHome ? '~' : home} — plan only (run with --apply)`)
      printRenamePlan(home, p)
    }
    return p.blocked.length ? 2 : 0
  }
  if (realHome && !iUnderstand) {
    console.error(
      'Refused: rename-migrate --apply on the real HOME requires --i-understand. Nothing was written.'
    )
    return 1
  }
  const r = applyRename(home)
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n')
  else {
    console.log(`[rename-migrate --apply] ${realHome ? '~' : home} — ${r.ok ? 'done' : `refused: ${r.reason}`}`)
    if (r.ok) {
      for (const m of r.moved) console.log(`  moved ${tilde(home, m.from)} → ${tilde(home, m.to)}`)
      if (r.configUpdated) console.log('  removed config.libraryPath')
      if (r.snapshot) console.log(`  snapshot ${tilde(home, r.snapshot)}`)
      if (r.manifestsRenamed) console.log(`  renamed ${r.manifestsRenamed} on/off files`)
      if (r.stateRewrites) console.log(`  updated ${r.stateRewrites} path strings in state.json`)
      for (const f of r.plan.followUps) console.log(`  next sync: ${f.split(home).join('~')}`)
    }
  }
  return r.ok ? 0 : 2
}

function runToggle(home: string, homeExplicit: boolean, json: boolean, args: string[]): number {
  const refused = writeGuard(home, homeExplicit, 'toggle')
  if (refused) {
    console.error(refused)
    return 1
  }
  const [kind, name, tool, state] = args
  if (args.length !== 4 || (state !== 'on' && state !== 'off'))
    throw new Error(
      'usage: toggle <rules|skills|mcp|agents> <name> <claude|codex|opencode|gemini> on|off --home <dir>'
    )
  if (!(MANIFEST_KINDS as readonly string[]).includes(kind))
    throw new Error(`kind must be ${MANIFEST_KINDS.join('|')}`)
  const k = kind as ManifestKind
  if (!(MANIFEST_TOOLS[k] as readonly string[]).includes(tool))
    throw new Error(`tool for ${k} must be ${MANIFEST_TOOLS[k].join('|')}`)
  const m = setToggle(home, k, name, tool as ToolId, state === 'on')
  if (json) process.stdout.write(JSON.stringify(m, null, 2) + '\n')
  else console.log(`[toggle] ${k}/${name} ${tool} → ${state} (saved only — apply writes to tools)`)
  return 0
}

/** Real HOME protection: write only when --home names a root other than the real HOME (until G1) */
function runApply(
  home: string,
  homeExplicit: boolean,
  json: boolean,
  only: TargetId[] | undefined,
  force: boolean
): number {
  if (!homeExplicit || sameDir(home, homedir())) {
    console.error(
      'Refused: apply is currently fixture-only. Pass --home <temp dir>.\n' +
        '      Applying to the real HOME opens after approval gate G1. No real HOME file was written.'
    )
    return 1
  }
  const results = apply(home, process.env, only, { force })
  if (json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n')
  } else {
    console.log(`[apply] ${home}${force ? ' (--force)' : ''}\n`)
    const mark = { written: '+', unchanged: '=', skipped: '!' } as const
    for (const r of results) {
      const why = r.reason ? ` — ${r.reason}${r.detail ? `: ${r.detail}` : ''}` : ''
      const bak = r.backupPath ? ` (backup ${tilde(home, r.backupPath)})` : ''
      console.log(`  ${mark[r.status]}  ${r.label} ${r.status}${why}${bak}`)
    }
  }
  return results.some((r) => r.status === 'skipped') ? 2 : 0
}

async function main(): Promise<number> {
  const {
    command,
    positionals,
    applyFlag,
    json,
    raw,
    home,
    repo,
    homeExplicit,
    only,
    force,
    replace,
    library,
    git,
    iUnderstand
  } = parseArgs(process.argv.slice(2))
  if ((only || force) && command !== 'apply') throw new Error('--only·--force are only for apply')
  if (command === 'config') return runConfig(home, json)
  if (command === 'init') return runInit(home, homeExplicit, json, library, git)
  if (command === 'import-sources') return runImportSources(home, json)
  if (command === 'import')
    return runImport(home, homeExplicit, json, applyFlag, positionals[0], replace)
  if (command === 'sync') return runSync(home, homeExplicit, json, applyFlag)
  if (command === 'rename-migrate')
    return runRenameMigrate(home, homeExplicit, json, applyFlag, iUnderstand)
  if (command === 'toggle') return runToggle(home, homeExplicit, json, positionals)
  if (command === 'apply') return runApply(home, homeExplicit, json, only, force)
  if (raw && command !== 'check') throw new Error('--raw is only for check')
  if (repo && command !== 'git') throw new Error('--repo is only for git')
  if (command === 'git') return runGit(repo ?? libraryRoot(home), json)
  if (command === 'artifacts') return runArtifacts(home, json)
  if (command === 'sessions') return runSessions(home, json)
  if (command === 'status') {
    const r = statusReport(home, process.env)
    if (json) process.stdout.write(JSON.stringify(redactStatus(r), null, 2) + '\n')
    else printStatus(home, r)
    return r.cells.some((c) => c.state === 'error') ? 2 : 0
  }
  if (command !== 'check') {
    console.error(USAGE)
    return command ? 1 : 0
  }
  const secrets = defaultSecretBackend()
  const changes = plan(home, process.env, undefined, secrets)
  if (json) {
    const out = raw ? maskSecretValues(home, changes, secrets) : changes.map(redact)
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  } else printCheck(home, changes)
  return changes.some((c) => c.error || c.serverErrors) ? 2 : 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    console.error((e as Error).message)
    process.exitCode = 1
  }
)
