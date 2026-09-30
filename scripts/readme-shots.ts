/**
 * README screenshots from a demo HOME (never the real one).
 * - Builds a fake HOME with a small library, tool configs and a few Claude/Codex sessions.
 * - Launches out/ with HOME and ILLITHID_HOME pointed at it, English UI, light and dark.
 * - Writes docs/screenshots/<menu>-<theme>.png
 *
 * Usage: npx electron-vite build && npx tsx scripts/readme-shots.ts
 *        SHOTS_TOOLS=all … for all five tools (Gemini CLI, GitHub Copilot and the richer session set)
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

export function put(root: string, rel: string, body: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}

// Only what the app needs; keeps real API keys in the environment out of the demo HOME
export const baseEnv = (home: string): Record<string, string> => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: home,
  LANG: 'en_US.UTF-8',
  DATABASE_URL: 'postgres://localhost:5432/demo'
})

const iso = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()

export const ALL_TOOLS = ['claude', 'codex', 'opencode', 'gemini', 'copilot'] as const

/** tools: 'all' also sets up Gemini CLI and GitHub Copilot and lists all five in toolsInUse. Default = the three config folders only */
/** Deterministic 0..1 sequence so the demo chart looks the same on every run */
function rng(seed: number): () => number {
  let x = seed
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648
    return x / 2147483648
  }
}

/**
 * Stats demo data: Claude and Codex sessions over the last four weeks, 35+ requests per model and effort so every series
 * reaches the chart. Each series gets its own response time and token profile (context, output) so the points spread out.
 */
export function seedStats(home: string): void {
  const rand = rng(42)
  const day = 86_400_000
  const ts = (ms: number): string => new Date(ms).toISOString()
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
  const jitter = (v: number, spread = 0.35): number => Math.max(1, Math.round(v * (1 - spread + rand() * spread * 2)))
  const prompts = [
    'Add pagination to the orders endpoint.', 'Why does the cart total round wrong for JPY?', 'Write tests for the refund service.',
    'Rename the legacy payment flags.', 'Profile the product search query.', 'Fix the flaky webhook retry test.',
    'Move the email templates to the new renderer.', 'Add an index for the inventory lookup.', 'Explain the session timeout bug.',
    'Update the API docs for the new filters.', 'Split the checkout controller.', 'Add metrics for the payment worker.'
  ]
  const titles = ['Orders API pagination', 'Cart rounding for JPY', 'Refund service tests', 'Payment flag cleanup', 'Search query profiling', 'Webhook retry test', 'Email renderer move', 'Inventory index']
  const hex = (n: number): string => n.toString(16).padStart(12, '0')
  let seq = 0

  const claude: { model: string; effort: string; sec: number; ctx: number; out: number }[] = [
    { model: 'claude-opus-5-5', effort: 'high', sec: 140, ctx: 180_000, out: 1400 },
    { model: 'claude-opus-5-5', effort: 'medium', sec: 85, ctx: 140_000, out: 900 },
    { model: 'claude-sonnet-5', effort: 'medium', sec: 55, ctx: 110_000, out: 800 },
    { model: 'claude-haiku-4-5', effort: '', sec: 18, ctx: 60_000, out: 400 }
  ]
  for (const c of claude)
    for (let sIdx = 0; sIdx < 6; sIdx++) {
      const sid = `cccccccc-${String(++seq).padStart(4, '0')}-4000-8000-${hex(seq)}`
      const cwd = '/Users/Shared/alex/shop-api'
      let t = Date.now() - (2 + sIdx * 4 + rand() * 3) * day
      const lines: unknown[] = [{ type: 'ai-title', aiTitle: pick(titles), sessionId: sid }]
      const msg = (id: string, at: number, content: unknown[], out: number): unknown => ({
        type: 'assistant', sessionId: sid, cwd, timestamp: ts(at), ...(c.effort ? { effort: c.effort } : {}),
        message: { id, role: 'assistant', model: c.model, usage: { input_tokens: jitter(12), cache_read_input_tokens: jitter(c.ctx), cache_creation_input_tokens: jitter(c.ctx / 40), output_tokens: jitter(out) }, content }
      })
      for (let r = 0; r < 7; r++) {
        const dur = jitter(c.sec) * 1000
        lines.push({ type: 'user', sessionId: sid, cwd, timestamp: ts(t), message: { role: 'user', content: pick(prompts) } })
        const tool = `t${seq}-${r}`
        lines.push(msg(`m${seq}-${r}a`, t + dur * 0.4, [{ type: 'tool_use', id: tool, name: pick(['Read', 'Edit', 'Bash', 'Grep']), input: {} }], c.out / 3))
        lines.push({ type: 'user', sessionId: sid, cwd, timestamp: ts(t + dur * 0.5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: 'ok' }] } })
        lines.push(msg(`m${seq}-${r}b`, t + dur, [{ type: 'text', text: 'Done.' }], c.out))
        t += dur + jitter(240) * 1000
      }
      put(home, `.claude/projects/-Users-Shared-alex-shop-api/${sid}.jsonl`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    }

  const codex: { effort: string; sec: number; ctx: number; out: number }[] = [
    { effort: 'high', sec: 95, ctx: 120_000, out: 1600 },
    { effort: 'medium', sec: 50, ctx: 90_000, out: 900 },
    { effort: 'low', sec: 24, ctx: 60_000, out: 450 }
  ]
  for (const c of codex)
    for (let sIdx = 0; sIdx < 6; sIdx++) {
      const id = `01a0e7${String(++seq).padStart(2, '0')}-0000-7000-8000-${hex(seq)}`
      const cwd = '/Users/Shared/alex/web'
      let t = Date.now() - (3 + sIdx * 4 + rand() * 3) * day
      const start = new Date(t)
      const d = `${start.getFullYear()}/${String(start.getMonth() + 1).padStart(2, '0')}/${String(start.getDate()).padStart(2, '0')}`
      const ev = (at: number, payload: unknown): unknown => ({ type: 'event_msg', timestamp: ts(at), payload })
      const lines: unknown[] = [{ type: 'session_meta', timestamp: ts(t), payload: { id, cwd, timestamp: ts(t) } }]
      for (let r = 0; r < 7; r++) {
        const dur = jitter(c.sec) * 1000
        const ctx = jitter(c.ctx)
        lines.push(ev(t, { type: 'task_started' }))
        lines.push({ type: 'turn_context', timestamp: ts(t), payload: { model: 'gpt-6.1-sol', effort: c.effort, cwd } })
        lines.push({ type: 'response_item', timestamp: ts(t), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: pick(prompts) }] } })
        lines.push(ev(t + dur * 0.5, { type: 'token_count', info: { last_token_usage: { input_tokens: ctx, cached_input_tokens: Math.round(ctx * 0.9), output_tokens: jitter(c.out / 3), reasoning_output_tokens: jitter(c.out / 6) } } }))
        lines.push(ev(t + dur, { type: 'token_count', info: { last_token_usage: { input_tokens: ctx, cached_input_tokens: Math.round(ctx * 0.92), output_tokens: jitter(c.out), reasoning_output_tokens: jitter(c.out / 3) } } }))
        lines.push({ type: 'response_item', timestamp: ts(t + dur), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } })
        lines.push(ev(t + dur + 500, { type: 'task_complete' }))
        t += dur + jitter(300) * 1000
      }
      put(home, `.codex/sessions/${d}/rollout-${d.replace(/\//g, '-')}T10-00-00-${id}.jsonl`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    }
}

