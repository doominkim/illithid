// Launches an installed (packaged) Illithid against a demo home and opens the sync preview — the release workflow's check that
// the installer produced a working app.  tsx scripts/smoke-packaged.ts <path to the app executable>
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

async function main(): Promise<void> {
  const exe = process.argv[2]
  if (!exe) throw new Error('usage: tsx scripts/smoke-packaged.ts <app executable>')
  const home = mkdtempSync(join(tmpdir(), 'illithid-smoke-home-'))
  buildDemoHome(home, { tools: 'all' })
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({
      ...JSON.parse(readFileSync(cfg, 'utf8')),
      updateCheck: false,
      marketEnabled: false,
      ui: { language: 'en' }
    })
  )
  const env = {
    ...baseEnv(home),
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-smoke-ud-')),
    ILLITHID_TEST: '1'
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: exe, env, timeout: 120_000 })
  try {
    const page = await app.firstWindow()
    await page.locator('[data-menu="rules"]').waitFor({ timeout: 60_000 })
    await page.getByTestId('sync-button').click()
    await page.getByTestId('apply-preview').waitFor({ timeout: 60_000 })
    console.log(
      `smoke ok: ${await app.evaluate(({ app: a }) => `${a.getName()} ${a.getVersion()}`)}`
    )
  } finally {
    await app.close()
  }
}

main().catch((e) => {
  console.error(`smoke failed: ${(e as Error).message}`)
  process.exit(1)
})
