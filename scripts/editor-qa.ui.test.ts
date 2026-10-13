import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { baseEnv, buildDemoHome, put } from './readme-shots'
import { createFolderScript, createHook, createScript, writeScriptFile } from '../src/engine'

async function launchEditorFixture(prepare?: (home: string) => void): Promise<{
  app: ElectronApplication
  page: Page
  home: string
}> {
  const home = mkdtempSync(join(tmpdir(), 'illithid-editor-qa-'))
  buildDemoHome(home, { tools: 'all' })
  const config = join(home, '.config/illithid/config.json')
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, 'utf8')),
      toolsInUse: ['claude', 'codex'],
      allowRealApply: false,
      updateCheck: false,
      marketEnabled: false,
      ui: { language: 'en', views: { rules: 'grid' } }
    })
  )
  prepare?.(home)
  const app = await electron.launch({
    args: [process.env.ILLITHID_UI_ENTRY ?? resolve('out/main/index.js')],
    env: {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-editor-qa-ud-')),
      ILLITHID_TEST: '1'
    },
    timeout: 60_000
  })
  const page = await app.firstWindow()
  await page.locator('[data-menu="rules"][data-active="true"]').waitFor()
  return { app, page, home }
}

async function editRule(page: Page): Promise<ReturnType<Page['locator']>> {
  await page.locator('main [data-card="20-git.md"]').click()
  await page.getByTestId('tab-edit').click()
  return page.getByTestId('detail-sheet').locator('textarea').last()
}

test(
  'QA-SAVE-3 failed and refused raw saves keep the draft dirty',
  { timeout: 120_000 },
  async () => {
    for (const response of [
      { ok: false, code: 'invalidSchema', message: 'Rejected fixture save' },
      { refused: 'invalid', message: 'Refused fixture save' }
    ]) {
      const { app, page } = await launchEditorFixture((home) => {
        createScript(home, 'qa-save', '#!/bin/sh\nprintf "original"\n')
      })
      try {
        await app.evaluate(({ ipcMain }, response) => {
          ipcMain.removeHandler('api:scriptSave')
          ipcMain.handle('api:scriptSave', () => response)
        }, response)
        await page.locator('[data-menu="scripts"]').click()
        await page.locator('main').getByText('qa-save', { exact: true }).first().click()
        await page.getByTestId('script-tab-edit').click()
        const editor = page.getByTestId('detail-sheet').locator('textarea:visible')
        const draft = '#!/bin/sh\nprintf "keep failed draft"\n'
        await editor.fill(draft)
        await page.getByTestId('editor-save').click()
        await page.getByText(response.message, { exact: true }).waitFor()
        await page.locator('[data-testid="editor-save"]:not([data-loading])').waitFor()
        assert.equal(await editor.inputValue(), draft)
        assert.equal(await page.getByTestId('editor-save').isEnabled(), true)
        await page.getByRole('button', { name: 'Back', exact: true }).click()
        await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).waitFor()
      } finally {
        await app.close()
      }
    }
  }
)

test('QA-SAVE-4 Save shortcuts wait for the pending write', { timeout: 120_000 }, async () => {
  const { app, page } = await launchEditorFixture((home) => {
    createScript(home, 'qa-save', '#!/bin/sh\nprintf "original"\n')
  })
  try {
    const initial = await page.evaluate(() => window.api.scripts())
    await app.evaluate(({ ipcMain }, initial) => {
      ipcMain.removeHandler('api:scripts')
      ipcMain.handle('api:scripts', () => initial)
      let pending = false
      ipcMain.removeHandler('api:scriptSave')
      ipcMain.handle('api:scriptSave', async () => {
        if (pending)
          return {
            ok: false,
            code: 'invalidSchema',
            message: 'A second save reached the pending writer'
          }
        pending = true
        await new Promise((resolve) => setTimeout(resolve, 500))
        pending = false
        return { ok: true, value: {} }
      })
    }, initial)
    await page.locator('[data-menu="scripts"]').click()
    await page.locator('main').getByText('qa-save', { exact: true }).first().click()
    await page.getByTestId('script-tab-edit').click()
    const editor = page.getByTestId('detail-sheet').locator('textarea:visible')
    await editor.fill('#!/bin/sh\nprintf "submitted"\n')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    const newer = '#!/bin/sh\nprintf "newer keyboard draft"\n'
    await editor.fill(newer)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await page.getByText('Script saved', { exact: true }).waitFor()
    await page.locator('[data-testid="editor-save"]:not([data-loading])').waitFor()
    assert.equal(
      await page.getByText('A second save reached the pending writer', { exact: true }).count(),
      0
    )
    assert.equal(await editor.inputValue(), newer)
    assert.equal(await page.getByTestId('editor-save').isEnabled(), true)
  } finally {
    await app.close()
  }
})

