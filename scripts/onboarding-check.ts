/**
 * First-run check against a demo HOME (never the real one).
 * - Empty HOME with only a Claude Code rule (~/.claude/rules/my-rule.md) and a `claude` executable on PATH.
 * - Walks onboarding: import existing → Claude only → import the rule → apply preview → Apply.
 * - Asserts: Codex/OpenCode folders were never created, the original rule was moved to backups/imported and
 *   replaced by the app copy, and the preview listed only Claude Code.
 * - Second scenario: ~/.claude.json missing while the library has an MCP server → yellow hint, not a sync error.
 * - Third scenario: Claude + OpenCode in use, auto apply off — rule edit toast, preview over an open item detail,
 *   OpenCode "reads the library directly" rows, and the rule rows under opencode.json after turning OpenCode off for a rule.
 * - Screenshots of each step go to SHOTS_DIR (default: a new temp dir), which is kept.
 *
 * Usage: npx electron-vite build && npx tsx scripts/onboarding-check.ts
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type Page } from 'playwright-core'
import { syncAll } from '../src/engine'
import { put } from './readme-shots'

const ROOT = resolve(__dirname, '..')
const RULE = '# My rule\n\n- Keep answers short.\n'

function findFiles(dir: string, name: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...findFiles(p, name))
    else if (e === name) out.push(p)
  }
  return out
}

interface RunResult {
  failures: string[]
  errors: string[]
}

/** Scenario 1: first run with a Claude rule → onboarding → import → preview → apply */
async function firstRun(shots: string): Promise<RunResult> {
  const home = '/Users/Shared/illithid-onboarding'
  if (existsSync(home)) throw new Error(`${home} already exists; remove it or pick another demo path`)
  mkdirSync(home)
  const userData = mkdtempSync(join(tmpdir(), 'illithid-onboarding-userdata-'))
  put(home, '.claude/rules/my-rule.md', RULE)
  // A real Claude Code install has both (the permissions and MCP targets are not optional)
  put(home, '.claude/settings.json', '{}\n')
  put(home, '.claude.json', '{}\n')
  put(home, 'bin/claude', '#!/bin/sh\nexit 0\n')
  chmodSync(join(home, 'bin/claude'), 0o755)

  const env = {
    PATH: `${home}/bin:/usr/bin:/bin`,
    HOME: home,
    LANG: 'en_US.UTF-8',
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: userData,
    ILLITHID_TEST: '1'
  }
  const failures: string[] = []
  const check = (ok: boolean, what: string): void => {
    if (!ok) failures.push(what)
  }
  const errors: string[] = []
  const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js')], cwd: ROOT, env })
  let n = 0
  const shot = async (page: Page, name: string): Promise<void> => {
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(shots, `${String(++n).padStart(2, '0')}-${name}.png`) })
  }
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => errors.push(e.message))
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 800)
    })
    await page.evaluate(() => localStorage.setItem('illithid-language', 'en'))
    await page.reload()
    const tid = (id: string): ReturnType<Page['locator']> => page.locator(`[data-testid="${id}"]`)

    await tid('onboarding').waitFor({ timeout: 30_000 })
    await shot(page, 'start')

    await tid('onboarding-mode-import').click()
    await tid('onboarding-tool-claude').waitFor()
    check(await tid('onboarding-tool-claude').isChecked(), 'Claude Code prefilled')
    check(!(await tid('onboarding-tool-codex').isChecked()), 'Codex unchecked (not detected)')
    check(!(await tid('onboarding-tool-opencode').isChecked()), 'OpenCode unchecked (not detected)')
    check(!(await tid('onboarding-tool-gemini').isChecked()), 'Gemini CLI unchecked (not detected)')
    check(!(await tid('onboarding-tool-copilot').isChecked()), 'GitHub Copilot unchecked (not detected)')
    await shot(page, 'tools')

    await tid('onboarding-tools-next').click()
    await tid('onboarding-import-claude').waitFor()
    check(!(await tid('onboarding-import-codex').count()), 'import step lists selected tools only')
    const cfg = JSON.parse(readFileSync(join(home, '.config/illithid/config.json'), 'utf8')) as { toolsInUse?: string[] }
    check(JSON.stringify(cfg.toolsInUse) === '["claude"]', `toolsInUse saved as ["claude"] (got ${JSON.stringify(cfg.toolsInUse)})`)
    await shot(page, 'import')

    await tid('onboarding-import-claude').click()
    const rule = page.locator('[data-testid^="import-rule-"]').first()
    await rule.waitFor({ timeout: 30_000 })
    await rule.check()
    await shot(page, 'import-pick')
    await tid('import-apply').click()
    await tid('import-close').waitFor({ timeout: 30_000 })
    await shot(page, 'import-done')
    await tid('import-close').click()
    check(readFileSync(join(home, '.claude/rules/my-rule.md'), 'utf8') === RULE, 'original rule untouched after import')
    check(!existsSync(join(home, '.claude/rules/illithid')), 'nothing written to Claude before apply')

    await tid('onboarding-import-next').click()
    await tid('apply-preview').waitFor({ timeout: 30_000 })
    await tid('apply-preview-claude').waitFor()
    check(
      !(await tid('apply-preview-codex').count()) && !(await tid('apply-preview-opencode').count()) && !(await tid('apply-preview-gemini').count()) && !(await tid('apply-preview-copilot').count()),
      'preview lists Claude Code only'
    )
    check((await tid('apply-preview-action-replace').count()) > 0, 'preview shows the rule replacement')
    await shot(page, 'preview')

    await tid('apply-preview-apply').click()
    await page.locator('[data-menu="rules"]').waitFor({ timeout: 30_000 })
    await shot(page, 'after-apply')

    check(!existsSync(join(home, '.codex')), '~/.codex not created')
    check(!existsSync(join(home, '.config/opencode')), '~/.config/opencode not created')
    check(!existsSync(join(home, '.gemini')), '~/.gemini not created')
    check(!existsSync(join(home, '.copilot')), '~/.copilot not created')
    check(!existsSync(join(home, '.claude/rules/my-rule.md')), 'original moved out of ~/.claude/rules')
    const copy = join(home, '.claude/rules/illithid/my-rule.md')
    check(existsSync(copy) && readFileSync(copy, 'utf8').includes('Keep answers short.'), 'app copy written to ~/.claude/rules/illithid')
    const backups = findFiles(join(home, '.config/illithid/backups/imported'), 'my-rule.md')
    check(backups.length === 1 && readFileSync(backups[0], 'utf8') === RULE, 'original kept in backups/imported')

    await page.click('[data-menu="settings"]')
    await tid('tool-in-use-claude').waitFor()
    await shot(page, 'settings')
    await page.click('[data-menu="rules"]')
    await page.waitForTimeout(400)
    // After the apply nothing should be pending (the button is disabled at 0)
    check(await tid('sync-button').isDisabled(), 'nothing pending after apply')

    console.log(JSON.stringify({ backups: backups.map((p) => p.slice(home.length)) }))
    return { failures, errors }
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * Scenario 2: Claude Code in use, library with a rule and an MCP server, but ~/.claude.json missing (Claude never started).
 * Expected: no red sync state; a yellow "run Claude Code once" hint in the sidebar and in the apply preview; the file is not created
 */
