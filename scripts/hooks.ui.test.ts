import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

const LIB = '.illithid/workspaces/default'

test(
  'REQ-HOOKS-UI-1 create a hook, edit a trigger and the script, and the tools follow',
  { timeout: 180000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-hooks-ui-'))
    buildDemoHome(home, { tools: 'all' })
    const config = join(home, '.config/illithid/config.json')
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, 'utf8')),
        toolsInUse: ['claude', 'codex', 'gemini'],
        updateCheck: false,
        marketEnabled: false,
        ui: { language: 'en', views: { hooks: 'list' } }
      })
    )
    const env = {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-hooks-ud-')),
      ILLITHID_TEST: '1'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="hooks"]').click()
      await page.getByTestId('empty-import').waitFor()

      // New hook: timing, name, template; every tool in use that has a matching event is connected
      await page.getByTestId('hook-new').click()
      await page.getByTestId('hook-new-name').fill('notify')
      await page.getByTestId('hook-new-timing').click()
      await page.getByRole('option', { name: 'Reply finished' }).click()
      await page.getByTestId('hook-create').click()

      // Detail: one trigger row per tool in use, with the tool's own event. Outside the real HOME a library write syncs at once
      const rows = page.getByTestId('hook-triggers')
      await rows.getByText('AfterAgent', { exact: true }).waitFor()
      await page
        .locator('[data-testid="sync-button"][data-state="synced"]')
        .waitFor({ timeout: 30000 })
      const copy = join(home, '.claude/hooks/illithid/notify/run.sh')
      const claude = (): {
        hooks: { Stop: { hooks: { command: string; timeout?: number }[] }[] }
      } => JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'))
      assert.equal(claude().hooks.Stop[0].hooks[0].command, `'${copy}' claude`)
      assert.equal(statSync(copy).mode & 0o111, 0o111)

      // Edit the Claude Code trigger: Stop takes no matcher, a timeout is written in seconds
      await page.getByTestId('hook-trigger-edit-claude').click()
      const form = page.getByTestId('hook-trigger-form-claude')
      await form.getByLabel('Timeout (seconds)').fill('7')
      await page.getByTestId('hook-trigger-save-claude').click()
      await page.getByText('Hook saved').waitFor()
      await page
        .locator('[data-testid="sync-button"][data-state="synced"]')
        .waitFor({ timeout: 30000 })
      assert.equal(claude().hooks.Stop[0].hooks[0].timeout, 7)

      // Edit the shared script: the library file and every tool copy follow
      const editor = page.getByTestId('detail-sheet').locator('textarea').first()
      await editor.fill('#!/bin/sh\necho done\n')
      await page.getByTestId('editor-save').click()
      await page.getByText('Script saved').waitFor()
      await page
        .locator('[data-testid="sync-button"][data-state="synced"]')
        .waitFor({ timeout: 30000 })
      assert.equal(
        readFileSync(join(home, LIB, 'hooks/notify/run.sh'), 'utf8'),
        '#!/bin/sh\necho done\n'
      )
      assert.equal(readFileSync(copy, 'utf8'), '#!/bin/sh\necho done\n')
      assert.ok(existsSync(join(home, '.gemini/hooks/illithid/notify/run.sh')))
    } finally {
      await app.close()
    }
  }
)

test(
  'REQ-HOOKS-UI-2 import a Claude Code hook: it joins the library and its original entry is replaced',
  { timeout: 180000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-hooks-ui-import-'))
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
    mkdirSync(join(home, 'bin'), { recursive: true })
    writeFileSync(join(home, 'bin/guard.sh'), '#!/bin/sh\nexit 0\n')
    const settingsPath = join(home, '.claude/settings.json')
    mkdirSync(join(home, '.claude'), { recursive: true })
    const prev = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
    writeFileSync(
      settingsPath,
      JSON.stringify({
        ...prev,
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/guard.sh' }] }]
        }
      })
    )
    const env = {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-hooks-ud-')),
      ILLITHID_TEST: '1'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="hooks"]').click()
      await page.getByTestId('hook-import').click()
      await page.getByTestId('import-source-tool:claude').click()
      await page.getByTestId('import-hook-guard').check()
      await page.getByTestId('import-apply').click()
      await page.getByText('Imported into the library').waitFor()
      await page.keyboard.press('Escape')
      await page
        .locator('main [data-card="guard"], main')
        .getByText('guard', { exact: true })
        .first()
        .waitFor()
      await page
        .locator('[data-testid="sync-button"][data-state="synced"]')
        .waitFor({ timeout: 30000 })
      const s = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        hooks: { PreToolUse: { hooks: { command: string }[] }[] }
      }
      assert.equal(s.hooks.PreToolUse.length, 1)
      assert.match(s.hooks.PreToolUse[0].hooks[0].command, /illithid\/guard\/run\.sh' claude$/)
    } finally {
      await app.close()
    }
  }
)
