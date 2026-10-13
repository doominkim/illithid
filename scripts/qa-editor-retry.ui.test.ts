import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type Page } from 'playwright-core'
import { createFolderScript, createHook, writeScriptFile } from '../src/engine'
import { baseEnv, buildDemoHome, put } from './readme-shots'

async function launchRetryFixture(prepare?: (home: string) => void): Promise<{
  app: Awaited<ReturnType<typeof electron.launch>>
  page: Page
}> {
  const home = mkdtempSync(join(tmpdir(), 'illithid-editor-retry-'))
  buildDemoHome(home, { tools: 'all' })
  const config = join(home, '.config/illithid/config.json')
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, 'utf8')),
      allowRealApply: false,
      updateCheck: false,
      marketEnabled: false,
      toolsInUse: ['claude', 'codex'],
      ui: { language: 'en', views: { skills: 'grid' } }
    })
  )
  createFolderScript(home, 'qa-folder', { description: 'Fixture folder' })
  writeScriptFile(home, 'qa-folder', 'extra.sh', '#!/bin/sh\nprintf "extra"\n')
  prepare?.(home)
  const app = await electron.launch({
    args: [process.env.ILLITHID_UI_ENTRY ?? resolve('out/main/index.js')],
    env: {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-editor-retry-ud-')),
      ILLITHID_TEST: '1'
    },
    timeout: 60_000
  })
  const page = await app.firstWindow()
  await page.locator('[data-menu="rules"]').waitFor()
  return { app, page }
}

async function offlineOnce(
  app: Awaited<ReturnType<typeof electron.launch>>,
  channel: string,
  value: unknown
): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, { channel, value }) => {
      let offline = true
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => {
        if (offline) {
          offline = false
          return { ok: false, code: 'notFound', message: 'Offline fixture reader' }
        }
        return { ok: true, value }
      })
    },
    { channel, value }
  )
}

test(
  'QA-RETRY-MEMORY-1 Reload recovers the same shared memory note',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchRetryFixture()
    try {
      await offlineOnce(app, 'api:memoryRead', '# Recovered shared memory\n')
      await page.locator('[data-menu="memory"]').click()
      await page.locator('main').getByText('MEMORY.md', { exact: true }).first().click()
      const sheet = page.getByTestId('detail-sheet')
      await sheet.getByText('Offline fixture reader', { exact: true }).waitFor()
      await sheet.getByRole('button', { name: 'Reload', exact: true }).click()
      await page.getByTestId('tab-edit').waitFor({ timeout: 5_000 })
      await page.getByTestId('tab-edit').click()
      assert.equal(
        await sheet.locator('textarea:visible').inputValue(),
        '# Recovered shared memory\n'
      )
      assert.equal(await sheet.locator('h1').first().innerText(), 'MEMORY.md')
    } finally {
      await app.close()
    }
  }
)

test(
  'QA-RETRY-AGENT-1 Reload recovers the same agent instructions',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchRetryFixture()
    try {
      await offlineOnce(app, 'api:agentDoc', {
        name: 'reviewer',
        description: 'Recovered agent',
        tools: {},
        body: '# Recovered reviewer\n'
      })
      await page.locator('[data-menu="agents"]').click()
      await page.locator('main').getByText('reviewer', { exact: true }).first().click()
      const sheet = page.getByTestId('detail-sheet')
      await sheet.getByText('Offline fixture reader', { exact: true }).waitFor()
      await sheet.getByRole('button', { name: 'Reload', exact: true }).click()
      await page.getByTestId('tab-edit').waitFor({ timeout: 5_000 })
      await page.getByTestId('tab-edit').click()
      assert.equal(await page.getByTestId('agent-name').inputValue(), 'reviewer')
      assert.equal(
        await sheet.locator('textarea:visible').last().inputValue(),
        '# Recovered reviewer\n'
      )
    } finally {
      await app.close()
    }
  }
)

