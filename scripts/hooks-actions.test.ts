import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  hookEventInfo,
  hookOptions,
  hookTriggers,
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
  input: unknown,
  opts: { env?: Record<string, string>; cwd?: string } = {}
): { code: number; out: string; err: string } {
  const dir = mkdtempSync(join(tmpdir(), 'illithid-hook-run-'))
  const file = join(dir, 'run.sh')
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  const r = spawnSync(file, [tool], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: { ...process.env, ...opts.env }
  })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr }
}

/** A bin folder with fake commands that record their arguments (one line per call, args joined by a tab) */
function fakeBin(...names: string[]): { path: string; calls: (name: string) => string[][] } {
  const dir = mkdtempSync(join(tmpdir(), 'illithid-fake-bin-'))
  for (const n of names) {
    const f = join(dir, n)
    writeFileSync(
      f,
      `#!/bin/sh\n{ for a in "$@"; do printf '%s\\t' "$a"; done; printf '\\n'; } >> '${dir}/${n}.calls'\n`
    )
    chmodSync(f, 0o755)
  }
  return {
    path: `${dir}:${process.env.PATH}`,
    calls: (n) => {
      const p = join(dir, `${n}.calls`)
      if (!existsSync(p)) return []
      return readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('\t').slice(0, -1))
    }
  }
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

test('REQ-HOOKS-ACTIONS-4 log appends time, tool, hook and folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'illithid-hook-log-'))
  const log = join(dir, 'sub/hooks.log')
  const r = run(
    renderActionScript('codex', 'trace', doc('log', 'session-start', { path: log })),
    'codex',
    {}
  )
  assert.equal(r.code, 0)
  assert.match(readFileSync(log, 'utf8'), /^\d{4}-\d\d-\d\dT[\d:]+Z\tcodex\ttrace\t\//)
})

test('REQ-HOOKS-ACTIONS-6 notify on macOS: title with the project folder, the message, a sound', () => {
  const bin = fakeBin('osascript', 'afplay')
  const proj = mkdtempSync(join(tmpdir(), 'my-app-'))
  const d = doc('notify', 'stop', { title: 'Agent', message: "It's done", sound: true })
  const r = run(
    renderActionScript('claude', 'done', d),
    'claude',
    {},
    {
      env: { PATH: bin.path },
      cwd: proj
    }
  )
  assert.equal(r.code, 0)
  const [call] = bin.calls('osascript')
  assert.deepEqual(call.slice(-2), [`Agent · ${basename(proj)}`, "It's done"])
  // The sound plays in the background so the hook returns at once
  for (let i = 0; i < 50 && !bin.calls('afplay').length; i++) spawnSync('sleep', ['0.02'])
  assert.equal(bin.calls('afplay').length, 1)
  // Without the project name
  const plain = fakeBin('osascript')
  run(
    renderActionScript('claude', 'done', doc('notify', 'stop', { title: 'Agent', project: false })),
    'claude',
    {},
    { env: { PATH: plain.path }, cwd: proj }
  )
  assert.equal(plain.calls('osascript')[0].at(-2), 'Agent')
})

test('REQ-HOOKS-ACTIONS-7 phone notifications go through ntfy or Slack from an environment variable, never stored', () => {
  const proj = mkdtempSync(join(tmpdir(), 'shop-'))
  const ntfy = doc('notify', 'stop', { channel: 'ntfy', title: 'Agent', message: 'Done' })
  const script = renderActionScript('claude', 'phone', ntfy)
  assert.ok(!script.includes('https://'), 'no address in the script')
  const bin = fakeBin('curl')
  // No address in the environment: nothing is sent
  assert.equal(run(script, 'claude', {}, { env: { PATH: bin.path }, cwd: proj }).code, 0)
  assert.equal(bin.calls('curl').length, 0)
  run(
    script,
    'claude',
    {},
    {
      env: { PATH: bin.path, ILLITHID_NTFY_URL: 'https://ntfy.sh/secret-topic' },
      cwd: proj
    }
  )
  const [call] = bin.calls('curl')
  assert.equal(call.at(-1), 'https://ntfy.sh/secret-topic')
  assert.ok(call.includes(`Title: Agent · ${basename(proj)}`), call.join(' '))
  assert.ok(call.includes('Done'), call.join(' '))
  // Slack: a JSON body with title and message, from a custom variable name
  const slack = fakeBin('curl')
  run(
    renderActionScript(
      'gemini',
      'phone',
      doc('notify', 'stop', { channel: 'slack', urlEnv: 'MY_SLACK', title: 'A "q"', message: 'B' })
    ),
    'gemini',
    {},
    { env: { PATH: slack.path, MY_SLACK: 'https://hooks.slack.com/x' }, cwd: proj }
  )
  const sc = slack.calls('curl')[0]
  assert.equal(sc.at(-1), 'https://hooks.slack.com/x')
  const body = JSON.parse(sc[sc.indexOf('-d') + 1]) as { text: string }
  assert.equal(body.text, `*A "q" · ${basename(proj)}*\nB`)
})

