import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

const LIB = '.illithid/workspaces/default'

test(
  'REQ-SCRIPTS-UI-1 write a library script, use it from a new hook, and see the hook from the script',
  { timeout: 180000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-scripts-ui-'))
    buildDemoHome(home, { tools: 'all' })
    const config = join(home, '.config/illithid/config.json')
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, 'utf8')),
        toolsInUse: ['claude'],
        updateCheck: false,
        marketEnabled: false,
        ui: { language: 'en', views: { hooks: 'list' } }
      })
    )
    const env = {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-scripts-ud-')),
      ILLITHID_TEST: '1'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
    try {
      const page = await app.firstWindow()
      const synced = (): Promise<void> =>
        page.locator('[data-testid="sync-button"][data-state="synced"]').waitFor({ timeout: 30000 })

      // New library script, then its content
      await page.locator('[data-menu="scripts"]').click()
      await page.getByTestId('script-new').click()
      await page.getByTestId('script-new-name').fill('lint')
      await page.getByTestId('script-new-description').fill('Lint the edited file')
      await page.getByTestId('script-create').click()
      const content = '#!/bin/sh\n# description: Lint the edited file\nexit 0\n'
      await page.getByTestId('detail-sheet').locator('textarea').first().fill(content)
      await page.getByTestId('editor-save').click()
      await page.getByText('Script saved').first().waitFor()
      assert.equal(readFileSync(join(home, LIB, 'scripts/lint.sh'), 'utf8'), content)
      await page.keyboard.press('Escape')

      // A new "write your own" hook picks the library script
      await page.locator('[data-menu="hooks"]').click()
      await page.getByTestId('hook-new').click()
      await page.locator('[data-card="hook-action-script"]').click()
      await page.getByTestId('hook-new-use').click()
      await page.getByRole('option', { name: 'lint', exact: true }).click()
      await page.getByTestId('hook-create').click()
      await page.getByTestId('hook-summary').waitFor()
      await synced()
      assert.equal(
        readFileSync(join(home, '.claude/hooks/illithid/script-stop/run.sh'), 'utf8'),
        content
      )
      await page.keyboard.press('Escape')

      // The script lists the hook that runs it, one click to the hook
      await page.locator('[data-menu="scripts"]').click()
      await page.getByText('lint', { exact: true }).first().click()
      await page.getByTestId('script-users').getByText('script-stop').click()
      await page.getByTestId('hook-summary').waitFor()
    } finally {
      await app.close()
    }
  }
)
