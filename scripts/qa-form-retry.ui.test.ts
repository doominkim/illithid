import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

async function launch(): Promise<Awaited<ReturnType<typeof electron.launch>>> {
  const home = mkdtempSync(join(tmpdir(), 'illithid-qa-form-retry-'))
  buildDemoHome(home, { tools: 'all' })
  const config = join(home, '.config/illithid/config.json')
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, 'utf8')),
      allowRealApply: false,
      toolsInUse: ['claude', 'codex'],
      updateCheck: false,
      marketEnabled: true,
      ui: { language: 'en', views: { mcp: 'list' } }
    })
  )
  const env = {
    ...baseEnv(home),
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-qa-form-retry-ud-')),
    ILLITHID_TEST: '1'
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({
    args: [resolve(process.env.ILLITHID_UI_ENTRY ?? 'out/main/index.js')],
    env,
    timeout: 60_000
  })
  // The window is created after IPC registration; replacing handlers earlier can abort startup.
  await app.firstWindow()
  await app.evaluate(({ ipcMain }) => {
    globalThis.fetch = (async () => {
      throw new Error('Network disabled in local retry fixtures')
    }) as typeof fetch
    ipcMain.removeHandler('api:mcpFetchTools')
    ipcMain.handle('api:mcpFetchTools', () => {
      throw new Error('Live MCP fetch disabled in local retry fixtures')
    })
  })
  return app
}

test(
  'MCP editing retries the same server after offline and rejected reads',
  { timeout: 120_000 },
  async () => {
    const app = await launch()
    try {
      const page = await app.firstWindow()
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:mcpRead')
        ipcMain.handle('api:mcpRead', () => ({
          ok: false,
          code: 'offline',
          message: 'MCP edit offline'
        }))
      })
      await page.locator('[data-menu="mcp"]').click()
      await page.locator('main .ac-row', { hasText: 'playwright' }).click()
      await page.getByTestId('tab-edit').click()
      const detail = page.getByTestId('detail-sheet')
      await detail.getByText('MCP edit offline', { exact: true }).waitFor()
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:mcpRead')
        ipcMain.handle('api:mcpRead', () => {
          throw new Error('MCP edit rejected')
        })
      })
      await detail.getByRole('button', { name: 'Reload', exact: true }).click()
      await detail.getByText(/MCP edit rejected$/).waitFor({ timeout: 3000 })
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:mcpRead')
        ipcMain.handle('api:mcpRead', (_event, name: string) => ({
          ok: true,
          value: {
            name,
            def: { transport: 'http', url: 'https://fixture.invalid/mcp' },
            masked: []
          }
        }))
      })
      await detail.getByRole('button', { name: 'Reload', exact: true }).click()
      await page.getByTestId('mcp-name').waitFor()
      assert.equal(await page.getByTestId('mcp-name').inputValue(), 'playwright')
      assert.equal(await page.getByTestId('mcp-url').inputValue(), 'https://fixture.invalid/mcp')
      await page.getByTestId('mcp-description').fill('Local draft after recovery')
      assert.equal(
        await page.getByTestId('mcp-description').inputValue(),
        'Local draft after recovery'
      )
    } finally {
      await app.close()
    }
  }
)

test(
  'market detail retries recover the selected item without installing or requesting the network',
  { timeout: 120_000 },
  async () => {
    const app = await launch()
    try {
      const page = await app.firstWindow()
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:marketSearch')
        ipcMain.handle('api:marketSearch', () => ({
          ok: true,
          value: {
            skills: [
              {
                id: 'sample/repo/qa-skill',
                source: 'sample/repo',
                skillId: 'qa-skill',
                name: 'QA detail skill',
                installs: 0
              }
            ],
            installed: {}
          }
        }))
        ipcMain.removeHandler('api:marketDetail')
        ipcMain.handle('api:marketDetail', () => ({
          ok: false,
          code: 'offline',
          message: 'Market detail offline'
        }))
      })
      await page.locator('[data-menu="market"]').click()
      await page.getByText('QA detail skill', { exact: true }).click()
      const detail = page.getByTestId('detail-sheet')
      await detail.getByText(/Market detail offline$/).waitFor()
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:marketDetail')
        ipcMain.handle('api:marketDetail', () => {
          throw new Error('Market detail rejected')
        })
      })
      await detail.getByRole('button', { name: 'Reload', exact: true }).click()
      await detail.getByText(/Market detail rejected$/).waitFor({ timeout: 3000 })
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:marketDetail')
        ipcMain.handle('api:marketDetail', (_event, kind: string, id: string) => ({
          ok: true,
          value: {
            kind,
            id,
            source: 'sample/repo',
            skillId: 'qa-skill',
            name: 'qa-skill',
            skillMd: '# Recovered QA skill',
            files: [],
            skipped: [],
            audit: null,
            ref: 'fixture-ref'
          }
        }))
      })
      await detail.getByRole('button', { name: 'Reload', exact: true }).click()
      await page.getByTestId('market-name').waitFor()
      assert.equal(await page.getByTestId('market-name').inputValue(), 'qa-skill')
      await detail.getByRole('heading', { name: 'Recovered QA skill', exact: true }).waitFor()
      await page.getByTestId('market-name').fill('local-install-draft')
      assert.equal(await page.getByTestId('market-name').inputValue(), 'local-install-draft')
      assert.equal(await detail.getByText('sample/repo/qa-skill', { exact: true }).count(), 1)
    } finally {
      await app.close()
    }
  }
)