async function notInitializedRun(shots: string): Promise<RunResult> {
  const home = '/Users/Shared/illithid-not-initialized'
  if (existsSync(home)) throw new Error(`${home} already exists; remove it or pick another demo path`)
  mkdirSync(home)
  const userData = mkdtempSync(join(tmpdir(), 'illithid-notinit-userdata-'))
  const ws = '.illithid/workspaces/default'
  put(home, `${ws}/workspace.json`, JSON.stringify({ name: 'default' }) + '\n')
  put(home, `${ws}/illithid.json`, JSON.stringify({ version: 1, rules: {}, skills: {}, mcp: {}, agents: {} }) + '\n')
  put(home, `${ws}/rules/my-rule.md`, RULE)
  put(home, `${ws}/mcps/context7.json`, JSON.stringify({ transport: 'http', url: 'https://mcp.context7.com/mcp' }) + '\n')
  put(home, '.config/illithid/config.json', JSON.stringify({ version: 1, activeWorkspace: 'default', toolsInUse: ['claude'] }) + '\n')
  put(home, '.claude/settings.json', '{}\n')

  const env = { PATH: '/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8', ILLITHID_HOME: home, ILLITHID_USER_DATA: userData, ILLITHID_TEST: '1' }
  const failures: string[] = []
  const check = (ok: boolean, what: string): void => {
    if (!ok) failures.push(what)
  }
  const errors: string[] = []
  const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js')], cwd: ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => errors.push(e.message))
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 800)
    })
    await page.evaluate(() => localStorage.setItem('illithid-language', 'en'))
    await page.reload()
    const tid = (id: string): ReturnType<Page['locator']> => page.locator(`[data-testid="${id}"]`)
    await page.locator('[data-menu="rules"]').waitFor({ timeout: 30_000 })
    check(!(await tid('onboarding').count()), 'no onboarding (tools in use already set)')
    // Reload runs a (plan-only) sync so the sidebar has a fresh status
    await page.getByRole('button', { name: 'Reload' }).click()
    await tid('sync-not-initialized').waitFor({ timeout: 30_000 })
    check((await tid('sync-button').getAttribute('data-state')) !== 'failed', 'sync button not red')
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(shots, 'notinit-1-sidebar.png') })

    await tid('sync-button').click()
    await tid('apply-preview').waitFor({ timeout: 30_000 })
    await tid('apply-preview-not-initialized').waitFor()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(shots, 'notinit-2-preview.png') })
    await tid('apply-preview-apply').click()
    await tid('apply-preview').waitFor({ state: 'detached', timeout: 30_000 })
    await page.waitForTimeout(600)
    check((await tid('sync-button').getAttribute('data-state')) !== 'failed', 'sync button not red after apply')
    check(await tid('sync-not-initialized').isVisible(), 'hint still shown after apply')
    check(!existsSync(join(home, '.claude.json')), '~/.claude.json not created')
    check(existsSync(join(home, '.claude/rules/illithid/my-rule.md')), 'rule applied')
    await page.screenshot({ path: join(shots, 'notinit-3-after-apply.png') })
    return { failures, errors }
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
}

