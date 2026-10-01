import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

const MAIN = resolve('out/main/index.js')
/** Usage the mocked index returns once it is "ready"; anything not listed has no calls */
const USAGE: Record<string, Record<string, number>> = {
  skill: { 'frontend-qa': 42, 'code-review': 7 },
  mcp: { postgres: 12 }
}

async function launch(
  home: string,
  userData: string
): Promise<{ app: ElectronApplication; page: Page }> {
  const env = {
    ...baseEnv(home),
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: userData,
    ILLITHID_TEST: '1'
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({ args: [MAIN], env, timeout: 60000 })
  // usageSummary answers null ("not indexed yet") until the test flips it, like a fresh install
  await app.evaluate(({ ipcMain }, usage) => {
    const g = globalThis as { usageReady?: boolean }
    g.usageReady = false
    ipcMain.removeHandler('api:usageSummary')
    ipcMain.handle('api:usageSummary', (_e, kind: string, names: string[]) =>
      g.usageReady
        ? Object.fromEntries(
            names.map((n) => {
              const recent = usage[kind]?.[n] ?? 0
              const d = Array.from({ length: 30 }, () => 0)
              d[29] = recent
              return [n, { recent, daily: d }]
            })
          )
        : null
    )
  }, USAGE)
  const page = await app.firstWindow()
  return { app, page }
}
const indexDone = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ BrowserWindow }) => {
    ;(globalThis as { usageReady?: boolean }).usageReady = true
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send('api:searchIndexEvent', { running: false })
  })
const rowNames = (page: Page): Promise<string[]> =>
  // Line 1 is the avatar initial, line 2 the name
  page.locator('main .ac-row').evaluateAll((rows) =>
    rows.map(
      (r) =>
        (r as HTMLElement).innerText
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)[1] ?? ''
    )
  )
async function pickSegment(page: Page, testId: string, value: string): Promise<void> {
  const id = await page.getByTestId(testId).locator(`input[value="${value}"]`).getAttribute('id')
  await page.locator(`label[for="${id}"]`).click()
}

test(
  'REQ-LIST-USAGE-1 REQ-LIST-USAGE-2 REQ-LIST-USAGE-5 REQ-LIST-USAGE-6 REQ-LIST-USAGE-7 lists show 30-day usage, sort by it and keep the order',
  { timeout: 150000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-list-usage-home-'))
    buildDemoHome(home, { tools: 'all' })
    const config = join(home, '.config/illithid/config.json')
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, 'utf8')),
        updateCheck: false,
        marketEnabled: false,
        ui: { language: 'en' }
      })
    )
    const userData = mkdtempSync(join(tmpdir(), 'illithid-list-usage-ud-'))

    let { app, page } = await launch(home, userData)
    try {
      await page.locator('[data-menu="skills"]').click()
      await page.locator('main .ac-row').first().waitFor()
      // REQ-5: nothing indexed yet → no usage shown, the list still works
      assert.equal(await page.getByTestId('usage-spark').count(), 0)
      await indexDone(app)
      // REQ-1 list view: every row gets a spark; values come from the index
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="usage-spark"]').length > 0
      )
      assert.equal(
        await page.getByTestId('usage-spark').count(),
        await page.locator('main .ac-row').count()
      )
      const frontend = page
        .locator('main .ac-row')
        .filter({ hasText: 'frontend-qa' })
        .getByTestId('usage-spark')
      assert.equal(await frontend.getAttribute('data-recent'), '42')
      assert.equal(await frontend.innerText(), '42 calls')
      assert.equal(await frontend.locator('rect').count(), 1)
      // REQ-6: most used first, ties by name
      const byName = await rowNames(page)
      assert.deepEqual(
        byName,
        [...byName].sort((a, b) => a.localeCompare(b))
      )
      await pickSegment(page, 'list-sort', 'usage')
      const byUsage = await rowNames(page)
      assert.deepEqual(byUsage.slice(0, 2), ['frontend-qa', 'code-review'])
      assert.deepEqual(
        byUsage.slice(2),
        [...byUsage.slice(2)].sort((a, b) => a.localeCompare(b))
      )
      assert.equal(JSON.parse(readFileSync(config, 'utf8')).ui.sorts.skills, 'usage')
      // REQ-1 card view
      await pickSegment(page, 'view-toggle', 'grid')
      assert.equal(
        await page
          .locator('main [data-card="frontend-qa"]')
          .getByTestId('usage-spark')
          .getAttribute('data-recent'),
        '42'
      )
      // REQ-2: MCP list (its own sort: still by name)
      await page.locator('[data-menu="mcp"]').click()
      await page.locator('main .ac-row, main [data-card]').first().waitFor()
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="usage-spark"]').length > 0
      )
      assert.equal(
        await page.getByTestId('list-sort').locator('input[value="name"]').isChecked(),
        true
      )
      const postgres = page
        .locator('main .ac-row, main [data-card]')
        .filter({ hasText: 'postgres' })
        .getByTestId('usage-spark')
        .first()
      assert.equal(await postgres.getAttribute('data-recent'), '12')
      await page.screenshot({ path: '/tmp/illithid-list-usage-mcp.png' })
    } finally {
      await app.close()
    }
    // REQ-7: the chosen order survives a restart
    ;({ app, page } = await launch(home, userData))
    try {
      await page.locator('[data-menu="skills"]').click()
      await page.getByTestId('list-sort').waitFor()
      assert.equal(
        await page.getByTestId('list-sort').locator('input[value="usage"]').isChecked(),
        true
      )
      await indexDone(app)
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="usage-spark"]').length > 0
      )
      await page.screenshot({ path: '/tmp/illithid-list-usage-skills.png' })
    } finally {
      await app.close()
    }
  }
)
