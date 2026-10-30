import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readSessionTranscript, scanSessions } from '../src/engine'
import { Collector, readOmp, type TurnUsage } from '../src/engine/scan/transcript'
import { modelList } from '../src/engine/search/modelStats'
import { indexSessions } from '../src/engine/search/sessionIndex'
import { classify, mcpToolNames, usageSummaries } from '../src/engine/search/usage'

const ID = '01a189e9-ddbe-7000-800a-e7444634aca9'
const LEGACY_ID = '01a0eaaf-4719-7000-baf7-08f31c74fc4b'
const CWD = '/Users/alex/code/shop-api'
const T = (s: number): string => new Date(Date.UTC(2026, 9, 6, 9, 0, s)).toISOString()
const NOW = Date.UTC(2026, 9, 7, 12)
const DIR = '.omp/agent/sessions/-code-shop-api'
const FILE = `2026-10-06T09-00-00-000Z_${ID}.jsonl`

/** Line 1 of an omp session: the fixed-width (256 bytes with the newline) title slot */
function titleSlot(title: string): string {
  const bare = JSON.stringify({ type: 'title', v: 1, title, updatedAt: T(0), pad: '' })
  return JSON.stringify({
    type: 'title',
    v: 1,
    title,
    updatedAt: T(0),
    pad: ' '.repeat(255 - Buffer.byteLength(bare))
  })
}

const usage = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  cost: number
): unknown => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost }
})

const entry = (id: string, parentId: string | null, s: number, rest: object): object => ({
  id,
  parentId,
  timestamp: T(s),
  ...rest
})
const user = (id: string, parentId: string, s: number, text: string): object =>
  entry(id, parentId, s, {
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 }
  })
const assistant = (
  id: string,
  parentId: string,
  s: number,
  model: string,
  content: object[],
  u: unknown,
  stopReason = 'stop'
): object =>
  entry(id, parentId, s, {
    type: 'message',
    message: {
      role: 'assistant',
      content,
      api: 'anthropic-messages',
      provider: 'anthropic',
      model,
      usage: u,
      stopReason,
      timestamp: 0
    }
  })
const toolResult = (
  id: string,
  parentId: string,
  s: number,
  callId: string,
  name: string,
  text: string,
  isError: boolean
): object =>
  entry(id, parentId, s, {
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId: callId,
      toolName: name,
      content: [{ type: 'text', text }],
      isError,
      timestamp: 0
    }
  })
const call = (id: string, name: string, args: object): object => ({
  type: 'toolCall',
  id,
  name,
  arguments: args
})

/**
 * One omp project folder: a session with a rewound branch (e6/e7), a tool error, skill and MCP calls and a subagent
 * transcript (plus a tool log) in its folder; and a legacy session without a title slot
 */
function ompHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-omp-sessions-'))
  const dir = join(home, DIR)
  const sub = join(dir, FILE.replace(/\.jsonl$/, ''))
  mkdirSync(sub, { recursive: true })
  const main = [
    titleSlot('Checkout fix'),
    JSON.stringify({
      type: 'session',
      version: 3,
      id: ID,
      timestamp: T(0),
      cwd: CWD,
      title: 'Header title'
    }),
    ...[
      entry('e1', null, 0, { type: 'model_change', model: 'anthropic/claude-opus-5-5' }),
      entry('e2', 'e1', 0, { type: 'thinking_level_change', thinkingLevel: 'high' }),
      user('e3', 'e2', 1, 'Fix the failing checkout test'),
      assistant(
        'e4',
        'e3',
        3,
        'claude-opus-5-5',
        [
          { type: 'thinking', thinking: 'secret plan' },
          { type: 'text', text: 'Running the tests first.' },
          call('c1', 'bash', { command: 'npm test' })
        ],
        usage(10, 100, 1000, 200, 0.05),
        'toolUse'
      ),
      toolResult('e5', 'e4', 4, 'c1', 'bash', 'Command failed: exit code 1', true),
      // Rewound: the next entries branch from e5 again
      user('e6', 'e5', 5, 'Abandoned idea'),
      assistant(
        'e7',
        'e6',
        6,
        'claude-opus-5-5',
        [{ type: 'text', text: 'Rewound answer' }],
        usage(1, 1, 0, 0, 0.5)
      ),
      entry('e8', 'e5', 7, { type: 'branch_summary', fromId: 'e5', summary: 'Abandoned idea' }),
      user('e9', 'e8', 8, 'Use the skill and the docs server'),
      assistant(
        'e10',
        'e9',
        10,
        'claude-opus-5-5',
        [
          call('c2', 'read', { path: 'skill://code-review' }),
          call('c3', 'mcp__docs_server_query', { query: 'checkout' }),
          call('c4', 'task', { agent: 'reviewer' })
        ],
        usage(20, 50, 0, 0, 0.01),
        'toolUse'
      ),
      toolResult('e11', 'e10', 11, 'c2', 'read', '---\nname: code-review', false),
      toolResult('e12', 'e11', 12, 'c3', 'mcp__docs_server_query', 'ok', false),
      toolResult('e13', 'e12', 13, 'c4', 'task', 'reviewed', false),
      entry('e14', 'e13', 14, { type: 'title_change', title: 'Renamed later', source: 'user' }),
      assistant(
        'e15',
        'e14',
        16,
        'claude-opus-5-5',
        [{ type: 'text', text: 'Done.' }],
        usage(5, 20, 0, 0, 0.02)
      ),
      user('e16', 'e15', 17, 'Stop there'),
      assistant('e17', 'e16', 18, 'claude-opus-5-5', [], usage(5, 0, 0, 0, 0), 'aborted')
    ].map((e) => JSON.stringify(e))
  ]
  writeFileSync(join(dir, FILE), main.join('\n') + '\n')
  const subagent = [
    titleSlot(''),
    JSON.stringify({
      type: 'session',
      version: 3,
      id: '01a189f6-19f6-7000-b9d8-5366f1d56a86',
      timestamp: T(12),
      cwd: CWD,
      parentSession: join(dir, FILE)
    }),
    ...[
      entry('s1', null, 12, { type: 'session_init', task: 'review' }),
      entry('s2', 's1', 12, {
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Review the fix' }],
          attribution: 'agent',
          timestamp: 0
        }
      }),
      assistant(
        's3',
        's2',
        13,
        'gpt-5.5',
        [call('d1', 'mcp__Docs--Server__lookup', { id: 'x' })],
        usage(30, 40, 0, 0, 0.03),
        'toolUse'
      ),
      toolResult('s4', 's3', 13, 'd1', 'mcp__docs_server_lookup', 'Permission denied', true),
      assistant(
        's5',
        's4',
        13,
        'gpt-5.5',
        [{ type: 'text', text: 'Looks fine' }],
        usage(30, 10, 0, 0, 0.01)
      )
    ].map((e) => JSON.stringify(e))
  ]
  writeFileSync(join(sub, 'Reviewer.jsonl'), subagent.join('\n') + '\n')
  writeFileSync(join(sub, '4.read.log'), 'log\n')
  writeFileSync(join(sub, 'Reviewer.md'), 'reviewed\n')

  const legacyDir = join(home, '.omp/agent/sessions/--private-tmp--')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(
    join(legacyDir, `2026-10-05T09-00-00-000Z_${LEGACY_ID}.jsonl`),
    [
      { type: 'session', version: 3, id: LEGACY_ID, timestamp: T(0), cwd: '/private/tmp' },
      user('l1', null as unknown as string, 1, 'Legacy question')
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n'
  )
  return home
}

test('omp sessions are listed from ~/.omp/agent/sessions/*, without subagent transcripts', () => {
  const home = ompHome()
  const { sessions, errors } = scanSessions(home, ['omp'])
  assert.deepEqual(errors, [])
  assert.deepEqual(sessions.map((s) => s.id).sort(), [LEGACY_ID, ID].sort())
  const s = sessions.find((x) => x.id === ID)!
  assert.equal(s.tool, 'omp')
  // The title slot wins over the header title and logged renames
  assert.equal(s.title, 'Checkout fix')
  assert.equal(s.cwd, CWD)
  assert.equal(s.project, 'shop-api')
  assert.equal(s.startedAt, T(0))
  assert.equal(s.updatedAt, T(18))
  // Active branch only: 3 user and 4 assistant messages (the rewound pair is not counted)
  assert.equal(s.messageCount, 7)
  // fast-glob returns forward slashes on Windows, like every other session scanner
  assert.equal(resolve(s.path), join(home, DIR, FILE))
  assert.equal(s.resumeCommand, `omp --resume ${ID}`)
  // A legacy file without the title slot falls back to the first user prompt
  assert.equal(sessions.find((x) => x.id === LEGACY_ID)!.title, 'Legacy question')
})

test('omp transcript follows the active branch and skips thinking and rewound entries', async () => {
  const home = ompHome()
  const t = await readSessionTranscript(home, 'omp', ID)
  const texts = t.messages.map((m) => `${m.role}:${m.kind ?? 'text'}:${m.text}`)
  assert.deepEqual(texts, [
    'user:text:Fix the failing checkout test',
    'assistant:text:Running the tests first.',
    'assistant:tool:bash: npm test',
    'user:text:Use the skill and the docs server',
    'assistant:tool:read: skill://code-review',
    'assistant:tool:mcp__docs_server_query: checkout',
    'assistant:tool:task',
    'assistant:text:Done.',
    'user:text:Stop there'
  ])
  await assert.rejects(readSessionTranscript(home, 'omp', '../etc'), /not found/)
})