test(
  'QA-SAVE-1 acknowledged raw save closes before the list reload finishes',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchEditorFixture((home) => {
      createScript(home, 'qa-save', '#!/bin/sh\nprintf "original"\n')
    })
    try {
      const initial = await page.evaluate(() => window.api.scripts())
      // Keep the public list response stale to model a reload that has not delivered the write yet.
      await app.evaluate(({ ipcMain }, initial) => {
        ipcMain.removeHandler('api:scripts')
        ipcMain.handle('api:scripts', () => initial)
      }, initial)
      await page.locator('[data-menu="scripts"]').click()
      await page.locator('main').getByText('qa-save', { exact: true }).first().click()
      await page.getByTestId('script-tab-edit').click()
      const editor = page.getByTestId('detail-sheet').locator('textarea:visible')
      await editor.fill('#!/bin/sh\nprintf "saved"\n')
      await page.getByTestId('editor-save').click()
      await page.getByText('Script saved', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await page.getByTestId('detail-sheet').waitFor({ state: 'hidden', timeout: 5_000 })
      assert.equal(
        await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).count(),
        0
      )
      await page.locator('[data-menu="hooks"]').click()
      await page.locator('[data-menu="hooks"][data-active="true"]').waitFor()
    } finally {
      await app.close()
    }
  }
)

test(
  'QA-SAVE-2 save acknowledgements and reloaded values preserve newer typing',
  { timeout: 120_000 },
  async () => {
    for (const phase of ['pending', 'acknowledged']) {
      const { app, page } = await launchEditorFixture((home) => {
        createScript(home, 'qa-save', '#!/bin/sh\nprintf "original"\n')
      })
      try {
        const initial = await page.evaluate(() => window.api.scripts())
        const submitted = '#!/bin/sh\nprintf "submitted"\n'
        const newer = '#!/bin/sh\nprintf "newer unsaved typing"\n'
        await app.evaluate(
          ({ ipcMain }, { initial, submitted }) => {
            let first = true
            ipcMain.removeHandler('api:scripts')
            ipcMain.handle('api:scripts', async () => {
              if (first) {
                first = false
                return initial
              }
              await new Promise((resolve) => setTimeout(resolve, 800))
              return {
                ...initial,
                scripts: initial.scripts.map((script) =>
                  script.name === 'qa-save' ? { ...script, content: submitted } : script
                )
              }
            })
            ipcMain.removeHandler('api:scriptSave')
            ipcMain.handle('api:scriptSave', async () => {
              await new Promise((resolve) => setTimeout(resolve, 300))
              return { ok: true, value: {} }
            })
          },
          { initial, submitted }
        )
        await page.locator('[data-menu="scripts"]').click()
        await page.locator('main').getByText('qa-save', { exact: true }).first().click()
        await page.getByTestId('script-tab-edit').click()
        const editor = page.getByTestId('detail-sheet').locator('textarea:visible')
        await editor.fill(submitted)
        await page.getByTestId('editor-save').click()
        if (phase === 'acknowledged')
          await page.getByText('Script saved', { exact: true }).waitFor()
        await editor.fill(newer)
        if (phase === 'pending') await page.getByText('Script saved', { exact: true }).waitFor()
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        assert.equal(await editor.inputValue(), newer, phase)
        assert.equal(await page.getByTestId('editor-save').isEnabled(), true)
        await page.getByRole('button', { name: 'Back', exact: true }).click()
        await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).waitFor()
      } finally {
        await app.close()
      }
    }
  }
)

