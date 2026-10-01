import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type Page } from 'playwright-core'
import { mcp } from '../src/main/reads'
import { baseEnv, buildDemoHome } from './readme-shots'

const en = JSON.parse(readFileSync('src/renderer/src/i18n/en.json', 'utf8')) as {
  sync: { why: Record<string, string> }
}
const why = (reason: string): string =>
  /^[A-Za-z]+$/.test(reason) ? (en.sync.why[reason] ?? reason) : reason

/** Text of the tooltip that opens when hovering a pill */
async function tooltipOf(page: Page, pill: ReturnType<Page['locator']>): Promise<string> {
  await page.mouse.move(0, 0)
  await pill.hover()
  const tip = page.getByRole('tooltip').last()
  await tip.waitFor({ timeout: 5000 })
  return tip.innerText()
}

test(
  'REQ-TOOL-PROBLEM-REASONS-1 REQ-TOOL-PROBLEM-REASONS-3 REQ-TOOL-PROBLEM-REASONS-4 cards have no status dot; problem pills say why',
  { timeout: 120000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-problem-reason-'))
    buildDemoHome(home, { tools: 'all' })
    const config = join(home, '.config/illithid/config.json')
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, 'utf8')),
        updateCheck: false,
        marketEnabled: false,
        ui: { language: 'en', views: { skills: 'grid', mcp: 'grid' } }
      })
    )
    // A broken Claude config puts every MCP server's Claude pill in error
    writeFileSync(join(home, '.claude.json'), '{ not json')
    const claudeReason = mcp(home, baseEnv(home)).servers[0].reasons!.claude!
    const env = {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-pr-ud-')),
      ILLITHID_TEST: '1'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="mcp"]').click()
      const card = page.locator('main [data-card="playwright"]')
      await card.waitFor()
      // REQ-1: no 8px status circle in any card
      const dots = await page.locator('main [data-card]').evaluateAll(
        (cards) =>
          cards
            .flatMap((c) => [...c.querySelectorAll('span')])
            .filter((s) => {
              const st = getComputedStyle(s)
              return st.width === '8px' && st.height === '8px' && st.borderRadius === '50%'
            }).length
      )
      assert.equal(dots, 0)
      // REQ-3: the problem pill explains itself
      const pill = card
        .locator('[data-tool="claude"] [data-problem], [data-tool="claude"][data-problem]')
        .first()
      await pill.waitFor()
      assert.ok(
        (await tooltipOf(page, pill)).includes(why(claudeReason)),
        `tooltip has: ${why(claudeReason)}`
      )
      // REQ-4: an item the last sync failed shows that and its reason
      await page.locator('[data-menu="skills"]').click()
      await page.locator('main [data-card="code-review"]').waitFor()
      // The app re-reads the sync status after the event, so the status channel returns the same failed result
      await app.evaluate(({ BrowserWindow, ipcMain }) => {
        const status = {
          wrote: false,
          targets: [],
          rules: [],
          agents: [],
          skills: [
            {
              tool: 'claude',
              name: 'code-review',
              action: 'copy',
              status: 'failed',
              reason: 'hashMismatch'
            }
          ],
          errorCount: 0,
          errors: []
        }
        ipcMain.removeHandler('api:syncStatus')
        ipcMain.handle('api:syncStatus', () => status)
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('api:syncEvent', status)
      })
      const failed = page.locator('main [data-card="code-review"] [data-problem]').first()
      await failed.waitFor()
      assert.ok(
        (await tooltipOf(page, failed)).includes(`Last sync failed: ${en.sync.why.hashMismatch}`)
      )
      await page.screenshot({ path: '/tmp/illithid-problem-reason.png' })
    } finally {
      await app.close()
    }
  }
)
