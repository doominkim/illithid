import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Collector, readClaude, type HookRun } from '../src/engine/scan/transcript'
import { openDb, searchIndexPath } from '../src/engine/search/sessionIndex'
import { ensureUsage, hookName, hookUsage, UsageCounter } from '../src/engine/search/usage'

const ORCA =
  'if [ -z "${HOME-}" ]; then printf \'{}\\n\'; fi; ORCA_AGENT_HOOK_PORT=1 /bin/sh "$HOME/.orca/agent-hooks/claude-hook.sh"'

test('a hook is named after its library folder, its script, or its first word', () => {
  assert.equal(
    hookName("'/Users/me/.claude/hooks/illithid/check-destructive/run.sh' claude"),
    'check-destructive'
  )
  assert.equal(hookName(ORCA), 'orca · claude-hook.sh')
  assert.equal(hookName('node /Users/me/tools/guard.mjs --strict'), 'guard.mjs')
  assert.equal(hookName('/Users/me/hooks/notify/run.sh'), 'notify')
  assert.equal(hookName('osascript -e "display notification"'), 'osascript')
  assert.equal(hookName(''), 'hook')
})

test('naming a very long inline hook stays fast', () => {
  const long = 'x'.repeat(200_000) + ' "a b c ' + '; '.repeat(50_000)
  const t = Date.now()
  hookName(long)
  assert.ok(Date.now() - t < 200)
})

test('readClaude reports each hook run with name, event, outcome and duration only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'illithid-hook-runs-'))
  const file = join(dir, 's.jsonl')
  const att = (a: Record<string, unknown>, at: string): string =>
    JSON.stringify({ type: 'attachment', timestamp: at, attachment: a })
  writeFileSync(
    file,
    [
      att(
        {
          type: 'hook_success',
          hookEvent: 'PreToolUse',
          hookName: 'PreToolUse:Bash',
          command: "'/h/.claude/hooks/illithid/check-destructive/run.sh' claude",
          exitCode: 0,
          durationMs: 120,
          stdout: 'SECRET-STDOUT',
          stderr: ''
        },
        '2026-10-20T01:00:00Z'
      ),
      att(
        {
          type: 'hook_cancelled',
          hookEvent: 'PreToolUse',
          command: "'/h/.claude/hooks/illithid/check-destructive/run.sh' claude",
          timedOut: true,
          timeoutMs: 5000,
          durationMs: 5030
        },
        '2026-10-20T01:01:00Z'
      ),
      att(
        { type: 'hook_success', hookEvent: 'Stop', command: ORCA, exitCode: 2, durationMs: 15 },
        '2026-10-20T01:02:00Z'
      ),
      att(
        {
          type: 'hook_non_blocking_error',
          hookEvent: 'PostToolUse',
          command: '/h/n/run.sh',
          durationMs: 9
        },
        '2026-10-20T01:03:00Z'
      ),
      att(
        { type: 'hook_additional_context', hookEvent: 'SessionStart', content: ['ctx'] },
        '2026-10-20T01:04:00Z'
      )
    ].join('\n')
  )
  const runs: HookRun[] = []
  const c = new Collector()
  c.onHook = (h) => runs.push(h)
  await readClaude(file, c)
  assert.deepEqual(runs, [
    {
      name: 'check-destructive',
      event: 'PreToolUse',
      outcome: 'ok',
      ms: 120,
      at: '2026-10-20T01:00:00.000Z'
    },
    {
      name: 'check-destructive',
      event: 'PreToolUse',
      outcome: 'timeout',
      ms: 5030,
      at: '2026-10-20T01:01:00.000Z'
    },
    {
      name: 'orca · claude-hook.sh',
      event: 'Stop',
      outcome: 'fail',
      ms: 15,
      at: '2026-10-20T01:02:00.000Z'
    },
    { name: 'n', event: 'PostToolUse', outcome: 'error', ms: 9, at: '2026-10-20T01:03:00.000Z' }
  ])
  assert.ok(!JSON.stringify(runs).includes('SECRET-STDOUT'))
})

const NOW = Date.parse('2026-10-23T12:00:00')

test('hook usage sums runs per hook with outcomes and average duration over the period', () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-hook-usage-'))
  const counter = new UsageCounter('claude')
  const run = (
    name: string,
    event: string,
    outcome: HookRun['outcome'],
    ms: number,
    at: string
  ): void => counter.addHook({ name, event, outcome, ms, at })
  run('check-destructive', 'PreToolUse', 'ok', 100, '2026-10-22T03:00:00')
  run('check-destructive', 'PreToolUse', 'ok', 300, '2026-10-22T04:00:00')
  run('check-destructive', 'PreToolUse', 'timeout', 5000, '2026-10-21T03:00:00')
  run('orca · claude-hook.sh', 'Stop', 'ok', 10, '2026-10-20T03:00:00')
  run('orca · claude-hook.sh', 'PostToolUse', 'ok', 30, '2026-10-20T03:00:00')
  run('old-hook', 'Stop', 'ok', 10, '2026-08-01T03:00:00') // outside 30 days
  const db = openDb(searchIndexPath(home))
  ensureUsage(db)
  const ins = db.prepare(
    'insert into usage(sid, tool, kind, name, item, model, day, n, outcome, ms) values (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const r of counter.rows.values())
    ins.run('claude', r.kind, r.name, r.item, r.model, r.day, r.n, r.outcome, r.ms)
  db.close()

  assert.deepEqual(hookUsage(home, { now: NOW }), [
    {
      name: 'check-destructive',
      events: ['PreToolUse'],
      runs: 3,
      ok: 2,
      fail: 0,
      timeout: 1,
      error: 0,
      avgMs: 1800,
      lastDay: '2026-10-22'
    },
    {
      name: 'orca · claude-hook.sh',
      events: ['PostToolUse', 'Stop'],
      runs: 2,
      ok: 2,
      fail: 0,
      timeout: 0,
      error: 0,
      avgMs: 20,
      lastDay: '2026-10-20'
    }
  ])
})
