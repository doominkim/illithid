import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { parse as parseToml } from 'smol-toml'
import { savePermissionRules, upsertMcpServer } from '../src/engine'
import { baseEnv, buildDemoHome } from './readme-shots'

/** A demo HOME with Claude Code and Codex in use, a kaneo server with known tools and a notion server with none */
async function launch(): Promise<{ home: string; app: ElectronApplication; page: Page }> {
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
  upsertMcpServer(home, 'notion', { transport: 'http', url: 'https://notion.example/mcp' })
  const env = {
    ...baseEnv(home),
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-mcp-perm-ud-')),
    ILLITHID_TEST: '1'
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
  return { home, app, page: await app.firstWindow() }
}

const claudeRules = (home: string): Record<string, string[]> =>
  JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).permissions
const synced = (page: Page): Promise<void> =>
  page.locator('[data-testid="sync-button"][data-state="synced"]').waitFor({ timeout: 30000 })
const server = (page: Page, name: string): ReturnType<Page['locator']> =>
  page.locator(`[data-testid="perm-mcp-server"][data-server="${name}"]`)

test(
  'REQ-MCP-PERM-UI-1 the permissions menu opens a server to set its default and per-tool rules; the tools follow',
  { timeout: 180000 },
  async () => {
    const { home, app, page } = await launch()
    try {
      await page.locator('[data-menu="permissions"]').click()
      const kaneo = server(page, 'kaneo')
      await kaneo.getByTestId('perm-mcp-server-open').click()
      // Tools known from the server's settings
      await kaneo.getByTestId('mcp-perm-tool-get_task').waitFor()
      await kaneo.getByTestId('mcp-perm-tool-delete_task').waitFor()
      // Copilot can't take tool rules: said so only for tools in use (not here)
      assert.equal(await kaneo.getByTestId('mcp-perm-note-copilot').count(), 0)

      await kaneo.getByTestId('mcp-perm-default').getByText('Allow', { exact: true }).click()
      await kaneo
        .getByTestId('mcp-perm-tool-delete_task')
        .getByText('Block', { exact: true })
        .click()
      await kaneo.getByTestId('mcp-perm-add').fill('archive_task')
      await kaneo.getByTestId('mcp-perm-add').press('Enter')
      await kaneo
        .getByTestId('mcp-perm-tool-archive_task')
        .getByText('Ask', { exact: true })
        .click()
      await synced(page)
      const claude = claudeRules(home)
      assert.ok(claude.allow.includes('mcp__kaneo'))
      assert.ok(claude.deny.includes('mcp__kaneo__delete_task'))
      assert.ok(claude.ask.includes('mcp__kaneo__archive_task'))
      const codex = parseToml(readFileSync(join(home, '.codex/config.toml'), 'utf8')) as {
        mcp_servers: Record<string, Record<string, unknown>>
      }
      assert.equal(codex.mcp_servers.kaneo.default_tools_approval_mode, 'approve')
      assert.deepEqual(codex.mcp_servers.kaneo.disabled_tools, ['delete_task'])
      // The server's line sums it up
      await kaneo
        .getByTestId('perm-mcp-summary')
        .getByText('Default: Allow · Block 1 · Ask 1', { exact: true })
        .waitFor()
    } finally {
      await app.close()
    }
  }
)

test(
  'REQ-MCP-PERM-UI-2 the default for all servers reaches a server without its own; the MCP detail sums it up and links to it',
  { timeout: 180000 },
  async () => {
    const { home, app, page } = await launch()
    try {
      await page.locator('[data-menu="permissions"]').click()
      await page.getByTestId('perm-mcp-default').getByText('Allow', { exact: true }).click()
      await page.getByTestId('perm-mcp-allow-warning').waitFor()
      await synced(page)
      assert.ok(claudeRules(home).allow.includes('mcp__notion'))
      const notion = server(page, 'notion')
      await notion
        .getByTestId('perm-mcp-summary')
        .getByText('Default: Allow (all servers)', { exact: true })
        .waitFor()

      // The MCP detail shows the same line and opens the server in the permissions menu
      await page.locator('[data-menu="mcp"]').click()
      await page.locator('main .ac-row', { hasText: 'notion' }).first().click()
      await page
        .getByTestId('mcp-perm-summary')
        .getByText('Default: Allow (all servers)', { exact: true })
        .waitFor()
      assert.equal(await page.getByTestId('mcp-tab-permissions').count(), 0)
      await page.getByTestId('mcp-perm-link').click()
      await notion
        .getByTestId('mcp-perm-default')
        .getByText('All servers (Allow)', { exact: true })
        .waitFor()

      // Its own default wins over the one for all
      await notion.getByTestId('mcp-perm-default').getByText('Ask', { exact: true }).click()
      await synced(page)
      const claude = claudeRules(home)
      assert.ok(!claude.allow.includes('mcp__notion'))
      assert.ok(claude.ask.includes('mcp__notion'))
    } finally {
      await app.close()
    }
  }
)