test('omp model stats: usage tokens, recorded cost, thinking level, tool errors and interrupts', async () => {
  const home = ompHome()
  const turns: { model?: string; effort?: string; usage: TurnUsage; cost?: number }[] = []
  const errors: { name?: string; kind: string }[] = []
  const prompts: (string | undefined)[] = []
  const interrupts: (string | undefined)[] = []
  const calls: string[] = []
  const c = new Collector()
  c.onCall = (x) => calls.push(`${x.model}:${x.name}`)
  c.stats = {
    turn: (x) => turns.push({ model: x.model, effort: x.effort, usage: x.usage, cost: x.cost }),
    toolError: (e) => errors.push({ name: e.name, kind: e.kind }),
    prompt: (at) => prompts.push(at),
    interrupt: (at) => interrupts.push(at),
    requestEnd: () => {},
    limits: () => {}
  }
  await readOmp(join(home, DIR, FILE), c)
  const m = 'claude-opus-5-5'
  assert.deepEqual(turns, [
    {
      model: m,
      effort: 'high',
      usage: { input: 10, cacheRead: 1000, cacheWrite: 200, output: 100, reasoning: 0 },
      cost: 0.05
    },
    {
      model: m,
      effort: 'high',
      usage: { input: 20, cacheRead: 0, cacheWrite: 0, output: 50, reasoning: 0 },
      cost: 0.01
    },
    {
      model: m,
      effort: 'high',
      usage: { input: 5, cacheRead: 0, cacheWrite: 0, output: 20, reasoning: 0 },
      cost: 0.02
    },
    {
      model: m,
      effort: 'high',
      usage: { input: 5, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      cost: 0
    }
  ])
  assert.deepEqual(errors, [{ name: 'bash', kind: 'command' }])
  assert.deepEqual(prompts, [T(1), T(8), T(17)])
  assert.deepEqual(interrupts, [T(18)])
  assert.deepEqual(calls, [`${m}:bash`, `${m}:read`, `${m}:mcp__docs_server_query`, `${m}:task`])
})

test('omp index: subagent transcripts feed model, skill and MCP usage; cost is the recorded one', async () => {
  const home = ompHome()
  const dbPath = join(home, 'search.sqlite')
  const { sessions } = scanSessions(home, ['omp'])
  await indexSessions(home, sessions, { dbPath })

  const models = modelList(home, { dbPath })!
  const opus = models.find((x) => x.tool === 'omp' && x.model === 'claude-opus-5-5')!
  assert.equal(opus.effort, 'high')
  assert.equal(opus.turns, 4)
  assert.equal(opus.tokens.cacheRead, 1000)
  assert.equal(opus.cost, 0.08)
  assert.equal(opus.pricing?.source, 'recorded')
  assert.equal(opus.errors.command, 1)
  assert.equal(opus.interrupts, 1)
  const gpt = models.find((x) => x.tool === 'omp' && x.model === 'gpt-5.5')!
  assert.equal(gpt.subagentSessions, 1)
  assert.equal(gpt.turns, 2)
  assert.equal(gpt.cost, 0.04)
  assert.equal(gpt.errors.policy, 1)

  const skills = usageSummaries(home, 'skill', ['code-review'], { dbPath, now: NOW })!
  assert.equal(skills['code-review'].recent, 1)
  // The server as configured; omp sanitized it to docs_server in both the main and the subagent call
  const mcp = usageSummaries(home, 'mcp', ['Docs--Server'], { dbPath, now: NOW })!
  assert.equal(mcp['Docs--Server'].recent, 2)
  assert.deepEqual(mcpToolNames(home, 'Docs--Server', { dbPath }), ['lookup', 'query'])
})

test('omp usage: skill:// reads and mcp__<server>_<tool> calls', () => {
  const skill = (path: string): unknown => classify('omp', { name: 'read', input: { path } })
  assert.deepEqual(skill('skill://code-review'), [{ kind: 'skill', name: 'code-review' }])
  assert.deepEqual(skill('skill://code-review/SKILL.md'), [{ kind: 'skill', name: 'code-review' }])
  assert.deepEqual(skill('skill://code-review:1-40'), [{ kind: 'skill', name: 'code-review' }])
  // Other files of a skill, namespaced plugin skills and plain files are not skill uses
  assert.deepEqual(skill('skill://code-review/references/a.md'), [])
  assert.deepEqual(skill('skill://plugin:code-review'), [])
  assert.deepEqual(skill('src/skills/code-review/SKILL.md'), [])
  assert.deepEqual(classify('omp', { name: 'mcp__context7_query_docs', input: {} }), [
    { kind: 'mcpRaw', name: 'context7_query_docs' }
  ])
  assert.deepEqual(classify('omp', { name: 'mcp__Context7__query-docs', input: {} }), [
    { kind: 'mcpRaw', name: 'context7_query_docs' }
  ])
  assert.deepEqual(classify('omp', { name: 'bash', input: { command: 'cat skill://x' } }), [])
})
