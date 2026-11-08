import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

test(
  'the apply preview warns about a library rule that names a skill the library does not have',
  { timeout: 180000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-stale-ui-'))
    buildDemoHome(home, { tools: 'all' })
    const config = join(home, '.config/illithid/config.json')
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, 'utf8')),
        toolsInUse: ['claude', 'codex'],
        updateCheck: false,
        marketEnabled: false,
        ui: { language: 'en' }
      })
    )
    const rules = join(home, '.illithid/workspaces/default/rules')
    mkdirSync(rules, { recursive: true })
    writeFileSync(
      join(rules, '99-ghost.md'),
      '# Ghost\n\nShared memory follows the `ghost-curation` skill.\n'
    )
    const env = {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-stale-ud-')),
      ILLITHID_TEST: '1'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
    try {
      const page = await app.firstWindow()
      // The pending count arrives after the first status read, which is slow on Windows runners
      await page.getByTestId('rule-new').waitFor({ timeout: 60000 })
      await page
        .locator('[data-testid="sync-button"][data-state="pending"]')
        .click({ timeout: 90000 })
      const alert = page.getByTestId('apply-preview-stale-refs')
      await alert.waitFor({ timeout: 30000 })
      const text = await alert.innerText()
      assert.match(text, /Skill references that no longer resolve/)
      assert.match(text, /rules\/99-ghost\.md line 3 names `ghost-curation`/)
      if (process.env.ILLITHID_SHOT) await page.screenshot({ path: process.env.ILLITHID_SHOT })
    } finally {
      await app.close()
    }
  }
)
