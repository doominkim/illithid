import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

const LIB = '.illithid/workspaces/default'

test(
  'REQ-UI-CONSISTENCY-1 every "new" opens the same sheet form with its buttons kept in view; every list shows a result count',
  { timeout: 180000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-consistency-'))
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
    const env = {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-consistency-ud-')),
      ILLITHID_TEST: '1'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
    try {
      const page = await app.firstWindow()
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(1280, 820)
      )
      const menus: [string, string][] = [
        ['rules', 'rule-new'],
        ['skills', 'skill-new'],
        ['mcp', 'mcp-new'],
        ['hooks', 'hook-new'],
        ['permissions', 'perm-new'],
        ['scripts', 'script-new'],
        ['agents', 'agent-new']
      ]
      for (const [menu, newId] of menus) {
        await page.locator(`[data-menu="${menu}"]`).click()
        await page.getByTestId('shown-count').waitFor()
        await page.getByTestId(newId).click()
        const sheet = page.getByTestId('detail-sheet')
        const footer = sheet.locator('.ac-form-footer')
        await footer.waitFor()
        // The buttons are on screen without scrolling, however long the form
        const box = (await footer.boundingBox())!
        const height = await page.evaluate(() => window.innerHeight)
        assert.ok(box.y + box.height <= height + 1, `${menu}: footer below the window`)
        assert.equal(
          await page.locator('.mantine-Modal-content').count(),
          0,
          `${menu}: opened a modal`
        )
        await page.keyboard.press('Escape')
      }

      // A skill made from the sheet
      await page.locator('[data-menu="skills"]').click()
      await page.getByTestId('skill-new').click()
      const sheet = page.getByTestId('detail-sheet')
      await sheet.getByLabel('Name').fill('my-skill')
      await sheet.getByRole('textbox').nth(1).fill('Does a thing')
      await sheet.locator('.ac-form-footer').getByRole('button', { name: 'Create' }).click()
      await page.getByText('my-skill', { exact: true }).first().waitFor()
      assert.ok(existsSync(join(home, LIB, 'skills/my-skill/SKILL.md')))
    } finally {
      await app.close()
    }
  }
)
