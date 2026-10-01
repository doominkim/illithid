import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
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

      // New rule: the typed command is shown as the words each tool matches; Block is the default
      await page.getByTestId('perm-new').click()
      await page.getByTestId('perm-command').fill('git push --force')
      await page.getByTestId('perm-argv').getByText('--force', { exact: true }).waitFor()
      await page.getByTestId('perm-create').click()
      await page.getByTestId('perm-group-deny').getByText('git push --force').waitFor()
      await synced()
      assert.deepEqual(claude().permissions?.deny, ['Bash(git push --force:*)'])
      assert.match(
        readFileSync(join(home, '.gemini/policies/illithid.toml'), 'utf8'),
        /decision = "deny"/
      )
      const copilotCheck = join(home, '.copilot/hooks/illithid/_permissions/run.sh')
      assert.ok(existsSync(copilotCheck))

      // Change it to Ask: Copilot can't ask, so its check hook goes
      await page.getByTestId('perm-group-deny').getByText('git push --force').click()
      await page.getByTestId('perm-decision').getByText('Ask', { exact: true }).click()
      await page.getByTestId('perm-save').click()
      await page.getByTestId('perm-group-ask').getByText('git push --force').waitFor()
      await synced()
      assert.deepEqual(claude().permissions?.ask, ['Bash(git push --force:*)'])
      assert.deepEqual(claude().permissions?.deny, [])
      assert.equal(existsSync(copilotCheck), false)

      // Delete (the sheet stays open on the saved rule)
      await page.getByTestId('perm-delete').click()
      await page.getByTestId('confirm-ok').click()
      await page.getByTestId('perm-group-ask').waitFor({ state: 'detached' })
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
  'REQ-PERM-UI-2 block one MCP tool from the MCP tab; Claude Code and Codex follow',
  { timeout: 180000 },
  async () => {
    const { home, app } = await launch(['claude', 'codex'])
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="permissions"]').click()
      await page.getByTestId('perm-tab-mcp').click()
      await page.getByTestId('perm-mcp-new').click()
      await page.getByTestId('perm-mcp-server').click()
      await page.getByRole('option', { name: 'github', exact: true }).click()
      await page.getByTestId('perm-mcp-tool').fill('delete_repository')
      await page.getByTestId('perm-mcp-create').click()
      await page.getByTestId('perm-mcp-group-deny').getByText('delete_repository').waitFor()
      await page
        .locator('[data-testid="sync-button"][data-state="synced"]')
        .waitFor({ timeout: 30000 })
      const claude = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')) as {
        permissions: { deny: string[] }
      }
      assert.deepEqual(claude.permissions.deny, ['mcp__github__delete_repository'])
      assert.match(
        readFileSync(join(home, '.codex/config.toml'), 'utf8'),
        /disabled_tools = \["delete_repository"\]/
      )
    } finally {
      await app.close()
    }
  }
)