test(
  'QA-RETRY-CLAUDE-1 Reload recovers the same Claude memory preview',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchRetryFixture((home) => {
      put(home, '.claude/projects/qa-retry-source/memory/note.md', '# Source note\n')
    })
    try {
      await offlineOnce(app, 'api:toolMemoryRead', '# Recovered Claude preview\n')
      await page.locator('[data-menu="memory"]').click()
      await page.getByTestId('memory-tab-claude').click()
      await page.getByTestId('tm-project').filter({ hasText: 'qa-retry-source' }).click()
      await page.getByTestId('tm-file').filter({ hasText: 'note' }).click()
      const preview = page.getByTestId('tm-preview')
      await preview.getByRole('button', { name: 'Reload', exact: true }).waitFor()
      await preview.getByRole('button', { name: 'Reload', exact: true }).click()
      await preview
        .getByRole('heading', { name: 'Recovered Claude preview' })
        .waitFor({ timeout: 5_000 })
      assert.equal(
        await page.locator('.ac-memory-preview').getByText('note.md', { exact: true }).count(),
        1
      )
    } finally {
      await app.close()
    }
  }
)

test(
  'QA-RETRY-CODEX-1 Reload recovers the same Codex memory preview',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchRetryFixture((home) => {
      put(home, '.codex/memories/MEMORY.md', '# Source Codex note\n')
    })
    try {
      await offlineOnce(app, 'api:codexMemoryRead', {
        text: '# Recovered Codex preview\n',
        size: 26
      })
      await page.locator('[data-menu="memory"]').click()
      await page.getByTestId('memory-tab-codex').click()
      await page.getByTestId('codex-entry').filter({ hasText: 'MEMORY.md' }).click()
      const preview = page.getByTestId('tm-preview')
      await preview.getByRole('button', { name: 'Reload', exact: true }).waitFor()
      await preview.getByRole('button', { name: 'Reload', exact: true }).click()
      await preview
        .getByRole('heading', { name: 'Recovered Codex preview' })
        .waitFor({ timeout: 5_000 })
      assert.equal(
        await page.locator('.ac-memory-preview').getByText('MEMORY.md', { exact: true }).count(),
        1
      )
    } finally {
      await app.close()
    }
  }
)

test('QA-RETRY-HOOK-1 Reload recovers the same hook detail', { timeout: 120_000 }, async () => {
  const { app, page } = await launchRetryFixture((home) => {
    createHook(home, 'qa-retry-hook', {
      description: 'Fixture hook',
      when: 'stop',
      action: 'script'
    })
  })
  try {
    const original = await page.evaluate(() => window.api.hookRead('qa-retry-hook'))
    assert.ok(original.ok)
    if (!original.ok) throw new Error('Fixture hook could not be read')
    await offlineOnce(app, 'api:hookRead', original.value)
    await page.locator('[data-menu="hooks"]').click()
    await page.locator('main').getByText('qa-retry-hook', { exact: true }).first().click()
    const sheet = page.getByTestId('detail-sheet')
    await sheet.getByText('Offline fixture reader', { exact: true }).waitFor()
    await sheet.getByRole('button', { name: 'Reload', exact: true }).click()
    await page.getByTestId('hook-tab-edit').waitFor({ timeout: 5_000 })
    await page.getByTestId('hook-tab-edit').click()
    assert.equal(await sheet.locator('h1').first().innerText(), 'qa-retry-hook')
    assert.match(await sheet.locator('textarea:visible').last().inputValue(), /^#!\/bin\/sh/)
  } finally {
    await app.close()
  }
})

test(
  'QA-RETRY-ROLLOUT-1 Reload recovers the Codex rollout list',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchRetryFixture((home) => {
      put(home, '.codex/memories/rollout_summaries/qa-summary.md', '# Source rollout summary\n')
    })
    try {
      await offlineOnce(app, 'api:codexRollouts', [
        { name: 'qa-summary.md', bytes: 25, updatedAt: '2026-10-13T00:00:00.000Z' }
      ])
      await page.locator('[data-menu="memory"]').click()
      await page.getByTestId('memory-tab-codex').click()
      await page.getByTestId('codex-entry').filter({ hasText: 'rollout_summaries/' }).click()
      const list = page.getByTestId('codex-memory')
      await list.getByRole('button', { name: 'Reload', exact: true }).waitFor()
      await list.getByRole('button', { name: 'Reload', exact: true }).click()
      await page
        .getByTestId('codex-rollout')
        .filter({ hasText: 'qa-summary.md' })
        .waitFor({ timeout: 5_000 })
      assert.equal(await list.getByText('rollout_summaries/', { exact: true }).count(), 1)
    } finally {
      await app.close()
    }
  }
)

