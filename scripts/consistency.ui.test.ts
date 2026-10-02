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

test(
  'REQ-UI-DESC-1 rules and MCP servers take a description that the list shows; the tools never get it',
  { timeout: 180000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-desc-ui-'))
    buildDemoHome(home, { tools: 'all' })
    const config = join(home, '.config/illithid/config.json')
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, 'utf8')),
        toolsInUse: ['claude'],
        updateCheck: false,
        marketEnabled: false,
        ui: { language: 'en', views: { rules: 'list', mcp: 'list' } }
      })
    )
    const env = {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-desc-ud-')),
      ILLITHID_TEST: '1'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
    try {
      const page = await app.firstWindow()
      const synced = (): Promise<void> =>
        page.locator('[data-testid="sync-button"][data-state="synced"]').waitFor({ timeout: 30000 })

      // A rule with a description: the list shows it
      await page.locator('[data-menu="rules"]').click()
      await page.getByTestId('rule-new').click()
      await page.getByTestId('rule-new-name').fill('zz-tone')
      await page.getByTestId('rule-new-description').fill('How replies should sound')
      await page.getByTestId('rule-new-ok').click()
      // The new rule opens: its description is there to edit
      await page.getByTestId('tab-edit').click()
      assert.equal(
        await page.getByTestId('rule-description').inputValue(),
        'How replies should sound'
      )
      await page.getByTestId('rule-description').fill('Keep it short')
      await page.getByTestId('rule-description').press('Tab')
      await page.getByText('Description saved').first().waitFor()
      // The list shows it
      await page
        .locator('main .ac-row', { hasText: 'Keep it short' })
        .waitFor({ state: 'attached' })
      await page.keyboard.press('Escape')

      // An MCP server with a description
      await page.locator('[data-menu="mcp"]').click()
      await page.getByTestId('mcp-new').click()
      await page.getByTestId('mcp-name').fill('docs')
      await page.getByTestId('mcp-description').fill('Library docs lookup')
      await page.getByTestId('mcp-url').fill('https://example.com/mcp')
      await page.getByTestId('mcp-save').click()
      await page.locator('main').getByText('Library docs lookup').waitFor()
      await synced()
      const meta = JSON.parse(readFileSync(join(home, LIB, 'mcps/docs.json'), 'utf8')) as {
        _?: { description?: string }
      }
      assert.equal(meta._?.description, 'Library docs lookup')
      assert.doesNotMatch(readFileSync(join(home, '.claude.json'), 'utf8'), /Library docs lookup/)
      assert.doesNotMatch(
        readFileSync(join(home, '.claude/rules/illithid/zz-tone.md'), 'utf8'),
        /Keep it short/
      )
    } finally {
      await app.close()
    }
  }
)

test(
  'REQ-UI-NEW-BODY-1 a new rule, skill, agent and script take their content in the new form',
  { timeout: 180000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-new-body-'))
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
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-new-body-ud-')),
      ILLITHID_TEST: '1'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
    try {
      const page = await app.firstWindow()
      const file = (rel: string): string => readFileSync(join(home, LIB, rel), 'utf8')
      const until = async (check: () => boolean): Promise<void> => {
        for (let i = 0; i < 50 && !check(); i++) await page.waitForTimeout(100)
        assert.ok(check())
      }

      await page.locator('[data-menu="rules"]').click()
      await page.getByTestId('rule-new').click()
      await page.getByTestId('rule-new-name').fill('zz-tone')
      await page.getByTestId('rule-new-body').fill('# Tone\n\nBe brief.\n')
      await page.getByTestId('rule-new-ok').click()
      await until(() => existsSync(join(home, LIB, 'rules/zz-tone.md')))
      assert.equal(file('rules/zz-tone.md'), '# Tone\n\nBe brief.\n')
      await page.keyboard.press('Escape')

      await page.locator('[data-menu="skills"]').click()
      await page.getByTestId('skill-new').click()
      const sheet = page.getByTestId('detail-sheet')
      await sheet.getByLabel('Name').fill('release')
      await sheet.getByRole('textbox').nth(1).fill('Cut a release')
      await page.getByTestId('skill-new-body').fill('# Release\n\n1. Tag\n')
      await sheet.locator('.ac-form-footer').getByRole('button', { name: 'Create' }).click()
      await until(() => existsSync(join(home, LIB, 'skills/release/SKILL.md')))
      assert.ok(file('skills/release/SKILL.md').endsWith('---\n\n# Release\n\n1. Tag\n'))
      await page.keyboard.press('Escape')

      await page.locator('[data-menu="agents"]').click()
      await page.getByTestId('agent-new').click()
      await sheet.getByLabel('Name').fill('checker')
      await sheet.getByRole('textbox').nth(1).fill('Checks things')
      await page.getByTestId('agent-new-body').fill('Review the diff.\n')
      await sheet.locator('.ac-form-footer').getByRole('button', { name: 'Create' }).click()
      await until(() => existsSync(join(home, LIB, 'agents/checker.md')))
      assert.ok(file('agents/checker.md').endsWith('---\n\nReview the diff.\n'))
      await page.keyboard.press('Escape')

      await page.locator('[data-menu="scripts"]').click()
      await page.getByTestId('script-new').click()
      await page.getByTestId('script-new-name').fill('hello')
      await page.getByTestId('script-new-body').fill('#!/bin/sh\necho hello\n')
      await page.getByTestId('script-create').click()
      await until(() => existsSync(join(home, LIB, 'scripts/hello.sh')))
      assert.equal(file('scripts/hello.sh'), '#!/bin/sh\necho hello\n')
    } finally {
      await app.close()
    }
  }
)
