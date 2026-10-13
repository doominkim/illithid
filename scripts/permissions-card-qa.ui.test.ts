import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { savePermissionRules } from '../src/engine'
import type { Api, PermissionRules } from '../src/shared/api'
import { baseEnv, buildDemoHome } from './readme-shots'
import { clearToasts } from './lib/toasts'

declare global {
  interface Window {
    api: Api
  }
}

async function launch(
  rules?: PermissionRules
): Promise<Awaited<ReturnType<typeof electron.launch>>> {
  const home = mkdtempSync(join(tmpdir(), 'illithid-permissions-card-qa-'))
  buildDemoHome(home, { tools: 'all' })
  const configPath = join(home, '.config/illithid/config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      ...JSON.parse(readFileSync(configPath, 'utf8')),
      allowRealApply: false,
      toolsInUse: ['claude', 'codex'],
      updateCheck: false,
      marketEnabled: false,
      ui: { language: 'en', views: { rules: 'grid' } }
    })
  )
  if (rules) savePermissionRules(home, rules)
  const env = {
    ...baseEnv(home),
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-permissions-card-qa-ud-')),
    ILLITHID_TEST: '1'
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  return electron.launch({
    args: [resolve(process.env.ILLITHID_UI_ENTRY ?? 'out/main/index.js')],
    env,
    timeout: 60_000
  })
}

test(
  'editing a permission description keeps the tools it is off for, and opening the editor is not a change',
  { timeout: 120_000 },
  async () => {
    const app = await launch({
      commands: [
        {
          decision: 'allow',
          argv: ['git', 'status'],
          exact: false,
          description: 'Original description',
          off: ['codex']
        }
      ]
    })
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="permissions"]').click()
      await page.getByTestId('perm-ungrouped').getByText('git status *', { exact: true }).click()
      await page.getByTestId('perm-tab-edit').click()
      assert.equal(await page.getByTestId('perm-save').isDisabled(), true)
      await page
        .getByTestId('detail-sheet')
        .getByLabel('Description', { exact: true })
        .fill('Updated description')
      await page.getByTestId('perm-save').click()
      await page
        .getByTestId('perm-ungrouped')
        .getByText('Updated description', { exact: true })
        .waitFor()
      const saved = await page.evaluate(() => window.api.permissions())
      assert.deepEqual(saved.rules.commands, [
        {
          decision: 'allow',
          argv: ['git', 'status'],
          exact: false,
          description: 'Updated description',
          off: ['codex']
        }
      ])
      assert.equal(
        await page
          .getByTestId('perm-detail-tools')
          .locator('[data-tool="codex"]')
          .getAttribute('aria-pressed'),
        'false'
      )
      assert.equal(await page.getByTestId('perm-save').isDisabled(), true)
    } finally {
      await app.close()
    }
  }
)

test(
  'editing a permission description preserves a quoted argument instead of splitting it into new words',
  { timeout: 120_000 },
  async () => {
    const app = await launch({
      commands: [{ decision: 'allow', argv: ['printf', 'two words'], exact: true, off: ['codex'] }]
    })
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="permissions"]').click()
      await page
        .getByTestId('perm-ungrouped')
        .getByText('printf two words', { exact: true })
        .click()
      await page.getByTestId('perm-tab-edit').click()
      assert.equal(await page.getByTestId('perm-command').inputValue(), "printf 'two words'")
      assert.equal(await page.getByTestId('perm-save').isDisabled(), true)
      await page
        .getByTestId('detail-sheet')
        .getByLabel('Description', { exact: true })
        .fill('Keep the words together')
      await page.getByTestId('perm-save').click()
      await page
        .getByTestId('perm-ungrouped')
        .getByText('Keep the words together', { exact: true })
        .waitFor()
      assert.deepEqual((await page.evaluate(() => window.api.permissions())).rules.commands, [
        {
          decision: 'allow',
          argv: ['printf', 'two words'],
          exact: true,
          description: 'Keep the words together',
          off: ['codex']
        }
      ])
    } finally {
      await app.close()
    }
  }
)

test(
  'card controls keep their keyboard behavior without opening details, and the card itself opens with Enter or Space',
  { timeout: 120_000 },
  async () => {
    const app = await launch()
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="rules"]').click()
      const card = page.locator('[data-card="20-git.md"]')
      await card.waitFor()
      const checkbox = card.getByTestId('card-all-toggle')
      assert.equal(await checkbox.isChecked(), true)
      await checkbox.focus()
      await page.keyboard.press('Space')
      assert.equal(await page.getByTestId('detail-sheet').isVisible(), false)
      await page
        .locator('[data-card="20-git.md"] [data-testid="card-all-toggle"]:not(:checked)')
        .waitFor()
      const disabled = await page.evaluate(() => window.api.rules())
      assert.equal(disabled.toggles['20-git.md']?.claude, false)
      assert.equal(disabled.toggles['20-git.md']?.codex, false)
      assert.equal(await checkbox.getAttribute('aria-label'), 'Toggle all tools for 20-git.md')

      // Native checkbox Enter does not activate its enclosing card.
      await checkbox.focus()
      await page.keyboard.press('Enter')
      assert.equal(await page.getByTestId('detail-sheet').isVisible(), false)
      assert.equal(await checkbox.isChecked(), false)

      const codex = card.getByRole('button', { name: 'Codex', exact: true })
      await codex.focus()
      await page.keyboard.press('Enter')
      await card.getByRole('button', { name: 'Codex', exact: true, pressed: true }).waitFor()
      assert.equal(await page.getByTestId('detail-sheet').isVisible(), false)
      const oneOn = await page.evaluate(() => window.api.rules())
      assert.equal(oneOn.toggles['20-git.md']?.claude, false)
      assert.equal(oneOn.toggles['20-git.md']?.codex !== false, true)

      await codex.focus()
      await page.keyboard.press('Space')
      await card.getByRole('button', { name: 'Codex', exact: true, pressed: false }).waitFor()
      assert.equal(await page.getByTestId('detail-sheet').isVisible(), false)
      const allOff = await page.evaluate(() => window.api.rules())
      assert.equal(allOff.toggles['20-git.md']?.claude, false)
      assert.equal(allOff.toggles['20-git.md']?.codex, false)

      await card.focus()
      await page.keyboard.press('Enter')
      await page.getByTestId('detail-sheet').waitFor()
      await page.keyboard.press('Escape')
      await page.getByTestId('detail-sheet').waitFor({ state: 'hidden' })
      await card.focus()
      await page.keyboard.press('Space')
      await page.getByTestId('detail-sheet').waitFor()
    } finally {
      await app.close()
    }
  }
)

