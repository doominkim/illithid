// Launches an installed (packaged) Illithid against a demo home and checks that the window loads and the startup sync writes the
// tools' files — the release workflow's check that the installer produced a working app.
//   tsx scripts/smoke-packaged.ts <path to the app executable>
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

async function main(): Promise<void> {
  const exe = process.argv[2]
  if (!exe) throw new Error('usage: tsx scripts/smoke-packaged.ts <app executable>')
  if (!existsSync(exe)) throw new Error(`not installed: ${exe}`)
  const home = demoHome()
  const env = appEnv(home)
  // A separate home: this run's own startup sync must not settle the one checked below
  await runAlone(exe, appEnv(demoHome()))
  const app = await electron.launch({ executablePath: exe, env, timeout: 120_000 })
  const page = await app.firstWindow()
  try {
    await page.locator('main .ac-row').first().waitFor({ timeout: 60_000 })
    // The startup sync writes each tool's copies
    const wanted = ['.claude/rules/illithid/00-communication.md', '.codex/AGENTS.md']
    const end = Date.now() + 90_000
    while (!wanted.every((rel) => existsSync(join(home, rel))) && Date.now() < end)
      await new Promise((r) => setTimeout(r, 500))
    for (const rel of wanted)
      if (!existsSync(join(home, rel))) throw new Error(`startup sync did not write ~/${rel}`)
    console.log("smoke ok: the window loaded and the startup sync wrote the tools' copies")
  } catch (e) {
    const toasts = await page.locator('.mantine-Notification-root').allInnerTexts()
    if (toasts.length) console.error(`toasts: ${toasts.join(' | ')}`)
    await page.screenshot({ path: 'smoke-failure.png' }).catch(() => {})
    throw e
  } finally {
    // Quitting runs the backup-on-quit; the smoke check doesn't wait for it
    const proc = app.process()
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 10_000))])
    if (proc.exitCode === null) proc.kill('SIGKILL')
  }
}

function demoHome(): string {
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
  return home
}

function appEnv(home: string): Record<string, string> {
  const env = {
    ...baseEnv(home),
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-smoke-ud-')),
    ILLITHID_TEST: '1'
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/** Start the app without the test driver for a few seconds: an early exit prints its code and output */
async function runAlone(exe: string, env: Record<string, string>): Promise<void> {
  const child = spawn(exe, [], { env: { ...env, ELECTRON_ENABLE_LOGGING: '1' } })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const code = await new Promise<number | null | 'running'>((resolve) => {
    const t = setTimeout(() => resolve('running'), 10_000)
    child.once('exit', (c) => {
      clearTimeout(t)
      resolve(c)
    })
  })
  if (code !== 'running')
    throw new Error(`app exited on its own (code ${code}):\n${out.slice(-4000)}`)
  child.kill('SIGKILL')
  console.log('app starts and keeps running on its own')
}

main().catch((e) => {
  console.error(`smoke failed: ${(e as Error).message}`)
  process.exit(1)
})
