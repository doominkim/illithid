import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'
import type { Api, ModelDetail, ModelSummary } from '../src/shared/api'
import { baseEnv, buildDemoHome, seedStats } from './readme-shots'
import { indexSessions } from '../src/engine/search/sessionIndex'
import { scanSessions } from '../src/engine/scan/sessions'

declare global {
  interface Window {
    api: Api
  }
}

const summary: ModelSummary = {
  tool: 'gemini',
  model: 'fixture-gemini',
  effort: '',
  first: '2026-10-05',
  last: '2026-10-05',
  activeDays: 1,
  sessions: 1,
  subagentSessions: 0,
  requests: 0,
  turns: 0,
  toolCalls: 2,
  errors: { mistake: 0, command: 0, policy: 0, userReject: 0, other: 0 },
  interrupts: 0,
  tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
  cost: null,
  median: {
    responseSec: null,
    toolsPerRequest: null,
    turnsPerRequest: null,
    outputPerRequest: null,
    contextPerTurn: null
  },
  metrics: { requests: false, turns: false, tokens: false, interrupts: false, errors: false }
}
const detail: ModelDetail = {
  summary,
  daily: [{ day: '2026-10-05', turns: 0, output: 0, context: 0 }],
  dist: {
    responseSec: null,
    toolsPerRequest: null,
    turnsPerRequest: null,
    outputPerRequest: null,
    contextPerTurn: null
  },
  maxSessions: {},
  tools: [{ name: 'read_file', calls: 2, errors: 0 }],
  skills: [],
  mcp: [],
  projects: [{ project: '/synthetic/gemini', turns: 0 }],
  sessions: [
    {
      tool: 'gemini',
      id: 'synthetic-gemini-session',
      title: 'Synthetic Gemini session',
      project: '/synthetic/gemini',
      first: '2026-10-05',
      last: '2026-10-05',
      turns: 0,
      toolCalls: 2,
      mistakes: 0,
      output: 0
    }
  ],
  limits: []
}

async function launchStats(
  prefix: string,
  preindex = false
): Promise<{ home: string; app: Awaited<ReturnType<typeof electron.launch>> }> {
  const home = mkdtempSync(join(tmpdir(), prefix))
  buildDemoHome(home, { tools: 'all' })
  seedStats(home)
  if (preindex) await indexSessions(home, scanSessions(home).sessions)
  const config = join(home, '.config/illithid/config.json')
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, 'utf8')),
      toolsInUse: [],
      marketEnabled: false,
      updateCheck: false,
      ui: { language: 'en' }
    })
  )
  const app = await electron.launch({
    args: [resolve(process.env.ILLITHID_TEST_MAIN ?? 'out/main/index.js')],
    env: {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_TEST: '1',
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-stats-contract-ud-'))
    },
    timeout: 30000
  })
  return { home, app }
}

test(
  'a statistics read failure shows an error instead of an endless indexing message',
  { timeout: 60000 },
  async () => {
    const { app } = await launchStats('illithid-stats-failure-')
    try {
      const page = await app.firstWindow()
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:models')
        ipcMain.handle('api:models', () => {
          throw new Error('Synthetic stats read failure')
        })
      })
      await page.locator('[data-menu="stats"]').click()
      const failure = page.getByTestId('stats-read-error')
      await failure.waitFor({ timeout: 3000 })
      assert.ok((await failure.innerText()).includes('Synthetic stats read failure'))
    } finally {
      await app.close()
    }
  }
)

test(
  'Stats Reload indexes newly appended session usage even when a model index already exists',
  { timeout: 60000 },
  async () => {
    const { home, app } = await launchStats('illithid-stats-reload-', true)
    const startupDeadline = Date.now() + 3500
    try {
      const page = await app.firstWindow()
      const deadline = Date.now() + 10000
      let idle = false
      while (Date.now() < deadline) {
        const before = await page.evaluate(() => window.api.sessionIndexStatus())
        // Startup indexes after three seconds; an unchanged scan keeps lastIndexedAt unchanged.
        if (!before.running && Date.now() >= startupDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 200))
          const after = await page.evaluate(() => window.api.sessionIndexStatus())
          if (!after.running && before.lastIndexedAt === after.lastIndexedAt) {
            idle = true
            break
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.equal(idle, true, 'startup indexing must settle before adding the new log')
      await page.locator('[data-menu="stats"]').click()
      await page.getByTestId('stats-table').waitFor({ timeout: 5000 })
      await page.getByTestId('stats-show-small').check()
      const stable = await page.evaluate(async () => {
        const before = await window.api.sessionIndexStatus()
        await new Promise((resolve) => setTimeout(resolve, 200))
        const after = await window.api.sessionIndexStatus()
        return !before.running && !after.running && before.lastIndexedAt === after.lastIndexedAt
      })
      assert.equal(stable, true)
      const dir = join(home, '.claude/projects/synthetic-stats-reload')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, '6ead73be-0000-4000-8000-000000000001.jsonl')
      const at = new Date().toISOString()
      appendFileSync(
        path,
        [
          {
            type: 'user',
            sessionId: '6ead73be-0000-4000-8000-000000000001',
            cwd: '/synthetic/stats',
            timestamp: at,
            message: { role: 'user', content: 'Synthetic request' }
          },
          {
            type: 'assistant',
            sessionId: '6ead73be-0000-4000-8000-000000000001',
            cwd: '/synthetic/stats',
            timestamp: at,
            message: {
              id: 'synthetic-index-after',
              role: 'assistant',
              model: 'claude-synthetic-after-reload',
              content: [{ type: 'text', text: 'Synthetic reply' }],
              usage: { input_tokens: 100, output_tokens: 20 },
              stop_reason: 'end_turn'
            }
          }
        ]
          .map((row) => JSON.stringify(row))
          .join('\n') + '\n'
      )
      assert.equal(
        await page.evaluate(async () =>
          (await window.api.models({}))!.some((m) => m.model === 'claude-synthetic-after-reload')
        ),
        false
      )
      await page.getByRole('button', { name: 'Reload', exact: true }).click()
      await page
        .getByTestId('stats-row')
        .filter({ hasText: 'claude-synthetic-after-reload' })
        .waitFor({ timeout: 5000 })
    } finally {
      await app.close()
    }
  }
)

