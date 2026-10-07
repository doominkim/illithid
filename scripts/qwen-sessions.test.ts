import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionTranscript, scanSessions } from '../src/engine'
import { Collector, readQwen, type TurnUsage } from '../src/engine/scan/transcript'
import { classify } from '../src/engine/search/usage'

const ID = '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f'
const CWD = '/Users/alex/code/shop-api'
const T = (s: number): string => new Date(Date.UTC(2026, 9, 6, 9, 0, s)).toISOString()
const base = { sessionId: ID, cwd: CWD, version: '0.25.0' }
const usage = (prompt: number, cached: number, out: number, thoughts: number): unknown => ({
  promptTokenCount: prompt,
  cachedContentTokenCount: cached,
  candidatesTokenCount: out,
  thoughtsTokenCount: thoughts,
  totalTokenCount: prompt + out
})

/** One Qwen chat file: a tool error, a rewound branch (u2/a2), a sidechain record and a trailing telemetry record */
function qwenHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-qwen-sessions-'))
  const records = [
    {
      ...base,
      uuid: 'u1',
      parentUuid: null,
      timestamp: T(0),
      type: 'user',
      message: { role: 'user', parts: [{ text: 'Fix the failing checkout test' }] }
    },
    {
      ...base,
      uuid: 'a1',
      parentUuid: 'u1',
      timestamp: T(5),
      type: 'assistant',
      model: 'qwen3.7-max',
      usageMetadata: usage(1000, 600, 200, 50),
      message: {
        role: 'model',
        parts: [
          { text: 'thinking…', thought: true },
          { text: 'Running the tests first.' },
          { functionCall: { id: 'c1', name: 'run_shell_command', args: { command: 'npm test' } } }
        ]
      }
    },
    {
      ...base,
      uuid: 't1',
      parentUuid: 'a1',
      timestamp: T(9),
      type: 'tool_result',
      message: {
        role: 'user',
        parts: [{ functionResponse: { id: 'c1', name: 'run_shell_command', response: {} } }]
      },
      toolCallResult: {
        callId: 'c1',
        status: 'error',
        error: { message: 'Command exited with exit code 1' }
      }
    },
    {
      ...base,
      uuid: 'u2',
      parentUuid: 't1',
      timestamp: T(12),
      type: 'user',
      message: { role: 'user', parts: [{ text: 'Rewound question' }] }
    },
    {
      ...base,
      uuid: 'a2',
      parentUuid: 'u2',
      timestamp: T(14),
      type: 'assistant',
      model: 'qwen3.7-max',
      usageMetadata: usage(9999, 0, 9999, 0),
      message: { role: 'model', parts: [{ text: 'Rewound answer' }] }
    },
    {
      ...base,
      uuid: 'u3',
      parentUuid: 't1',
      timestamp: T(20),
      type: 'user',
      message: { role: 'user', parts: [{ text: 'Use the skill and the docs server' }] }
    },
    {
      ...base,
      uuid: 'x1',
      parentUuid: 'u3',
      timestamp: T(21),
      type: 'assistant',
      isSidechain: true,
      agentId: 'sub-1',
      model: 'qwen3.7-max',
      usageMetadata: usage(10, 0, 10, 0),
      message: { role: 'model', parts: [{ text: 'Subagent work' }] }
    },
    {
      ...base,
      uuid: 'a3',
      parentUuid: 'u3',
      timestamp: T(25),
      type: 'assistant',
      model: 'deepseek-v4-pro',
      usageMetadata: usage(500, 0, 80, 0),
      message: {
        role: 'model',
        parts: [
          { text: 'Done.' },
          { functionCall: { id: 'c2', name: 'skill', args: { skill: 'code-review' } } },
          { functionCall: { id: 'c3', name: 'mcp__context7__query-docs', args: { q: 'x' } } }
        ]
      }
    },
    {
      ...base,
      uuid: 's1',
      parentUuid: 'a3',
      timestamp: T(26),
      type: 'system',
      subtype: 'ui_telemetry'
    }
  ]
  const dir = join(home, '.qwen/projects/-Users-alex-code-shop-api/chats')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${ID}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  writeFileSync(join(dir, `${ID}.runtime.json`), '{}\n')
  return home
}

