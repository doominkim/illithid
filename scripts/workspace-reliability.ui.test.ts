import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type Page } from 'playwright-core'
import { createWorkspace, switchWorkspace } from '../src/engine'
import { baseEnv, buildDemoHome } from './readme-shots'
import type { Api } from '../src/shared/api'

declare global {
  interface Window {
    api: Api
  }
}

/** Playwright's installed waitForFunction treats an async predicate as truthy; poll awaited IPC results in Node. */
async function waitForAutomaticSnapshot(page: Page): ReturnType<Api['backupHistory']> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => window.api.backupHistory())
    if (
      'ok' in result &&
      result.ok &&
      result.value.some((snapshot) => snapshot.message === 'auto backup')
    )
      return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Automatic backup was not recorded in the active workspace before the deadline')
}

test(
  'switching workspaces resets a dirty memory editor before saving a same-path note',
  { timeout: 120_000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-workspace-editor-ui-'))
    buildDemoHome(home, { tools: 'all' })
    const configPath = join(home, '.config/illithid/config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(configPath, 'utf8')),
        updateCheck: false,
        marketEnabled: false,
        allowRealApply: false,
        ui: { language: 'en' }
      })
    )
    const first = join(home, '.illithid/workspaces/default/memory/note.md')
    writeFileSync(first, '# First workspace\n')
    const second = createWorkspace(home, 'Second', { from: 'current' })
    const next = join(home, `.illithid/workspaces/${second.id}/memory/note.md`)
    writeFileSync(next, '# Second workspace\n')
    switchWorkspace(home, 'default')
    const env = {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-workspace-editor-ud-')),
      ILLITHID_TEST: '1'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({
      args: [resolve('out/main/index.js')],
      env,
      timeout: 60_000
    })
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="memory"]').click()
      await page.getByText('note.md', { exact: true }).first().click()
      await page.getByTestId('tab-edit').click()
      const editor = page.getByTestId('detail-sheet').locator('textarea')
      await editor.fill('# Unsaved first draft\n')
      await page.getByTestId('workspace-select').click()
      await page.getByRole('option', { name: 'Second' }).click()
      // Switching must make draft loss visible and require the preview to complete.
      await page.getByTestId('workspace-switch-unsaved').waitFor()
      await page.getByTestId('confirm-ok').click()
      await page.getByTestId('workspace-select').waitFor()
      await page.getByText('note.md', { exact: true }).first().click()
      await page.getByTestId('tab-edit').click()
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLTextAreaElement>('[data-testid="detail-sheet"] textarea')
            ?.value === '# Second workspace\n'
      )
      await editor.fill('# Updated second workspace\n')
      await page.getByTestId('editor-save').click()
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="editor-save"]:not([disabled])')
      )
      assert.equal(readFileSync(first, 'utf8'), '# First workspace\n')
      assert.equal(readFileSync(next, 'utf8'), '# Updated second workspace\n')
    } finally {
      await app.close()
    }
  }
)

test(
  'a failed workspace preview keeps switching disabled and shows the failure',
  { timeout: 120_000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-workspace-preview-ui-'))
    buildDemoHome(home, { tools: 'all' })
    const configPath = join(home, '.config/illithid/config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(configPath, 'utf8')),
        updateCheck: false,
        marketEnabled: false,
        allowRealApply: false,
        ui: { language: 'en' }
      })
    )
    const second = createWorkspace(home, 'Second', { from: 'current' })
    const env = {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-workspace-preview-ud-')),
      ILLITHID_TEST: '1'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({
      args: [resolve('out/main/index.js')],
      env,
      timeout: 60_000
    })
    try {
      const page = await app.firstWindow()
      await page.getByTestId('workspace-select').waitFor()
      await page.getByTestId('workspace-select').click()
      await page.getByRole('option', { name: 'Second' }).waitFor()
      const path = join(home, `.illithid/workspaces/${second.id}`)
      renameSync(path, `${path}.moved`)
      await page.getByRole('option', { name: 'Second' }).click()
      await page.getByTestId('workspace-switch-preview-error').waitFor()
      assert.equal(await page.getByTestId('confirm-ok').isDisabled(), true)
      assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).activeWorkspace, 'default')
    } finally {
      await app.close()
    }
  }
)

test(
  'an app memory edit queues a local backup and reports a pending remote upload',
  { timeout: 120_000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-workspace-backup-ui-'))
    buildDemoHome(home, { tools: 'all' })
    const configPath = join(home, '.config/illithid/config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(configPath, 'utf8')),
        updateCheck: false,
        marketEnabled: false,
        autoBackup: true,
        allowRealApply: false,
        ui: { language: 'en' }
      })
    )
    const env = {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-workspace-backup-ud-')),
      ILLITHID_TEST: '1',
      ILLITHID_TEST_BACKUP_DELAY_MS: '1000'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({
      args: [resolve('out/main/index.js')],
      env,
      timeout: 60_000
    })
    try {
      const page = await app.firstWindow()
      await page.getByTestId('workspace-select').waitFor()
      const remote = join(home, 'missing-remote.git')
      const edited = await page.evaluate(async (remote) => {
        const connected = await window.api.backupConnect(remote)
        if (!('ok' in connected) || !connected.ok) return connected
        return window.api.memorySave('queued-note.md', '# Queued app edit\n')
      }, remote)
      assert.equal('ok' in edited && edited.ok, true)
      const secondId = await page.evaluate(async (remote) => {
        const created = await window.api.workspaceCreate('Second', 'empty')
        if (!created.ok) throw new Error(created.message)
        const switched = await window.api.workspaceSwitch(created.value.id, false)
        if (!switched.ok) throw new Error(switched.message)
        await window.api.backupConnect(remote)
        await window.api.memorySave('second-note.md', '# Second queued edit\n')
        return created.value.id
      }, remote)
      await waitForAutomaticSnapshot(page)
      const switchedToFirst = await page.evaluate(() =>
        window.api.workspaceSwitch('default', false)
      )
      assert.equal(switchedToFirst.ok, true)
      // Independent workspaces can finish in either order; wait for A's own durable snapshot.
      const firstHistory = await waitForAutomaticSnapshot(page)
      const switchedBack = await page.evaluate(
        (id) => window.api.workspaceSwitch(id, false),
        secondId
      )
      assert.equal(switchedBack.ok, true)
      assert.equal(
        'ok' in firstHistory &&
          firstHistory.ok &&
          firstHistory.value.some((snapshot) => snapshot.message === 'auto backup'),
        true
      )
      assert.equal(
        readFileSync(join(home, '.illithid/workspaces/default/memory/queued-note.md'), 'utf8'),
        '# Queued app edit\n'
      )
      const result = await page.evaluate(() => window.api.backupSnapshot('manual fixture'))
      assert.equal('ok' in result && result.ok, true)
      if ('ok' in result && result.ok) {
        assert.equal(result.value.pushed, false)
        assert.ok(result.value.remoteError)
      }
      await page.locator('[data-menu="backup"]').click()
      await page.getByTestId('backup-remote-error').waitFor()
      const state = await page.evaluate(() => window.api.backupStatus())
      assert.equal(state.dirty, false)
      assert.equal(state.ahead, 1)
      assert.ok(state.remoteError)
    } finally {
      await app.close()
    }
  }
)
