/**
 * M7c write scenario (fixture HOME, new library layout). Launches the built app with ILLITHID_HOME=<fixture> and verifies via real clicks.
 *
 * A. First run: no library → created automatically on app start
 * B. Settings: turn on allow real apply (confirm modal) → immediate sync writes tool files and skill copies
 * C. Skill codex off (pill) → auto sync immediately moves the codex copy to backup (no sync screen)
 * D. Save rule edit → auto sync → reflected in the AGENTS.md block
 * E. Add MCP server → auto sync → server appears in 3 tool config files (no raw secret on screen)
 * F. Import: pick source (Codex) → 1 tool-only skill → appears in the library
 * Per-step screenshots at /tmp/illithid-screens/m7c-*.png. Real HOME is verified unchanged via mtime.
 *
 * Run: electron-vite build && npx tsx scripts/m7c-scenario.ts
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type Page } from 'playwright-core'
import { TARGETS } from '../src/engine/targets'
import {
  APP_CONFIG_DIR,
  DEFAULT_LIBRARY_DIR,
  libraryRoot,
  workspacesRoot
} from '../src/engine/config'
import { LEGACY_MANIFEST_FILES } from '../src/engine/manifest'
import { BACKUP_SUFFIX, LEGACY_BACKUP_SUFFIXES } from '../src/engine/write'
import { readConfig, readState } from '../src/engine'
import { planSyncAll } from '../src/engine/sync'
import {
  cleanupFixtures,
  cleanupOnSignals,
  legacyAppProbePaths,
  REAL_HOME
} from './lib/fixtureHome'
import {
  buildLibraryFromLegacy,
  cleanupCopyFixtures,
  fakeEnv,
  FIXTURE_LIBRARY,
  makeCopyFixture,
  seedToolOnlySkill
} from './lib/copyFixture'

const ROOT = resolve(__dirname, '..')
const OUT = '/tmp/illithid-screens'
// ko UI text (common.loading in ko.json)
const LOADING = '\uBD88\uB7EC\uC624\uB294 \uC911'
const rows: { step: string; ok: boolean; detail: string; shot?: string }[] = []
const check = (step: string, ok: boolean, detail: string, shot?: string): void => {
  rows.push({ step, ok, detail, shot })
}

function probe(): Map<string, string> {
  const m = new Map<string, string>()
  const paths = [
    ...TARGETS.filter((t) => t.id !== 'claudeMcp').map((t) => join(REAL_HOME, t.rel)),
    ...TARGETS.map((t) => join(REAL_HOME, t.rel) + BACKUP_SUFFIX),
    ...LEGACY_BACKUP_SUFFIXES.flatMap((sfx) => TARGETS.map((t) => join(REAL_HOME, t.rel) + sfx)),
    join(REAL_HOME, APP_CONFIG_DIR),
    join(REAL_HOME, DEFAULT_LIBRARY_DIR),
    join(REAL_HOME, DEFAULT_LIBRARY_DIR, 'rules'),
    workspacesRoot(REAL_HOME),
    libraryRoot(REAL_HOME),
    join(libraryRoot(REAL_HOME), 'rules'),
    ...legacyAppProbePaths(),
    join(REAL_HOME, '.agents'),
    ...LEGACY_MANIFEST_FILES.map((f) => join(REAL_HOME, '.agents', f)),
    join(REAL_HOME, '.agents/sync/mcp.json'),
    join(REAL_HOME, '.agents/rules'),
    join(REAL_HOME, '.agents/skills'),
    join(REAL_HOME, '.claude/skills'),
    join(REAL_HOME, '.codex/skills'),
    join(REAL_HOME, '.claude/rules')
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

async function waitLoaded(page: Page): Promise<void> {
  await page.waitForFunction((text) => !document.body.innerText.includes(text), LOADING, {
    timeout: 60_000
  })
  await page.waitForTimeout(200)
}
async function go(page: Page, menu: string): Promise<void> {
  await page.click(`[data-menu="${menu}"]`)
  await waitLoaded(page)
}
async function shot(page: Page, name: string): Promise<string> {
  const file = join(OUT, `m7c-${name}.png`)
  await page.waitForTimeout(300)
  await page.screenshot({ path: file })
  return file
}
async function confirm(page: Page): Promise<void> {
  await page.click('[data-testid="confirm-ok"]')
  await page.waitForTimeout(600)
  await waitLoaded(page)
}
let stepNo = 0
const STEP_TIMEOUT = 30_000
/** Each step must finish within 30s — if it ends up waiting for human input, cut it off as FAIL */
async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  stepNo++
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error(`step timeout ${STEP_TIMEOUT / 1000}s`)),
          STEP_TIMEOUT
        ).unref()
      )
    ])
    // The script closes any open modal or sheet
    await page.keyboard.press('Escape').catch(() => {})
  } catch (e) {
    const file = join(OUT, `m7c-fail-${stepNo}.png`)
    try {
      await page.screenshot({ path: file })
    } catch {
      // The window may have closed
    }
    const active = await page
      .evaluate(() => document.querySelector('.ac-nav[data-active]')?.textContent ?? '?')
      .catch(() => '?')
    check(
      name,
      false,
      `exception: ${(e as Error).message.split('\n').slice(0, 3).join(' | ')} (active menu: ${active})`,
      file
    )
  }
}

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '')
// ko UI text (part of sync.watchSynced in ko.json)
const t_watchText = (): string => '\uC790\uB3D9 \uB3D9\uAE30\uD654'

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const before = probe()
  const F = makeCopyFixture('illithid-m7c-', false) // start without a library (first-run flow)
  cleanupOnSignals()
  seedToolOnlySkill(F, 'codex', 'm7c-import-skill')
  // One session for transcript checks: copy the smallest jsonl from the real ~/.claude/projects into the fixture
  const projRoot = join(REAL_HOME, '.claude/projects')
  let seededSession = false
  if (existsSync(projRoot)) {
    const files = readdirSync(projRoot).flatMap((d) =>
      existsSync(join(projRoot, d)) && lstatSync(join(projRoot, d)).isDirectory()
        ? readdirSync(join(projRoot, d))
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => join(projRoot, d, f))
        : []
    )
    // Smallest session that actually has user and AI messages (empty sandbox sessions excluded)
    const hasChat = (f: string): boolean => {
      const txt = readFileSync(f, 'utf8')
      return (
        (txt.match(/"type":"user"/g) ?? []).length >= 2 &&
        (txt.match(/"type":"assistant"/g) ?? []).length >= 2
      )
    }
    const smallest = files
      .map((f) => ({ f, n: lstatSync(f).size }))
      .filter((x) => x.n > 4000 && x.n < 400_000)
      .sort((a, b) => a.n - b.n)
      .find((x) => hasChat(x.f))
    if (smallest) {
      const dst = join(F, '.claude/projects/-fixture-project')
      mkdirSync(dst, { recursive: true, mode: 0o700 })
      copyFileSync(smallest.f, join(dst, smallest.f.split('/').pop()!))
      seededSession = true
    }
  }
  // Backup remote: bare repo inside the fixture (no real remote access)
  const bare = join(F, 'backup-remote.git')
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare])
  const LIB = libraryRoot(F)
  const env = {
    ...process.env,
    ...fakeEnv(F),
    HOME: F,
    ILLITHID_HOME: F,
    ILLITHID_TEST: '1',
    ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-m7c-userdata-'))
  } as Record<string, string>
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE

  // ILLITHID_TEST=1 hides the window (offscreen) — it doesn't show on the user's screen or steal focus
  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js')],
    cwd: ROOT,
    env,
    timeout: 60_000
  })
  const consoleErrors: string[] = []
  try {
    const page = await app.firstWindow()
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
    page.on('pageerror', (e) => consoleErrors.push(e.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1400, 900))
    await page.evaluate(() => {
      localStorage.setItem('illithid-language', 'ko')
      localStorage.setItem('illithid-color-scheme', 'light')
    })
    await page.reload()
    await page.waitForSelector('[data-menu="dashboard"]')
    await waitLoaded(page)

    // ---- A. First run → library created automatically (no start screen)
    await step(page, 'A. first run → library created automatically', async () => {
      const deadline = Date.now() + 20_000
      const want = ['rules', 'skills', 'mcps', 'memory']
      while (Date.now() < deadline && !want.every((d) => existsSync(join(LIB, d))))
        await page.waitForTimeout(300)
      await waitLoaded(page)
      const dirs = want.filter((d) => existsSync(join(LIB, d)))
      const cfg = readConfig(F)
      const s1 = await shot(page, '01-after-init')
      check(
        'A. first run → library created automatically',
        dirs.length === 4,
        `created ${dirs.join(',')} · config ${cfg.exists ? 'present' : 'absent'}`,
        s1
      )
    })

    // Library content: imported by the engine's importAllFromLegacy from the fixture's legacy copy (~/.agents)
    const legacyImport = buildLibraryFromLegacy(F)
    check(
      'A2. importAllFromLegacy → import rules, skills, MCP, memory, permissions',
      legacyImport.imported > 0 && legacyImport.errors.length === 0,
      `imported ${legacyImport.imported} · errors ${legacyImport.errors.slice(0, 3).join(' | ') || 0}`
    )
    const skills = existsSync(join(LIB, 'skills'))
      ? readdirSync(join(LIB, 'skills')).filter((n) => !n.startsWith('.'))
      : []
    const skill = skills.find((n) => n === 'find-skills') ?? skills[0]

    // ---- B. Allow real apply → immediate sync
    await step(page, 'B. allow real apply → immediate sync', async () => {
      await go(page, 'settings')
      await page.waitForSelector('[data-testid="allow-apply"]')
      await page.locator('[data-testid="allow-apply"]').click({ force: true })
      await page.waitForSelector('[data-testid="confirm-ok"]')
      await confirm(page)
      // There is no sync screen — call the app's sync API directly
      await page.evaluate(() =>
        (window as unknown as { api: { syncNow: () => Promise<unknown> } }).api.syncNow()
      )
      await page.waitForTimeout(1500)
      await waitLoaded(page)
      const plan = planSyncAll(F, env)
      const left =
        plan.targets.filter((c) => c.changed && !c.error).length +
        plan.skills.filter((x) => x.action === 'copy').length
      const managed = readState(F).state.skills ?? {}
      const s = await shot(page, '02-sync-after-allow')
      check(
        'B. allow real apply → sync now → 0 pending changes, skill copies created',
        !!readConfig(F).config.allowRealApply &&
          left === 0 &&
          Object.keys(managed.codex ?? {}).length > 0,
        `allowRealApply on · pending changes ${left} · codex copies ${Object.keys(managed.codex ?? {}).length}`,
        s
      )
    })

    // ---- C. Skill codex off → auto sync deletes immediately (moved to backup)
    await step(page, 'C. skill codex off → deleted immediately (backup)', async () => {
      await go(page, 'skills')
      const card = page.locator(`[data-card="${skill}"]`)
      await card.waitFor()
      await card.locator('.ac-pill[data-tool="codex"]').click()
      await page.waitForTimeout(1500)
      await waitLoaded(page)
      const s1 = await shot(page, '03-skill-codex-off')
      const gone = !existsSync(join(F, '.codex/skills', skill))
      const backups = existsSync(join(F, '.config/illithid/backups/deleted'))
        ? readdirSync(join(F, '.config/illithid/backups/deleted'))
        : []
      const cand = planSyncAll(F, env).skills.filter((x) => x.action === 'deleteCandidate').length
      const s3 = await shot(page, '03-after-delete')
      check(
        'C. skill codex off → auto sync deletes immediately (backup) → 0 candidates',
        gone && backups.length === 1 && cand === 0,
        `copy removed ${gone} · backups ${backups.length} · remaining candidates ${cand} (${s1})`,
        s3
      )
    })

    // ---- D. Save rule edit → auto sync
    await step(page, 'D. save rule edit → auto sync', async () => {
      await go(page, 'rules')
      await page.locator('[data-card]').first().click()
      await page.waitForSelector('[data-testid="tab-edit"]')
      await page.click('[data-testid="tab-edit"]')
      const ta = page.locator('.ac-sheet textarea')
      await ta.waitFor()
      const cur = await ta.inputValue()
      const marker = `m7c-scenario-${Date.now()}`
      await ta.fill(cur + `\n\n- ${marker}\n`)
      const s1 = await shot(page, '04-rule-edit')
      await page.click('[data-testid="editor-save"]')
      await page.waitForTimeout(1500)
      await waitLoaded(page)
      await page.keyboard.press('Escape')
      const agentsMd = read(join(F, '.codex/AGENTS.md'))
      const left = planSyncAll(F, env)
        .targets.filter((c) => c.changed && !c.error)
        .map((c) => c.id)
      const s2 = await shot(page, '04-rule-synced')
      check(
        'D. save rule edit → immediate sync → reflected in AGENTS.md block, 0 pending changes',
        agentsMd.includes(marker) && left.length === 0,
        `in AGENTS.md ${agentsMd.includes(marker)} · pending changes ${left.join(',') || 0} (${s1})`,
        s2
      )
    })

    // ---- E. Add MCP server → auto sync → 3 tool files
    await step(page, 'E. add MCP server → auto sync', async () => {
      await go(page, 'mcp')
      await page.click('[data-testid="mcp-new"]')
      await page.fill('[data-testid="mcp-name"]', 'm7c-demo')
      await page.fill('[data-testid="mcp-url"]', 'https://example.com/mcp')
      const s1 = await shot(page, '05-mcp-new')
      await page.click('[data-testid="mcp-save"]')
      await page.waitForTimeout(1500)
      await waitLoaded(page)
      await page.keyboard.press('Escape')
      const inClaude = read(join(F, '.claude.json')).includes('"m7c-demo"')
      const inCodex = read(join(F, '.codex/config.toml')).includes('m7c-demo')
      const inOpencode = read(join(F, '.config/opencode/opencode.json')).includes('"m7c-demo"')
      const body = await page.evaluate(() => document.body.innerText)
      const leaked = /fixture-value-/.test(body)
      const s2 = await shot(page, '05-mcp-synced')
      check(
        'E. add MCP server → immediate sync → appears in claude/codex/opencode files, no raw secret on screen',
        inClaude && inCodex && inOpencode && !leaked,
        `claude ${inClaude} · codex ${inCodex} · opencode ${inOpencode} · secret exposed ${leaked} (${s1})`,
        s2
      )
    })

    // ---- E2. Library watch: rule edited directly in an editor → auto sync
    await step(page, 'E2. edit library file directly → watch → auto sync', async () => {
      const ruleFiles = readdirSync(join(LIB, 'rules')).filter((f) => f.endsWith('.md'))
      const target = join(LIB, 'rules', ruleFiles[0])
      const marker = `m7c-watch-${Date.now()}`
      writeFileSync(target, readFileSync(target, 'utf8') + `\n- ${marker}\n`)
      // watch (800ms debounce) → sync → notification. Wait generously (evaluate callback is a string due to the tsx __name issue)
      await page
        .waitForFunction(
          `document.body.innerText.includes(${JSON.stringify(t_watchText())})`,
          undefined,
          { timeout: 15_000 }
        )
        .catch(() => {})
      await page.waitForTimeout(2500)
      const agentsMd = read(join(F, '.codex/AGENTS.md'))
      const s1 = await shot(page, '05b-watch-synced')
      check(
        'E2. edit library file directly → watch → auto sync → reflected in AGENTS.md',
        agentsMd.includes(marker),
        `in AGENTS.md ${agentsMd.includes(marker)}`,
        s1
      )
    })

    // ---- F. Import (source: Codex)
    await step(page, 'F. pick import source → apply 1 item', async () => {
      await go(page, 'dashboard')
      await page.click('[data-testid="import-open"]')
      await page.waitForSelector('[data-testid="import-source-tool:codex"]', { timeout: 20_000 })
      const s1 = await shot(page, '06-import-sources')
      await page.click('[data-testid="import-source-tool:codex"]')
      await page.waitForSelector('[data-testid="import-skill-m7c-import-skill"]', {
        timeout: 30_000
      })
      await page.locator('[data-testid="import-skill-m7c-import-skill"]').check({ force: true })
      const s2 = await shot(page, '06-import-plan')
      await page.click('[data-testid="import-apply"]')
      await page.waitForSelector('[data-testid="import-close"]', { timeout: 15_000 })
      const imported = existsSync(join(LIB, 'skills/m7c-import-skill/SKILL.md'))
      const s3 = await shot(page, '06-import-done')
      await page.click('[data-testid="import-close"]')
      check(
        'F. import: pick source (Codex) → 1 tool-only skill → appears in library',
        imported,
        `${FIXTURE_LIBRARY}/skills/m7c-import-skill ${imported} (${s1}, ${s2})`,
        s3
      )
    })
    // ---- G1. Memory edit → auto sync
    await step(page, 'G1. create and edit memory note', async () => {
      await go(page, 'memory')
      await page.click('[data-testid="memory-new"]')
      await page.fill('[data-testid="memory-new-name"]', 'feedback/m7c-note')
      await page.click('[data-testid="memory-new-ok"]')
      await page.waitForTimeout(1200)
      await waitLoaded(page)
      await page.waitForSelector('[data-testid="tab-edit"]', { timeout: 15_000 })
      await page.click('[data-testid="tab-edit"]')
      const ta = page.locator('.ac-sheet textarea')
      await ta.waitFor()
      await ta.fill('# m7c-note\n\n- memory edit scenario\n')
      await page.click('[data-testid="editor-save"]')
      await page.waitForTimeout(1200)
      await waitLoaded(page)
      await page.keyboard.press('Escape')
      const file = join(LIB, 'memory/feedback/m7c-note.md')
      const s1 = await shot(page, '07-memory')
      check(
        'G1. create/edit/save memory note → library file',
        existsSync(file) && read(file).includes('memory edit scenario'),
        `${existsSync(file) ? 'file present' : 'file missing'}`,
        s1
      )
    })

    // ---- G3. Backup: connect (bare) → snapshot → change library → restore
    await step(page, 'G3. backup connect, snapshot, restore', async () => {
      await go(page, 'backup')
      await page.waitForSelector('[data-testid="backup-url"]')
      await page.fill('[data-testid="backup-url"]', bare)
      await page.click('[data-testid="backup-connect"]')
      await page.waitForTimeout(2500)
      const s1 = await shot(page, '09-backup-connected')
      await page.click('[data-testid="backup-now"]')
      await page.waitForTimeout(3000)
      const remoteLog = ((): string[] => {
        try {
          return execFileSync('git', ['--git-dir', bare, 'log', '--oneline', 'main'], {
            encoding: 'utf8'
          })
            .trim()
            .split('\n')
            .filter(Boolean)
        } catch {
          return []
        }
      })()
      // Change the library (delete one rule), then restore
      const ruleFiles = readdirSync(join(LIB, 'rules')).filter((f) => f.endsWith('.md'))
      const victim = join(LIB, 'rules', ruleFiles[ruleFiles.length - 1])
      rmSync(victim)
      await page.waitForTimeout(2500)
      await page.click('[data-menu="backup"]')
      await page.waitForTimeout(800)
      const firstRestore = page.locator('[data-testid^="backup-restore-"]').first()
      await firstRestore.waitFor({ timeout: 15_000 })
      const s2 = await shot(page, '09-backup-history')
      await firstRestore.click()
      await page.waitForSelector('[data-testid="confirm-ok"]')
      await confirm(page)
      await page.waitForTimeout(3000)
      const restored = existsSync(victim)
      const s3 = await shot(page, '09-backup-restored')
      check(
        'G3. connect backup (bare remote) → push snapshot → delete rule → restored',
        remoteLog.length >= 1 && restored,
        `remote commits ${remoteLog.length} · deleted rule restored ${restored} (${s1}, ${s2})`,
        s3
      )
    })

    // ---- G4. Session transcript
    await step(page, 'G4. session history and Contents', async () => {
      await go(page, 'sessions')
      await page.waitForTimeout(1500)
      await waitLoaded(page)
      const msgs = await page.locator('main .ac-card >> text=/./').count()
      const contents = await page
        .locator('[data-testid="session-count"]')
        .innerText()
        .catch(() => '')
      const body = (await page.evaluate('document.body.innerText')) as string
      const bubbles = await page
        .locator('main .ac-card >> text=/^(\uC0AC\uC6A9\uC790|AI)$/')
        .count()
      const contentsItems = await page.locator('main .ac-row .mantine-Badge-root').count()
      const s1 = await shot(page, '10-sessions-transcript')
      check(
        'G4. session 3-pane: list → history bubbles and numbered Contents',
        seededSession
          ? bubbles > 0 &&
              contentsItems > 0 &&
              !/\uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4/.test(body)
          : true,
        `session seeded ${seededSession} · list ${contents} · bubbles ${bubbles} · Contents ${contentsItems} (elements ${msgs})`,
        s1
      )
    })
  } finally {
    await app.close()
  }

  const after = probe()
  const changed = [...before.entries()].filter(([k, v]) => after.get(k) !== v).map(([k]) => k)
  check(
    'G. real HOME targets (except ~/.claude.json), library, ~/.illithid, ~/.config/illithid mtime unchanged',
    changed.length === 0,
    changed.length
      ? `changed paths: ${changed.join(', ')}`
      : `${before.size} paths unchanged (~/.illithid ${after.get(join(REAL_HOME, '.illithid')) === 'absent' ? 'absent' : 'pre-existing, unchanged'})`
  )
  check(
    'H. no renderer console errors',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || '0'
  )

  cleanupCopyFixtures()
  cleanupFixtures()
  rmSync(env.ILLITHID_USER_DATA, { recursive: true, force: true })
  for (const r of rows)
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  ${r.step}\n      ${r.detail}${r.shot ? `\n      ${r.shot}` : ''}`
    )
  const pass = rows.filter((r) => r.ok).length
  console.log(`\nm7c-scenario ${pass}/${rows.length} PASS`)
  if (pass !== rows.length) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  cleanupCopyFixtures()
  cleanupFixtures()
  process.exitCode = 1
})
