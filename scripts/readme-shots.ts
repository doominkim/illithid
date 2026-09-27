/**
 * README screenshots from a demo HOME (never the real one).
 * - Builds a fake HOME with a small library, tool configs and a few Claude/Codex sessions.
 * - Launches out/ with HOME and ILLITHID_HOME pointed at it, English UI, light and dark.
 * - Writes docs/screenshots/<menu>-<theme>.png
 *
 * Usage: npx electron-vite build && npx tsx scripts/readme-shots.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron, type Page } from 'playwright-core'
import { syncAll, pendingSyncCount } from '../src/engine'

const ROOT = resolve(__dirname, '..')
const OUT_DIR = join(ROOT, 'docs/screenshots')
const MENUS = ['rules', 'skills', 'mcp', 'agents', 'artifacts', 'sessions', 'memory'] as const
const THEMES = ['light', 'dark'] as const
type Menu = (typeof MENUS)[number]

function put(root: string, rel: string, body: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}

// Only what the app needs; keeps real API keys in the environment out of the demo HOME
const baseEnv = (home: string): Record<string, string> => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: home,
  LANG: 'en_US.UTF-8',
  DATABASE_URL: 'postgres://localhost:5432/demo'
})

const iso = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()

function buildDemoHome(home: string): void {
  const ws = '.illithid/workspaces/default'
  put(home, `${ws}/workspace.json`, JSON.stringify({ name: 'default' }, null, 2) + '\n')
  put(home, `${ws}/illithid.json`, JSON.stringify({ version: 1, rules: {}, skills: {}, mcp: {}, agents: {} }, null, 2) + '\n')
  put(home, '.config/illithid/config.json', JSON.stringify({ version: 1, allowRealApply: true, activeWorkspace: 'default' }, null, 2) + '\n')

  const rules: Record<string, string> = {
    '00-communication.md': '# Communication\n\n- Answer in the language the user writes in.\n- Lead with the result, then the reasoning.\n- Keep status updates to one or two lines.\n',
    '10-code-style.md': '# Code Style\n\n- Match the surrounding code before introducing a new pattern.\n- Prefer small functions with clear names over comments.\n- No new dependencies without asking.\n',
    '20-git.md': '# Git\n\n- Conventional Commits: `type(scope): subject`.\n- Never commit, push or force-push without approval.\n- One logical change per commit.\n',
    '30-safety.md': '# Safety\n\n- Do not print secrets, tokens or `.env` values.\n- Ask before destructive commands (`rm -rf`, `reset --hard`, migrations).\n- Verification runs read-only commands only.\n',
    '40-testing.md': '# Testing\n\n- Run the relevant tests before reporting a change as done.\n- Reproduce a bug with a failing test first when practical.\n',
    '50-docs-lookup.md': '# Docs Lookup\n\n1. Project README and docs/\n2. Type definitions in node_modules\n3. Official documentation\n'
  }
  for (const [f, b] of Object.entries(rules)) put(home, `${ws}/rules/${f}`, b)

  const skills: Record<string, [string, string]> = {
    'code-review': ['Review a diff for correctness, regressions and security issues. Use before merging.', '# Code Review\n\n1. Read the diff and the files it touches.\n2. List findings by severity with file:line.\n3. Suggest the smallest fix for each.\n'],
    'release-notes': ['Draft release notes from merged commits since the last tag.', '# Release Notes\n\nGroup commits by type, drop chores, write one line per user-facing change.\n'],
    'sql-explain': ['Explain a slow SQL query plan and propose indexes.', '# SQL Explain\n\nRun EXPLAIN ANALYZE, find the costliest node, propose one index at a time.\n'],
    'frontend-qa': ['Check a web page in the browser for layout, console errors and accessibility.', '# Frontend QA\n\nOpen the dev server, capture screenshots at 1280 and 390 widths, read console errors.\n']
  }
  for (const [n, [d, b]] of Object.entries(skills)) put(home, `${ws}/skills/${n}/SKILL.md`, `---\nname: ${n}\ndescription: ${d}\n---\n\n${b}`)

  const agents: Record<string, string> = {
    reviewer: '---\nname: reviewer\ndescription: Reviews changes for correctness, regressions and security. Does not edit files.\nclaude:\n  model: opus\ncodex:\n  model: gpt-5.5\n  effort: high\nopencode:\n  model: anthropic/claude-opus-5-5\n---\n\n# reviewer\n\n- Read the diff first, then the surrounding code.\n- Report findings as file:line with severity.\n',
    explorer: '---\nname: explorer\ndescription: Finds files, symbols and call paths and returns locations with a short summary.\nclaude:\n  model: haiku\ncodex:\n  model: gpt-5.5-mini\n  effort: low\n---\n\n# explorer\n\n- Never edit files.\n- Return file:line and one-line summaries.\n',
    planner: '---\nname: planner\ndescription: Turns a request into an implementation plan with affected files and verification steps.\nclaude:\n  model: sonnet\n---\n\n# planner\n\nList affected files, steps in order, and how to verify each.\n'
  }
  for (const [n, b] of Object.entries(agents)) put(home, `${ws}/agents/${n}.md`, b)

  const mcps: Record<string, unknown> = {
    context7: { transport: 'http', url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' } },
    github: { transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } },
    playwright: { transport: 'stdio', command: 'npx', args: ['@playwright/mcp@latest', '--isolated'] },
    postgres: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'], env: { DATABASE_URL: '${DATABASE_URL}' } }
  }
  for (const [n, b] of Object.entries(mcps)) put(home, `${ws}/mcps/${n}.json`, JSON.stringify(b, null, 2) + '\n')

  put(home, `${ws}/memory/MEMORY.md`, '# Memory\n\n## feedback\n- [Small commits](feedback/small-commits.md) - one logical change per commit\n## reference\n- [Staging dashboard](reference/staging.md) - where to check deploy health\n')
  put(home, `${ws}/memory/feedback/small-commits.md`, '---\nname: small-commits\ndescription: one logical change per commit\n---\n\nSplit unrelated changes into separate commits.\n')
  put(home, `${ws}/memory/reference/staging.md`, '---\nname: staging\ndescription: where to check deploy health\n---\n\nStaging health lives at the ops dashboard, "api" panel.\n')

  put(home, `${ws}/artifacts/q3-latency-report/manifest.json`, JSON.stringify({ tool: 'Claude Code', created: iso(300), source: 'API latency review' }) + '\n')
  put(home, `${ws}/artifacts/q3-latency-report/report.md`, '# API latency, Q3\n\n| Endpoint | p50 | p95 |\n|---|---|---|\n| GET /orders | 42 ms | 180 ms |\n| POST /checkout | 95 ms | 410 ms |\n| GET /search | 61 ms | 240 ms |\n\n- `/checkout` p95 driven by the payment provider call.\n- `/search` improved after the trigram index.\n')
  put(home, `${ws}/artifacts/onboarding-guide/manifest.json`, JSON.stringify({ tool: 'Codex', created: iso(900), source: 'New hire onboarding' }) + '\n')
  put(home, `${ws}/artifacts/onboarding-guide/guide.html`, '<!doctype html><meta charset="utf-8"><title>Onboarding</title><h1>Developer onboarding</h1><ol><li>Clone the monorepo</li><li>Run <code>make setup</code></li><li>Start the dev server with <code>make dev</code></li></ol><h2>Services</h2><table border="1"><tr><th>Service</th><th>Port</th></tr><tr><td>api</td><td>4000</td></tr><tr><td>web</td><td>3000</td></tr></table>')

  put(home, '.claude/settings.json', '{}\n')
  put(home, '.claude.json', '{}\n')
  put(home, '.codex/config.toml', 'model = "gpt-5.5"\n')
  put(home, '.config/opencode/opencode.json', '{}\n')

  const claudeSession = (id: string, cwd: string, title: string, turns: [string, string][], ago: number): void => {
    const lines: unknown[] = [{ type: 'ai-title', aiTitle: title, sessionId: id }]
    let t = ago + turns.length * 4
    for (const [u, a] of turns) {
      lines.push({ type: 'user', sessionId: id, cwd, timestamp: iso(t), message: { role: 'user', content: u } })
      t -= 2
      lines.push({ type: 'assistant', sessionId: id, cwd, timestamp: iso(t), message: { role: 'assistant', content: [{ type: 'text', text: a }] } })
      t -= 2
    }
    put(home, `.claude/projects/${cwd.replace(/\//g, '-')}/${id}.jsonl`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  claudeSession('0b6f3c1e-5a52-4f0e-9d7a-2f1c9e8b7a01', '/Users/alex/code/shop-api', 'Speed up checkout endpoint', [
    ['Checkout p95 went over 400ms after the last deploy. Can you find why?', 'The regression comes from `applyCoupons()` in `src/checkout/pricing.ts:88`. It now loads every coupon for the account on each request.\n\nFix: query only active coupons with the account index. Expected p95 back to about 180ms.'],
    ['Do it and add a test.', 'Done. Changed the query in `pricing.ts` and added `pricing.test.ts` covering expired and active coupons. All 214 tests pass.']
  ], 20)
  claudeSession('1c7a4d2f-6b63-4a1f-8e8b-3a2d0f9c8b12', '/Users/alex/code/web', 'Fix flaky login e2e test', [
    ['The login e2e test fails about 1 in 5 runs on CI.', 'It clicks "Sign in" before the form finishes hydrating. I switched the test to wait for the `data-ready` attribute. 50 local runs, 0 failures.']
  ], 240)
  claudeSession('2d8b5e30-7c74-4b20-9f9c-4b3e1a0d9c23', '/Users/alex/code/shop-api', 'Add rate limiting to public API', [
    ['Add rate limiting to the public endpoints.', 'Added a token bucket middleware (100 req/min per key) on `/v1/*`, with `Retry-After` on 429.']
  ], 1500)

  const codexSession = (id: string, cwd: string, prompt: string, answer: string, ago: number, day: string): void => {
    const lines = [
      { type: 'session_meta', timestamp: iso(ago + 6), payload: { id, cwd, timestamp: iso(ago + 6) } },
      { type: 'event_msg', timestamp: iso(ago + 5), payload: { type: 'user_message', message: prompt } },
      { type: 'response_item', timestamp: iso(ago + 4), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
      { type: 'response_item', timestamp: iso(ago), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] } }
    ]
    put(home, `.codex/sessions/${day}/rollout-${day.replace(/\//g, '-')}T10-00-00-${id}.jsonl`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  codexSession('3e9c6f41-8d85-4c31-a0ad-5c4f2b1e0d34', '/Users/alex/code/web', 'Migrate the settings page to the new form library', 'Migrated `SettingsForm` to the new form hooks. Validation messages are unchanged; bundle size down 11 KB.', 90, '2026/09/26')
  codexSession('4fad7052-9e96-4d42-b1be-6d503c2f1e45', '/Users/alex/code/infra', 'Write a runbook for rotating the database password', 'Wrote `docs/runbooks/rotate-db-password.md`: create the new user, update the secret, roll the pods, drop the old user.', 2000, '2026/09/25')
}

async function waitLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => !document.body.innerText.includes('Loading'), undefined, { timeout: 60_000 })
}

async function selectItem(page: Page, menu: Menu): Promise<void> {
  const main = page.locator('main')
  const pick = async (name: string): Promise<void> => {
    const cards = main.locator('[data-card]')
    const card = (await cards.filter({ hasText: name }).count()) ? cards.filter({ hasText: name }).first() : cards.first()
    if (await card.count()) await card.click()
  }
  if (menu === 'agents') await pick('reviewer')
  else if (menu === 'artifacts' || menu === 'sessions') {
    const links = main.locator('.mantine-NavLink-root')
    const first = menu === 'artifacts' ? links.filter({ hasText: 'API latency' }).first() : links.first()
    if (await first.count()) await first.click()
  }
  await waitLoaded(page)
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })
  // Under /Users/Shared so paths shown in the UI look like a normal Mac home
  const home = '/Users/Shared/alex'
  if (existsSync(home)) throw new Error(`${home} already exists; remove it or pick another demo path`)
  mkdirSync(home)
  const userData = mkdtempSync(join(tmpdir(), 'illithid-demo-userdata-'))
  buildDemoHome(home)
  const r = syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
  const failed = [
    ...(r.results?.targets ?? []).filter((x) => x.status === 'skipped'),
    ...(r.results?.rules ?? []).filter((x) => x.status === 'failed' || x.status === 'refused'),
    ...(r.results?.skills ?? []).filter((x) => x.status === 'failed' || x.status === 'refused'),
    ...(r.results?.agents ?? []).filter((x) => x.status === 'failed' || x.status === 'refused')
  ]
  console.log(JSON.stringify({ presync: { pending: pendingSyncCount(home, baseEnv(home)), failed } }, null, 2))
  const env = { ...baseEnv(home), ILLITHID_HOME: home, ILLITHID_USER_DATA: userData, ILLITHID_TEST: '1' }

  const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js')], cwd: ROOT, env })
  const errors: string[] = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => errors.push(e.message))
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 800)
    })
    for (const theme of THEMES) {
      await page.evaluate((th) => {
        localStorage.setItem('illithid-language', 'en')
        localStorage.setItem('illithid-color-scheme', th)
      }, theme)
      await page.reload()
      await page.waitForSelector('[data-menu="rules"]')
      for (const menu of MENUS) {
        await page.click(`[data-menu="${menu}"]`)
        await waitLoaded(page)
        await selectItem(page, menu)
        await page.waitForTimeout(600)
        await page.screenshot({ path: join(OUT_DIR, `${menu}-${theme}.png`) })
      }
    }
    console.log(JSON.stringify({ outDir: OUT_DIR, errors }, null, 2))
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