test('Qwen sessions are listed from ~/.qwen/projects/*/chats', () => {
  const home = qwenHome()
  const { sessions, errors } = scanSessions(home, ['qwen'])
  assert.deepEqual(errors, [])
  assert.equal(sessions.length, 1)
  const s = sessions[0]
  assert.equal(s.id, ID)
  assert.equal(s.tool, 'qwen')
  assert.equal(s.title, 'Fix the failing checkout test')
  assert.equal(s.cwd, CWD)
  assert.equal(s.project, 'shop-api')
  assert.equal(s.startedAt, T(0))
  assert.equal(s.updatedAt, T(26))
  assert.equal(
    s.resumeCommand,
    process.platform === 'win32'
      ? `Set-Location -LiteralPath '${CWD}'; qwen --resume ${ID}`
      : `cd -- ${CWD} && qwen --resume ${ID}`
  )
})

test('Qwen transcript follows the active branch and skips rewound and sidechain records', async () => {
  const home = qwenHome()
  const t = await readSessionTranscript(home, 'qwen', ID)
  const texts = t.messages.map((m) => `${m.role}:${m.text}`)
  assert.deepEqual(texts, [
    'user:Fix the failing checkout test',
    'assistant:Running the tests first.',
    texts[2],
    'user:Use the skill and the docs server',
    'assistant:Done.',
    texts[5],
    texts[6]
  ])
  assert.match(texts[2], /^assistant:run_shell_command/)
  assert.ok(!texts.some((x) => x.includes('Rewound') || x.includes('Subagent')))
})

test('Qwen model stats: one turn per assistant record with Gemini-style token counts', async () => {
  const home = qwenHome()
  const path = join(home, `.qwen/projects/-Users-alex-code-shop-api/chats/${ID}.jsonl`)
  const turns: { model?: string; usage: TurnUsage }[] = []
  const errors: { name?: string; kind: string }[] = []
  const prompts: (string | undefined)[] = []
  const calls: string[] = []
  const c = new Collector()
  c.onCall = (call) => calls.push(`${call.model}:${call.name}`)
  c.stats = {
    turn: (x) => turns.push({ model: x.model, usage: x.usage }),
    toolError: (e) => errors.push({ name: e.name, kind: e.kind }),
    prompt: (at) => prompts.push(at),
    interrupt: () => {},
    requestEnd: () => {},
    limits: () => {}
  }
  await readQwen(path, c)
  assert.deepEqual(turns, [
    {
      model: 'qwen3.7-max',
      usage: { input: 400, cacheRead: 600, cacheWrite: 0, output: 200, reasoning: 50 }
    },
    {
      model: 'deepseek-v4-pro',
      usage: { input: 500, cacheRead: 0, cacheWrite: 0, output: 80, reasoning: 0 }
    }
  ])
  assert.deepEqual(errors, [{ name: 'run_shell_command', kind: 'command' }])
  assert.deepEqual(prompts, [T(0), T(20)])
  assert.deepEqual(calls, [
    'qwen3.7-max:run_shell_command',
    'deepseek-v4-pro:skill',
    'deepseek-v4-pro:mcp__context7__query-docs'
  ])
})

test('Qwen usage: skill tool and mcp__server__tool calls', () => {
  assert.deepEqual(classify('qwen', { name: 'skill', input: { skill: 'code-review' } }), [
    { kind: 'skill', name: 'code-review' }
  ])
  assert.deepEqual(
    classify('qwen', { name: 'mcp__context7__query-docs', input: {} }).map((h) => [h.kind, h.name]),
    [['mcp', 'context7']]
  )
  assert.deepEqual(classify('qwen', { name: 'run_shell_command', input: {} }), [])
})