async function verifyRenameDraft(menu: 'rules' | 'skills' | 'agents', name: string): Promise<void> {
  const { app, page } = await launchEditorFixture()
  try {
    await page.locator(`[data-menu="${menu}"]`).click()
    await page.locator('main').getByText(name, { exact: true }).first().click()
    await page.getByTestId('tab-edit').click()
    const prefix = menu === 'rules' ? 'rule' : menu === 'skills' ? 'skill' : 'agent'
    const editor = page.getByTestId('detail-sheet').locator('textarea:visible').last()
    const draft = `# ${menu}\n\nDo not discard my draft by renaming.\n`
    const next = menu === 'rules' ? 'qa-renamed.md' : 'qa-renamed'
    await editor.fill(draft)
    await page.getByTestId(`${prefix}-name`).fill(next)
    await page.getByTestId(`${prefix}-rename`).click()
    const dialog = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
    await dialog.waitFor({ timeout: 5_000 })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(await editor.inputValue(), draft)
    assert.equal(await page.getByTestId('detail-sheet').locator('h1').first().innerText(), name)
    const names = await page.evaluate(async (menu) => {
      if (menu === 'rules') return (await window.api.rules()).files.map((item) => item.name)
      if (menu === 'skills') return (await window.api.skills()).names
      return (await window.api.agents()).names
    }, menu)
    assert.ok(names.includes(name))
    assert.ok(!names.includes(next))
    await page.getByTestId(`${prefix}-rename`).click()
    await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click()
    await page
      .getByTestId('detail-sheet')
      .locator('h1')
      .first()
      .getByText(next, { exact: true })
      .waitFor()
    await page.getByTestId('tab-edit').click()
    assert.notEqual(await editor.inputValue(), draft)
  } finally {
    await app.close()
  }
}

test('QA-DRAFT-8 renaming a rule protects its raw draft', { timeout: 120_000 }, async () => {
  await verifyRenameDraft('rules', '20-git.md')
})

test('QA-DRAFT-9 renaming a skill protects its raw draft', { timeout: 120_000 }, async () => {
  await verifyRenameDraft('skills', 'code-review')
})

test('QA-DRAFT-10 renaming an agent protects its raw draft', { timeout: 120_000 }, async () => {
  await verifyRenameDraft('agents', 'reviewer')
})

test(
  'QA-DRAFT-12 name-only renames do not require raw-draft consent',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchEditorFixture()
    try {
      const journeys = [
        { menu: 'rules', name: '20-git.md', prefix: 'rule', next: 'qa-name-rule.md' },
        { menu: 'skills', name: 'code-review', prefix: 'skill', next: 'qa-name-skill' },
        { menu: 'agents', name: 'reviewer', prefix: 'agent', next: 'qa-name-agent' }
      ]
      for (const journey of journeys) {
        await page.locator(`[data-menu="${journey.menu}"]`).click()
        await page.locator('main').getByText(journey.name, { exact: true }).first().click()
        await page.getByTestId('tab-edit').click()
        assert.equal(await page.locator('[data-testid="editor-save"]:visible').isDisabled(), true)
        await page.getByTestId(`${journey.prefix}-name`).fill(journey.next)
        await page.getByTestId(`${journey.prefix}-rename`).click()
        await page
          .getByTestId('detail-sheet')
          .locator('h1')
          .first()
          .getByText(journey.next, { exact: true })
          .waitFor()
        assert.equal(
          await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).count(),
          0
        )
        await page.getByRole('button', { name: 'Back', exact: true }).click()
      }
    } finally {
      await app.close()
    }
  }
)

