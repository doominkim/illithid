import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

async function launch(): Promise<{
  app: Awaited<ReturnType<typeof electron.launch>>
  home: string
}> {
  const home = mkdtempSync(join(tmpdir(), 'illithid-artifact-sources-ui-'))
  buildDemoHome(home, { tools: 'all' })
  mkdirSync(join(home, 'reports/fika-renewal'), { recursive: true })
  writeFileSync(
    join(home, 'reports/fika-renewal/report.html'),
    '<title>Fika renewal</title><h1>Fika renewal</h1>'
  )
  const config = join(home, '.config/illithid/config.json')
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, 'utf8')),
      marketEnabled: false,
      updateCheck: false,
      autoBackup: false,
      ui: { language: 'en' },
      artifactSources: [{ root: '~/reports', project: 'first-segment' }]
    })
  )
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_TEST: '1',
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-artifact-sources-ud-'))
    },
    timeout: 30000
  })
  await app.firstWindow()
  return { app, home }
}

test(
  'an added artifact location is scanned next to the built-in ones and can be removed in Settings',
  { timeout: 90000 },
  async () => {
    const { app, home } = await launch()
    try {
      const page = await app.firstWindow()
      // The report from the added folder sits next to the library artifacts
      await page.locator('[data-menu="artifacts"]').click()
      await page.getByText('Fika renewal').first().waitFor()
      await page.getByText('API latency').first().waitFor()

      await page.locator('[data-menu="settings"]').click()
      const custom = page.getByTestId('artifact-source-custom')
      await custom.waitFor()
      assert.equal(await custom.count(), 1)
      assert.match(await custom.innerText(), /~\/reports/)
      assert.ok((await page.getByTestId('artifact-source-builtin').count()) >= 1)

      await custom.getByTestId('artifact-source-remove').click()
      await custom.waitFor({ state: 'detached' })
      const saved = JSON.parse(readFileSync(join(home, '.config/illithid/config.json'), 'utf8'))
      assert.equal(saved.artifactSources, undefined)

      await page.locator('[data-menu="artifacts"]').click()
      await page.getByText('API latency').first().waitFor()
      assert.equal(await page.getByText('Fika renewal').count(), 0)
    } finally {
      await app.close()
    }
  }
)
