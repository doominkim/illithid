import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

for (const fixture of [
  {
    menu: 'sessions',
    channel: 'api:sessionSearch',
    mode: 'search-mode',
    placeholder: 'Search conversations'
  },
  {
    menu: 'artifacts',
    channel: 'api:docSearch',
    mode: 'artifact-search-mode',
    placeholder: 'Search document content'
  }
])
  test(
    `failed ${fixture.menu} content search shows an error and can retry without losing the query`,
    { timeout: 60000 },
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'illithid-qa-search-'))
      buildDemoHome(home, { tools: 'all' })
      const path = join(home, '.config/illithid/config.json')
      writeFileSync(
        path,
        JSON.stringify({
          ...JSON.parse(readFileSync(path, 'utf8')),
          allowRealApply: false,
          updateCheck: false,
          marketEnabled: false,
          ui: { language: 'en' }
        })
      )
      const app = await electron.launch({
        args: [process.env.ILLITHID_UI_ENTRY ?? resolve('out/main/index.js')],
        env: {
          ...baseEnv(home),
          ILLITHID_HOME: home,
          ILLITHID_TEST: '1',
          ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-search-ud-'))
        }
      })
      try {
        const page = await app.firstWindow()
        // Control only the public process reply: an unavailable search service later recovers.
        await app.evaluate(({ ipcMain }, channel) => {
          const state = globalThis as typeof globalThis & {
            qaSearchReady?: boolean
            qaSearchCalled?: boolean
          }
          state.qaSearchReady = false
          state.qaSearchCalled = false
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, () => {
            state.qaSearchCalled = true
            if (!state.qaSearchReady) throw new Error('Fixture search offline')
            return { results: [], mode: 'fts', limited: false, ms: 0 }
          })
        }, fixture.channel)
        await page.locator(`[data-menu="${fixture.menu}"]`).click()
        await page.getByTestId(fixture.mode).getByText('Content', { exact: true }).click()
        const input = page.getByPlaceholder(fixture.placeholder)
        await input.fill('fixture query')
        const until = Date.now() + 10000
        while (
          !(await app.evaluate(
            () => (globalThis as typeof globalThis & { qaSearchCalled?: boolean }).qaSearchCalled
          ))
        ) {
          assert.ok(Date.now() < until, 'the content search request must reach the IPC boundary')
          await new Promise((r) => setTimeout(r, 20))
        }
        await page.waitForTimeout(100)
        const alert = page.getByRole('alert').filter({ hasText: 'Fixture search offline' })
        assert.equal(
          await alert.count(),
          1,
          'an unavailable search must not masquerade as zero matches'
        )
        assert.equal(await page.getByText('No matching items.', { exact: true }).count(), 0)
        await app.evaluate(() => {
          ;(globalThis as typeof globalThis & { qaSearchReady?: boolean }).qaSearchReady = true
        })
        await alert.getByRole('button', { name: 'Reload', exact: true }).click()
        await page.getByText('No matching items.', { exact: true }).waitFor()
        assert.equal(await alert.count(), 0)
        assert.equal(await input.inputValue(), 'fixture query')
      } finally {
        await app.close()
      }
    }
  )