test(
  'QA-DRAFT-11 changing a hook script source protects its raw draft',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchEditorFixture((home) => {
      createScript(home, 'qa-library', '#!/bin/sh\nprintf "library"\n')
      createHook(home, 'qa-hook', {
        description: 'Fixture hook',
        when: 'stop',
        action: 'script',
        script: '#!/bin/sh\nprintf "own"\n'
      })
    })
    try {
      await page.locator('[data-menu="hooks"]').click()
      await page.locator('main').getByText('qa-hook', { exact: true }).first().click()
      await page.getByTestId('hook-tab-edit').click()
      const editor = page.getByTestId('detail-sheet').locator('textarea:visible').last()
      const draft = '#!/bin/sh\nprintf "keep unsaved hook draft"\n'
      await editor.fill(draft)
      const source = page.getByTestId('hook-script-use')
      const original = await source.inputValue()
      await source.click()
      await page.getByRole('option', { name: 'qa-library', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
      await dialog.waitFor({ timeout: 5_000 })
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      assert.equal(await editor.inputValue(), draft)
      assert.equal(await source.inputValue(), original)
      const unchanged = await page.evaluate(() => window.api.hookRead('qa-hook'))
      assert.equal(unchanged.ok ? (unchanged.value.doc.options.use ?? '') : null, '')
      await source.click()
      await page.getByRole('option', { name: 'qa-library', exact: true }).click()
      await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click()
      await page.getByTestId('hook-lib-script').waitFor()
      assert.equal(await source.inputValue(), 'qa-library')
      assert.equal(await page.locator('[data-testid="editor-save"]:visible').count(), 0)
      const changed = await page.evaluate(() => window.api.hookRead('qa-hook'))
      assert.equal(changed.ok ? changed.value.doc.options.use : null, 'qa-library')
    } finally {
      await app.close()
    }
  }
)

test(
  'QA-DRAFT-6 changing memory categories protects a raw draft',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchEditorFixture()
    try {
      await page.locator('[data-menu="memory"]').click()
      await page.locator('main').getByText('MEMORY.md', { exact: true }).first().click()
      await page.getByTestId('tab-edit').click()
      const editor = page.getByTestId('detail-sheet').locator('textarea:visible')
      const draft = '# Memory\n\nKeep before switching categories.\n'
      await editor.fill(draft)
      await page.getByTestId('memory-tab-claude').focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
      await dialog.waitFor({ timeout: 5_000 })
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      assert.equal(await editor.inputValue(), draft)
      await page.getByTestId('memory-tab-claude').focus()
      await page.keyboard.press('Enter')
      await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click()
      await page.getByTestId('detail-sheet').waitFor({ state: 'hidden' })
      assert.equal(
        await page.getByTestId('memory-tab-claude').getAttribute('aria-selected'),
        'true'
      )
    } finally {
      await app.close()
    }
  }
)

test(
  'QA-MOVE-1 a changed path cannot use the previous destination',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchEditorFixture((home) => {
      put(home, '.claude/projects/qa-source/memory/note.md', '# Source memory\n')
    })
    try {
      // Hold only the OS-boundary slug reply; scanning and reading use the real fixture files.
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:toolMemorySlug')
        ipcMain.handle('api:toolMemorySlug', async (_event, path: string) => {
          if (path === '/tmp/qa/A') return '-tmp-qa-A'
          await new Promise((resolve) => setTimeout(resolve, 1_500))
          return path === '/tmp/qa/B' ? '-tmp-qa-B' : ''
        })
      })
      await page.locator('[data-menu="memory"]').click()
      await page.getByTestId('memory-tab-claude').click()
      await page.getByTestId('tm-project').filter({ hasText: 'qa-source' }).click()
      await page.getByRole('checkbox', { name: 'note.md', exact: true }).check()
      await page.getByTestId('tm-move').click()
      const path = page.getByTestId('tm-move-path')
      const next = page.getByTestId('tm-move-next')
      await path.fill('/tmp/qa/A')
      await page.getByText('-tmp-qa-A', { exact: true }).waitFor()
      assert.equal(await next.isEnabled(), true)
      await path.fill('/tmp/qa/B')
      assert.equal(await next.isDisabled(), true, 'B must resolve before Move can continue')
      assert.equal(await page.getByText('-tmp-qa-A', { exact: true }).count(), 0)
      await page.getByText('-tmp-qa-B', { exact: true }).waitFor()
      await next.click()
      assert.equal(
        await page.getByTestId('tm-confirm-list').innerText(),
        'note.md → /tmp/qa/B/note.md'
      )
      // Real movement stays gated off, including when the user confirms this fixture destination.
      await page.getByTestId('confirm-ok').click()
      const source = await page.evaluate(() => window.api.toolMemoryRead('qa-source', 'note.md'))
      assert.equal(source.ok && source.value, '# Source memory\n')
    } finally {
      await app.close()
    }
  }
)

test('QA-SCRIPT-1 description replacement tokens stay literal', { timeout: 120_000 }, async () => {
  const { app, page } = await launchEditorFixture()
  try {
    await page.locator('[data-menu="scripts"]').click()
    await page.getByTestId('script-new').click()
    await page.getByTestId('script-new-name').fill('qa-description')
    await page.getByTestId('script-new-description').fill("Use $& $` $' literally")
    await page.getByTestId('script-new-body').fill('#!/bin/sh\n# description: \nprintf "qa"\n')
    await page.getByTestId('script-create').click()
    await page.getByTestId('script-preview').waitFor()
    await page.getByTestId('script-tab-edit').click()
    assert.equal(
      await page.getByTestId('detail-sheet').locator('textarea:visible').inputValue(),
      '#!/bin/sh\n# description: Use $& $` $\' literally\nprintf "qa"\n'
    )
  } finally {
    await app.close()
  }
})

