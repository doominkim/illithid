import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type Locator } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'
import type { Api } from '../src/shared/api'

declare global {
  interface Window {
    api: Api
  }
}

async function launch(): Promise<Awaited<ReturnType<typeof electron.launch>>> {
  const home = mkdtempSync(join(tmpdir(), 'illithid-qa-ux-'))
  buildDemoHome(home, { tools: 'all' })
  const config = join(home, '.config/illithid/config.json')
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, 'utf8')),
      allowRealApply: false,
      toolsInUse: ['claude', 'codex'],
      updateCheck: false,
      marketEnabled: true,
      ui: { language: 'en', colorScheme: 'dark', views: { rules: 'grid' } }
    })
  )
  const env = {
    ...baseEnv(home),
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-qa-ux-ud-')),
    ILLITHID_TEST: '1'
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  return electron.launch({
    args: [resolve(process.env.ILLITHID_UI_ENTRY ?? 'out/main/index.js')],
    env,
    timeout: 60_000
  })
}

async function contrast(button: Locator): Promise<number> {
  const colors = await button.evaluate((element) => {
    const backgrounds: string[] = []
    for (let parent: Element | null = element; parent; parent = parent.parentElement)
      backgrounds.push(getComputedStyle(parent).backgroundColor)
    return { foreground: getComputedStyle(element).color, backgrounds }
  })
  const rgba = (color: string): number[] => {
    const channels = color.match(/[\d.]+/g)?.map(Number)
    if (!channels || channels.length < 3) throw new Error(`Unsupported computed color: ${color}`)
    return [channels[0], channels[1], channels[2], channels[3] ?? 1]
  }
  const composite = (front: number[], back: number[]): number[] =>
    front.slice(0, 3).map((channel, i) => channel * front[3] + back[i] * (1 - front[3]))
  let background = [255, 255, 255]
  for (const color of colors.backgrounds.reverse()) background = composite(rgba(color), background)
  const foreground = composite(rgba(colors.foreground), background)
  const luminance = (color: number[]): number => {
    const channels = color.map((channel) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test('Settings controls can be found by their visible labels', { timeout: 120_000 }, async () => {
  const app = await launch()
  try {
    const page = await app.firstWindow()
    await page.locator('[data-menu="settings"]').click()
    await page.getByTestId('settings-language').waitFor()
    for (const name of [
      'Claude Code',
      'Codex',
      'OpenCode',
      'Gemini CLI',
      'GitHub Copilot',
      'Grok CLI',
      'Qwen Code',
      'Use the marketplace',
      'Check for new versions',
      'Auto apply',
      'Auto cleanup'
    ]) {
      assert.equal(await page.getByRole('switch', { name, exact: true }).count(), 1, name)
    }
    assert.equal(
      await page.getByRole('combobox', { name: 'Language', exact: true }).inputValue(),
      'English'
    )
    assert.equal(await page.getByLabel('Keep days', { exact: true }).inputValue(), '30')
    assert.equal(
      await page.getByLabel('Rollback snapshots kept', { exact: true }).inputValue(),
      '3'
    )
  } finally {
    await app.close()
  }
})

test(
  'a rejected library load can be reloaded from its error without changing menus',
  { timeout: 120_000 },
  async () => {
    const app = await launch()
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="skills"]').waitFor()
      const successfulReply = await page.evaluate(() => window.api.skills())
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:skills')
        ipcMain.handle('api:skills', () => {
          throw new Error('Library temporarily unavailable')
        })
      })
      await page.locator('[data-menu="skills"]').click()
      await page.getByText('Library temporarily unavailable', { exact: true }).waitFor()
      const reload = page.locator('main').getByRole('button', { name: 'Reload', exact: true })
      assert.equal(await reload.count(), 1)
      await app.evaluate(({ ipcMain }, reply) => {
        ipcMain.removeHandler('api:skills')
        ipcMain.handle('api:skills', () => reply)
      }, successfulReply)
      await reload.click()
      await page.locator('main').getByText('code-review', { exact: true }).first().waitFor()
      assert.equal(
        await page.getByText('Library temporarily unavailable', { exact: true }).count(),
        0
      )
      assert.equal(await page.locator('[data-menu="skills"][data-active]').count(), 1)
    } finally {
      await app.close()
    }
  }
)

test(
  'small button text meets 4.5:1 contrast in light and dark themes',
  { timeout: 120_000 },
  async () => {
    const app = await launch()
    try {
      const page = await app.firstWindow()
      await page.getByTestId('rule-new').waitFor()
      await page.waitForFunction(
        () => document.documentElement.getAttribute('data-mantine-color-scheme') === 'dark'
      )
      await page.locator('[data-testid="sync-button"][data-state="pending"]').waitFor()
      const darkRule = await contrast(page.getByTestId('rule-new'))
      const darkSync = await contrast(page.getByTestId('sync-button'))
      await page.locator('[data-menu="settings"]').click()
      await page.getByTestId('settings-theme').getByText('Light', { exact: true }).click()
      await page.waitForFunction(
        () => document.documentElement.getAttribute('data-mantine-color-scheme') === 'light'
      )
      await page.locator('[data-menu="rules"]').click()
      await page.getByTestId('rule-new').waitFor()
      const lightRule = await contrast(page.getByTestId('rule-new'))
      const lightSync = await contrast(page.getByTestId('sync-button'))
      const ratios = { darkRule, darkSync, lightRule, lightSync }
      console.log('Button text contrast', ratios)
      for (const [name, ratio] of Object.entries(ratios))
        assert.ok(ratio >= 4.5, `${name}: ${ratio.toFixed(2)}:1`)
    } finally {
      await app.close()
    }
  }
)

test(
  'a short window keeps Sync readable and every sidebar menu reachable',
  { timeout: 120_000 },
  async () => {
    const app = await launch()
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="rules"]').waitFor()
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(1000, 900)
      )
      await page.waitForFunction(() => window.innerHeight === 900)
      const sync = page.getByTestId('sync-button')
      const tall = await sync.boundingBox()
      assert.ok(tall && tall.height >= 28)
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(1000, 600)
      )
      await page.waitForFunction(() => window.innerHeight === 600)
      const short = await sync.boundingBox()
      assert.ok(short && short.height >= 28, `Sync height is ${short?.height}px at 1000×600`)
      assert.ok(Math.abs(short.height - tall.height) <= 1)
      for (const menu of [
        'rules',
        'skills',
        'mcp',
        'hooks',
        'permissions',
        'scripts',
        'agents',
        'market',
        'artifacts',
        'sessions',
        'stats',
        'memory',
        'backup',
        'settings'
      ]) {
        const item = page.locator(`nav [data-menu="${menu}"]`)
        await item.scrollIntoViewIfNeeded()
        const box = await item.boundingBox()
        assert.ok(box && box.height >= 28 && box.y >= 0 && box.y + box.height <= 600, menu)
        const stillVisible = await sync.boundingBox()
        assert.ok(
          stillVisible && stillVisible.height >= 28 && stillVisible.y + stillVisible.height <= 600
        )
      }
      await page.locator('nav [data-menu="settings"]').click()
      await page.getByRole('combobox', { name: 'Language', exact: true }).waitFor()
    } finally {
      await app.close()
    }
  }
)