export function buildDemoHome(home: string, opts: { tools?: 'all' } = {}): void {
  const all = opts.tools === 'all'
  const ws = '.illithid/workspaces/default'
  put(home, `${ws}/workspace.json`, JSON.stringify({ name: 'default' }, null, 2) + '\n')
  put(home, `${ws}/illithid.json`, JSON.stringify({ version: 1, rules: {}, skills: {}, mcp: {}, agents: {} }, null, 2) + '\n')
  const config = { version: 1, allowRealApply: true, activeWorkspace: 'default', ...(all ? { toolsInUse: [...ALL_TOOLS] } : {}) }
  put(home, '.config/illithid/config.json', JSON.stringify(config, null, 2) + '\n')

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
  if (all) {
    put(home, '.gemini/settings.json', '{}\n')
    mkdirSync(join(home, '.copilot'), { recursive: true })
  }

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
  const codexSession = (id: string, cwd: string, prompt: string, answer: string, ago: number, day: string): void => {
    const lines = [
      { type: 'session_meta', timestamp: iso(ago + 6), payload: { id, cwd, timestamp: iso(ago + 6) } },
      { type: 'event_msg', timestamp: iso(ago + 5), payload: { type: 'user_message', message: prompt } },
      { type: 'response_item', timestamp: iso(ago + 4), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
      { type: 'response_item', timestamp: iso(ago), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] } }
    ]
    put(home, `.codex/sessions/${day}/rollout-${day.replace(/\//g, '-')}T10-00-00-${id}.jsonl`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  if (!all) {
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

    codexSession('3e9c6f41-8d85-4c31-a0ad-5c4f2b1e0d34', '/Users/alex/code/web', 'Migrate the settings page to the new form library', 'Migrated `SettingsForm` to the new form hooks. Validation messages are unchanged; bundle size down 11 KB.', 90, '2026/09/26')
    codexSession('4fad7052-9e96-4d42-b1be-6d503c2f1e45', '/Users/alex/code/infra', 'Write a runbook for rotating the database password', 'Wrote `docs/runbooks/rotate-db-password.md`: create the new user, update the secret, roll the pods, drop the old user.', 2000, '2026/09/25')
    return
  }

  // All tools: several requests per session, "checkout" across Claude, Codex, OpenCode and Gemini (Copilot sessions are not scanned)
  claudeSession('0b6f3c1e-5a52-4f0e-9d7a-2f1c9e8b7a01', '/Users/alex/code/shop-api', 'Speed up checkout endpoint', [
    ['Checkout p95 went over 400ms after the last deploy. Can you find why?', 'The regression comes from `applyCoupons()` in `src/checkout/pricing.ts:88`. It now loads every coupon for the account on each request.\n\nFix: query only active coupons with the account index. Expected p95 back to about 180ms.'],
    ['Query only active coupons and keep the account index.', 'Changed the query in `pricing.ts` to filter on `active = true` and use `coupons_account_id_idx`. Checkout now reads 3 rows instead of 1,200 for the largest account.'],
    ['Add a test for expired coupons.', 'Added `pricing.test.ts` cases for expired, future and active coupons. All 216 tests pass.'],
    ['Run the checkout load test again and compare p95.', 'Checkout p95 is 176 ms (was 412 ms), p99 is 240 ms. Error rate unchanged at 0.02%.']
  ], 20)
  claudeSession('1c7a4d2f-6b63-4a1f-8e8b-3a2d0f9c8b12', '/Users/alex/code/web', 'Fix flaky login e2e test', [
    ['The login e2e test fails about 1 in 5 runs on CI.', 'It clicks "Sign in" before the form finishes hydrating. I switched the test to wait for the `data-ready` attribute. 50 local runs, 0 failures.'],
    ['Check the checkout e2e for the same race.', 'Same pattern in `checkout.spec.ts`: it fills the card form before hydration. Applied the same `data-ready` wait.'],
    ['Run both suites 50 times on CI.', '100 runs, 0 failures. Average suite time went from 4m10s to 4m02s.']
  ], 180)
  claudeSession('2d8b5e30-7c74-4b20-9f9c-4b3e1a0d9c23', '/Users/alex/code/shop-api', 'Add rate limiting to public API', [
    ['Add rate limiting to the public endpoints.', 'Added a token bucket middleware (100 req/min per key) on `/v1/*`, with `Retry-After` on 429.'],
    ['Exclude the checkout webhook from the limit.', 'Excluded `/v1/webhooks/checkout`; it is already authenticated by signature.'],
    ['Document the limits in the API reference.', 'Added a "Rate limits" section to `docs/api.md` with the headers and an example 429 response.']
  ], 1500)

  const codexTurns = (id: string, cwd: string, turns: [string, string][], ago: number, day: string): void => {
    let t = ago + turns.length * 5 + 1
    const lines: unknown[] = [{ type: 'session_meta', timestamp: iso(t), payload: { id, cwd, timestamp: iso(t) } }]
    for (const [u, a] of turns) {
      t -= 1
      lines.push({ type: 'event_msg', timestamp: iso(t), payload: { type: 'user_message', message: u } })
      lines.push({ type: 'response_item', timestamp: iso(t), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: u }] } })
      t -= 4
      lines.push({ type: 'response_item', timestamp: iso(t), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: a }] } })
    }
    put(home, `.codex/sessions/${day}/rollout-${day.replace(/\//g, '-')}T10-00-00-${id}.jsonl`, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  codexTurns('3e9c6f41-8d85-4c31-a0ad-5c4f2b1e0d34', '/Users/alex/code/shop-api', [
    ['Write the migration for the new index on coupons(account_id, active).', 'Added `migrations/0042_coupons_account_active_idx.sql` creating `coupons_account_active_idx`.'],
    ['Create it concurrently so checkout is not blocked.', 'Switched to `CREATE INDEX CONCURRENTLY` and moved it out of the transaction block.'],
    ['Add a rollback step.', 'Added `DROP INDEX CONCURRENTLY IF EXISTS coupons_account_active_idx` to the down migration.']
  ], 60, '2026/09/27')
  codexTurns('4fad7052-9e96-4d42-b1be-6d503c2f1e45', '/Users/alex/code/infra', [
    ['Write a runbook for rotating the database password.', 'Wrote `docs/runbooks/rotate-db-password.md`: create the new user, update the secret, roll the pods, drop the old user.'],
    ['Add a check that the checkout service reconnected.', 'Added step 5: watch `checkout_db_pool_active` and the `/healthz` of `checkout-api` until both are green.'],
    ['Link it from the on-call index.', 'Linked it under "Database" in `docs/runbooks/README.md`.']
  ], 2000, '2026/09/25')

  // OpenCode keeps sessions in SQLite (session / message / part, the tables the scanner reads)
  const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
  if (sqlite) {
    mkdirSync(join(home, '.local/share/opencode'), { recursive: true })
    const db = new sqlite.DatabaseSync(join(home, '.local/share/opencode/opencode.db'))
    db.exec(`create table session (id text primary key, title text, directory text, parent_id text, time_created integer, time_updated integer);
      create table message (id text primary key, session_id text, time_created integer, data text);
      create table part (id text primary key, message_id text, time_created integer, data text);`)
    const ms = (minutesAgo: number): number => Date.now() - minutesAgo * 60_000
    const sid = 'ses_7c21d9a0f3e14b52'
    const turns: [string, string][] = [
      ['The checkout button is hidden under the keyboard on iOS Safari.', 'The footer is `position: fixed; bottom: 0`, which iOS places under the keyboard. The card input keeps focus while the button is covered.'],
      ['Use a sticky footer instead.', 'Changed `CheckoutFooter` to `position: sticky` inside the scroll container and added `env(safe-area-inset-bottom)` padding.'],
      ['Add a screenshot test at 390px width.', 'Added `checkout-footer.visual.ts` at 390x844 with the keyboard open and closed. Baselines committed.']
    ]
    let t = 120 + turns.length * 5
    db.prepare('insert into session values (?, ?, ?, ?, ?, ?)').run(sid, 'Checkout button hidden on iOS', '/Users/alex/code/web', null, ms(t), ms(120))
    const msg = db.prepare('insert into message values (?, ?, ?, ?)')
    const part = db.prepare('insert into part values (?, ?, ?, ?)')
    turns.forEach(([u, a], i) => {
      for (const [role, text, at] of [['user', u, (t -= 1)], ['assistant', a, (t -= 4)]] as const) {
        const mid = `msg_${i}_${role}`
        msg.run(mid, sid, ms(at), JSON.stringify({ role, time: { created: ms(at) } }))
        part.run(`prt_${i}_${role}`, mid, ms(at), JSON.stringify({ type: 'text', text }))
      }
    })
    db.close()
  }

  const gid = '5a0b8163-af07-4e53-82cf-7e614d3a2f56'
  const gTurns: [string, string][] = [
    ['Add idempotency keys to the checkout webhook handler.', 'Added an `Idempotency-Key` check in `src/webhooks/checkout.ts`. Duplicate deliveries now return the stored response instead of charging twice.'],
    ['Store the responses for 24 hours.', 'Responses go to the `webhook_responses` table with a 24 h TTL, cleaned by the nightly job.'],
    ['Write a test for duplicate deliveries.', 'Added `checkout-webhook.test.ts`: the same event sent twice charges once and returns identical bodies.']
  ]
  let gt = 45 + gTurns.length * 5
  const gHeader = { sessionId: gid, projectHash: 'c0ffee5e7a1d', startTime: iso(gt), lastUpdated: iso(45), kind: 'main' }
  const gMsgs = gTurns.flatMap(([u, a], i) => [
    { id: `u${i}`, timestamp: iso((gt -= 1)), type: 'user', content: [{ text: u }] },
    { id: `g${i}`, timestamp: iso((gt -= 4)), type: 'gemini', content: [{ text: a }] }
  ])
  put(home, '.gemini/tmp/shop-api/.project_root', '/Users/alex/code/shop-api\n')
  put(home, `.gemini/tmp/shop-api/chats/session-${gHeader.startTime.slice(0, 16).replace(':', '-')}-${gid.slice(0, 8)}.jsonl`, [gHeader, ...gMsgs].map((l) => JSON.stringify(l)).join('\n') + '\n')
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
  if (menu === 'agents') {
    await pick('reviewer')
    // Scroll the detail so every per-tool card (the last one is GitHub Copilot) fits in the 800px window
    const last = page.getByText('GitHub Copilot', { exact: true }).last()
    if (await last.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
      await last.evaluate((el) => {
        const card = el.closest('.ac-card') ?? el
        card.scrollIntoView({ block: 'end' })
      })
      await page.waitForTimeout(200)
    }
  } else if (menu === 'rules') await pick('20-git.md')
  else if (menu === 'skills') await pick('code-review')
  else if (menu === 'mcp') await pick('playwright')
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
  buildDemoHome(home, process.env.SHOTS_TOOLS === 'all' ? { tools: 'all' } : {})
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

// Only run when executed directly (readme-demo.ts imports the demo HOME builder)
if (require.main === module)
  main().catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