test(
  'market list retries keep the search query and recover from rejected replies',
  { timeout: 120_000 },
  async () => {
    const app = await launch()
    try {
      const page = await app.firstWindow()
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:marketSearch')
        ipcMain.handle('api:marketSearch', (_event, _kind: string, query: string) => ({
          ok: false,
          code: 'offline',
          message: `Market list offline for ${query}`
        }))
      })
      await page.locator('[data-menu="market"]').click()
      await page.getByPlaceholder('Search', { exact: true }).fill('qa')
      await page
        .locator('main')
        .getByText(/Market list offline for qa$/)
        .waitFor()
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:marketSearch')
        ipcMain.handle('api:marketSearch', (_event, _kind: string, query: string) => {
          throw new Error(`Market list rejected for ${query}`)
        })
      })
      await page.locator('main').getByRole('button', { name: 'Reload', exact: true }).click()
      await page
        .locator('main')
        .getByText(/Market list rejected for qa$/)
        .waitFor({ timeout: 3000 })
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:marketSearch')
        ipcMain.handle('api:marketSearch', () => ({
          ok: true,
          value: {
            skills: [
              {
                id: 'sample/repo/qa-skill',
                source: 'sample/repo',
                skillId: 'qa-skill',
                name: 'QA listed skill',
                installs: 0
              }
            ],
            installed: {}
          }
        }))
      })
      await page.locator('main').getByRole('button', { name: 'Reload', exact: true }).click()
      await page.getByText('QA listed skill', { exact: true }).waitFor()
      assert.equal(await page.getByPlaceholder('Search', { exact: true }).inputValue(), 'qa')
      assert.equal(
        await page.getByTestId('market-tabs').locator('input[value="skill"]').isChecked(),
        true
      )
    } finally {
      await app.close()
    }
  }
)

test(
  'MCP permission retries recover locally and keep the manually typed tool draft',
  { timeout: 120_000 },
  async () => {
    const app = await launch()
    try {
      const page = await app.firstWindow()
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:mcpToolInfo')
        ipcMain.handle('api:mcpToolInfo', () => ({
          ok: false,
          code: 'offline',
          message: 'MCP rules offline'
        }))
      })
      await page.locator('[data-menu="mcp"]').click()
      await page.locator('main .ac-row', { hasText: 'playwright' }).click()
      await page.getByTestId('mcp-tab-permissions').click()
      const detail = page.getByTestId('detail-sheet')
      await detail.getByText('MCP rules offline', { exact: true }).waitFor()
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:mcpToolInfo')
        ipcMain.handle('api:mcpToolInfo', () => {
          throw new Error('MCP rules rejected')
        })
      })
      await detail.getByRole('button', { name: 'Reload', exact: true }).click()
      await detail.getByText(/MCP rules rejected$/).waitFor({ timeout: 3000 })
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:mcpToolInfo')
        ipcMain.handle('api:mcpToolInfo', () => ({
          ok: true,
          value: { tools: ['inspect'], permissions: {}, codexOnly: {} }
        }))
      })
      await detail.getByRole('button', { name: 'Reload', exact: true }).click()
      await page.getByTestId('mcp-perm-tool-inspect').waitFor()
      await page.getByTestId('mcp-perm-add').fill('keep_this_draft')
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:mcpPermissionsSave')
        ipcMain.handle('api:mcpPermissionsSave', () => ({
          ok: true,
          value: { path: '/fixture/permissions.json' }
        }))
        ipcMain.removeHandler('api:mcpToolInfo')
        ipcMain.handle('api:mcpToolInfo', () => ({
          ok: false,
          code: 'offline',
          message: 'Refresh after save offline'
        }))
      })
      await page.getByTestId('mcp-perm-default').getByText('Allow', { exact: true }).click()
      await detail.getByText('Refresh after save offline', { exact: true }).waitFor()
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:mcpToolInfo')
        ipcMain.handle('api:mcpToolInfo', () => ({
          ok: true,
          value: { tools: ['inspect'], permissions: { default: 'allow' }, codexOnly: {} }
        }))
      })
      await detail.getByRole('button', { name: 'Reload', exact: true }).click()
      await page.getByTestId('mcp-perm-tool-inspect').waitFor()
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLInputElement>(
            '[data-testid="mcp-perm-default"] input[value="allow"]'
          )?.checked === true
      )
      assert.equal(await page.getByTestId('mcp-perm-add').inputValue(), 'keep_this_draft')
      assert.equal(
        await page.getByTestId('mcp-perm-default').locator('input[value="allow"]').isChecked(),
        true
      )
    } finally {
      await app.close()
    }
  }
)
