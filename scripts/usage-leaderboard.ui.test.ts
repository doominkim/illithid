import { convertedCost, readPriceBook } from '../src/engine/search/modelPricing'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import type { ModelSummary } from '../src/shared/api'

const base = (
  model: string,
  tool: string,
  effort: string,
  requests: number,
  response: number
): ModelSummary => ({
  model,
  tool,
  effort,
  requests,
  first: '2026-09-01',
  last: '2026-09-30',
  activeDays: 5,
  sessions: 3,
  subagentSessions: 0,
  turns: 120,
  toolCalls: 250,
  interrupts: 0,
  errors: { mistake: 0, command: 2, policy: 0, userReject: 0, other: 0 },
  tokens: {
    input: 1e6,
    cacheRead: 2e6,
    cacheWrite: tool === 'claude' ? 10000 : 0,
    output: 100000,
    reasoning: 3000
  },
  cost: null,
  pricing: convertedCost(
    model,
    tool,
    {
      input: 1e6,
      cacheRead: 2e6,
      cacheWrite: tool === 'claude' ? 10000 : 0,
      output: 100000,
      reasoning: 3000
    },
    requests,
    null,
    {
      ...readPriceBook('/fixture-no-cache'),
      providers: {
        ...readPriceBook('/fixture-no-cache').providers,
        openai: {
          models: {
            'gpt-6.1-sol': { cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 } }
          }
        }
      }
    }
  ),
  median: {
    responseSec: requests >= 30 ? response : null,
    toolsPerRequest: 2,
    turnsPerRequest: 3,
    outputPerRequest: 800,
    contextPerTurn: 9000
  }
})
const fixtures = [
  base('gpt-6.1-sol', 'codex', 'medium', 40, 50),
  base('gpt-6.1-sol', 'codex', 'high', 60, 90),
  base('claude-fable-5-1', 'claude', 'high', 80, 115),
  base('gemini-2.5-pro', 'opencode', 'medium', 35, 160),
  base('claude-haiku-4-5', 'claude', '', 12, 10),
  base('unpriced-model', 'opencode', '', 70, 60)
]