test(
  'QA-RETRY-FILE-1 Reload retries the same folder file after an offline response',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchRetryFixture()
    try {
      await app.evaluate(({ ipcMain }) => {
        let offline = true
        ipcMain.removeHandler('api:scriptFileRead')
        ipcMain.handle('api:scriptFileRead', () => {
          if (offline) {
            offline = false
            return { ok: false, code: 'notFound', message: 'Offline fixture file' }
          }
          return { ok: true, value: '#!/bin/sh\nprintf "recovered same file"\n' }
        })
      })
      await page.locator('[data-menu="scripts"]').click()
      await page.locator('main').getByText('qa-folder/', { exact: true }).first().click()
      await page.getByTestId('script-tab-edit').click()
      const sheet = page.getByTestId('detail-sheet')
      await sheet.getByText('Offline fixture file', { exact: true }).waitFor()
      await sheet.getByRole('button', { name: 'Reload', exact: true }).click()
      await sheet.locator('textarea:visible').waitFor({ timeout: 5_000 })
      assert.equal(
        await sheet.locator('textarea:visible').inputValue(),
        '#!/bin/sh\nprintf "recovered same file"\n'
      )
      assert.equal(await page.getByTestId('script-file-select').inputValue(), 'run.sh')
    } finally {
      await app.close()
    }
  }
)

test(
  'QA-RETRY-SKILL-1 Reload retries the same skill after an offline file-list response',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchRetryFixture()
    try {
      await app.evaluate(({ ipcMain }) => {
        let offline = true
        ipcMain.removeHandler('api:skillFiles')
        ipcMain.handle('api:skillFiles', () => {
          if (offline) {
            offline = false
            return { ok: false, code: 'notFound', message: 'Offline fixture skill files' }
          }
          return { ok: true, value: ['SKILL.md'] }
        })
      })
      await page.locator('[data-menu="skills"]').click()
      await page.locator('main').getByText('code-review', { exact: true }).first().click()
      const sheet = page.getByTestId('detail-sheet')
      await sheet.getByText('Offline fixture skill files', { exact: true }).waitFor()
      await sheet.getByRole('button', { name: 'Reload', exact: true }).click()
      await page.getByTestId('tab-edit').waitFor({ timeout: 5_000 })
      await page.getByTestId('tab-edit').click()
      assert.equal(await page.getByTestId('skill-name').inputValue(), 'code-review')
      assert.match(await sheet.locator('textarea:visible').last().inputValue(), /^# Code Review\n/)
    } finally {
      await app.close()
    }
  }
)

test('QA-RETRY-FILE-2 rejected file reads remain retryable', { timeout: 120_000 }, async () => {
  const { app, page } = await launchRetryFixture()
  try {
    await app.evaluate(({ ipcMain }) => {
      let offline = true
      ipcMain.removeHandler('api:scriptFileRead')
      ipcMain.handle('api:scriptFileRead', () => {
        if (offline) {
          offline = false
          throw new Error('Offline fixture rejected file')
        }
        return { ok: true, value: '# Recovered rejected file\n' }
      })
    })
    await page.locator('[data-menu="scripts"]').click()
    await page.locator('main').getByText('qa-folder/', { exact: true }).first().click()
    await page.getByTestId('script-tab-edit').click()
    const sheet = page.getByTestId('detail-sheet')
    await sheet.getByText(/Offline fixture rejected file/).waitFor({ timeout: 5_000 })
    await sheet.getByRole('button', { name: 'Reload', exact: true }).click()
    await sheet.locator('textarea:visible').waitFor({ timeout: 5_000 })
    assert.equal(
      await sheet.locator('textarea:visible').inputValue(),
      '# Recovered rejected file\n'
    )
    assert.equal(await page.getByTestId('script-file-select').inputValue(), 'run.sh')
  } finally {
    await app.close()
  }
})

