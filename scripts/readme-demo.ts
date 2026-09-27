/**
 * README demo video from a demo HOME (never the real one).
 * - Reuses the readme-shots demo HOME with all five tools, pre-syncs it, launches out/ with Playwright video recording (1280x800, light theme).
 * - Auto apply is off after the pre-sync, so every change goes through the sidebar Sync → apply preview → Apply.
 * - Sequence: rule edit (all five tools) → skill off for Gemini → MCP server off for Copilot → a session's requests in Contents.
 * - Checks on disk that tool files only change on Apply and that the edit reached every tool, then encodes docs/demo/illithid-demo.{mp4,gif}.
 *
 * Usage: npx electron-vite build && npx tsx scripts/readme-demo.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const SKILL = 'frontend-qa'
const SKILL_OFF = 'gemini'
const MCP = 'playwright'
const MCP_OFF = 'copilot'
const WS = '.illithid/workspaces/default'
const COPILOT_RULE = `.copilot/instructions/illithid/${RULE.replace(/\.md$/, '.instructions.md')}`

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

async function waitState(page: Page, state: 'pending' | 'synced'): Promise<void> {
  await page.waitForSelector(`[data-testid="sync-button"][data-state="${state}"]`, { timeout: 15_000 })
}

/** Wheel-scroll (under the current pointer) until the target is fully on screen, so long dialogs scroll visibly */
async function reveal(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const box = await target.boundingBox()
    if (!box) return
    if (box.y + box.height <= SIZE.height - 24) return
    await page.mouse.wheel(0, 60)
    await page.waitForTimeout(50)
  }
}

/** Sidebar Sync → apply preview (pause on the per-tool list) → Apply */
async function applyViaPreview(page: Page, tools: string[], hold: number): Promise<void> {
  await waitState(page, 'pending')
  await clickSlow(page, page.locator('[data-testid="sync-button"]'), 300)
  await page.waitForSelector('[data-testid="apply-preview"]')
  for (const tool of tools) await page.waitForSelector(`[data-testid="apply-preview-${tool}"]`)
  await moveTo(page, page.locator(`[data-testid="apply-preview-${tools[tools.length - 1]}"]`))
  await page.waitForTimeout(hold)
  const apply = page.locator('[data-testid="apply-preview-apply"]')
  await reveal(page, apply)
  await clickSlow(page, apply, 300)
  await waitState(page, 'synced')
  await page.locator('[data-testid="apply-preview"]').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
}

/** Tool-side files the demo touches; must stay byte-identical until Apply */
function toolFiles(home: string): Record<string, string> {
  const read = (rel: string): string => readFileSync(join(home, rel), 'utf8')
  return {
    claude: read(join('.claude/rules/illithid', RULE)),
    codex: read('.codex/AGENTS.md'),
    opencode: read('.config/opencode/opencode.json'),
    gemini: read('.gemini/GEMINI.md'),
    copilot: read(COPILOT_RULE)
  }
}

const same = (a: Record<string, string>, b: Record<string, string>): boolean => Object.keys(a).every((k) => a[k] === b[k])

