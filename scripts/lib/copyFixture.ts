/**
 * Fixture HOME with a new-layout (`~/.illithid`) library (for app scenarios and write checks).
 * - The library is a **converted copy** of the import source (legacySource): rules/ skills/ memory/ as-is,
 *   sync/mcp.json → mcps/<name>.json, sync/allowlist.json → permissions.json. Never writes to the real library.
 * - The 6 target files are copied from the real HOME. Tool skill/rule directories are left empty.
 * - The import source is also copied into .agents inside the fixture (to check the legacy import source).
 * - Cleanup removes the copies first (fixtureHome.cleanupFixtures only accepts a .agents symlink).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TARGETS } from '../../src/engine/targets'
import { initLibrary, importAllFromLegacy } from '../../src/engine'
import { copyInto, isSymlink, legacySource, makeFixture, REAL_HOME, TMP } from './fixtureHome'

export const FIXTURE_LIBRARY = '.illithid'
const copies: { dir: string; prefix: string }[] = []

/** Parts to copy from a legacy-layout library (also used by m7-fixture) */
export const LEGACY_PARTS = ['rules', 'memory/MEMORY.md', 'sync/allowlist.json', 'sync/mcp.json', 'skills'] as const

/** Makes a copy of the import source (legacySource) legacy library at `to` (symlinks as content, .git excluded) */
export function copyLegacyLibrary(to: string): void {
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


/** Fixture legacy copy (~/.agents) → create and import a new library via the engine (engine conventions such as mcps/_order.json as-is) */
export function buildLibraryFromLegacy(F: string): { imported: number; errors: string[] } {
  initLibrary(F)
  const all = importAllFromLegacy(F)
  const errors = all.results.filter((r) => r.status !== 'imported').map((r) => `${r.kind}:${r.name} ${r.status}${r.reason ? ` (${r.reason})` : ''}`)
  return { imported: all.results.length - errors.length, errors }
}

/** prefix e.g. 'illithid-m7c-'. withLibrary=false means no library (first-run flow) */
export function makeCopyFixture(prefix: string, withLibrary = true): string {
  const F = makeFixture(prefix)
  const link = join(F, '.agents')
  if (!isSymlink(link)) throw new Error('fixture .agents is not a symlink')
  unlinkSync(link)
  // Legacy library copy (import source)
  copyLegacyLibrary(link)
  for (const t of TARGETS) {
    if (!copyInto(REAL_HOME, F, t.rel)) throw new Error(`${t.rel} missing in real HOME`)
  }
  for (const d of ['.claude/skills', '.codex/skills', '.claude/rules', '.config/opencode']) {
    mkdirSync(join(F, d), { recursive: true, mode: 0o700 })
  }
  copies.push({ dir: F, prefix })
  if (withLibrary) buildLibraryFromLegacy(F)
  return F
}

/** env filling ${VAR}s referenced by library mcps with fake values (keeps real tokens out of the fixture) */
export function fakeEnv(F: string): Record<string, string> {
  const env: Record<string, string> = {}
  const scan = (text: string): void => {
    for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) env[m[1]] = `fixture-value-${m[1].toLowerCase()}`
  }
  for (const p of [join(F, '.agents/sync/mcp.json')]) if (existsSync(p)) scan(readFileSync(p, 'utf8'))
  return env
}

/** For import candidates: creates one skill that exists only on the tool side */
export function seedToolOnlySkill(F: string, tool: 'claude' | 'codex', name: string): void {
  const dir = join(F, tool === 'claude' ? '.claude/skills' : '.codex/skills', name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture-only skill for import test\n---\n\n# ${name}\n`)
}

/** Cleans up copies. Call before fixtureHome.cleanupFixtures */
export function cleanupCopyFixtures(): void {
  for (const { dir, prefix } of copies.splice(0)) {
    if (!dir.startsWith(join(TMP, prefix))) continue
    for (const d of ['.agents', FIXTURE_LIBRARY]) {
      const p = join(dir, d)
      if (existsSync(p) && !isSymlink(p)) rmSync(p, { recursive: true, force: true })
    }
  }
}