test('REQ-HOOKS-ACTIONS-8 "waiting for input" uses each tool\'s notification event and filter; the message comes from the event', () => {
  const d = doc('notify', 'notification', {})
  const t = hookTriggers(d)
  assert.deepEqual(t.claude, { event: 'Notification', matcher: 'permission_prompt|idle_prompt' })
  assert.deepEqual(t.copilot, { event: 'notification', matcher: 'permission_prompt' })
  assert.deepEqual(t.grok, { event: 'Notification', matcher: 'permission_prompt|idle_prompt' })
  assert.deepEqual(t.gemini, { event: 'Notification' })
  assert.equal(t.codex, undefined)
  const bin = fakeBin('osascript')
  run(
    renderActionScript(
      'claude',
      'wait',
      doc('notify', 'notification', { title: 'Agent', project: false })
    ),
    'claude',
    { message: 'Claude needs your permission to use Bash' },
    { env: { PATH: bin.path } }
  )
  assert.equal(bin.calls('osascript')[0].at(-1), 'Claude needs your permission to use Bash')
})

test('REQ-HOOKS-ACTIONS-9 event catalog: matchers on session start and notifications, Copilot subagent stop can block', () => {
  assert.equal(hookEventInfo('grok', 'SessionStart')?.matcher, true)
  assert.equal(hookEventInfo('grok', 'Notification')?.matcher, true)
  assert.equal(hookEventInfo('gemini', 'SessionStart')?.matcher, true)
  assert.equal(hookEventInfo('copilot', 'subagentStop')?.canBlock, true)
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

/** A project folder with package.json and a fake npm whose test fails while FAIL is set */
function nodeProject(testScript = 'vitest run'): { dir: string; bin: ReturnType<typeof fakeBin> } {
  const dir = mkdtempSync(join(tmpdir(), 'illithid-verify-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: testScript } }))
  const bin = fakeBin('npm')
  // The fake npm also prints a failure and exits 1 when FAIL is set
  const npm = join(bin.path.split(':')[0], 'npm')
  writeFileSync(
    npm,
    readFileSync(npm, 'utf8') +
      'if [ -n "$FAIL" ]; then echo "  1 failing: adds numbers"; exit 1; fi\n'
  )
  return { dir, bin }
}

test('REQ-HOOKS-ACTIONS-10 check before finishing: failing tests send the agent back with the output, then give up after 3 tries', () => {
  const { dir, bin } = nodeProject()
  const script = renderActionScript('claude', 'verify', doc('verify', 'stop'))
  const env = { PATH: bin.path, FAIL: '1', TMPDIR: mkdtempSync(join(tmpdir(), 'illithid-tmp-')) }
  const input = { session_id: 's1', stop_hook_active: false }
  for (let i = 1; i <= 3; i++) {
    const r = run(script, 'claude', input, { env, cwd: dir })
    assert.equal(r.code, 2, `try ${i}`)
    assert.match(r.err, /npm test/)
    assert.match(r.err, /1 failing: adds numbers/)
  }
  // Fourth time in the same session: let it finish
  assert.equal(run(script, 'claude', input, { env, cwd: dir }).code, 0)
  assert.equal(bin.calls('npm').length, 3)
  // Already continuing because of a stop hook: never block again
  const again = run(
    script,
    'claude',
    { session_id: 's2', stop_hook_active: true },
    { env, cwd: dir }
  )
  assert.equal(again.code, 0)
  assert.equal(bin.calls('npm').length, 3)
  // Passing tests: finish
  const ok = run(script, 'claude', { session_id: 's3' }, { env: { ...env, FAIL: '' }, cwd: dir })
  assert.equal(ok.code, 0)
})

test("REQ-HOOKS-ACTIONS-11 check before finishing: Copilot gets a block decision as JSON; Grok's camelCase flag is read", () => {
  const { dir, bin } = nodeProject()
  const env = { PATH: bin.path, FAIL: '1', TMPDIR: mkdtempSync(join(tmpdir(), 'illithid-tmp-')) }
  const r = run(
    renderActionScript('copilot', 'verify', doc('verify', 'stop')),
    'copilot',
    { sessionId: 'c1' },
    {
      env,
      cwd: dir
    }
  )
  assert.equal(r.code, 0)
  const out = JSON.parse(r.out) as { decision: string; reason: string }
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /1 failing: adds numbers/)
  const grok = run(
    renderActionScript('grok', 'verify', doc('verify', 'stop')),
    'grok',
    { stopHookActive: true },
    { env, cwd: dir }
  )
  assert.equal(grok.code, 0)
  assert.equal(bin.calls('npm').length, 1)
})

test("REQ-HOOKS-ACTIONS-12 check before finishing picks the project's test command, skips when there is none or nothing changed", () => {
  const env = { TMPDIR: mkdtempSync(join(tmpdir(), 'illithid-tmp-')) }
  const script = renderActionScript('claude', 'verify', doc('verify', 'stop'))
  // npm init's placeholder test is not a test
  const placeholder = nodeProject('echo "Error: no test specified" && exit 1')
  assert.equal(
    run(
      script,
      'claude',
      {},
      { env: { ...env, PATH: placeholder.bin.path, FAIL: '1' }, cwd: placeholder.dir }
    ).code,
    0
  )
  assert.equal(placeholder.bin.calls('npm').length, 0)
  // go.mod → go test ./...
  const goDir = mkdtempSync(join(tmpdir(), 'illithid-go-'))
  writeFileSync(join(goDir, 'go.mod'), 'module x\n')
  const go = fakeBin('go')
  run(script, 'claude', {}, { env: { ...env, PATH: go.path }, cwd: goDir })
  assert.deepEqual(go.calls('go'), [['test', './...']])
  // pyproject.toml but no tests (pytest exits 5), or the tool isn't installed (127): let the agent finish
  const pyDir = mkdtempSync(join(tmpdir(), 'illithid-py-'))
  writeFileSync(join(pyDir, 'pyproject.toml'), '[project]\nname = "x"\n')
  const py = fakeBin('pytest')
  const pyBin = join(py.path.split(':')[0], 'pytest')
  writeFileSync(pyBin, readFileSync(pyBin, 'utf8') + 'exit 5\n')
  assert.equal(run(script, 'claude', {}, { env: { ...env, PATH: py.path }, cwd: pyDir }).code, 0)
  assert.equal(py.calls('pytest').length, 1)
  assert.equal(
    run(script, 'claude', {}, { env: { ...env, PATH: '/usr/bin:/bin' }, cwd: pyDir }).code,
    0
  )
  // Nothing to test with
  const empty = mkdtempSync(join(tmpdir(), 'illithid-empty-'))
  assert.equal(run(script, 'claude', {}, { env, cwd: empty }).code, 0)
  // A git repo with no changes: nothing to check
  const repo = nodeProject()
  spawnSync('git', ['init', '-q'], { cwd: repo.dir })
  spawnSync('git', ['add', '.'], { cwd: repo.dir })
  spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'x'], {
    cwd: repo.dir
  })
  assert.equal(
    run(script, 'claude', {}, { env: { ...env, PATH: repo.bin.path, FAIL: '1' }, cwd: repo.dir })
      .code,
    0
  )
  assert.equal(repo.bin.calls('npm').length, 0)
  // The user's own command wins
  const make = fakeBin('make')
  run(
    renderActionScript('claude', 'verify', doc('verify', 'stop', { command: 'make check' })),
    'claude',
    {},
    {
      env: { ...env, PATH: make.path },
      cwd: empty
    }
  )
  assert.deepEqual(make.calls('make'), [['check']])
  // Every tool gets a long enough timeout (Copilot's default is 30 s, Gemini's 60 s)
  const t = hookTriggers(doc('verify', 'stop'))
  assert.deepEqual(t.copilot, { event: 'agentStop', timeout: 300 })
  assert.deepEqual(t.gemini, { event: 'AfterAgent', timeout: 300 })
})
