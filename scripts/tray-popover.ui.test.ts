import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

/** The popover is the same renderer bundle mounted at #tray; load it in the main window to drive it with Playwright */
async function launchPopover(): Promise<{
  app: Awaited<ReturnType<typeof electron.launch>>
  page: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>
}> {
  const home = mkdtempSync(join(tmpdir(), 'illithid-tray-ui-'))
  buildDemoHome(home, { tools: 'all' })
  const config = join(home, '.config/illithid/config.json')
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, 'utf8')),
      marketEnabled: false,
      updateCheck: false,
      autoBackup: false,
      ui: { language: 'en' }
    })
  )
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_TEST: '1',
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-tray-ui-ud-'))
    },
    timeout: 30000
  })
  try {
    await app.firstWindow()
    // Open the popover view the way main does for the menu bar: a window on index.html with the #tray hash
    const opened = app.waitForEvent('window', { timeout: 20000 })
    await app.evaluate(
      ({ BrowserWindow }, { html, preload }) => {
        const w = new BrowserWindow({
          width: 380,
          height: 480,
          show: true,
          webPreferences: { preload, sandbox: false, contextIsolation: true }
        })
        void w.loadFile(html, { hash: 'tray' })
      },
      { html: resolve('out/renderer/index.html'), preload: resolve('out/preload/index.js') }
    )
    const page = await opened
    await page.getByTestId('tray-popover').waitFor()
    return { app, page }
  } catch (e) {
    await app.close().catch(() => {})
    throw e
  }
}

test(
  'the tray popover lists recent artifacts under the sessions with Open and Reveal buttons',
  { timeout: 60000 },
  async () => {
    const { app, page } = await launchPopover()
    try {
      await page.getByText('Recent sessions').waitFor()
      await page.getByText('Recent artifacts').waitFor()
      const rows = page.getByTestId('tray-artifact')
      await rows.first().waitFor()
      const titles = await rows.allInnerTexts()
      assert.ok(
        titles.some((t) => /API latency|report\.md/.test(t)),
        titles.join(' | ')
      )
      assert.ok(
        titles.some((t) => /Onboarding|guide\.html/.test(t)),
        titles.join(' | ')
      )
      assert.equal(await rows.first().getByRole('button', { name: 'Open' }).count(), 1)
      assert.equal(await rows.first().getByRole('button', { name: 'Reveal' }).count(), 1)
      // The two lists share the space: neither section may take (almost) the whole popover
      const sessions = await page.getByTestId('tray-sessions').boundingBox()
      const artifacts = await page.getByTestId('tray-artifacts').boundingBox()
      assert.ok(sessions && artifacts)
      assert.ok(
        Math.abs(sessions!.height - artifacts!.height) <= 2,
        `${sessions!.height} vs ${artifacts!.height}`
      )
    } finally {
      await app.close()
    }
  }
)
