import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'

const electronBin = createRequire(import.meta.url)('electron') as unknown as string
const MAIN = resolve('out/main/index.js')

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-settings-home-'))
  mkdirSync(join(home, '.config/illithid'), { recursive: true })
  writeFileSync(
    join(home, '.config/illithid/config.json'),
    JSON.stringify({
      version: 1,
      toolsInUse: [],
      marketEnabled: false,
      updateCheck: false,
      backupRetention: { enabled: false, days: 30, keepRollback: 3 }
    })
  )
  return home
}
const envFor = (
  home: string,
  userData: string,
  extra: Record<string, string> = {}
): Record<string, string> => {
  const env = {
    ...process.env,
    HOME: home,
    ILLITHID_HOME: home,
    ILLITHID_TEST: '1',
    ILLITHID_USER_DATA: userData,
    ...extra
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  return env
}
const newUserData = (): string => mkdtempSync(join(tmpdir(), 'illithid-settings-userdata-'))
const launch = (env: Record<string, string>): Promise<ElectronApplication> =>
  electron.launch({ args: [MAIN], env, timeout: 60000 })
const uiOf = (home: string): Record<string, unknown> | undefined =>
  JSON.parse(readFileSync(join(home, '.config/illithid/config.json'), 'utf8')).ui
async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  ms = 15000
): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.fail(`timed out: ${what}`)
}
async function pickSegment(page: Page, testId: string, value: string): Promise<void> {
  const id = await page.getByTestId(testId).locator(`input[value="${value}"]`).getAttribute('id')
  await page.locator(`label[for="${id}"]`).click()
}
const exited = (p: ChildProcess): Promise<number | null> =>
  new Promise((r) => (p.exitCode !== null ? r(p.exitCode) : p.once('exit', (code) => r(code))))

test(
  'REQ-SETTINGS-PERSISTENCE-1 REQ-SETTINGS-PERSISTENCE-2 REQ-SETTINGS-PERSISTENCE-3 REQ-SETTINGS-PERSISTENCE-4 language, theme and view mode are saved to config.json and restored with empty Local Storage',
  { timeout: 120000 },
  async () => {
    const home = makeHome()
    const first = await launch(envFor(home, newUserData()))
    try {
      const page = await first.firstWindow()
      await page.locator('[data-menu="settings"]').click()
      // Picking the language already in effect changes nothing: first pick one that isn't (the system's varies)
      const current = await page.evaluate(() => document.documentElement.lang)
      const [other, label] = current.startsWith('ja') ? ['zh', '简体中文'] : ['ja', '日本語']
      await page.getByTestId('settings-language').click()
      await page.getByRole('option', { name: label, exact: true }).click()
      await until(() => uiOf(home)?.language === other, `ui.language saved (${other})`)
      await page.getByTestId('settings-language').click()
      await page.getByRole('option', { name: 'English', exact: true }).click()
      await until(() => uiOf(home)?.language === 'en', 'ui.language saved')
      await pickSegment(page, 'settings-theme', 'dark')
      await until(() => uiOf(home)?.colorScheme === 'dark', 'ui.colorScheme saved')
      await page.locator('[data-menu="skills"]').click()
      await pickSegment(page, 'view-toggle', 'grid')
      await until(
        () => (uiOf(home)?.views as Record<string, string> | undefined)?.skills === 'grid',
        'ui.views.skills saved'
      )
    } finally {
      await first.close()
    }
    // A fresh userData = empty Chromium storage, as after a second instance or a recreated Local Storage
    const second = await launch(envFor(home, newUserData()))
    try {
      const page = await second.firstWindow()
      await page.locator('[data-menu="skills"]').click()
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'en')
      assert.equal(
        await page.evaluate(() =>
          document.documentElement.getAttribute('data-mantine-color-scheme')
        ),
        'dark'
      )
      assert.equal(
        await page.getByTestId('view-toggle').locator('input[value="grid"]').isChecked(),
        true
      )
    } finally {
      await second.close()
    }
  }
)

test(
  'REQ-SETTINGS-PERSISTENCE-5 values left in localStorage move to config.json once',
  { timeout: 120000 },
  async () => {
    const home = makeHome()
    const userData = newUserData()
    const seed = await launch(envFor(home, userData))
    try {
      const page = await seed.firstWindow()
      await page.locator('[data-menu="settings"]').waitFor()
      await page.evaluate(() => {
        localStorage.setItem('illithid-language', 'ja')
        localStorage.setItem('illithid-color-scheme', 'light')
        localStorage.setItem('illithid-view:mcp', 'grid')
      })
      // Remove what this launch itself may have written, so the next start sees an old-format install
      writeFileSync(
        join(home, '.config/illithid/config.json'),
        JSON.stringify({ version: 1, toolsInUse: [], marketEnabled: false, updateCheck: false })
      )
    } finally {
      await seed.close()
    }
    const next = await launch(envFor(home, userData))
    try {
      const page = await next.firstWindow()
      await until(
        () => (uiOf(home)?.views as Record<string, string> | undefined)?.mcp === 'grid',
        'localStorage values moved'
      )
      assert.deepEqual(uiOf(home), { language: 'ja', colorScheme: 'light', views: { mcp: 'grid' } })
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'ja')
      assert.equal(await page.evaluate(() => localStorage.getItem('illithid-language')), 'ja')
    } finally {
      await next.close()
    }
  }
)

test(
  'REQ-SETTINGS-PERSISTENCE-7 REQ-SETTINGS-PERSISTENCE-8 a same-version launch focuses the running app; a newer one takes over',
  { timeout: 120000 },
  async () => {
    const home = makeHome()
    const userData = newUserData()
    const running = await launch(envFor(home, userData))
    let newer: ChildProcess | null = null
    try {
      await running.firstWindow()
      const visible = (): Promise<boolean> =>
        running.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((w) => w.isVisible())
        )
      assert.equal(await visible(), false)
      await until(() => existsSync(join(userData, 'instance.json')), 'instance.json written')

      const same = spawn(electronBin, [MAIN], { env: envFor(home, userData), stdio: 'ignore' })
      const started = Date.now()
      assert.equal(await exited(same), 0)
      assert.ok(Date.now() - started < 10000, 'same version leaves without waiting for the lock')
      await until(visible, 'running window brought forward')

      const runningExit = exited(running.process())
      newer = spawn(electronBin, [MAIN], {
        env: envFor(home, userData, { ILLITHID_TEST_VERSION: '99.0.0' }),
        stdio: 'ignore'
      })
      await runningExit
      await until(
        () =>
          JSON.parse(readFileSync(join(userData, 'instance.json'), 'utf8')).version === '99.0.0',
        'newer build took over'
      )
      assert.equal(newer.exitCode, null)
    } finally {
      newer?.kill('SIGTERM')
      if (newer) await exited(newer)
      await running.close().catch(() => {})
    }
  }
)
