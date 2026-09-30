/**
 * README demo video from a demo HOME (never the real one).
 * - Reuses the readme-shots demo HOME with all five tools, pre-syncs it, launches out/ with Playwright video recording (1280x800, light theme).
 * - Auto apply is off after the pre-sync, so every change goes through the sidebar Sync → apply preview → Apply.
 * - Scenes, each cut into its own GIF (docs/demo/<scene>.gif): rules (edit → all five tools), skills (off for Gemini),
 *   mcp (off for Copilot, then the usage chart), market (install two skills), sessions (a session's requests), stats
 *   (cost against response time per model on seeded sessions, tool and period filters, a cost detail), tools
 *   (Grok CLI on → the Claude combo dialog → apply; Codex off → the preview lists what leaves, cancelled).
 * - Checks on disk that tool files only change on Apply and that the edit reached every tool, then encodes the full
 *   docs/demo/illithid-demo.mp4 and the per-scene GIFs. The market scene uses the network (public GET APIs).
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
import { baseEnv, buildDemoHome, put, seedStats } from './readme-shots'

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
async function applyViaPreview(page: Page, tools: string[], hold: number, focus?: string): Promise<void> {
  await waitState(page, 'pending')
  await clickSlow(page, page.locator('[data-testid="sync-button"]'), 300)
  await page.waitForSelector('[data-testid="apply-preview"]')
  for (const tool of tools) await page.waitForSelector(`[data-testid="apply-preview-${tool}"]`)
  const target = focus ? `[data-testid="apply-preview"] [data-testid="${focus}"]` : `[data-testid="apply-preview-${tools[tools.length - 1]}"]`
  await moveTo(page, page.locator(target).first())
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
async function toggleOff(page: Page, card: string, tool: string, hold: number, focus = 'apply-preview-action-remove'): Promise<void> {
  // Rest on the Remove row under the tool (skill copy / MCP server entry)
  const pill = page.locator(`main [data-card="${card}"] [data-tool="${tool}"]`)
  await clickSlow(page, pill, 300)
  await page.waitForFunction((sel) => document.querySelector(sel)?.hasAttribute('data-off') ?? false, `main [data-card="${card}"] [data-tool="${tool}"]`, { timeout: 10_000 })
  await applyViaPreview(page, [tool], hold, focus)
}

/** Scene boundaries in seconds from the video start */
const SCENES: { name: string; from: number; to: number }[] = []
let T0 = 0
const at = (): number => (Date.now() - T0) / 1000
async function scene(page: Page, name: string, run: () => Promise<void>): Promise<void> {
  const from = at()
  await run()
  await page.waitForTimeout(600)
  SCENES.push({ name, from, to: at() })
}

