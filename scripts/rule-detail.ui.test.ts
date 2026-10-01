import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type Page } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

const RULES = '.illithid/workspaces/default/rules'

async function openRule(page: Page, name: string): Promise<void> {
  // The detail sheet covers the list; close it first
  const sheet = page.getByTestId('rule-name')
  if (await sheet.isVisible()) {
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'hidden' })
  }
  await page.locator(`main [data-card="${name}"]`).click()
  await page.getByTestId('tab-edit').click()
}

test('rule detail: the name field follows the open rule and a save leaves nothing unsaved', { timeout: 120000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-rule-detail-'))
  buildDemoHome(home)
  const config = join(home, '.config/illithid/config.json')
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, 'utf8')),
      updateCheck: false,
      marketEnabled: false,
      ui: { language: 'en', views: { rules: 'grid' } }
    })
  )
  const env = {
    ...baseEnv(home),
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-rd-ud-')),
    ILLITHID_TEST: '1'
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
  try {
    const page = await app.firstWindow()
    await page.locator('[data-menu="rules"]').click()
    const name = page.getByTestId('rule-name')

    await openRule(page, '20-git.md')
    const first = await name.inputValue()
    assert.match(first, /^20-git/)

    // An unsaved rename draft is dropped when another rule opens
    await name.fill('draft-name')
    await openRule(page, '30-safety.md')
    assert.match(await name.inputValue(), /^30-safety/)
    await openRule(page, '20-git.md')
    assert.equal(await name.inputValue(), first)

    // Saving takes the saved text back as the editor value: the text stays and nothing is left unsaved
    const editor = page.getByTestId('detail-sheet').locator('textarea').first()
    await editor.fill('# Git\n\nsaved from the editor\n')
    await page.getByText('Unsaved').waitFor()
    await page.getByTestId('editor-save').click()
    await page.getByText('Unsaved').waitFor({ state: 'hidden' })
    assert.equal(await editor.inputValue(), '# Git\n\nsaved from the editor\n')
    assert.equal(readFileSync(join(home, RULES, '20-git.md'), 'utf8'), '# Git\n\nsaved from the editor\n')
    assert.ok(await page.getByTestId('editor-save').isDisabled())
  } finally {
    await app.close()
  }
})