test(
  'a group edits exact and prefix rules for the same command independently and refuses only a true duplicate',
  { timeout: 120_000 },
  async () => {
    const app = await launch({
      groups: [{ name: 'git', decision: 'deny' }],
      commands: [
        {
          decision: 'allow',
          argv: ['git', 'status'],
          exact: true,
          group: 'git',
          description: 'Exact rule',
          off: ['codex']
        },
        {
          decision: 'deny',
          argv: ['git', 'status'],
          exact: false,
          group: 'git',
          description: 'Prefix rule',
          off: ['claude']
        }
      ]
    })
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="permissions"]').click()
      const group = page.locator('[data-testid="perm-group"][data-group="git"]')
      await group.getByTestId('perm-group-open').click()
      const lines = page.getByTestId('perm-line')
      assert.deepEqual(
        await lines
          .getByTestId('perm-line-match')
          .locator('input:checked')
          .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
        ['exact', 'prefix']
      )
      assert.equal(await page.getByTestId('perm-line-duplicate').count(), 0)
      assert.equal(await page.getByTestId('perm-group-save').isDisabled(), true)

      await page.getByTestId('perm-group-description').fill('Two valid match scopes')
      await page.getByTestId('perm-group-save').click()
      await group.getByText('Two valid match scopes', { exact: true }).waitFor()
      assert.deepEqual((await page.evaluate(() => window.api.permissions())).rules.commands, [
        {
          decision: 'allow',
          argv: ['git', 'status'],
          exact: true,
          description: 'Exact rule',
          group: 'git',
          off: ['codex']
        },
        {
          decision: 'deny',
          argv: ['git', 'status'],
          exact: false,
          description: 'Prefix rule',
          group: 'git',
          off: ['claude']
        }
      ])

      // Matching both words and scope is a duplicate; merely sharing words is valid.
      await lines.nth(1).getByTestId('perm-line-match').getByText('Exact', { exact: true }).click()
      assert.equal(await page.getByTestId('perm-line-duplicate').count(), 1)
      assert.equal(await page.getByTestId('perm-group-save').isDisabled(), true)
      await lines
        .nth(1)
        .getByTestId('perm-line-match')
        .getByText('Prefix *', { exact: true })
        .click()
      assert.equal(await page.getByTestId('perm-line-duplicate').count(), 0)
      await lines.nth(0).getByText('Ask', { exact: true }).click()
      await clearToasts(page)
      await page.getByTestId('perm-group-save').click()
      await group.locator('.ac-row').getByTestId('perm-badge-ask').waitFor()
      assert.deepEqual((await page.evaluate(() => window.api.permissions())).rules.commands, [
        {
          decision: 'ask',
          argv: ['git', 'status'],
          exact: true,
          description: 'Exact rule',
          group: 'git',
          off: ['codex']
        },
        {
          decision: 'deny',
          argv: ['git', 'status'],
          exact: false,
          description: 'Prefix rule',
          group: 'git',
          off: ['claude']
        }
      ])

      // Changing decisions can reorder the stored rules; each match scope still owns its exclusions.
      await lines.nth(0).getByText('Block', { exact: true }).click()
      await lines.nth(1).getByText('Allow', { exact: true }).click()
      await clearToasts(page)
      await page.getByTestId('perm-group-save').click()
      await group.locator('.ac-row').getByTestId('perm-badge-allow').waitFor()
      await page
        .getByTestId('perm-group-description')
        .fill('Keep exclusions after decision changes')
      await clearToasts(page)
      await page.getByTestId('perm-group-save').click()
      await group.getByText('Keep exclusions after decision changes', { exact: true }).waitFor()
      assert.deepEqual((await page.evaluate(() => window.api.permissions())).rules.commands, [
        {
          decision: 'allow',
          argv: ['git', 'status'],
          exact: false,
          description: 'Prefix rule',
          group: 'git',
          off: ['claude']
        },
        {
          decision: 'deny',
          argv: ['git', 'status'],
          exact: true,
          description: 'Exact rule',
          group: 'git',
          off: ['codex']
        }
      ])
      assert.equal(await page.getByTestId('perm-group-save').isDisabled(), true)
    } finally {
      await app.close()
    }
  }
)
