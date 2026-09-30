import { convertedCost, readPriceBook } from '../src/engine/search/modelPricing'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type Page } from 'playwright-core'
import type { ModelSummary } from '../src/shared/api'
import { usd } from '../src/renderer/src/lib/leaderboard'

/** Choose an option from a Mantine Select by its input test id */
async function pick(page: Page, testId: string, label: string): Promise<void> {
  await page.getByTestId(testId).click()
  await page.getByRole('option').getByText(label, { exact: true }).click()
  assert.equal(await page.getByTestId(testId).inputValue(), label)
}

/** The chart and the per-request column use the median of completed requests; fixtures set it to 60% of the mean */
const withMedian = (p: ReturnType<typeof convertedCost>): ReturnType<typeof convertedCost> => ({
  ...p,
  medianPerRequest: p.perRequest === null ? null : p.perRequest * 0.6
})
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
  pricing: withMedian(convertedCost(
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
  )),
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
  'REQ-USAGE-LEADERBOARD-3 REQ-USAGE-LEADERBOARD-4 REQ-USAGE-LEADERBOARD-5 REQ-USAGE-LEADERBOARD-6 REQ-USAGE-LEADERBOARD-7 REQ-MODEL-EFFICIENCY-1 REQ-MODEL-EFFICIENCY-2 REQ-MODEL-EFFICIENCY-4 REQ-MODEL-EFFICIENCY-5 REQ-MODEL-EFFICIENCY-6 REQ-STATS-MEDIAN-COST-1 REQ-STATS-MEDIAN-COST-3 REQ-STATS-MEDIAN-COST-4 renderer interaction, shell, filter, reload, detail and price persistence',
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
          ;(globalThis as { lastModelRange?: unknown }).lastModelRange = range ?? null
          if (range?.from && range.from === range.to) return data.slice(0, 1)
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
      const svg = viewport.locator('svg[role="group"]')
      await page.getByRole('button', { name: '확대', exact: true }).click()
      assert.equal(await svg.getAttribute('data-zoom'), '1.25')
      assert.ok(await viewport.evaluate((e) => e.scrollWidth <= e.clientWidth))
      assert.notEqual(await svg.getAttribute('data-domain'), null)
      await page.getByRole('button', { name: '축소', exact: true }).click()
      assert.equal(await svg.getAttribute('data-zoom'), '1')
      await page.getByRole('button', { name: '확대', exact: true }).click()
      await page.getByRole('button', { name: '초기화', exact: true }).click()
      assert.equal(await svg.getAttribute('data-zoom'), '1')
      // REQ-MODEL-EFFICIENCY-18: region zoom changes domains, not SVG or mark sizes.
      const fullDomain = await svg.getAttribute('data-domain')
      const area = (await svg.boundingBox())!
      await page.mouse.move(area.x + area.width * 0.55, area.y + area.height * 0.2)
      await page.mouse.down()
      await page.mouse.move(area.x + area.width * 0.9, area.y + area.height * 0.65, { steps: 8 })
      await page.mouse.up()
      assert.notEqual(await svg.getAttribute('data-domain'), fullDomain)
      assert.equal(await svg.evaluate((e) => (e as SVGSVGElement).style.width), '100%')
      await page.getByRole('button', { name: '초기화', exact: true }).click()
      assert.equal(await svg.getAttribute('data-domain'), fullDomain)
      await page.mouse.move(area.x + area.width * 0.07, area.y + area.height * 0.15)
      await page.mouse.down()
      await page.mouse.move(area.x + area.width * 0.97, area.y + area.height * 0.4, { steps: 8 })
      await page.mouse.up()
      assert.ok(Number(await svg.getAttribute('data-zoom')) > 1)
      assert.ok(await page.getByRole('button', { name: '축소', exact: true }).isEnabled())
      await page.getByRole('button', { name: '초기화', exact: true }).click()
      for (const line of await svg.locator('polyline').all())
        assert.ok((await line.getAttribute('clip-path'))?.startsWith('url('))
      assert.equal(await rows.count(), 5)
      // REQ-MODEL-EFFICIENCY-16: flat by default, tool headers optional, model hierarchy opt-in.
      assert.equal(await page.getByTestId('stats-model-parent').count(), 0)
      assert.equal(await rows.first().locator('td').count(), 12)
      assert.equal(await page.getByTestId('stats-compare-open').count(), 0)
      const flatTokens = page
        .getByTestId('stats-table')
        .getByRole('columnheader')
        .filter({ hasText: '토큰 합계' })
      await flatTokens.getByRole('button').click()
      const flatValues = await rows
        .locator('td:nth-child(2) [title]')
        .evaluateAll((cells) =>
          cells.map((c) => Number(c.getAttribute('title')?.replaceAll(',', '')))
        )
      assert.deepEqual(
        flatValues,
        [...flatValues].sort((a, b) => a - b)
      )
      await flatTokens.getByRole('button').click()
      const flatDescending = await rows
        .locator('td:nth-child(2) [title]')
        .evaluateAll((cells) =>
          cells.map((c) => Number(c.getAttribute('title')?.replaceAll(',', '')))
        )
      assert.deepEqual(
        flatDescending,
        [...flatValues].sort((a, b) => b - a)
      )
      await page.screenshot({ path: '/tmp/illithid-stats-flat-before.png', fullPage: true })
      const grouping = page.getByTestId('stats-group-by')
      await grouping.getByText('툴별', { exact: true }).click()
      await page.screenshot({ path: '/tmp/illithid-stats-tool-before.png', fullPage: true })
      assert.equal(await page.getByTestId('stats-tool-header').count(), 3)
      assert.equal(await page.getByTestId('stats-model-parent').count(), 0)
      assert.equal(await rows.count(), 5)
      await grouping.getByText('전체 조합', { exact: true }).click()
      assert.equal(await page.getByTestId('stats-tool-header').count(), 0)
      assert.equal(await rows.count(), 5)
      await grouping.getByText('모델별', { exact: true }).click()
      await page
        .getByTestId('stats-table')
        .getByText('API 환산 비용 / 요청 (중앙값)', { exact: true })
        .click()
      await page.getByTestId('stats-show-small').check()
      assert.equal(await rows.count(), 6)
      await page.getByTestId('stats-table').getByText('요청', { exact: true }).click()
      await page.getByTestId('stats-table').getByText('요청 ↑', { exact: true }).click()
      assert.equal(
        await page.getByTestId('stats-model-parent').first().getAttribute('data-model'),
        'gpt-6.1-sol'
      )
      // REQ-MODEL-EFFICIENCY-15: totals sort by raw parent sum, independently of compact text.
      const tokensHeader = page
        .getByTestId('stats-table')
        .getByRole('columnheader')
        .filter({ hasText: '토큰 합계' })
      await tokensHeader.getByRole('button').click()
      assert.equal(await tokensHeader.getAttribute('aria-sort'), 'ascending')
      const ascending = await page
        .getByTestId('stats-model-parent')
        .locator('td:nth-child(3)')
        .evaluateAll((cells) =>
          cells.map((c) => Number(c.getAttribute('title')?.replaceAll(',', '')))
        )
      assert.deepEqual(
        ascending,
        [...ascending].sort((a, b) => a - b)
      )
      await tokensHeader.getByRole('button').click()
      assert.equal(await tokensHeader.getAttribute('aria-sort'), 'descending')
      const descending = await page
        .getByTestId('stats-model-parent')
        .locator('td:nth-child(3)')
        .evaluateAll((cells) =>
          cells.map((c) => Number(c.getAttribute('title')?.replaceAll(',', '')))
        )
      assert.deepEqual(
        descending,
        [...ascending].sort((a, b) => b - a)
      )
      assert.match(
        await page.getByTestId('stats-model-parent').first().locator('td:nth-child(3)').innerText(),
        /M$/
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
        .locator('svg[role="group"]')
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
      // REQ-STATS-MEDIAN-COST-4: the hovered point shows its median context per turn
      assert.equal(await page.getByTestId('stats-guide-context').textContent(), '컨텍스트 9K / 턴')
      // REQ-STATS-MEDIAN-COST-1: the point sits at the median cost per request, not the period mean
      const claudeFixture = fixtures.find((m) => m.model === 'claude-fable-5-1')!
      assert.ok((await claude.getAttribute('aria-label'))!.includes(usd(claudeFixture.pricing!.medianPerRequest)))
      assert.ok(!(await claude.getAttribute('aria-label'))!.includes(usd(claudeFixture.pricing!.perRequest)))
      // REQ-STATS-MEDIAN-COST-3: the per-request column shows the same median
      assert.ok(
        (await page.locator('[data-testid="stats-row"][data-model="claude-fable-5-1"] td').last().innerText()).includes(
          usd(claudeFixture.pricing!.medianPerRequest)
        )
      )
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
      assert.equal(await page.getByTestId('stats-guide-context').count(), 1)
      await page.getByRole('button', { name: '다시 읽기', exact: true }).focus()
      assert.equal(await page.getByTestId('stats-guides').count(), 0)
      await page.screenshot({ path: '/tmp/illithid-leaderboard-light.png', fullPage: true })
      await claude.locator('.lb-dot').click()
      await page.getByTestId('stats-cost-detail').waitFor()
      assert.ok((await page.getByTestId('stats-cost-detail').innerText()).includes('API 환산 비용'))
      assert.equal(await page.getByTestId('stats-cost-daily').locator('.recharts-line').count(), 1)
      assert.equal(await page.getByTestId('stats-cost-distribution').locator('svg').count(), 1)
      await page.getByTestId('detail-sheet').getByRole('button', { name: '뒤로' }).click()
      await pick(page, 'stats-days', '7일')
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="stats-row"]').length === 2
      )
      await pick(page, 'stats-days', '직접 설정')
      const day = (d: Date): string =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const now = new Date()
      assert.equal(await page.getByTestId('stats-to').inputValue(), day(now))
      assert.equal(
        await page.getByTestId('stats-from').inputValue(),
        day(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29, 12))
      )
      const lastRange = (): Promise<unknown> =>
        app.evaluate(() => (globalThis as { lastModelRange?: unknown }).lastModelRange)
      await page.getByTestId('stats-from').fill('2026-09-20')
      await page.getByTestId('stats-to').fill('2026-09-10')
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="stats-row"]').length === 6
      )
      assert.deepEqual(await lastRange(), { from: '2026-09-10', to: '2026-09-20' })
      await page.screenshot({ path: '/tmp/illithid-stats-custom-range.png' })
      await page.getByTestId('stats-to').fill('2026-09-20')
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="stats-row"]').length === 1
      )
      await pick(page, 'stats-days', '30일')
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="stats-row"]').length === 6
      )
      assert.equal(await page.getByTestId('stats-from').count(), 0)
      await pick(page, 'stats-tool', 'Codex')
      assert.equal(await rows.count(), 2)
      assert.equal(await page.getByTestId('stats-mixed-tools').count(), 0)
      await pick(page, 'stats-tool', '전체')
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
      // HAR-41 REQ-1/2/3: responsive controls and independently bounded memory panes.
      await app.evaluate(({ ipcMain }, data) => {
        ipcMain.removeHandler('api:toolMemoryScan')
        ipcMain.handle('api:toolMemoryScan', () => data)
        ipcMain.removeHandler('api:toolMemoryRead')
        ipcMain.handle('api:toolMemoryRead', () => ({ ok: true, value: '# Memory\n'.repeat(100) }))
      }, {
        claude: { projects: [{ slug: 'fixture', cwd: '/fixture/project', missing: false, temp: false,
          files: [{ file: 'project.md', title: 'Project memory', inIndex: true, inShared: false, mtime: '2026-09-30' }],
          index: { exists: true, lines: 5, bytes: 50, broken: [] }, updatedAt: '2026-09-30' }],
          shared: null, limits: { lines: 200, bytes: 25600 } }, codex: []
      })
      for (const width of [1280, 900]) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size, 800), width)
        await page.locator('[data-menu="stats"]').click()
        await page.locator('[data-testid="stats-tool"]').waitFor()
        assert.equal(await page.locator('.ac-stats-filters').evaluate(el => el.scrollWidth <= el.clientWidth), true)
        await page.locator('[data-menu="memory"]').click()
        await page.locator('[data-testid="memory-tab-claude"]').click()
        await page.locator('[data-testid="tm-project"]').click()
        await page.locator('[data-testid="tm-index"]').click()
        await page.locator('[data-testid="tm-preview"] h1').first().waitFor()
        assert.equal(await page.locator('[data-testid="tm-preview"]').evaluate(el => el.scrollHeight > el.clientHeight), true)
        const panes = await page.locator('.ac-memory-panes').evaluate(el => {
          const root = el.getBoundingClientRect()
          return { overflow: el.scrollWidth > el.clientWidth, height: root.height,
            children: [...el.children].filter(e => e.classList.contains('ac-card')).map(e => {
              const r = e.getBoundingClientRect()
              return { bottom: r.bottom, right: r.right }
            }), bottom: root.bottom, right: root.right }
        })
        assert.equal(panes.overflow, false)
        assert.ok(panes.height > 300)
        assert.ok(panes.children.every(p => p.bottom <= panes.bottom + 1 && p.right <= panes.right + 1))
        await page.screenshot({ path: `/tmp/illithid-consistency-memory-${width}.png` })
        await page.locator('[data-menu="artifacts"]').click()
        await page.getByRole('radio', { name: /Grid view|격자 보기/, exact: true }).waitFor({ state: 'attached' })
        await page.getByRole('radio', { name: /List view|목록 보기/, exact: true }).waitFor({ state: 'attached' })
        assert.equal(await page.locator('.ac-toolbar').evaluate(el => el.scrollWidth <= el.clientWidth), true)
      }
      assert.deepEqual(errors, [])
    } finally {
      await app.close()
    }
  }
)
