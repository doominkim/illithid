/**
 * Model stats fixture check. Never touches the real home.
 *
 * Builds a fake HOME with one Claude session (plus a subagent), one Codex session and one OpenCode session, indexes it and
 * checks turns, tokens, tool errors by kind, requests, interrupts, subagents, effort, limits, cost, schema reset and removal.
 * Prints PASS/FAIL per step and exits 1 if any step fails.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { scanSessions } from '../src/engine/scan/sessions'
import { modelDetail, modelList, sessionModels } from '../src/engine/search/modelStats'
import { indexSessions, metaSet, openDb, searchIndexPath } from '../src/engine/search/sessionIndex'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const home = mkdtempSync(join(tmpdir(), 'illithid-model-stats-'))
const put = (rel: string, body: string): void => {
  const p = join(home, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
}
const jsonl = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
const T0 = Date.parse('2026-09-20T10:00:00Z')
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString()

// ---------------------------------------------------------------- Claude
const CL = 'aaaaaaaa-1111-4111-8111-111111111111'
const cwd = '/Users/alex/code/shop-api'
const cl = (o: Record<string, unknown>): Record<string, unknown> => ({ sessionId: CL, cwd, ...o })
put(
  `.claude/projects/-Users-alex-code-shop-api/${CL}.jsonl`,
  jsonl([
    cl({
      type: 'user',
      timestamp: at(0),
      message: { role: 'user', content: 'Fix the coupon query' }
    }),
    // One API response streamed as two lines with the same id: 1 turn, 2 tool calls
    cl({
      type: 'assistant',
      timestamp: at(5),
      effort: 'medium',
      perTurnEffort: 'medium',
      message: {
        id: 'm1',
        role: 'assistant',
        model: 'claude-opus-5-5-20260901',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 100,
          output_tokens: 50,
          output_tokens_details: { thinking_tokens: 12 }
        },
        content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: {} }]
      }
    }),
    cl({
      type: 'assistant',
      timestamp: at(6),
      effort: 'medium',
      perTurnEffort: 'medium',
      message: {
        id: 'm1',
        role: 'assistant',
        model: 'claude-opus-5-5-20260901',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 100,
          output_tokens: 50,
          output_tokens_details: { thinking_tokens: 12 }
        },
        content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }]
      }
    }),
    cl({
      type: 'user',
      timestamp: at(8),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            is_error: true,
            content: 'String to replace not found in file.'
          },
          {
            type: 'tool_result',
            tool_use_id: 't2',
            is_error: true,
            content: 'Exit code 1\nnpm test failed'
          }
        ]
      }
    }),
    cl({
      type: 'assistant',
      timestamp: at(60),
      effort: 'medium',
      message: {
        id: 'm2',
        role: 'assistant',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 5, cache_read_input_tokens: 2000, output_tokens: 20 },
        content: [{ type: 'text', text: 'Done.' }]
      }
    }),
    cl({ type: 'user', timestamp: at(120), message: { role: 'user', content: 'Now add a test' } }),
    cl({
      type: 'assistant',
      timestamp: at(125),
      message: {
        id: 'm3',
        role: 'assistant',
        model: '<synthetic>',
        usage: { output_tokens: 0 },
        content: [{ type: 'text', text: 'x' }]
      }
    }),
    cl({
      type: 'user',
      timestamp: at(130),
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }
    }),
    cl({
      type: 'user',
      timestamp: at(200),
      message: { role: 'user', content: 'Think harder about the index' }
    }),
    cl({
      type: 'assistant',
      timestamp: at(260),
      perTurnEffort: 'high',
      effort: 'high',
      message: {
        id: 'm4',
        role: 'assistant',
        model: 'claude-opus-5-5',
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 3000,
          output_tokens: 90,
          output_tokens_details: { thinking_tokens: 40 }
        },
        content: [{ type: 'text', text: 'Use a partial index.' }]
      }
    })
  ])
)
put(
  `.claude/projects/-Users-alex-code-shop-api/${CL}/subagents/agent-1.jsonl`,
  jsonl([
    {
      type: 'assistant',
      isSidechain: true,
      timestamp: at(30),
      message: {
        id: 's1',
        role: 'assistant',
        model: 'claude-sonnet-5',
        usage: { input_tokens: 3, output_tokens: 5 },
        content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: {} }]
      }
    }
  ])
)

// ---------------------------------------------------------------- Codex
const CX = 'bbbbbbbb-2222-4222-8222-222222222222'
const ev = (sec: number, payload: Record<string, unknown>): Record<string, unknown> => ({
  type: 'event_msg',
  timestamp: at(sec),
  payload
})
const tokens = (
  input: number,
  cached: number,
  output: number,
  reasoning: number
): Record<string, unknown> => ({
  type: 'token_count',
  info: {
    last_token_usage: {
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: output,
      reasoning_output_tokens: reasoning
    }
  },
  rate_limits: { primary: { used_percent: 12, window_minutes: 10080 }, plan_type: 'prolite' }
})
put(
  `.codex/sessions/2026/09/20/rollout-2026-09-20T10-00-00-${CX}.jsonl`,
  jsonl([
    {
      type: 'session_meta',
      timestamp: at(0),
      payload: { id: CX, cwd: '/Users/alex/code/web', timestamp: at(0) }
    },
    ev(0, { type: 'task_started' }),
    {
      type: 'turn_context',
      timestamp: at(0),
      payload: { model: 'gpt-5.6-sol', effort: 'high', cwd: '/Users/alex/code/web' }
    },
    {
      type: 'response_item',
      timestamp: at(1),
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Why is the build red?' }]
      }
    },
    ev(5, tokens(1000, 800, 30, 10)),
    {
      type: 'response_item',
      timestamp: at(6),
      payload: {
        type: 'function_call',
        name: 'exec',
        call_id: 'c1',
        arguments: '{"cmd":"npm run build"}'
      }
    },
    {
      type: 'response_item',
      timestamp: at(12),
      payload: {
        type: 'function_call_output',
        call_id: 'c1',
        output: 'Exit code: 2\nWall time: 3s'
      }
    },
    ev(20, tokens(1200, 1000, 40, 0)),
    {
      type: 'response_item',
      timestamp: at(21),
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'A type error.' }]
      }
    },
    ev(30, { type: 'task_complete' }),
    ev(60, { type: 'task_started' }),
    {
      type: 'turn_context',
      timestamp: at(60),
      payload: { model: 'gpt-5.6-sol', effort: 'medium' }
    },
    {
      type: 'response_item',
      timestamp: at(61),
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Try again' }]
      }
    },
    ev(70, tokens(500, 0, 5, 0)),
    ev(80, { type: 'turn_aborted' })
  ])
)

// ---------------------------------------------------------------- OpenCode
function opencodeDb(): void {
  const path = join(home, '.local/share/opencode/opencode.db')
  mkdirSync(dirname(path), { recursive: true })
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
    DatabaseSync: new (p: string) => DatabaseSync
  }
  const db = new DatabaseSync(path)
  db.exec(`
    create table session(id text primary key, project_id text, parent_id text, slug text, directory text, title text, version text, time_created integer, time_updated integer);
    create table message(id text primary key, session_id text, time_created integer, time_updated integer, data text);
    create table part(id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
  `)
  const ms = (sec: number): number => T0 + sec * 1000
  db.prepare('insert into session values (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'ses_1',
    'p',
    null,
    's',
    '/Users/alex/code/cli',
    'Refactor flags',
    '1',
    ms(0),
    ms(40)
  )
  const msg = db.prepare('insert into message values (?, ?, ?, ?, ?)')
  const part = db.prepare('insert into part values (?, ?, ?, ?, ?, ?)')
  msg.run(
    'msg_u',
    'ses_1',
    ms(0),
    ms(0),
    JSON.stringify({ role: 'user', time: { created: ms(0) } })
  )
  part.run(
    'prt_u',
    'msg_u',
    'ses_1',
    ms(0),
    ms(0),
    JSON.stringify({ type: 'text', text: 'Refactor the flag parser' })
  )
  msg.run(
    'msg_a',
    'ses_1',
    ms(2),
    ms(40),
    JSON.stringify({
      role: 'assistant',
      modelID: 'glm-5.3-flash',
      cost: 0.0123,
      tokens: { input: 300, output: 60, reasoning: 7, cache: { read: 900, write: 0 } },
      time: { created: ms(2), completed: ms(40) }
    })
  )
  part.run(
    'prt_t',
    'msg_a',
    'ses_1',
    ms(3),
    ms(3),
    JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'error', input: {} } })
  )
  db.close()
}
opencodeDb()

async function main(): Promise<void> {
  const run = async (): Promise<void> => {
    const { sessions } = scanSessions(home)
    await indexSessions(home, sessions)
  }
  await run()
  const list = modelList(home) ?? []
  const find = (tool: string, model: string, effort = ''): (typeof list)[number] | undefined =>
    list.find((m) => m.tool === tool && m.model === model && m.effort === effort)

  const opus = find('claude', 'claude-opus-5-5', 'medium')
  const opusHigh = find('claude', 'claude-opus-5-5', 'high')
  check(
    'claude: effort from perTurnEffort and older effort field',
    opus?.turns === 2 && opusHigh?.turns === 1,
    `medium ${opus?.turns} high ${opusHigh?.turns}`
  )
  check(
    'claude: thinking tokens as reasoning',
    opus?.tokens.reasoning === 12 && opusHigh?.tokens.reasoning === 40,
    `${opus?.tokens.reasoning}/${opusHigh?.tokens.reasoning}`
  )
  check('claude: request at the new effort', opusHigh?.requests === 1, `${opusHigh?.requests}`)
  check(
    'claude: dated id merged, streamed lines = 1 turn',
    opus?.turns === 2,
    `turns ${opus?.turns}`
  )
  check('claude: <synthetic> dropped', !list.some((m) => m.model.includes('synthetic')))
  check('claude: 2 tool calls', opus?.toolCalls === 2, `${opus?.toolCalls}`)
  check(
    'claude: errors by kind (mistake 1, command 1)',
    opus?.errors.mistake === 1 && opus?.errors.command === 1,
    JSON.stringify(opus?.errors)
  )
  check('claude: interrupt counted', opus?.interrupts === 1, `${opus?.interrupts}`)
  check(
    'claude: tokens (input excludes cache)',
    opus?.tokens.input === 15 &&
      opus?.tokens.cacheRead === 3000 &&
      opus?.tokens.cacheWrite === 100 &&
      opus?.tokens.output === 70,
    JSON.stringify(opus?.tokens)
  )
  check(
    'claude: main session 1, interrupted request has no duration',
    opus?.sessions === 1 && opus?.requests === 1,
    `sessions ${opus?.sessions} requests ${opus?.requests}`
  )
  const sonnet = find('claude', 'claude-sonnet-5')
  check(
    'claude: subagent kept apart',
    sonnet?.subagentSessions === 1 && sonnet?.sessions === 0 && sonnet?.turns === 1,
    JSON.stringify({ sub: sonnet?.subagentSessions, sessions: sonnet?.sessions })
  )

  const d = modelDetail(home, { tool: 'claude', model: 'claude-opus-5-5', effort: 'medium' })
  check(
    'claude: request below sample size shows no distribution',
    d?.dist.responseSec === null && d?.summary.median.responseSec === null
  )
  check(
    'claude: context per turn',
    d?.dist.contextPerTurn?.n === 2 && d?.dist.contextPerTurn?.max === 2005,
    JSON.stringify(d?.dist.contextPerTurn)
  )
  check(
    'claude: tool table with errors',
    d?.tools.find((t) => t.name === 'Edit')?.errors === 1,
    JSON.stringify(d?.tools)
  )
  check(
    'claude: session list has the session with its title',
    d?.sessions[0]?.id === CL && d?.sessions[0]?.title === 'Fix the coupon query',
    JSON.stringify(d?.sessions[0])
  )

  const high = find('codex', 'gpt-5.6-sol', 'high')
  const medium = find('codex', 'gpt-5.6-sol', 'medium')
  check('codex: effort kept apart', !!high && !!medium)
  check(
    'codex: turns = token_count events',
    high?.turns === 2 && medium?.turns === 1,
    `${high?.turns}/${medium?.turns}`
  )
  check(
    'codex: cached input subtracted',
    high?.tokens.input === 400 && high?.tokens.cacheRead === 1800 && high?.tokens.reasoning === 10,
    JSON.stringify(high?.tokens)
  )
  check(
    'codex: exit code → command error',
    high?.errors.command === 1 && high?.errors.mistake === 0,
    JSON.stringify(high?.errors)
  )
  check(
    'codex: task_started..task_complete is one request',
    high?.requests === 1,
    `${high?.requests}`
  )
  check(
    'codex: turn_aborted = interrupt, no request',
    medium?.interrupts === 1 && medium?.requests === 0,
    JSON.stringify({ i: medium?.interrupts, r: medium?.requests })
  )
  const cd = modelDetail(home, { tool: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
  check(
    'codex: limits (account-wide)',
    cd?.limits.length === 1 && cd?.limits[0].usedPercent === 12 && cd?.limits[0].plan === 'prolite',
    JSON.stringify(cd?.limits)
  )

  const glm = find('opencode', 'glm-5.3-flash')
  check(
    'opencode: tokens, cost, tool error',
    glm?.tokens.output === 60 && glm?.cost === 0.0123 && glm?.errors.other === 1,
    JSON.stringify({ t: glm?.tokens, c: glm?.cost, e: glm?.errors })
  )
  check(
    'REQ-MODEL-EFFICIENCY-3 OpenCode recorded cost takes priority without a matching price',
    glm?.pricing?.source === 'recorded' && glm.pricing.total === 0.0123
  )
  check(
    'REQ-MODEL-EFFICIENCY-4 daily converted costs reflect token totals',
    !!d?.costDaily?.length &&
      Math.abs((d.costDaily[0].cost ?? 0) - (d.summary.pricing?.total ?? 0)) < 1e-10
  )
  check('opencode: request ends at completion', glm?.requests === 1, `${glm?.requests}`)

  const shares = sessionModels(home, 'claude', CL) ?? []
  check(
    'session models by model and effort, subagent included',
    shares.length === 3 && shares[0].effort === 'medium' && Math.abs(shares[0].share - 0.5) < 0.01,
    JSON.stringify(shares)
  )

  check(
    'range filter (days) excludes old days',
    (modelList(home, { days: 1, now: Date.parse('2026-12-01T12:00:00Z') }) ?? []).length === 0
  )

  // Schema change → every session read again
  const db = openDb(searchIndexPath(home))
  metaSet(db, 'modelSchema', '0')
  db.close()
  await run()
  check(
    'schema change rebuilds model tables',
    find('claude', 'claude-opus-5-5', 'medium')?.turns === 2 &&
      (modelList(home) ?? []).length === list.length
  )

  // Removed session → its rows go
  rmSync(join(home, `.codex/sessions/2026/09/20/rollout-2026-09-20T10-00-00-${CX}.jsonl`))
  await run()
  check('removed session drops its rows', !(modelList(home) ?? []).some((m) => m.tool === 'codex'))
}

main()
  .catch((e) => {
    failures++
    console.error(e)
  })
  .finally(() => {
    rmSync(home, { recursive: true, force: true })
    if (failures) {
      console.log(`\n${failures} failed`)
      process.exit(1)
    }
    console.log('\nall passed')
  })