test(
  'QA-MOVE-2 stale and failed lookup replies cannot replace the current destination',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchEditorFixture((home) => {
      put(home, '.claude/projects/qa-source/memory/note.md', '# Source memory\n')
    })
    try {
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:toolMemorySlug')
        ipcMain.handle('api:toolMemorySlug', async (_event, path: string) => {
          if (path === '/tmp/qa/A') {
            await new Promise((resolve) => setTimeout(resolve, 1_000))
            return '-tmp-qa-A'
          }
          if (path === '/tmp/qa/B') return '-tmp-qa-B'
          throw new Error('Destination lookup failed')
        })
      })
      await page.locator('[data-menu="memory"]').click()
      await page.getByTestId('memory-tab-claude').click()
      await page.getByTestId('tm-project').filter({ hasText: 'qa-source' }).click()
      await page.getByRole('checkbox', { name: 'note.md', exact: true }).check()
      await page.getByTestId('tm-move').click()
      const path = page.getByTestId('tm-move-path')
      const next = page.getByTestId('tm-move-next')
      await path.fill('/tmp/qa/A')
      await path.fill('/tmp/qa/B')
      await page.getByText('-tmp-qa-B', { exact: true }).waitFor()
      // The deliberately delayed A reply must remain harmless after B has resolved.
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      assert.equal(await page.getByText('-tmp-qa-B', { exact: true }).count(), 1)
      assert.equal(await next.isEnabled(), true)
      await path.fill('/tmp/qa/C')
      assert.equal(await next.isDisabled(), true)
      await page.getByText(/Destination lookup failed/).waitFor()
      assert.equal(await page.getByText('-tmp-qa-B', { exact: true }).count(), 0)
    } finally {
      await app.close()
    }
  }
)

test(
  'QA-DRAFT-7 Spotlight protects raw drafts for menus and items',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchEditorFixture()
    try {
      const editor = await editRule(page)
      const draft = '# Git\n\nKeep before Spotlight navigation.\n'
      await editor.fill(draft)
      const spotlight = async (query: string): Promise<void> => {
        await page.getByRole('button', { name: 'Back', exact: true }).focus()
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
        const search = page.getByPlaceholder('Go to screen or search skills, MCP, rules, agents…')
        await search.fill(query)
        await page.keyboard.press('Enter')
      }
      await spotlight('Sessions')
      const dialog = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
      await dialog.waitFor({ timeout: 5_000 })
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      assert.equal(await editor.inputValue(), draft)
      await spotlight('30-safety.md')
      await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click()
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLInputElement>('[data-testid="rule-name"]')?.value ===
          '30-safety.md'
      )
      assert.notEqual(await editor.inputValue(), draft)
    } finally {
      await app.close()
    }
  }
)

test('QA-DRAFT-1 Preview preserves unsaved rule text', { timeout: 120_000 }, async () => {
  const { app, page } = await launchEditorFixture()
  try {
    const editor = await editRule(page)
    const draft = '# Git\n\nUnsaved text must survive Preview.\n'
    await editor.fill(draft)
    await page.getByRole('tab', { name: 'Preview', exact: true }).click()
    await page.getByTestId('tab-edit').click()
    assert.equal(await editor.inputValue(), draft)
  } finally {
    await app.close()
  }
})

