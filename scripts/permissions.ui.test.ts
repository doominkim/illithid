import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type Locator } from 'playwright-core'
import { createHook } from '../src/engine'
import { baseEnv, buildDemoHome } from './readme-shots'

async function launch(
  tools: string[],
  prepare?: (home: string) => void
): Promise<{ home: string; app: Awaited<ReturnType<typeof electron.launch>> }> {
  const home = mkdtempSync(join(tmpdir(), 'illithid-perm-ui-'))
  buildDemoHome(home, { tools: 'all' })
  const config = join(home, '.config/illithid/config.json')
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, 'utf8')),
      toolsInUse: tools,
      updateCheck: false,
      marketEnabled: false,
      ui: { language: 'en' }
    })
  )
  prepare?.(home)
  const env = {
    ...baseEnv(home),
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-perm-ud-')),
    ILLITHID_TEST: '1'
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
  return { home, app }
}

test(
  'REQ-PERM-UI-1 add a block rule, change it to ask, delete it; the tools follow, and guard hooks are listed with a link',
  { timeout: 180000 },
  async () => {
    const { home, app } = await launch(['claude', 'gemini', 'copilot'], (home) =>
      createHook(home, 'guard-before-tool', {
        description: '',
        when: 'before-tool',
        action: 'guard',
        options: {}
      })
    )
    try {
      const page = await app.firstWindow()
      const synced = (): Promise<void> =>
        page.locator('[data-testid="sync-button"][data-state="synced"]').waitFor({ timeout: 30000 })
      const claude = (): { permissions?: Record<string, string[]> } =>
        JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'))
      await page.locator('[data-menu="permissions"]').click()

      const row = (command: string): Locator =>
        page.getByTestId('perm-ungrouped').locator('.ac-row', { hasText: command })

      // New rule: the typed command is shown as the words each tool matches; Block is the default
      await page.getByTestId('perm-new').click()
      await page.getByTestId('perm-command').fill('git push --force')
      await page.getByTestId('perm-argv').getByText('--force', { exact: true }).waitFor()
      await page.getByTestId('perm-create').click()
      await page.getByTestId('perm-ungrouped').getByText('git push --force').waitFor()
      await row('git push --force').getByTestId('perm-badge-deny').waitFor()
      await synced()
      assert.deepEqual(claude().permissions?.deny, ['Bash(git push --force:*)'])
      assert.match(
        readFileSync(join(home, '.gemini/policies/illithid.toml'), 'utf8'),
        /decision = "deny"/
      )
      const copilotCheck = join(home, '.copilot/hooks/illithid/_permissions/run.sh')
      assert.ok(existsSync(copilotCheck))

      // Change it to Ask: Copilot can't ask, so its check hook goes
      await row('git push --force').click()
      await page.getByTestId('perm-decision').getByText('Ask', { exact: true }).click()
      await page.getByTestId('perm-save').click()
      await row('git push --force').getByTestId('perm-badge-ask').waitFor()
      await synced()
      assert.deepEqual(claude().permissions?.ask, ['Bash(git push --force:*)'])
      assert.deepEqual(claude().permissions?.deny, [])
      assert.equal(existsSync(copilotCheck), false)

      // Delete (the sheet stays open on the saved rule)
      await page.getByTestId('perm-delete').click()
      await page.getByTestId('confirm-ok').click()
      await page.getByTestId('perm-ungrouped').waitFor({ state: 'detached' })
      await synced()
      assert.equal(claude().permissions?.ask, undefined)
      await page.keyboard.press('Escape')

      // Guard hooks block commands too: listed here, one click to the hook
      await page.getByTestId('perm-guard-hooks').getByText('guard-before-tool').click()
      await page.getByTestId('hook-summary').waitFor()
    } finally {
      await app.close()
    }
  }
)

test(
  'REQ-PERM-UI-2 a group takes several commands at once, each with its own decision; editing and deleting it changes its rules',
  { timeout: 180000 },
  async () => {
    const { home, app } = await launch(['claude'])
    try {
      const page = await app.firstWindow()
      const synced = (): Promise<void> =>
        page.locator('[data-testid="sync-button"][data-state="synced"]').waitFor({ timeout: 30000 })
      const claude = (): { permissions?: Record<string, string[]> } =>
        JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'))
      const lib = (): Record<string, unknown> =>
        JSON.parse(
          readFileSync(join(home, '.illithid/workspaces/default/permissions.json'), 'utf8')
        )
      const line = (command: string): Locator =>
        page.getByTestId('perm-line').filter({ hasText: command })
      await page.locator('[data-menu="permissions"]').click()

      // New group: Block by default; one line is changed to Allow
      await page.getByTestId('perm-group-new').click()
      await page.getByTestId('perm-group-name').fill('git')
      await page.getByTestId('perm-group-description').fill('Hard to undo')
      await page
        .getByTestId('perm-group-commands')
        .fill('git push --force\ngit reset --hard\n\ngit status')
      await line('git status').getByText('Allow', { exact: true }).click()
      await page.getByTestId('perm-group-create').click()
      const section = page.locator('[data-testid="perm-group"][data-group="git"]')
      await section.getByText('Hard to undo').waitFor()
      await section.getByText('git reset --hard').waitFor()
      await synced()
      assert.deepEqual(claude().permissions?.deny, [
        'Bash(git push --force:*)',
        'Bash(git reset --hard:*)'
      ])
      assert.deepEqual(claude().permissions?.allow, ['Bash(git status:*)'])
      assert.deepEqual(lib().groups, [
        { name: 'git', description: 'Hard to undo', decision: 'deny' }
      ])

      // Edit: rename, drop a line, add one that starts with the group default
      await section.getByTestId('perm-group-open').click()
      await page.getByTestId('perm-group-name').fill('git danger')
      await page
        .getByTestId('perm-group-commands')
        .fill('git push --force\ngit status\ngit clean -fd')
      await line('git status').getByText('Allow', { exact: true }).waitFor()
      await page.getByTestId('perm-group-save').click()
      const renamed = page.locator('[data-testid="perm-group"][data-group="git danger"]')
      await renamed.getByText('git clean -fd').waitFor()
      await synced()
      assert.deepEqual(claude().permissions?.deny, [
        'Bash(git push --force:*)',
        'Bash(git clean -fd:*)'
      ])
      assert.deepEqual(claude().permissions?.allow, ['Bash(git status:*)'])
      await page.keyboard.press('Escape')

      // A line that another rule already has is refused
      await page.getByTestId('perm-new').click()
      await page.getByTestId('perm-command').fill('ls')
      await page.getByTestId('perm-create').click()
      await page.getByTestId('perm-ungrouped').getByText('ls', { exact: true }).waitFor()
      await renamed.getByTestId('perm-group-open').click()
      await page.getByTestId('perm-group-commands').fill('git push --force\nls')
      await line('ls').getByTestId('perm-line-duplicate').waitFor()
      assert.equal(await page.getByTestId('perm-group-save').isDisabled(), true)

      // Delete the group: its rules go, the others stay
      await page.getByTestId('perm-group-delete').click()
      await page.getByTestId('confirm-ok').click()
      await renamed.waitFor({ state: 'detached' })
      await synced()
      // ls was added with the default, Block
      assert.deepEqual(claude().permissions?.deny, ['Bash(ls:*)'])
      assert.deepEqual(claude().permissions?.allow, [])
      assert.equal(lib().groups, undefined)
    } finally {
      await app.close()
    }
  }
)
