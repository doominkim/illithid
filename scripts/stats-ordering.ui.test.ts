import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import type { ModelSummary } from '../src/shared/api'
import { baseEnv, buildDemoHome } from './readme-shots'

interface StatsFixture {
  reads: number
  finishOld?: (reject: boolean) => void
  oldSettled?: Promise<void>
}

const model = (name: string): ModelSummary => ({
  model: name,
  tool: 'claude',
  effort: '',
  first: '2026-10-13',
  last: '2026-10-13',
  activeDays: 1,
  requests: 40,
  turns: 40,
  sessions: 1,
  subagentSessions: 0,
  toolCalls: 100,
  interrupts: 0,
  errors: { mistake: 0, command: 0, policy: 0, userReject: 0, other: 0 },
  tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20, reasoning: 0 },
  cost: null,
  median: {
    responseSec: null,
    toolsPerRequest: null,
    turnsPerRequest: null,
    outputPerRequest: null,
    contextPerTurn: null
  }
})

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const home = mkdtempSync(join(tmpdir(), 'illithid-stats-ordering-'))
  buildDemoHome(home, { tools: 'all' })
  const config = join(home, '.config/illithid/config.json')
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, 'utf8')),
      toolsInUse: [],
      marketEnabled: false,
      updateCheck: false,
      allowRealApply: false,
      backupRetention: { enabled: false, days: 30, keepRollback: 3 },
      ui: { language: 'en' }
    })
  )
  const app = await electron.launch({
    args: [resolve(process.env.ILLITHID_UI_ENTRY ?? 'out/main/index.js')],
    env: {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_TEST: '1',
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-stats-ordering-ud-'))
    },
    timeout: 60000
  })
  try {
    const page = await app.firstWindow()
    await page.locator('[data-menu="stats"]').waitFor()
    return { app, page }
  } catch (e) {
    await app.close()
    throw e
  }
}

async function beginReads(
  app: ElectronApplication,
  page: Page,
  rejectLatest = false
): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, data) => {
      const state: StatsFixture = { reads: 0 }
      ;(globalThis as typeof globalThis & { qaStats?: StatsFixture }).qaStats = state
      ipcMain.removeHandler('api:models')
      ipcMain.handle('api:models', () => {
        state.reads++
        if (state.reads === 1) {
          const old = new Promise<ModelSummary[]>((resolve, reject) => {
            state.finishOld = (fail) =>
              fail ? reject(new Error('Previous statistics read failed')) : resolve([data.old])
          })
          state.oldSettled = old.then(
            () => {},
            () => {}
          )
          return old
        }
        if (state.reads === 2) {
          if (data.rejectLatest) throw new Error('Latest statistics read failed')
          return [data.fresh]
        }
        // Further background completions keep their replies pending so they cannot hide an old reply.
        return new Promise(() => {})
      })
    },
    {
      old: model('synthetic-previous-read'),
      fresh: model('synthetic-latest-read'),
      rejectLatest
    }
  )
  await page.locator('[data-menu="stats"]').click()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (
      await app.evaluate(
        () => (globalThis as typeof globalThis & { qaStats?: StatsFixture }).qaStats?.reads
      )
    )
      return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('The initial statistics fixture request did not arrive')
}

async function completeIndex(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('api:searchIndexEvent', {
        exists: true,
        sessions: 1,
        messages: 2,
        running: false,
        lastIndexedAt: '2026-10-13T00:00:00Z'
      })
  })
}

async function finishOld(app: ElectronApplication, page: Page, reject = false): Promise<void> {
  await app.evaluate(async (_electron, fail) => {
    const state = (globalThis as typeof globalThis & { qaStats?: StatsFixture }).qaStats!
    state.finishOld!(fail)
    await state.oldSettled
  }, reject)
  // A public IPC round trip followed by paint lets the old reply reach the renderer and commit.
  await page.evaluate(async () => {
    await window.api.sessionIndexStatus()
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
  })
}

test(
  'statistics keep the latest indexed models when an earlier read succeeds late',
  { timeout: 60000 },
  async () => {
    const { app, page } = await launch()
    try {
      await beginReads(app, page)
      await completeIndex(app)
      const latest = page.getByTestId('stats-row').filter({ hasText: 'synthetic-latest-read' })
      await latest.waitFor({ timeout: 5000 })
      await finishOld(app, page)
      assert.equal(await latest.count(), 1)
      assert.equal(
        await page.getByTestId('stats-row').filter({ hasText: 'synthetic-previous-read' }).count(),
        0
      )
    } finally {
      await app.close()
    }
  }
)

test(
  'statistics keep the latest indexed models when an earlier read rejects late',
  { timeout: 60000 },
  async () => {
    const { app, page } = await launch()
    try {
      await beginReads(app, page)
      await completeIndex(app)
      const latest = page.getByTestId('stats-row').filter({ hasText: 'synthetic-latest-read' })
      await latest.waitFor({ timeout: 5000 })
      await finishOld(app, page, true)
      assert.equal(await latest.count(), 1)
      assert.equal(await page.getByTestId('stats-read-error').count(), 0)
    } finally {
      await app.close()
    }
  }
)

test(
  'statistics show the latest read failure even when an earlier read succeeds late',
  { timeout: 60000 },
  async () => {
    const { app, page } = await launch()
    try {
      await beginReads(app, page, true)
      await completeIndex(app)
      const failure = page.getByTestId('stats-read-error')
      await failure.waitFor({ timeout: 5000 })
      assert.match(await failure.innerText(), /Latest statistics read failed/)
      await finishOld(app, page)
      assert.equal(await failure.count(), 1)
      assert.match(await failure.innerText(), /Latest statistics read failed/)
      assert.equal(
        await page.getByTestId('stats-row').filter({ hasText: 'synthetic-previous-read' }).count(),
        0
      )
    } finally {
      await app.close()
    }
  }
)