async function sequence(page: Page, home: string): Promise<Record<string, boolean>> {
  const main = page.locator('main')
  await page.waitForTimeout(800)
  let before: Record<string, string> = {}
  let afterSave: Record<string, string> = {}
  let offBefore = { skill: false, mcp: false }

  // 1. Rules: one edit → Sync → preview for all five tools → Apply
  await scene(page, 'rules', async () => {
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
  before = toolFiles(home)
  await clickSlow(page, page.locator('[data-testid="editor-save"]'), 300)
  await waitState(page, 'pending')
  await page.waitForTimeout(800)
  afterSave = toolFiles(home)
  await applyViaPreview(page, ['claude', 'codex', 'opencode', 'gemini', 'copilot'], 1500)
  await page.waitForTimeout(700)
  await page.keyboard.press('Escape')
  })

  // 2. Skills: turn one skill off for Gemini
  offBefore = offTargets(home)
  await clickSlow(page, page.locator('[data-menu="skills"]'), 300)
  await waitLoaded(page)
  await main.locator(`[data-card="${SKILL}"]`).waitFor()
  await scene(page, 'skills', async () => {
    await page.waitForTimeout(300)
    await toggleOff(page, SKILL, SKILL_OFF, 900)
  })

  // 3. MCP: server cards with per-tool icons → turn one server off for Copilot → the server's usage by model
  await clickSlow(page, page.locator('[data-menu="mcp"]'), 300)
  await waitLoaded(page)
  const server = main.locator(`[data-card="${MCP}"]`)
  await server.waitFor()
  await scene(page, 'mcp', async () => {
    await moveTo(page, server.locator('[data-tool="claude"]'))
    await page.waitForTimeout(400)
    await toggleOff(page, MCP, MCP_OFF, 1500, `apply-preview-mcp-${MCP_OFF}-${MCP}-remove`)
    await page.waitForTimeout(400)
    // Open the detail from the card's name corner (the center holds the pills and switch)
    const card = await server.boundingBox()
    if (card) {
      await page.mouse.move(card.x + 60, card.y + 22, { steps: 15 })
      await page.waitForTimeout(300)
      await page.mouse.click(card.x + 60, card.y + 22)
    }
    const chart = page.locator('[data-testid="usage-panel"] .recharts-wrapper').first()
    await chart.waitFor({ timeout: 30_000 })
    await reveal(page, chart)
    await moveTo(page, chart)
    const box = await chart.boundingBox()
    if (box) for (const fx of [0.55, 0.75, 0.9]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * 0.45, { steps: 15 })
      await page.waitForTimeout(700)
    }
    await page.keyboard.press('Escape')
  })

  // 4. Market: two popular skills checked → installed → the Market badge on the Skills page
  await scene(page, 'market', async () => {
    await clickSlow(page, page.locator('[data-menu="market"]'), 300)
    const picks = main.locator('[data-testid="market-pick"]')
    await picks.nth(1).waitFor({ timeout: 60_000 })
    await page.waitForTimeout(600)
    for (const i of [0, 1]) await clickSlow(page, picks.nth(i), 400)
    await clickSlow(page, main.locator('[data-testid="market-install-picked"]'), 300)
    await page.waitForFunction(() => document.body.innerText.includes('Installed'), undefined, { timeout: 90_000 }).catch(() => {})
    await page.waitForTimeout(1200)
    await clickSlow(page, page.locator('[data-menu="skills"]'), 600)
    await waitLoaded(page)
    await page.waitForTimeout(1500)
  })

  // 5. Sessions: open one and walk its requests in Contents
  await scene(page, 'sessions', async () => {
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
  })

  // 6. Stats: cost per request against response time by model, a tool filter and the period list, then one model's cost detail
  await scene(page, 'stats', async () => {
    await clickSlow(page, page.locator('[data-menu="stats"]'), 300)
    const point = (model: string): Locator => page.locator(`[data-testid="stats-point"][data-model="${model}"]`).first()
    await point('claude-opus-5-5').waitFor({ timeout: 60_000 })
    await page.waitForTimeout(1200)
    for (const model of ['claude-haiku-4-5', 'gpt-6.1-sol', 'claude-opus-5-5']) {
      await moveTo(page, point(model))
      await page.waitForTimeout(900)
    }
    const option = (label: string): Locator => page.getByRole('option').getByText(label, { exact: true })
    await clickSlow(page, page.getByTestId('stats-tool'), 500)
    await clickSlow(page, option('Codex'), 1800)
    await clickSlow(page, page.getByTestId('stats-tool'), 500)
    await clickSlow(page, option('All'), 1200)
    await clickSlow(page, page.getByTestId('stats-days'), 500)
    await moveTo(page, option('Custom'))
    await page.waitForTimeout(600)
    await clickSlow(page, option('90 days'), 1200)
    await clickSlow(page, point('claude-opus-5-5'), 300)
    const cost = page.getByTestId('stats-cost-detail')
    await cost.waitFor({ timeout: 10_000 })
    await moveTo(page, cost)
    await page.waitForTimeout(2200)
    await page.keyboard.press('Escape')
  })

  const offAfter = offTargets(home)

  // 7. Tools: Grok CLI on → the Claude combo dialog → Use both → apply; Codex off → the preview lists what leaves → Cancel
  await scene(page, 'tools', async () => {
    await clickSlow(page, page.locator('[data-menu="settings"]'), 500)
    const grok = page.locator('[data-testid="tool-in-use-grok"]')
    await grok.waitFor()
    await moveTo(page, grok)
    await page.waitForTimeout(400)
    await grok.click({ force: true })
    const both = page.locator('[data-testid="combo-both"]')
    await both.waitFor({ timeout: 10_000 })
    await page.waitForTimeout(2200)
    await clickSlow(page, both, 300)
    await page.waitForSelector('[data-testid="apply-preview-grok"]', { timeout: 30_000 })
    await moveTo(page, page.locator('[data-testid="apply-preview-grok"]'))
    await page.waitForTimeout(1500)
    await clickSlow(page, page.locator('[data-testid="apply-preview-apply"]'), 300)
    await page.locator('[data-testid="apply-preview"]').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(2500)
    const codex = page.locator('[data-testid="tool-in-use-codex"]')
    await moveTo(page, codex)
    await codex.click({ force: true })
    await page.waitForSelector('[data-testid="apply-preview-codex"]', { timeout: 30_000 })
    await moveTo(page, page.locator('[data-testid="apply-preview-codex"]'))
    await page.waitForTimeout(2000)
    await clickSlow(page, page.locator('[data-testid="apply-preview-cancel"]'), 600)
  })

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
  const cut = ['-ss', trim.toFixed(2), '-t', duration.toFixed(2), '-i', raw]
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...cut, '-vf', 'fps=30,scale=1280:-2:flags=lanczos,setpts=PTS-STARTPTS', '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-output_ts_offset', '0', '-an', mp4])
  // One palette GIF per scene; drop fps until each fits under 6 MB
  for (const sc of SCENES) {
    const gif = join(OUT_DIR, `${sc.name}.gif`)
    const part = ['-ss', sc.from.toFixed(2), '-t', (sc.to - sc.from).toFixed(2), '-i', raw]
    for (const fps of [12, 10, 8]) {
      const vf = `fps=${fps},scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`
      execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...part, '-vf', vf, gif])
      if (statSync(gif).size < 6 * 1024 * 1024) break
    }
  }
}