/** Skill copy in the tool's skills dir and the MCP server entry in the tool's config */
function offTargets(home: string): { skill: boolean; mcp: boolean } {
  const skillLink = join(home, `.${SKILL_OFF}/skills`, SKILL)
  let skill = false
  try {
    lstatSync(skillLink)
    skill = true
  } catch {
    skill = false
  }
  const mcpConfig = join(home, '.copilot/mcp-config.json')
  const mcp = existsSync(mcpConfig) && MCP in ((JSON.parse(readFileSync(mcpConfig, 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {})
  return { skill, mcp }
}

/** Click one tool icon on a card → Sync → preview for that tool → Apply */
async function toggleOff(page: Page, card: string, tool: string, hold: number): Promise<void> {
  const pill = page.locator(`main [data-card="${card}"] [data-tool="${tool}"]`)
  await clickSlow(page, pill, 300)
  await page.waitForFunction((sel) => document.querySelector(sel)?.hasAttribute('data-off') ?? false, `main [data-card="${card}"] [data-tool="${tool}"]`, { timeout: 10_000 })
  await applyViaPreview(page, [tool], hold)
}

async function sequence(page: Page, home: string): Promise<Record<string, boolean>> {
  const main = page.locator('main')
  await page.waitForTimeout(800)

  // 1. Rules: one edit → Sync → preview for all five tools → Apply
  const card = main.locator(`[data-card="${RULE}"]`)
  await moveTo(page, card.locator('[data-tool="copilot"]'))
  await page.waitForTimeout(500)
  await clickSlow(page, card, 800)
  await clickSlow(page, page.locator('[data-testid="tab-edit"]'), 500)
  const area = page.locator('.mantine-Drawer-content textarea').first()
  await moveTo(page, area)
  await area.click()
  await area.evaluate((el: HTMLTextAreaElement, anchor) => {
    const at = el.value.indexOf(anchor) + anchor.length
    el.setSelectionRange(at, at)
  }, ANCHOR)
  await page.keyboard.type(ADDED, { delay: 45 })
  await page.waitForTimeout(400)
  const before = toolFiles(home)
  await clickSlow(page, page.locator('[data-testid="editor-save"]'), 300)
  await waitState(page, 'pending')
  await page.waitForTimeout(800)
  const afterSave = toolFiles(home)
  await applyViaPreview(page, ['claude', 'codex', 'opencode', 'gemini', 'copilot'], 1500)
  await page.waitForTimeout(700)
  await page.keyboard.press('Escape')

  // 2. Skills: turn one skill off for Gemini
  const offBefore = offTargets(home)
  await clickSlow(page, page.locator('[data-menu="skills"]'), 300)
  await waitLoaded(page)
  await main.locator(`[data-card="${SKILL}"]`).waitFor()
  await page.waitForTimeout(300)
  await toggleOff(page, SKILL, SKILL_OFF, 900)
  await page.waitForTimeout(400)

  // 3. MCP: server cards with per-tool icons → turn one server off for Copilot
  await clickSlow(page, page.locator('[data-menu="mcp"]'), 300)
  await waitLoaded(page)
  const server = main.locator(`[data-card="${MCP}"]`)
  await server.waitFor()
  await moveTo(page, server.locator('[data-tool="claude"]'))
  await page.waitForTimeout(400)
  await toggleOff(page, MCP, MCP_OFF, 900)
  await page.waitForTimeout(400)

  // 4. Sessions: open one and walk its requests in Contents
  await clickSlow(page, page.locator('[data-menu="sessions"]'), 300)
  await waitLoaded(page)
  const rows = main.locator('.mantine-NavLink-root')
  await rows.first().waitFor()
  await moveTo(page, rows.nth(1))
  const session = rows.filter({ hasText: 'Write the migration' }).first()
  await clickSlow(page, (await session.count()) ? session : rows.nth(2), 400)
  const items = main.locator('[data-testid="contents-item"]')
  await items.first().waitFor({ timeout: 10_000 })
  await moveTo(page, items.first())
  await page.waitForTimeout(1500)
  for (const i of [1, 2]) if ((await items.count()) > i) await clickSlow(page, items.nth(i), 1000)
  await moveTo(page, main.locator('[data-testid="resume-copy"]'))
  await page.waitForTimeout(1000)

  const offAfter = offTargets(home)
  return {
    toolsUnchangedAfterSave: same(before, afterSave),
    skillPresentBefore: offBefore.skill,
    skillRemovedFromGemini: !offAfter.skill,
    mcpPresentBefore: offBefore.mcp,
    mcpRemovedFromCopilot: !offAfter.mcp
  }
}

/** Marker block of a tool instructions file ('' if missing) */
function markerBlock(path: string): string {
  const text = readFileSync(path, 'utf8')
  const b = text.indexOf(MD_BEGIN)
  const e = text.indexOf(MD_END)
  return b >= 0 && e > b ? text.slice(b, e) : ''
}

/** Edited text must reach Claude, Codex, OpenCode, Gemini CLI and GitHub Copilot */
function verifyOnDisk(home: string): Record<string, boolean> {
  const line = ANCHOR + ADDED
  const libRule = join(home, WS, 'rules', RULE)
  const claude = readFileSync(join(home, '.claude/rules/illithid', RULE), 'utf8')
  const block = markerBlock(join(home, '.codex/AGENTS.md'))
  const gemini = markerBlock(join(home, '.gemini/GEMINI.md'))
  const copilot = readFileSync(join(home, COPILOT_RULE), 'utf8')
  const oc = JSON.parse(readFileSync(join(home, '.config/opencode/opencode.json'), 'utf8')) as { instructions?: string[] }
  const instructions = oc.instructions ?? []
  return {
    library: readFileSync(libRule, 'utf8').includes(line),
    claude: claude.includes(line),
    codex: block.includes(line),
    opencode: instructions.includes(libRule) && readFileSync(libRule, 'utf8').includes(line),
    gemini: gemini.includes(line),
    copilot: copilot.includes(line) && /^---\n[\s\S]*?applyTo: ["']?\*\*["']?\n[\s\S]*?---\n/.test(copilot)
  }
}

function encode(raw: string, trim: number, duration: number): void {
  const mp4 = join(OUT_DIR, 'illithid-demo.mp4')
  const gif = join(OUT_DIR, 'illithid-demo.gif')
  const cut = ['-ss', trim.toFixed(2), '-t', duration.toFixed(2), '-i', raw]
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...cut, '-vf', 'fps=30,scale=1280:-2:flags=lanczos,setpts=PTS-STARTPTS', '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-output_ts_offset', '0', '-an', mp4])
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
    buildDemoHome(home, { tools: 'all' })
    syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
    // Auto apply off: saves stay in the library until Apply in the preview
    const configPath = join(home, '.config/illithid/config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    writeFileSync(configPath, JSON.stringify({ ...config, allowRealApply: false }, null, 2) + '\n')
    const env = { ...baseEnv(home), ILLITHID_HOME: home, ILLITHID_USER_DATA: userData, ILLITHID_TEST: '1' }
    const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js')], cwd: ROOT, env, recordVideo: { dir: videoDir, size: SIZE } })
    const errors: string[] = []
    let raw = ''
    let trim = 0
    let duration = 0
    let gated: Record<string, boolean> = {}
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
      gated = await sequence(page, home)
      trim = (start - t0) / 1000
      duration = (Date.now() - start) / 1000
      raw = (await page.video()?.path()) ?? ''
    } finally {
      await app.close()
    }
    if (!raw || !existsSync(raw)) throw new Error('no video recorded')
    const check = { ...gated, ...verifyOnDisk(home) }
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
