import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hookOptions,
  renderActionScript,
  renderAskPrompt,
  type HookAction,
  type HookDoc,
  type HookTiming,
  type HookTool
} from '../src/engine'

const doc = (
  action: HookAction,
  when: HookTiming,
  options: Record<string, unknown> = {}
): HookDoc => ({
  description: '',
  when,
  action,
  options: hookOptions(action, options),
  body: ''
})

/** Run a generated script the way the tool does: tool name as $1, the event JSON on stdin */
function run(
  script: string,
  tool: HookTool,
  input: unknown
): { code: number; out: string; err: string } {
  const dir = mkdtempSync(join(tmpdir(), 'illithid-hook-run-'))
  const file = join(dir, 'run.sh')
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  const r = spawnSync(file, [tool], { input: JSON.stringify(input), encoding: 'utf8' })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr }
}

// Each tool's before-tool payload for a shell command (shapes from each tool's hook docs)
const shell = (tool: HookTool, command: string): unknown =>
  tool === 'copilot'
    ? { toolName: 'bash', toolArgs: JSON.stringify({ command }) }
    : tool === 'grok'
      ? { toolName: 'run_terminal_command', toolInput: { command } }
      : { tool_name: tool === 'gemini' ? 'run_shell_command' : 'Bash', tool_input: { command } }

const TOOLS: HookTool[] = ['claude', 'codex', 'gemini', 'copilot', 'grok']

test('REQ-HOOKS-ACTIONS-1 guard blocks a dangerous command in every tool with exit 2 and a reason, and lets others through', () => {
  const d = doc('guard', 'before-tool')
  for (const tool of TOOLS) {
    const script = renderActionScript(tool, 'guard', d)
    const blocked = run(script, tool, shell(tool, 'git push --force origin main'))
    assert.equal(blocked.code, 2, `${tool} blocks`)
    assert.match(blocked.err, /Blocked by Illithid \(guard\): git push --force/, tool)
    const allowed = run(script, tool, shell(tool, 'ls -la'))
    assert.equal(allowed.code, 0, `${tool} allows`)
    // Gemini CLI parses stdout as JSON: nothing may be printed there
    assert.equal(allowed.out, '', tool)
  }
  // Copilot documents toolArgs as an object too
  const obj = run(renderActionScript('copilot', 'guard', d), 'copilot', {
    toolName: 'bash',
    toolArgs: { command: 'rm -rf / --no-preserve-root' }
  })
  assert.equal(obj.code, 2)
})

test('REQ-HOOKS-ACTIONS-2 guard patterns are matched literally, quotes included', () => {
  const d = doc('guard', 'before-tool', { patterns: ["it's *", 'DROP TABLE'] })
  const script = renderActionScript('claude', 'guard', d)
  assert.equal(run(script, 'claude', shell('claude', "echo it's * here")).code, 2)
  assert.equal(run(script, 'claude', shell('claude', 'echo its anything')).code, 0)
  assert.equal(run(script, 'claude', shell('claude', 'psql -c "DROP TABLE x"')).code, 2)
})

test('REQ-HOOKS-ACTIONS-3 format runs the command on the edited file, read from each tool its own way', () => {
  const dir = mkdtempSync(join(tmpdir(), 'illithid-hook-fmt-'))
  const seen = join(dir, 'seen.txt')
  const fake = join(dir, 'fmt.sh')
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${seen}'\n`)
  chmodSync(fake, 0o755)
  const d = doc('format', 'after-tool', { command: `'${fake}'` })
  const payload: Record<string, unknown> = {
    claude: { tool_name: 'Edit', tool_input: { file_path: '/p/a.ts' } },
    gemini: { tool_name: 'write_file', tool_input: { file_path: '/p/b.ts' } },
    grok: { toolName: 'search_replace', toolInput: { file_path: '/p/c.ts' } },
    copilot: { toolName: 'edit', toolArgs: JSON.stringify({ path: '/p/d.ts' }) }
  }
  for (const tool of ['claude', 'gemini', 'grok', 'copilot'] as const) {
    const r = run(renderActionScript(tool, 'fmt', d), tool, payload[tool])
    assert.equal(r.code, 0, tool)
  }
  assert.equal(readFileSync(seen, 'utf8'), '/p/a.ts\n/p/b.ts\n/p/c.ts\n/p/d.ts\n')
  // No file path (e.g. a shell call slipping through): nothing runs
  assert.equal(run(renderActionScript('claude', 'fmt', d), 'claude', { tool_input: {} }).code, 0)
  assert.equal(readFileSync(seen, 'utf8').split('\n').length, 5)
})

test('REQ-HOOKS-ACTIONS-4 log appends time, tool, hook and folder; notify passes its texts as arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'illithid-hook-log-'))
  const log = join(dir, 'sub/hooks.log')
  const r = run(
    renderActionScript('codex', 'trace', doc('log', 'session-start', { path: log })),
    'codex',
    {}
  )
  assert.equal(r.code, 0)
  assert.match(readFileSync(log, 'utf8'), /^\d{4}-\d\d-\d\dT[\d:]+Z\tcodex\ttrace\t\//)
  // Not run here (it would show a real notification): the texts go in as osascript arguments, quotes escaped
  const n = renderActionScript(
    'claude',
    'done',
    doc('notify', 'stop', { message: "It's done", sound: true })
  )
  assert.match(n, /'Illithid' 'It'\\''s done'/)
  assert.match(n, /afplay/)
})

test('REQ-HOOKS-ACTIONS-5 ask wraps the instruction with the event and the reply format; $ in it stays literal', () => {
  const p = renderAskPrompt({
    ...doc('ask', 'stop'),
    body: 'Keep going until tests pass. Budget: $5'
  })
  assert.match(p, /^Keep going until tests pass\. Budget: \\\$5\n/)
  assert.match(p, /\$ARGUMENTS/)
  assert.match(p, /"decision": "block"/)
  const pre = renderAskPrompt({ ...doc('ask', 'before-tool'), body: 'Deny anything touching prod' })
  assert.match(pre, /permissionDecision/)
  // An imported prompt is written as is
  const raw = renderAskPrompt({
    ...doc('ask', 'stop', { verbatim: true }),
    body: 'Original prompt $ARGUMENTS'
  })
  assert.equal(raw, 'Original prompt $ARGUMENTS')
})