test(
  'REQ-USAGE-LEADERBOARD-3 REQ-USAGE-LEADERBOARD-4 REQ-USAGE-LEADERBOARD-5 REQ-USAGE-LEADERBOARD-6 REQ-USAGE-LEADERBOARD-7 REQ-MODEL-EFFICIENCY-1 REQ-MODEL-EFFICIENCY-2 REQ-MODEL-EFFICIENCY-4 REQ-MODEL-EFFICIENCY-5 REQ-MODEL-EFFICIENCY-6 renderer interaction, shell, filter, reload, detail and price persistence',
  { timeout: 90000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-leaderboard-home-'))
    const config = join(home, '.config/illithid')
    mkdirSync(config, { recursive: true })
    writeFileSync(
      join(config, 'config.json'),
      JSON.stringify({
        version: 1,
        toolsInUse: [],
        marketEnabled: false,
        updateCheck: false,
        backupRetention: { enabled: false, days: 30, keepRollback: 3 }
      })
    )
    const env = {
      ...process.env,
      HOME: home,
      ILLITHID_HOME: home,
      ILLITHID_TEST: '1',
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-leaderboard-userdata-'))
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
    const errors: string[] = []
    try {
      const page = await app.firstWindow()
      page.on('pageerror', (error) => errors.push(error.message))
      // REQ-MODEL-EFFICIENCY-7: app zoom shortcuts work symmetrically.
      const zoomLevel = (): Promise<number> =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.getZoomLevel()
        )
      const shortcut = async (keyCode: string): Promise<void> => {
        await app.evaluate(({ BrowserWindow }, key) => {
          const wc = BrowserWindow.getAllWindows()[0].webContents
          wc.sendInputEvent({
            type: 'keyDown',
            keyCode: key,
            modifiers: [process.platform === 'darwin' ? 'meta' : 'control']
          })
          wc.sendInputEvent({
            type: 'keyUp',
            keyCode: key,
            modifiers: [process.platform === 'darwin' ? 'meta' : 'control']
          })
        }, keyCode)
      }
      await shortcut('=')
      assert.equal(await zoomLevel(), 1)
      await shortcut('-')
      assert.equal(await zoomLevel(), 0)
      await shortcut('-')
      assert.equal(await zoomLevel(), -1)
      await shortcut('0')
      assert.equal(await zoomLevel(), 0)
      await app.evaluate(({ ipcMain, BrowserWindow }, data) => {
        BrowserWindow.getAllWindows()[0].setSize(1280, 800)
        let reads = 0
        ipcMain.removeHandler('api:models')
        ipcMain.handle('api:models', (_event, range) => {
          reads++
          return range?.days === 7 ? data.slice(0, 2) : data
        })
        ipcMain.handle('test:modelReads', () => reads)
        ipcMain.removeHandler('api:modelDetail')
        ipcMain.handle('api:modelDetail', (_event, key) => ({
          summary: data.find(
            (m) => m.model === key.model && m.tool === key.tool && m.effort === key.effort
          ),
          daily: [{ day: '2026-09-30', turns: 20, output: 20000, context: 40000 }],
          costDaily: [{ day: '2026-09-30', cost: 1, converted: 1 }],
          costDist: {
            min: 0.01,
            p25: 0.02,
            median: 0.04,
            mean: 0.05,
            p75: 0.07,
            p90: 0.1,
            max: 0.2,
            n: 40
          },
          dist: {
            responseSec: null,
            toolsPerRequest: null,
            turnsPerRequest: null,
            outputPerRequest: null,
            contextPerTurn: null
          },
          maxSessions: {},
          tools: [],
          skills: [],
          mcp: [],
          projects: [],
          sessions: [],
          limits: []
        }))
      }, fixtures)
      await page.evaluate(() => {
        localStorage.setItem('illithid-language', 'ko')
        localStorage.setItem('illithid-color-scheme', 'light')
      })
      await page.reload()
      await page.locator('[data-menu="stats"]').click()
      const points = page.getByTestId('stats-point'),
        rows = page.getByTestId('stats-row')
      await points.first().waitFor()
      assert.equal(await points.count(), 4)
      // REQ-USAGE-LEADERBOARD-6: model labels only, bounded zoom and reset.
      assert.equal(await points.locator('.lb-agent').count(), 0)
      const viewport = page.getByTestId('stats-chart-viewport')
      const svg = viewport.locator('svg')
      await page.getByRole('button', { name: '확대', exact: true }).click()
      assert.equal(await svg.getAttribute('data-zoom'), '1.25')
      assert.ok(await viewport.evaluate((e) => e.scrollWidth > e.clientWidth))
      await page.getByRole('button', { name: '축소', exact: true }).click()
      assert.equal(await svg.getAttribute('data-zoom'), '1')
      await page.getByRole('button', { name: '확대', exact: true }).click()
      await page.getByRole('button', { name: '초기화', exact: true }).click()
      assert.equal(await svg.getAttribute('data-zoom'), '1')
      assert.equal(await rows.count(), 5)
      await page.getByTestId('stats-show-small').check()
      assert.equal(await rows.count(), 6)
      await page.getByTestId('stats-table').getByText('요청', { exact: true }).click()
      await page.getByTestId('stats-table').getByText('요청 ↑', { exact: true }).click()
      assert.equal(
        await page.getByTestId('stats-model-parent').first().getAttribute('data-model'),
        'gpt-6.1-sol'
      )
      assert.equal(await rows.first().locator('td').count(), 13)
      assert.equal(await page.getByTestId('stats-model-parent').first().locator('td').count(), 13)
      assert.equal(await page.getByTestId('stats-model-parent').count(), 5)
      const parent = page.locator('[data-testid="stats-model-parent"][data-model="gpt-6.1-sol"]')
      await parent.getByRole('button').click()
      assert.equal(await rows.count(), 4)
      await parent.getByRole('button').click()
      assert.equal(await rows.count(), 6)
      // REQ-USAGE-LEADERBOARD-7: per-column ratios and unknown-cost omission.
      const responseBars = page.locator('[data-metric-bar="response"]')
      assert.equal(await responseBars.count(), 5)
      assert.equal(await responseBars.first().getAttribute('aria-hidden'), 'true')
      const geminiBar = page.locator(
        '[data-testid="stats-row"][data-model="gemini-2.5-pro"] [data-metric-bar="response"] > span'
      )
      assert.equal(await geminiBar.evaluate((e) => (e as HTMLElement).style.width), '100%')
      assert.equal(
        await page
          .locator(
            '[data-testid="stats-row"][data-model="unpriced-model"] [data-metric-bar="perCost"]'
          )
          .count(),
        0
      )

      assert.equal(await page.getByTestId('stats-table').count(), 1)
      assert.equal(await page.getByTestId('stats-scatter').locator('h1,h2,h3,p,small').count(), 0)
      assert.equal(await page.locator('[data-series-line]').count(), 1)
      // Locator filtering keeps the g element rather than searching its children.
      const claude = page.locator('[data-testid="stats-point"][data-model="claude-fable-5-1"]')
      const gpt = page.locator('[data-testid="stats-point"][data-model="gpt-6.1-sol"]').first()
      assert.equal(
        await page
          .locator('.lb-labels .lb-model[data-model="gpt-6.1-sol"]')
          .first()
          .evaluate((e) => getComputedStyle(e).fontSize),
        '10px'
      )
      // REQ-MODEL-EFFICIENCY-9: labels remain above chart marks with a background halo.
      const labelLayer = page.locator('.lb-labels')
      assert.equal(await labelLayer.locator('text').count(), await points.count())
      assert.equal(await labelLayer.evaluate((e) => e === e.parentElement?.lastElementChild), true)
      assert.equal(await labelLayer.locator('text').first().getAttribute('text-anchor'), 'middle')
      assert.equal(
        await labelLayer
          .locator('text')
          .first()
          .evaluate((e) => getComputedStyle(e).strokeWidth),
        '3.5px'
      )
      const centered = await page
        .getByTestId('stats-scatter')
        .locator('svg')
        .evaluate((svg) => {
          const dots = [...svg.querySelectorAll('.lb-dot')]
          return [...svg.querySelectorAll('.lb-labels text')].some(
            (label, index) =>
              Math.abs(Number(label.getAttribute('x')) - Number(dots[index].getAttribute('cx'))) <
                0.01 && Number(label.getAttribute('y')) < Number(dots[index].getAttribute('cy'))
          )
        })
      assert.equal(centered, true)
      const gptNormal = await gpt.locator('.lb-dot').getAttribute('fill')
      const rowName = page
        .locator('[data-testid="stats-row"][data-model="gpt-6.1-sol"]')
        .first()
        .getByTestId('stats-row-model')
      const rowColor = await rowName.evaluate((e) => getComputedStyle(e).color)
      await claude.locator('.lb-dot').hover()
      // REQ-MODEL-EFFICIENCY-10: the hovered point label is painted above every other label.
      assert.equal(
        await labelLayer.locator('text').last().getAttribute('data-model'),
        'claude-fable-5-1'
      )
      assert.equal(
        await page
          .getByTestId('stats-active-layer')
          .evaluate((e) => e === e.parentElement?.lastElementChild),
        true
      )
      assert.equal(await page.getByTestId('stats-guides').locator('line').count(), 2)
      assert.equal(await page.getByTestId('stats-point-tooltip').count(), 0) // REQ-MODEL-EFFICIENCY-6
      assert.equal(await gpt.locator('.lb-dot').getAttribute('fill'), 'var(--ac-text-muted)')
      assert.equal(await rowName.evaluate((e) => getComputedStyle(e).color), rowColor)
      await page.screenshot({ path: '/tmp/illithid-leaderboard-hover.png', fullPage: true })
      await page.locator('[data-menu="stats"]').hover()
      assert.equal(await page.getByTestId('stats-guides').count(), 0)
      assert.equal(await gpt.locator('.lb-dot').getAttribute('fill'), gptNormal)
      await gpt.focus()
      assert.equal(
        await page.locator('[data-testid="stats-active-dot"][stroke-dasharray="3 2"]').count(),
        1
      )
      assert.equal(
        await labelLayer.locator('text').last().getAttribute('data-model'),
        'gpt-6.1-sol'
      )
      assert.equal(await page.getByTestId('stats-guides').count(), 1)
      await page.getByRole('button', { name: '다시 읽기', exact: true }).focus()
      assert.equal(await page.getByTestId('stats-guides').count(), 0)
      await page.screenshot({ path: '/tmp/illithid-leaderboard-light.png', fullPage: true })
      await claude.locator('.lb-dot').click()
      await page.getByTestId('stats-cost-detail').waitFor()
      assert.ok((await page.getByTestId('stats-cost-detail').innerText()).includes('API 환산 비용'))
      assert.equal(await page.getByTestId('stats-cost-daily').locator('.recharts-line').count(), 1)
      assert.equal(await page.getByTestId('stats-cost-distribution').locator('svg').count(), 1)
      await page.getByTestId('detail-sheet').getByRole('button', { name: '뒤로' }).click()
      await page.getByTestId('stats-days').getByText('7일', { exact: true }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="stats-row"]').length === 2
      )
      await page.getByTestId('stats-days').getByText('30일', { exact: true }).click()
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="stats-row"]').length === 6
      )
      await page.getByTestId('stats-tool').getByText('Codex', { exact: true }).click()
      assert.equal(await rows.count(), 2)
      assert.equal(await page.getByTestId('stats-mixed-tools').count(), 0)
      await page.getByTestId('stats-tool').locator('label').first().click()
      assert.equal(await rows.count(), 6)
      const unknown = page.locator('[data-testid="stats-row"][data-model="unpriced-model"]')
      assert.ok((await unknown.innerText()).includes('단가 없음'))
      await page.getByRole('button', { name: '다시 읽기', exact: true }).click()
      await points.first().waitFor()
      assert.equal(await points.count(), 4)
      await page.evaluate(() => localStorage.setItem('illithid-color-scheme', 'dark'))
      await page.reload()
      await page.locator('[data-menu="stats"]').click()
      await points.first().waitFor()
      await page.screenshot({ path: '/tmp/illithid-leaderboard-dark.png', fullPage: true })
      assert.deepEqual(errors, [])
    } finally {
      await app.close()
    }
  }
)
