import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { createHook, createScript, readScript } from '../src/engine'
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

test(
  'REQ-SCRIPTS-UI-2 the scripts menu has no Illithid built-in section, even with recipe hooks around',
  { timeout: 180000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-scripts-ui-builtin-'))
    buildDemoHome(home, { tools: 'all' })
    createHook(home, 'verify-stop', {
      description: '',
      when: 'stop',
      action: 'verify',
      options: {}
    })
    const config = join(home, '.config/illithid/config.json')
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, 'utf8')),
        toolsInUse: ['claude', 'codex'],
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
      await page.locator('[data-menu="scripts"]').click()
      await page.getByTestId('scripts-empty').waitFor()
      assert.equal(await page.getByTestId('script-builtins').count(), 0)
      assert.equal(await page.getByText('Check before finishing').count(), 0)
    } finally {
      await app.close()
    }
  }
)

test(
  'REQ-SCRIPTS-UI-3 a folder script: made and filled in the scripts menu, used by a hook, and the tool gets the whole folder',
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
        ui: { language: 'en' }
      })
    )
    createScript(home, 'lint', '#!/bin/sh\n# description: Lint\nexit 0\n')
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
      const sheet = page.getByTestId('detail-sheet')
      const editFile = async (rel: string, text: string): Promise<void> => {
        await page.getByTestId('script-file-select').click()
        await page.getByRole('option', { name: rel, exact: true }).click()
        await sheet.locator('textarea').first().fill(text)
        await page.getByTestId('editor-save').click()
        await page.waitForTimeout(300)
      }

      // A new folder script
      await page.locator('[data-menu="scripts"]').click()
      await page.getByTestId('script-new').click()
      await page.getByTestId('script-new-kind').getByText('Folder', { exact: true }).click()
      await page.getByTestId('script-new-name').fill('fmt')
      await page.getByTestId('script-new-description').fill('Format')
      await page.getByTestId('script-create').click()
      await page.getByTestId('script-files').waitFor()
      // Show in Finder sits with the header icons; no hook list or argument note while nothing uses it
      await page.getByTestId('detail-sheet').getByTestId('script-reveal').waitFor()
      assert.equal(await page.getByTestId('script-users').count(), 0)
      assert.equal(await page.getByText('The tool name comes as the first argument').count(), 0)
      // A helper file from the + next to the file picker, then the entry that calls it
      await page.getByTestId('script-file-add').click()
      await page.getByTestId('script-file-new').fill('lib/util.sh')
      await page.getByTestId('script-file-new').press('Enter')
      await editFile('lib/util.sh', 'say_done() { echo "done $1"; }\n')
      const run = '#!/bin/sh\n. "$(dirname "$0")/lib/util.sh"\nsay_done "$1"\n'
      await editFile('run.sh', run)
      const s = readScript(home, 'fmt')!
      assert.equal(s.kind, 'folder')
      assert.deepEqual(s.files, ['SCRIPT.md', 'lib/util.sh', 'run.sh'])
      assert.equal(s.content, run)
      await page.keyboard.press('Escape')

      // A hook runs it: the tool gets the folder, and the hook shows the entry and the other files
      await page.locator('[data-menu="hooks"]').click()
      await page.getByTestId('hook-new').click()
      await page.getByTestId('hook-new-use').click()
      await page.getByRole('option', { name: 'fmt/', exact: true }).click()
      await page.getByTestId('hook-create').click()
      await page.getByTestId('hook-summary').waitFor()
      await page.getByTestId('hook-overview-files').getByText('lib/util.sh').waitFor()
      await synced()
      const copy = join(home, '.claude/hooks/illithid/_scripts/fmt')
      assert.equal(
        readFileSync(join(copy, 'lib/util.sh'), 'utf8'),
        'say_done() { echo "done $1"; }\n'
      )
      const settings = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')) as {
        hooks: { Stop: { hooks: { command: string }[] }[] }
      }
      assert.equal(settings.hooks.Stop[0].hooks[0].command, `'${copy}/run.sh' claude script-stop`)
      await page.keyboard.press('Escape')

      // A file script turns into a folder script
      await page.locator('[data-menu="scripts"]').click()
      await page.getByText('lint', { exact: true }).first().click()
      await page.getByTestId('script-to-folder').click()
      await page.getByTestId('confirm-ok').click()
      await page.getByTestId('script-files').waitFor()
      assert.equal(readScript(home, 'lint')!.kind, 'folder')
    } finally {
      await app.close()
    }
  }
)