test(
  'QA-RETRY-SKILL-2 rejected skill file and document reads remain retryable',
  { timeout: 120_000 },
  async () => {
    for (const channel of ['api:skillFiles', 'api:skillDoc']) {
      const { app, page } = await launchRetryFixture()
      try {
        await app.evaluate(({ ipcMain }, channel) => {
          let offline = true
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, () => {
            if (offline) {
              offline = false
              throw new Error('Offline fixture rejected skill')
            }
            return {
              ok: true,
              value:
                channel === 'api:skillFiles'
                  ? ['SKILL.md']
                  : {
                      name: 'code-review',
                      frontmatterName: 'code-review',
                      description: 'Recovered skill',
                      extra: {},
                      body: '# Recovered code-review\n'
                    }
            }
          })
        }, channel)
        await page.locator('[data-menu="skills"]').click()
        await page.locator('main').getByText('code-review', { exact: true }).first().click()
        const sheet = page.getByTestId('detail-sheet')
        await sheet
          .getByText(/Offline fixture rejected skill/)
          .first()
          .waitFor({ timeout: 5_000 })
        await sheet.getByRole('button', { name: 'Reload', exact: true }).click()
        await sheet
          .getByText(/Offline fixture rejected skill/)
          .first()
          .waitFor({ state: 'hidden' })
        await page.getByTestId('tab-edit').click()
        assert.equal(await page.getByTestId('skill-name').inputValue(), 'code-review')
        const text = await sheet.locator('textarea:visible').last().inputValue()
        assert.match(
          text,
          channel === 'api:skillFiles' ? /^# Code Review\n/ : /^# Recovered code-review\n/
        )
      } finally {
        await app.close()
      }
    }
  }
)

test(
  'QA-RETRY-FILE-3 a delayed retried file cannot overwrite the next selected file',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchRetryFixture()
    try {
      await app.evaluate(({ ipcMain }) => {
        let offline = true
        ipcMain.removeHandler('api:scriptFileRead')
        ipcMain.handle('api:scriptFileRead', async (_event, _name: string, rel: string) => {
          if (rel === 'extra.sh') return { ok: true, value: '# Current extra file\n' }
          if (offline) {
            offline = false
            return { ok: false, code: 'notFound', message: 'Offline fixture file' }
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000))
          return { ok: true, value: '# Stale run.sh response\n' }
        })
      })
      await page.locator('[data-menu="scripts"]').click()
      await page.locator('main').getByText('qa-folder/', { exact: true }).first().click()
      await page.getByTestId('script-tab-edit').click()
      const sheet = page.getByTestId('detail-sheet')
      await sheet.getByText('Offline fixture file', { exact: true }).waitFor()
      await sheet.getByRole('button', { name: 'Reload', exact: true }).click()
      const picker = page.getByTestId('script-file-select')
      await picker.click()
      await page.getByRole('option', { name: 'extra.sh', exact: true }).click()
      await sheet.locator('textarea:visible').waitFor()
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      assert.equal(await sheet.locator('textarea:visible').inputValue(), '# Current extra file\n')
      assert.equal(await picker.inputValue(), 'extra.sh')
    } finally {
      await app.close()
    }
  }
)

test(
  'QA-RETRY-SKILL-3 a delayed retried skill cannot overwrite the next selected skill',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchRetryFixture()
    try {
      await app.evaluate(({ ipcMain }) => {
        let offline = true
        ipcMain.removeHandler('api:skillFiles')
        ipcMain.handle('api:skillFiles', async (_event, name: string) => {
          if (name !== 'code-review') return { ok: true, value: ['SKILL.md'] }
          if (offline) {
            offline = false
            return { ok: false, code: 'notFound', message: 'Offline fixture skill files' }
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000))
          return { ok: false, code: 'notFound', message: 'Stale code-review failure' }
        })
      })
      await page.locator('[data-menu="skills"]').click()
      await page.locator('main').getByText('code-review', { exact: true }).first().click()
      const sheet = page.getByTestId('detail-sheet')
      await sheet.getByText('Offline fixture skill files', { exact: true }).waitFor()
      await sheet.getByRole('button', { name: 'Reload', exact: true }).click()
      await page.locator('main [data-card="release-notes"]').focus()
      await page.keyboard.press('Enter')
      await page.getByTestId('tab-edit').click()
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      assert.equal(await page.getByTestId('skill-name').inputValue(), 'release-notes')
      assert.match(
        await sheet.locator('textarea:visible').last().inputValue(),
        /^# Release Notes\n/
      )
      assert.equal(await sheet.getByText('Stale code-review failure', { exact: true }).count(), 0)
    } finally {
      await app.close()
    }
  }
)