test(
  'a skill usage read failure shows an error instead of an endless indexing message',
  { timeout: 60000 },
  async () => {
    const { app } = await launchStats('illithid-usage-failure-')
    try {
      const page = await app.firstWindow()
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:usage')
        ipcMain.handle('api:usage', () => {
          throw new Error('Synthetic usage read failure')
        })
      })
      await page.locator('[data-menu="skills"]').click()
      await page.locator('main .ac-row').filter({ hasText: 'frontend-qa' }).click()
      const failure = page.getByTestId('usage-read-error')
      await failure.waitFor({ timeout: 3000 })
      assert.ok((await failure.innerText()).includes('Synthetic usage read failure'))
    } finally {
      await app.close()
    }
  }
)

test(
  'model skill and MCP usage opens existing management details',
  { timeout: 60000 },
  async () => {
    const { app } = await launchStats('illithid-stats-navigation-')
    try {
      const page = await app.firstWindow()
      await app.evaluate(
        ({ ipcMain }, fixture) => {
          ipcMain.removeHandler('api:models')
          ipcMain.handle('api:models', () => [fixture.summary])
          ipcMain.removeHandler('api:modelDetail')
          ipcMain.handle('api:modelDetail', () => ({
            ...fixture.detail,
            skills: [{ name: 'frontend-qa', calls: 2 }],
            mcp: [{ name: 'postgres', calls: 2 }]
          }))
        },
        { summary, detail }
      )
      const openDetail = async (): Promise<void> => {
        await page.locator('[data-menu="stats"]').click()
        await page.getByTestId('stats-show-small').check()
        await page.getByTestId('stats-row').getByRole('button').click()
        await page.getByTestId('stats-detail').waitFor()
      }
      await openDetail()
      await page
        .getByTestId('stats-detail')
        .getByRole('tab', { name: 'Skills 1', exact: true })
        .click()
      await page.getByTestId('stats-item-skill-frontend-qa').click({ timeout: 3000 })
      await page.getByTestId('usage-panel').waitFor()
      assert.ok(await page.getByRole('heading', { name: 'frontend-qa', exact: true }).isVisible())
      await openDetail()
      await page
        .getByTestId('stats-detail')
        .getByRole('tab', { name: 'MCP 1', exact: true })
        .click()
      await page.getByTestId('stats-item-mcp-postgres').click({ timeout: 3000 })
      await page.getByTestId('usage-panel').waitFor()
      assert.ok(await page.getByRole('heading', { name: 'postgres', exact: true }).isVisible())
    } finally {
      await app.close()
    }
  }
)

test(
  'unsupported Gemini metrics show unavailable while measured tool calls remain visible',
  { timeout: 60000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-core-stats-ui-'))
    buildDemoHome(home, { tools: 'all' })
    const config = join(home, '.config/illithid/config.json')
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, 'utf8')),
        toolsInUse: [],
        marketEnabled: false,
        updateCheck: false,
        ui: { language: 'en' }
      })
    )
    const app = await electron.launch({
      args: [resolve(process.env.ILLITHID_TEST_MAIN ?? 'out/main/index.js')],
      env: {
        ...baseEnv(home),
        ILLITHID_HOME: home,
        ILLITHID_TEST: '1',
        ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-core-stats-ud-'))
      },
      timeout: 30000
    })
    try {
      const page = await app.firstWindow()
      await app.evaluate(
        ({ ipcMain }, fixture) => {
          ipcMain.removeHandler('api:models')
          ipcMain.handle('api:models', () => [fixture.summary])
          ipcMain.removeHandler('api:modelDetail')
          ipcMain.handle('api:modelDetail', () => fixture.detail)
        },
        { summary, detail }
      )
      await page.locator('[data-menu="stats"]').click()
      await page.getByTestId('stats-show-small').check()
      const row = page.getByTestId('stats-row').filter({ hasText: 'fixture-gemini' })
      await row.waitFor()
      const cells = row.locator('td')
      assert.equal((await cells.nth(1).innerText()).trim().split('\n')[0], '—')
      await row.getByRole('button').click()
      const sheet = page.getByTestId('stats-detail')
      await sheet.waitFor()
      const translations = JSON.parse(readFileSync('src/renderer/src/i18n/en.json', 'utf8'))
      const turns = sheet
        .getByText(translations.models.detail.turns, { exact: true })
        .first()
        .locator('..')
      assert.ok((await turns.innerText()).includes('—'))
      const calls = sheet
        .getByText(translations.models.detail.toolCalls, { exact: true })
        .first()
        .locator('..')
      assert.ok((await calls.innerText()).includes('2'))
      const sessionCells = sheet.getByTestId('stats-session').locator('td')
      assert.equal((await sessionCells.nth(3).innerText()).trim(), '—')
      assert.equal((await sessionCells.nth(6).innerText()).trim(), '—')
      assert.ok(!(await sheet.innerText()).includes('0.0 requests/session'))
    } finally {
      await app.close()
    }
  }
)
