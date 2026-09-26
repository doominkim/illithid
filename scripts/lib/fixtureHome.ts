/**
 * Shared fixture HOME utilities (apply-fixture, m7-fixture).
 * - Creates a temp directory (700); .agents is a symlink to the import source (legacy), read-only.
 *   Source = legacySource(): the real ~/.agents is retired, so this is a temp copy built by reading the real library
 *   (~/.illithid or a previous name) into the legacy layout (rules/ memory/ skills/ sync/mcp.json sync/allowlist.json).
 * - Cleanup unlinks the .agents symlink first so recursive deletion can never follow it to the target.
 */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_LIBRARY_DIR,
  LEGACY_APP_GENERATIONS,
  LEGACY_LIBRARY_DIR,
  libraryRoot
} from '../../src/engine/config'
import { LEGACY_CLAUDE_RULES_DIRS } from '../../src/engine/ruleSync'

export const REAL_HOME = homedir()
/** userData folders from previous app names (`~/Library/Application Support/<name>`) */
const LEGACY_USER_DATA_DIRS = ['harnesssync']

/**
 * Previous-app-name paths for watching the real HOME — real data from before the rename migration (library, config,
 * Claude rule copies, userData) lives here. Watched together with the new-name paths
 */
export function legacyAppProbePaths(): string[] {
  return [
    ...LEGACY_APP_GENERATIONS.flatMap((g) => [
      join(REAL_HOME, g.libraryDir),
      join(REAL_HOME, g.libraryDir, 'workspaces'),
      join(REAL_HOME, g.libraryDir, 'workspaces', 'default'),
      join(REAL_HOME, g.libraryDir, 'workspaces', 'default', 'rules'),
      join(REAL_HOME, g.configDir),
      join(REAL_HOME, g.configDir, 'state.json')
    ]),
    ...LEGACY_CLAUDE_RULES_DIRS.map((d) => join(REAL_HOME, '.claude/rules', d)),
    ...LEGACY_USER_DATA_DIRS.map((d) => join(REAL_HOME, 'Library/Application Support', d)),
    join(REAL_HOME, 'Library/Application Support', 'illithid')
  ]
}
export const TMP = realpathSync(tmpdir())

const fixtures: { dir: string; prefix: string }[] = []

export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

const LEGACY_SRC_PREFIX = 'illithid-legacy-src-'
let legacySrcRoot: string | null = null

const hasMd = (d: string): boolean =>
  existsSync(d) && readdirSync(d).some((f) => f.endsWith('.md') && !f.startsWith('.'))

/**
 * Real library to use as the import source (read-only). Order: active workspace → default workspace → pre-workspace root layout → previous name
 * (the real HOME may be in either the pre- or post-migration layout)
 */
function realLibrary(): string | null {
  for (const p of [
    libraryRoot(REAL_HOME),
    // If the active workspace is empty, use the default workspace
    join(REAL_HOME, DEFAULT_LIBRARY_DIR, 'workspaces', 'default'),
    join(REAL_HOME, DEFAULT_LIBRARY_DIR),
    // Previous name (before the rename migration): default if workspace layout, else root
    ...LEGACY_APP_GENERATIONS.flatMap((g) => [
      join(REAL_HOME, g.libraryDir, 'workspaces', 'default'),
      join(REAL_HOME, g.libraryDir)
    ])
  ]) {
    if (hasMd(join(p, 'rules'))) return p
  }
  return null
}

/** Synthetic allowlist used when the library has no permissions.json */
const SYNTHETIC_ALLOWLIST = {
  bash: [['git', 'status'], ['git', 'diff'], ['ls'], { argv: ['rg'], claudeExact: false }],
  claudeOnly: { allow: ['WebSearch'], deny: [] }
}

/**
 * Import source (legacy) directory. The real ~/.agents if present, otherwise a temp copy of the real library rewritten
 * into the legacy layout (one per process, removed by cleanupFixtures). Never writes to real paths.
 */