test('QA-DRAFT-3 library Preview tabs retain raw drafts', { timeout: 120_000 }, async () => {
  const { app, page } = await launchEditorFixture((home) => {
    createScript(home, 'qa-script', '#!/bin/sh\nprintf "fixture"\n')
    createHook(home, 'qa-hook', { description: 'Fixture hook', when: 'stop', action: 'script' })
  })
  try {
    const journeys = [
      { menu: 'skills', name: 'code-review', edit: 'tab-edit' },
      { menu: 'agents', name: 'reviewer', edit: 'tab-edit' },
      { menu: 'memory', name: 'MEMORY.md', edit: 'tab-edit' },
      { menu: 'scripts', name: 'qa-script', edit: 'script-tab-edit' },
      { menu: 'hooks', name: 'qa-hook', edit: 'hook-tab-edit' }
    ]
    for (const journey of journeys) {
      await page.locator(`[data-menu="${journey.menu}"]`).click()
      await page.locator('main').getByText(journey.name, { exact: true }).first().click()
      await page.getByTestId(journey.edit).click()
      const editor = page.getByTestId('detail-sheet').locator('textarea:visible').last()
      const draft = `# ${journey.menu}\n\nUnsaved Preview draft.\n`
      await editor.fill(draft)
      await page.getByRole('tab', { name: 'Preview', exact: true }).click()
      await page.getByTestId(journey.edit).click()
      assert.equal(await editor.inputValue(), draft, journey.menu)
      await page.locator('[data-testid="editor-save"]:visible').click()
      await page.locator('[data-testid="editor-save"]:visible[disabled]').waitFor()
      await page.getByRole('button', { name: 'Back', exact: true }).click()
    }
  } finally {
    await app.close()
  }
})

test(
  'QA-DRAFT-2 leaving a raw draft requires cancel or discard',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchEditorFixture()
    try {
      const editor = await editRule(page)
      const draft = '# Git\n\nKeep this until I explicitly discard it.\n'
      await editor.fill(draft)
      await page.locator('[data-menu="sessions"]').click()
      const dialog = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
      await dialog.waitFor({ timeout: 5_000 })
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      assert.equal(await editor.inputValue(), draft)
      assert.equal(await page.locator('[data-menu="rules"][data-active="true"]').count(), 1)

      await page.getByRole('button', { name: 'Back', exact: true }).click()
      await dialog.waitFor()
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      assert.equal(await editor.inputValue(), draft)

      await page.locator('[data-menu="sessions"]').click()
      await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click()
      await page.locator('[data-menu="sessions"][data-active="true"]').waitFor()
      await page.locator('[data-menu="rules"]').click()
      const reopened = await editRule(page)
      assert.notEqual(await reopened.inputValue(), draft)
    } finally {
      await app.close()
    }
  }
)

test(
  'QA-DRAFT-4 changing a folder file requires cancel or discard',
  { timeout: 120_000 },
  async () => {
    const { app, page } = await launchEditorFixture((home) => {
      createFolderScript(home, 'qa-folder', { description: 'Fixture folder' })
      writeScriptFile(home, 'qa-folder', 'extra.sh', '#!/bin/sh\nprintf "extra"\n')
    })
    try {
      await page.locator('[data-menu="scripts"]').click()
      await page.locator('main').getByText('qa-folder/', { exact: true }).first().click()
      await page.getByTestId('script-tab-edit').click()
      const editor = page.getByTestId('detail-sheet').locator('textarea:visible').last()
      const draft = '#!/bin/sh\nprintf "unsaved folder draft"\n'
      await editor.fill(draft)
      const picker = page.getByTestId('script-file-select')
      await picker.click()
      await page.getByRole('option', { name: 'extra.sh', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
      await dialog.waitFor({ timeout: 5_000 })
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      assert.equal(await editor.inputValue(), draft)
      assert.equal(await picker.inputValue(), 'run.sh')
      await picker.click()
      await page.getByRole('option', { name: 'extra.sh', exact: true }).click()
      await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click()
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLTextAreaElement>('[data-testid="detail-sheet"] textarea')
            ?.value === '#!/bin/sh\nprintf "extra"\n'
      )
    } finally {
      await app.close()
    }
  }
)

test('QA-DRAFT-5 opening another item protects a raw draft', { timeout: 120_000 }, async () => {
  const { app, page } = await launchEditorFixture()
  try {
    const editor = await editRule(page)
    const draft = '# Git\n\nKeep before opening another item.\n'
    await editor.fill(draft)
    await page.locator('main [data-card="30-safety.md"]').focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
    await dialog.waitFor({ timeout: 5_000 })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(await editor.inputValue(), draft)
    await page.locator('main [data-card="30-safety.md"]').focus()
    await page.keyboard.press('Enter')
    await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click()
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLInputElement>('[data-testid="rule-name"]')?.value ===
        '30-safety.md'
    )
    assert.notEqual(await editor.inputValue(), draft)
  } finally {
    await app.close()
  }
})
