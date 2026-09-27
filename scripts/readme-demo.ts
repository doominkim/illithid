/**
 * README demo video from a demo HOME (never the real one).
 * - Reuses the readme-shots demo HOME, pre-syncs it, launches out/ with Playwright video recording (1280x800, light theme).
 * - Sequence: Rules grid → open 20-git.md → Edit → append to a line → Save (synced) → turn OpenCode off for 40-testing.md → Sessions search.
 * - Checks on disk that the edit reached Claude Code, Codex and OpenCode, then encodes docs/demo/illithid-demo.{mp4,gif}.
 *
 * Usage: npx electron-vite build && npx tsx scripts/readme-demo.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type Locator, type Page } from 'playwright-core'
import { syncAll } from '../src/engine'
import { MD_BEGIN, MD_END } from '../src/engine/targets/codexAgents'
import { baseEnv, buildDemoHome } from './readme-shots'

const ROOT = resolve(__dirname, '..')
const OUT_DIR = join(ROOT, 'docs/demo')
const FFMPEG = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'
const SIZE = { width: 1280, height: 800 }
const RULE = '20-git.md'
const ANCHOR = '- One logical change per commit.'
const ADDED = ' Explain the why in the body.'
const OFF_RULE = '40-testing.md'
const WS = '.illithid/workspaces/default'

/** Visible pointer: Playwright videos do not draw the OS cursor */
async function addCursor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dot = document.createElement('div')
    dot.id = 'demo-cursor'
    Object.assign(dot.style, {
      position: 'fixed', left: '0px', top: '0px', width: '18px', height: '18px', marginLeft: '-9px', marginTop: '-9px',
      borderRadius: '50%', background: 'rgba(30, 30, 30, 0.35)', border: '2px solid rgba(255, 255, 255, 0.9)',
      boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.25)', pointerEvents: 'none', zIndex: '2147483647', transition: 'transform 120ms'
    })
    document.body.appendChild(dot)
    document.addEventListener('mousemove', (e) => {
      dot.style.left = `${e.clientX}px`
      dot.style.top = `${e.clientY}px`
    }, true)
    document.addEventListener('mousedown', () => (dot.style.transform = 'scale(0.7)'), true)
    document.addEventListener('mouseup', () => (dot.style.transform = 'scale(1)'), true)
  })
  await page.mouse.move(640, 400)
}

async function moveTo(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box) throw new Error('target not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 })
  await page.waitForTimeout(250)
}

async function clickSlow(page: Page, target: Locator, after = 900): Promise<void> {
  await moveTo(page, target)
  await target.click()
  await page.waitForTimeout(after)
}

async function waitLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => !document.body.innerText.includes('Loading'), undefined, { timeout: 60_000 })
}

async function waitSynced(page: Page): Promise<void> {
  const btn = page.locator('[data-testid="sync-button"]')
  const deadline = Date.now() + 15_000
  let clicked = false
  while (Date.now() < deadline) {
    const state = await btn.getAttribute('data-state')
    if (state === 'synced') return
    if (state === 'failed') throw new Error('sync failed in the app')
    // The watcher normally syncs on its own; fall back to the sidebar button once
    if (!clicked && Date.now() > deadline - 11_000) {
      await clickSlow(page, btn, 300)
      clicked = true
    }
    await page.waitForTimeout(250)
  }
  throw new Error('sync button never reached the synced state')
}

async function sequence(page: Page): Promise<void> {
  const main = page.locator('main')
  await page.waitForTimeout(1800)

  // Rules grid with per-tool icons on each card
  const card = main.locator(`[data-card="${RULE}"]`)
  await moveTo(page, card.locator('[data-tool="codex"]'))
  await page.waitForTimeout(900)
  await clickSlow(page, card, 1400)

  // Edit one line
  await clickSlow(page, page.locator('[data-testid="tab-edit"]'), 900)
  const area = page.locator('.mantine-Drawer-content textarea').first()
  await moveTo(page, area)
  await area.click()
  await area.evaluate((el: HTMLTextAreaElement, anchor) => {
    const at = el.value.indexOf(anchor) + anchor.length
    el.setSelectionRange(at, at)
  }, ANCHOR)
  await page.waitForTimeout(400)
  await page.keyboard.type(ADDED, { delay: 65 })
  await page.waitForTimeout(900)

  // Save → the watcher syncs to all three tools
  await clickSlow(page, page.locator('[data-testid="editor-save"]'), 300)
  await waitSynced(page)
  await moveTo(page, page.locator('[data-testid="sync-button"]'))
  await page.waitForTimeout(2000)

  // Back to the grid, turn one tool off for another rule
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1000)
  const off = main.locator(`[data-card="${OFF_RULE}"] [data-tool="opencode"]`)
  await clickSlow(page, off, 400)
  await page.waitForFunction((sel) => document.querySelector(sel)?.hasAttribute('data-off') ?? false, `[data-card="${OFF_RULE}"] [data-tool="opencode"]`, { timeout: 10_000 })
  await waitSynced(page)
  await page.waitForTimeout(1800)

  // Sessions from every tool, searched in one place
  await clickSlow(page, page.locator('[data-menu="sessions"]'), 300)
  await waitLoaded(page)
  await page.waitForTimeout(900)
  const search = main.locator('input[type="text"], input:not([type])').first()
  await clickSlow(page, search, 300)
  await page.keyboard.type('checkout', { delay: 110 })
  await page.waitForTimeout(1200)
  const hit = main.locator('.mantine-NavLink-root').first()
  if (await hit.count()) await clickSlow(page, hit, 2200)
  else await page.waitForTimeout(2200)
}