export function legacySource(): string {
  const real = join(REAL_HOME, LEGACY_LIBRARY_DIR)
  if (hasMd(join(real, 'rules'))) return real
  if (legacySrcRoot && existsSync(join(legacySrcRoot, '.agents')))
    return join(legacySrcRoot, '.agents')
  const lib = realLibrary()
  if (!lib) throw new Error('no import source (neither ~/.agents nor a real library exists)')
  legacySrcRoot = realpathSync(mkdtempSync(join(TMP, LEGACY_SRC_PREFIX)))
  const out = join(legacySrcRoot, '.agents')
  const noGit = (s: string): boolean => !s.includes('/.git/') && !s.endsWith('/.git')
  mkdirSync(join(out, 'rules'), { recursive: true })
  for (const f of readdirSync(join(lib, 'rules')))
    if (f.endsWith('.md') && !f.startsWith('.'))
      copyFileSync(join(lib, 'rules', f), join(out, 'rules', f))
  for (const part of ['memory', 'skills'])
    if (existsSync(join(lib, part)))
      cpSync(join(lib, part), join(out, part), {
        recursive: true,
        dereference: true,
        filter: noGit
      })
  mkdirSync(join(out, 'sync'), { recursive: true })
  const mcps = join(lib, 'mcps')
  const names = existsSync(mcps)
    ? readdirSync(mcps)
        .filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('.'))
        .map((f) => f.slice(0, -5))
    : []
  let order: string[] = []
  try {
    order = JSON.parse(readFileSync(join(mcps, '_order.json'), 'utf8')) as string[]
  } catch {
    order = []
  }
  const sorted = [
    ...order.filter((n) => names.includes(n)),
    ...names.filter((n) => !order.includes(n)).sort()
  ]
  const servers: Record<string, unknown> = {}
  for (const n of sorted) servers[n] = JSON.parse(readFileSync(join(mcps, `${n}.json`), 'utf8'))
  writeFileSync(join(out, 'sync/mcp.json'), JSON.stringify({ servers }, null, 2) + '\n')
  const perm = join(lib, 'permissions.json')
  writeFileSync(
    join(out, 'sync/allowlist.json'),
    existsSync(perm)
      ? readFileSync(perm, 'utf8')
      : JSON.stringify(SYNTHETIC_ALLOWLIST, null, 2) + '\n'
  )
  return out
}

/** prefix e.g. 'illithid-m7-A-' */
export function makeFixture(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(TMP, prefix)))
  chmodSync(dir, 0o700)
  fixtures.push({ dir, prefix })
  symlinkSync(legacySource(), join(dir, '.agents'))
  return dir
}

export function cleanupFixtures(): void {
  if (legacySrcRoot && legacySrcRoot.startsWith(join(TMP, LEGACY_SRC_PREFIX))) {
    rmSync(legacySrcRoot, { recursive: true, force: true })
    legacySrcRoot = null
  }
  for (const { dir, prefix } of fixtures.splice(0)) {
    if (!dir.startsWith(join(TMP, prefix))) continue
    const link = join(dir, '.agents')
    if (isSymlink(link)) unlinkSync(link)
    else if (existsSync(link)) throw new Error(`cleanup aborted: ${link} is not a symlink`)
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Copies fromRoot/rel → toRoot/rel (symlinks as target content). false if missing */
export function copyInto(fromRoot: string, toRoot: string, rel: string, mode = 0o600): boolean {
  const src = join(fromRoot, rel)
  if (!existsSync(src)) return false
  const dst = join(toRoot, rel)
  mkdirSync(dirname(dst), { recursive: true, mode: 0o700 })
  copyFileSync(src, dst)
  chmodSync(dst, mode)
  return true
}

/** Also cleans up on SIGINT etc. */
export function cleanupOnSignals(): void {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      cleanupFixtures()
      process.exit(130)
    })
  }
}
