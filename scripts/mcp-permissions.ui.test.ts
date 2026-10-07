import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { parse as parseToml } from 'smol-toml'
import { savePermissionRules, upsertMcpServer } from '../src/engine'
import { baseEnv, buildDemoHome } from './readme-shots'

test(
  'REQ-MCP-PERM-UI-1 the MCP permissions tab sets a server default and per-tool rules; the tools follow; the permissions menu links back',
  { timeout: 180000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-mcp-perm-ui-'))
    buildDemoHome(home, { tools: 'all' })
    const config = join(home, '.config/illithid/config.json')
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, 'utf8')),
        toolsInUse: ['claude', 'codex'],
        updateCheck: false,
        marketEnabled: false,
        ui: { language: 'en', views: { mcp: 'list' } }
      })
    )
    savePermissionRules(home, { commands: [] })
    upsertMcpServer(home, 'kaneo', {
      transport: 'http',
      url: 'https://kaneo.example/mcp',
      codex: { toolApprovals: { get_task: 'auto' } },
      _: { tools: ['delete_task'] }
    })
    const env = {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-mcp-perm-ud-')),
      ILLITHID_TEST: '1'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
    try {
      const page = await app.firstWindow()
      const synced = (): Promise<void> =>
        page.locator('[data-testid="sync-button"][data-state="synced"]').waitFor({ timeout: 30000 })
      await page.locator('[data-menu="mcp"]').click()
      await page.locator('main .ac-row', { hasText: 'kaneo' }).first().click()
      await page.getByTestId('mcp-tab-permissions').click()
      // Tools known from the server's settings
      await page.getByTestId('mcp-perm-tool-get_task').waitFor()
      await page.getByTestId('mcp-perm-tool-delete_task').waitFor()
      // Copilot can't take tool rules: said so only for tools in use (not here)
      assert.equal(await page.getByTestId('mcp-perm-note-copilot').count(), 0)

      await page.getByTestId('mcp-perm-default').getByText('Allow', { exact: true }).click()
      await page
        .getByTestId('mcp-perm-tool-delete_task')
        .getByText('Block', { exact: true })
        .click()
      await page.getByTestId('mcp-perm-add').fill('archive_task')
      await page.getByTestId('mcp-perm-add').press('Enter')
      // A save toast can sit over the row on a small screen (Windows CI): name it, wait for it to go
      const toasts = page.locator('.mantine-Notification-root')
      const texts = await toasts.allInnerTexts()
      if (texts.length) console.log(`toasts: ${texts.join(' | ')}`)
      await toasts
        .first()
        .waitFor({ state: 'detached', timeout: 15_000 })
        .catch(() => {})
      await page.getByTestId('mcp-perm-tool-archive_task').getByText('Ask', { exact: true }).click()
      await synced()
      const claude = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'))
        .permissions as Record<string, string[]>
      assert.ok(claude.allow.includes('mcp__kaneo'))
      assert.ok(claude.deny.includes('mcp__kaneo__delete_task'))
      assert.ok(claude.ask.includes('mcp__kaneo__archive_task'))
      const codex = parseToml(readFileSync(join(home, '.codex/config.toml'), 'utf8')) as {
        mcp_servers: Record<string, Record<string, unknown>>
      }
      assert.equal(codex.mcp_servers.kaneo.default_tools_approval_mode, 'approve')
      assert.deepEqual(codex.mcp_servers.kaneo.disabled_tools, ['delete_task'])
      await page.keyboard.press('Escape')

      // The permissions menu sums it up and opens the server's permissions tab
      await page.locator('[data-menu="permissions"]').click()
      const row = page.getByTestId('perm-mcp-tools').locator('.ac-row', { hasText: 'kaneo' })
      await row.waitFor()
      await row.click()
      await page.locator('[data-testid="mcp-tab-permissions"][aria-selected="true"]').waitFor()
    } finally {
      await app.close()
    }
  }
)

test(
  'MCP permissions warn when a Claude block default prevents a per-tool ask override',
  { timeout: 90000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-mcp-deny-ask-ui-'))
    buildDemoHome(home, { tools: 'all' })
    const config = join(home, '.config/illithid/config.json')
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, 'utf8')),
        toolsInUse: ['claude'],
        updateCheck: false,
        marketEnabled: false,
        ui: { language: 'en', views: { mcp: 'list' } }
      })
    )
    upsertMcpServer(home, 'deny-ask-fixture', {
      transport: 'http',
      url: 'https://fixture.example/mcp',
      permissions: { default: 'deny', tools: { inspect: 'ask' } }
    })
    const env = {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-mcp-deny-ask-ud-')),
      ILLITHID_TEST: '1'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="mcp"]').click()
      await page.locator('main .ac-row', { hasText: 'deny-ask-fixture' }).click()
      await page.getByTestId('mcp-tab-permissions').click()
      await page.getByTestId('mcp-perm-tool-inspect').waitFor()
      await page.getByTestId('mcp-perm-note-claude').waitFor({ timeout: 3000 })
    } finally {
      await app.close()
    }
  }
)
