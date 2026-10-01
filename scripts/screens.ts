/**
 * Launches the build output (out/) in Electron and takes a screenshot per menu (language ko, light and dark).
 * - Uses playwright-core's _electron, so no browser download is needed.
 * - userData is redirected to a temp directory so the real ~/Library/Application Support is untouched.
 * - Reads the real HOME by default (no writes happen here).
 *   With ILLITHID_HOME=<fixture>, main uses that directory as HOME (write scenarios live in scripts/m7c-scenario.ts).
 *
 * Usage: npm run screens   (runs after electron-vite build)
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type Page } from 'playwright-core'

const ROOT = resolve(__dirname, '..')
const OUT_DIR = '/tmp/illithid-screens'
const MENUS = [
  'dashboard',
  'rules',
  'skills',
  'mcp',
  'agents',
  'artifacts',
  'sessions',
  'backup',
  'settings'
] as const
const THEMES = ['light', 'dark'] as const
// ko UI text (common.loading in ko.json); screenshots run with language ko
const LOADING = '\uBD88\uB7EC\uC624\uB294 \uC911'

type Menu = (typeof MENUS)[number]

async function waitLoaded(page: Page): Promise<void> {
  await page.waitForFunction((text) => !document.body.innerText.includes(text), LOADING, {
    timeout: 60_000
  })
}

/** On list screens, select one item so the detail panel shows */
async function selectItem(page: Page, menu: Menu): Promise<void> {
  const main = page.locator('main')
  const pickCard = async (name?: string): Promise<void> => {
    const cards = main.locator('[data-card]')
    const card =
      name && (await cards.filter({ hasText: name }).count())
        ? cards.filter({ hasText: name }).first()
        : cards.first()
    if (await card.count()) await card.click()
  }
  if (menu === 'rules') await pickCard()
  else if (menu === 'skills') await pickCard('find-skills')
  else if (menu === 'mcp') await pickCard('context7')
  else if (menu === 'agents') await pickCard()
  else if (menu === 'artifacts' || menu === 'sessions') {
    await main.locator('.mantine-NavLink-root').first().click()
  }
  await waitLoaded(page)
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })
  const userData = mkdtempSync(join(tmpdir(), 'illithid-userdata-'))
  // ILLITHID_TEST=1: hide the window (offscreen) and don't steal focus
  const env = { ...process.env, ILLITHID_USER_DATA: userData, ILLITHID_TEST: '1' } as Record<
    string,
    string
  >
  if (env.ILLITHID_HOME) env.HOME = env.ILLITHID_HOME
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js')], cwd: ROOT, env })
  const consoleErrors: string[] = []
  const written: string[] = []
  try {
    const page = await app.firstWindow()
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(e.message))
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1400, 900)
    })

    for (const theme of THEMES) {
      await page.evaluate((th) => {
        localStorage.setItem('illithid-language', 'ko')
        localStorage.setItem('illithid-color-scheme', th)
      }, theme)
      await page.reload()
      await page.waitForSelector('[data-menu="dashboard"]')

      for (const menu of MENUS) {
        await page.click(`[data-menu="${menu}"]`)
        await waitLoaded(page)
        await selectItem(page, menu)
        await page.waitForTimeout(300)
        const file = join(OUT_DIR, `${menu}-${theme}.png`)
        await page.screenshot({ path: file })
        written.push(file)
      }
    }

    // Summary for cross-checking numbers (against CLI status and sessions)
    await page.click('[data-menu="dashboard"]')
    await waitLoaded(page)
    const cells = await page.$$eval('[data-cell]', (els) =>
      els.map((e) => `${e.getAttribute('data-cell')}=${e.getAttribute('data-state')}`)
    )
    // With an empty library the skills/agents summary may be absent, so read it only if present
    const textOf = async (sel: string): Promise<string> => {
      const loc = page.locator(sel)
      return (await loc.count()) ? loc.first().innerText() : '(none)'
    }
    await page.click('[data-menu="sessions"]')
    await waitLoaded(page)
    const sessionCount = await textOf('[data-testid="session-count"]')
    const sessionAlerts = await page.locator('main .mantine-Alert-root').allInnerTexts()
    const hide = page.getByLabel('\uC11C\uBE0C\uC5D0\uC774\uC804\uD2B8 \uC228\uAE40') // ko: sessions.hideSubagents
    if (await hide.count()) await hide.uncheck({ force: true })
    await page.waitForTimeout(200)
    const sessionCountAll = await textOf('[data-testid="session-count"]')
    await page.click('[data-menu="skills"]')
    await waitLoaded(page)
    const linkPlanText = await textOf('[data-testid="link-plan"]')
    await page.click('[data-menu="agents"]')
    await waitLoaded(page)
    const rosterText = await textOf('[data-testid="roster-summary"]')
    await page.click('[data-menu="artifacts"]')
    await waitLoaded(page)
    const artifactCount = await textOf('[data-testid="artifact-count"]')

    console.log(
      JSON.stringify(
        {
          screenshots: written,
          cells,
          sessionCount,
          sessionCountAll,
          sessionAlerts,
          linkPlanText,
          rosterText,
          artifactCount,
          consoleErrors
        },
        null,
        2
      )
    )
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