/** Calls in a demo session over the last 30 days so the MCP detail has a usage chart (Claude and Codex, several models) */
function seedUsage(home: string): void {
  const sid = 'aaaaaaaa-0000-4000-8000-00000000u5a9'
  const lines: unknown[] = [{ type: 'user', sessionId: sid, cwd: '/Users/Shared/alex/shop-web', timestamp: new Date(Date.now() - 31 * 86_400_000).toISOString(), message: { role: 'user', content: 'Check the checkout page in the browser.' } }]
  const models = ['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1']
  for (let d = 0; d < 30; d++) {
    const n = [0, 1, 3, 2, 0, 4, 1, 2][d % 8] + (d > 22 ? 2 : 0)
    for (let i = 0; i < n; i++)
      lines.push({ type: 'assistant', sessionId: sid, timestamp: new Date(Date.now() - d * 86_400_000 - i * 60_000).toISOString(), message: { role: 'assistant', model: models[(d + i) % 3], content: [{ type: 'tool_use', name: `mcp__${MCP}__browser_navigate`, input: {} }] } })
  }
  put(home, `.claude/projects/-Users-Shared-alex-shop-web/${sid}.jsonl`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const xid = '01a0e700-0000-7000-8000-00000000u5a9'
  const xl: unknown[] = [{ type: 'session_meta', timestamp: new Date(Date.now() - 20 * 86_400_000).toISOString(), payload: { id: xid, cwd: '/Users/Shared/alex/shop-web' } }, { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }, { type: 'response_item', timestamp: new Date(Date.now() - 20 * 86_400_000).toISOString(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Smoke-test the signup flow in the browser.' }] } }]
  for (let d = 0; d < 20; d++)
    if (d % 3 !== 1) xl.push({ type: 'response_item', timestamp: new Date(Date.now() - d * 86_400_000).toISOString(), payload: { type: 'function_call', name: 'browser_navigate', namespace: `mcp__${MCP}`, arguments: '{}' } })
  put(home, `.codex/sessions/2026/09/08/rollout-2026-09-08T10-00-00-${xid}.jsonl`, xl.map((l) => JSON.stringify(l)).join('\n') + '\n')
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
    seedUsage(home)
    seedStats(home)
    syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
    // Auto apply off: saves stay in the library until Apply in the preview
    const configPath = join(home, '.config/illithid/config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    writeFileSync(configPath, JSON.stringify({ ...config, allowRealApply: false, ui: { language: 'en', colorScheme: 'light', views: { rules: 'grid', skills: 'grid', mcp: 'grid', agents: 'grid' } } }, null, 2) + '\n')
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
      T0 = t0
      page.on('pageerror', (e) => errors.push(e.message))
      await app.evaluate(({ BrowserWindow }, s) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height)
      }, SIZE)
      await page.setViewportSize(SIZE).catch(() => {})
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
