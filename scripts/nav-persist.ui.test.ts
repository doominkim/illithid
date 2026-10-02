import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

test(
  'REQ-NAV-PERSIST-1 reloading the window stays on the menu that was open',
  { timeout: 180000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-nav-'))
    buildDemoHome(home, { tools: 'all' })
    const config = join(home, '.config/illithid/config.json')
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, 'utf8')),
        toolsInUse: ['claude'],
        updateCheck: false,
        marketEnabled: false,
        ui: { language: 'en' }
      })
    )
    const env = {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-nav-ud-')),
      ILLITHID_TEST: '1'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
    try {
      const page = await app.firstWindow()
      const active = (menu: string): ReturnType<typeof page.locator> =>
        page.locator(`[data-menu="${menu}"][data-active="true"]`)
      await active('rules').waitFor()
      await page.locator('[data-menu="hooks"]').click()
      await active('hooks').waitFor()
      await page.reload()
      await active('hooks').waitFor({ timeout: 30000 })
      assert.equal(await active('rules').count(), 0)
      // And again from another menu
      await page.locator('[data-menu="settings"]').click()
      await active('settings').waitFor()
      await page.reload()
      await active('settings').waitFor({ timeout: 30000 })
    } finally {
      await app.close()
    }
  }
)
