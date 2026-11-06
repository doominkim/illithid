import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

const FILES = 3000

test(
  'the artifact grid mounts only visible cards and still reaches the last artifact',
  { timeout: 90000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-artifact-grid-ui-'))
    buildDemoHome(home, { tools: 'all' })
    const dir = join(home, 'downloads/bulk')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < FILES; i++) writeFileSync(join(dir, `bulk-${i}.pdf`), 'x')
    // Oldest of all: sorts to the very end of the grid
    const oldest = join(dir, 'oldest-artifact.pdf')
    writeFileSync(oldest, 'x')
    utimesSync(oldest, new Date('1990-01-01'), new Date('1990-01-01'))
    const config = join(home, '.config/illithid/config.json')
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, 'utf8')),
        marketEnabled: false,
        updateCheck: false,
        autoBackup: false,
        ui: { language: 'en', views: { artifacts: 'grid' } },
        artifactSources: [{ root: '~/downloads', project: 'first-segment' }]
      })
    )
    const app = await electron.launch({
      args: [resolve('out/main/index.js')],
      env: {
        ...baseEnv(home),
        ILLITHID_HOME: home,
        ILLITHID_TEST: '1',
        ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-artifact-grid-ud-'))
      },
      timeout: 30000
    })
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="artifacts"]').click()
      const grid = page.getByTestId('artifact-grid')
      await grid.locator('.ac-thumb-card').first().waitFor()
      const mounted = await grid.locator('.ac-thumb-card').count()
      assert.ok(mounted > 0 && mounted < 200, `mounted cards: ${mounted}`)

      await grid.evaluate((el) => (el.scrollTop = el.scrollHeight))
      await grid.getByText('oldest-artifact.pdf').waitFor()
      assert.ok((await grid.locator('.ac-thumb-card').count()) < 200)
    } finally {
      await app.close()
    }
  }
)