/** Edited text must be in the Claude copy, the Codex AGENTS.md block and the OpenCode instructions */
function verifyOnDisk(home: string): Record<string, boolean> {
  const line = ANCHOR + ADDED
  const libRule = join(home, WS, 'rules', RULE)
  const claude = readFileSync(join(home, '.claude/rules/illithid', RULE), 'utf8')
  const agents = readFileSync(join(home, '.codex/AGENTS.md'), 'utf8')
  const b = agents.indexOf(MD_BEGIN)
  const e = agents.indexOf(MD_END)
  const block = b >= 0 && e > b ? agents.slice(b, e) : ''
  const oc = JSON.parse(readFileSync(join(home, '.config/opencode/opencode.json'), 'utf8')) as { instructions?: string[] }
  const instructions = oc.instructions ?? []
  return {
    library: readFileSync(libRule, 'utf8').includes(line),
    claude: claude.includes(line),
    codex: block.includes(line),
    opencode: instructions.includes(libRule) && readFileSync(libRule, 'utf8').includes(line),
    opencodeOffRemoved: !instructions.some((p) => p.endsWith(`/${OFF_RULE}`)),
    codexOffKept: block.includes('# Testing')
  }
}

function encode(raw: string, trim: number, duration: number): void {
  const mp4 = join(OUT_DIR, 'illithid-demo.mp4')
  const gif = join(OUT_DIR, 'illithid-demo.gif')
  const cut = ['-ss', trim.toFixed(2), '-t', duration.toFixed(2), '-i', raw]
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...cut, '-vf', 'fps=30,scale=1280:-2:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4])
  // Palette GIF; drop fps until it fits under 8 MB
  for (const fps of [12, 10, 8]) {
    const vf = `fps=${fps},scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...cut, '-vf', vf, gif])
    if (statSync(gif).size < 8 * 1024 * 1024) break
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })
  const home = '/Users/Shared/alex'
  if (existsSync(home)) throw new Error(`${home} already exists; remove it or pick another demo path`)
  mkdirSync(home)
  const userData = mkdtempSync(join(tmpdir(), 'illithid-demo-userdata-'))
  const videoDir = mkdtempSync(join(tmpdir(), 'illithid-demo-video-'))
  let ok = false
  try {
    buildDemoHome(home)
    syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
    const env = { ...baseEnv(home), ILLITHID_HOME: home, ILLITHID_USER_DATA: userData, ILLITHID_TEST: '1' }
    const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js')], cwd: ROOT, env, recordVideo: { dir: videoDir, size: SIZE } })
    const errors: string[] = []
    let raw = ''
    let trim = 0
    let duration = 0
    try {
      const page = await app.firstWindow()
      const t0 = Date.now()
      page.on('pageerror', (e) => errors.push(e.message))
      await app.evaluate(({ BrowserWindow }, s) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height)
      }, SIZE)
      await page.setViewportSize(SIZE).catch(() => {})
      await page.evaluate(() => {
        localStorage.setItem('illithid-language', 'en')
        localStorage.setItem('illithid-color-scheme', 'light')
      })
      await page.reload()
      await page.waitForSelector('[data-menu="rules"]')
      await page.waitForSelector(`main [data-card="${RULE}"]`)
      await waitLoaded(page)
      await addCursor(page)
      await page.waitForTimeout(300)
      const start = Date.now()
      await sequence(page)
      trim = (start - t0) / 1000
      duration = (Date.now() - start) / 1000
      raw = (await page.video()?.path()) ?? ''
    } finally {
      await app.close()
    }
    if (!raw || !existsSync(raw)) throw new Error('no video recorded')
    const check = verifyOnDisk(home)
    console.log(JSON.stringify({ errors, trim, duration, check }, null, 2))
    if (!Object.values(check).every(Boolean)) throw new Error('sync check failed')
    encode(raw, trim, duration)
    ok = true
  } finally {
    rmSync(userData, { recursive: true, force: true })
    rmSync(videoDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
  if (ok) console.log(JSON.stringify({ outDir: OUT_DIR }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