/** Scenario 3: preview details with Claude Code + OpenCode in use and auto apply off */
async function previewDetailsRun(shots: string): Promise<RunResult> {
  const home = '/Users/Shared/illithid-preview-details'
  if (existsSync(home)) throw new Error(`${home} already exists; remove it or pick another demo path`)
  mkdirSync(home)
  const userData = mkdtempSync(join(tmpdir(), 'illithid-preview-userdata-'))
  const ws = '.illithid/workspaces/default'
  put(home, `${ws}/workspace.json`, JSON.stringify({ name: 'default' }) + '\n')
  put(home, `${ws}/illithid.json`, JSON.stringify({ version: 1, rules: {}, skills: {}, mcp: {}, agents: {} }) + '\n')
  put(home, `${ws}/rules/style.md`, '# Style\n\n- Match the surrounding code.\n')
  put(home, '.config/illithid/config.json', JSON.stringify({ version: 1, activeWorkspace: 'default', toolsInUse: ['claude', 'opencode'] }) + '\n')
  put(home, '.claude/settings.json', '{}\n')
  put(home, '.claude.json', '{}\n')
  put(home, '.config/opencode/opencode.json', '{}\n')
  const env = { PATH: '/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8', ILLITHID_HOME: home, ILLITHID_USER_DATA: userData, ILLITHID_TEST: '1' }
  // Start from a synced state
  syncAll(home, env, { allowReal: true, approvedOnce: true })

  const failures: string[] = []
  const check = (ok: boolean, what: string): void => {
    if (!ok) failures.push(what)
  }
  const errors: string[] = []
  const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js')], cwd: ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => errors.push(e.message))
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 800)
    })
    await page.evaluate(() => localStorage.setItem('illithid-language', 'en'))
    await page.reload()
    const tid = (id: string): ReturnType<Page['locator']> => page.locator(`[data-testid="${id}"]`)
    const card = page.locator('main [data-card]').filter({ hasText: 'style.md' }).first()
    await card.waitFor({ timeout: 30_000 })

    // 1. Edit the rule in the detail sheet: auto apply is off, so the toast must say library only
    await card.click()
    await tid('detail-sheet').waitFor()
    await tid('tab-edit').click()
    await page.locator('[data-testid="detail-sheet"] textarea').fill('# Style\n\n- Match the surrounding code.\n- Keep functions small.\n')
    await tid('editor-save').click()
    const toast = page.locator('.mantine-Notification-root').filter({ hasText: 'Saved to library only' })
    await toast.first().waitFor({ timeout: 10_000 }).catch(() => {})
    check((await toast.count()) > 0, 'rule save toast says library only')
    check(!(await page.locator('.mantine-Notification-root').filter({ hasText: 'syncing' }).count()), 'no "syncing to tools" toast')

    // 2 + 3. Preview on top of the open detail sheet; OpenCode listed as reading the library directly
    await tid('sync-button').click()
    await tid('apply-preview').waitFor({ timeout: 30_000 })
    await tid('apply-preview-library-direct').waitFor()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(shots, 'details-1-preview-over-sheet.png') })
    await tid('apply-preview-apply').click()
    await tid('apply-preview').waitFor({ state: 'detached', timeout: 30_000 })
    check(readFileSync(join(home, '.claude/rules/illithid/style.md'), 'utf8').includes('Keep functions small.'), 'apply clicked through the sheet reached Claude')

    // 4. OpenCode off for the rule → opencode.json row with the rule leaving instructions
    await page.keyboard.press('Escape')
    await tid('detail-sheet').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    await card.locator('[aria-label="OpenCode"]').click()
    await page.waitForTimeout(800)
    await tid('sync-button').click()
    await tid('apply-preview').waitFor({ timeout: 30_000 })
    await tid('apply-preview-opencode').waitFor()
    check((await tid('apply-preview-opencode').getByText('style.md').count()) > 0, 'rule named under opencode.json')
    check((await tid('apply-preview-opencode').locator('[data-testid="apply-preview-action-remove"]').count()) > 0, 'rule shown as removed')
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(shots, 'details-2-opencode-off.png') })
    return { failures, errors }
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const shots = process.env.SHOTS_DIR ?? mkdtempSync(join(tmpdir(), 'illithid-onboarding-shots-'))
  mkdirSync(shots, { recursive: true })
  const a = await firstRun(shots)
  const b = await notInitializedRun(shots)
  const c = await previewDetailsRun(shots)
  console.log(JSON.stringify({ shots, firstRun: a, notInitialized: b, previewDetails: c }, null, 2))
  if ([a, b, c].some((r) => r.failures.length || r.errors.length)) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
