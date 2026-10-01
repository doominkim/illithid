import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  HOOK_ACTION_INFO,
  hookEventInfo,
  hookOptions,
  hookSupport,
  hookTriggers,
  validateHookDoc,
  renderActionScript,
  renderAskPrompt,
  renderUniversalScript,
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

test('REQ-HOOKS-ACTIONS-13 protect files: edits to .env, lock files and .git are blocked with a reason; other files pass', () => {
  const d = doc('protect', 'before-tool')
  const edit = (tool: HookTool, file: string): unknown =>
    tool === 'grok'
      ? { toolName: 'search_replace', toolInput: { file_path: file } }
      : { tool_name: tool === 'gemini' ? 'write_file' : 'Edit', tool_input: { file_path: file } }
  for (const tool of ['claude', 'gemini', 'grok'] as const) {
    const script = renderActionScript(tool, 'protect', d)
    const env = run(script, tool, edit(tool, '/p/app/.env'))
    assert.equal(env.code, 2, tool)
    assert.match(env.err, /Protected by Illithid \(protect\): \/p\/app\/\.env/)
    assert.equal(run(script, tool, edit(tool, '/p/app/config/.env.local')).code, 2, tool)
    assert.equal(run(script, tool, edit(tool, '/p/app/yarn.lock')).code, 2, tool)
    assert.equal(run(script, tool, edit(tool, '/p/app/.git/config')).code, 2, tool)
    assert.equal(run(script, tool, edit(tool, '/p/app/src/env.ts')).code, 0, tool)
  }
  // Codex and Copilot don't tell hooks the edited file reliably
  assert.equal(hookSupport('protect', 'before-tool', 'codex'), 'noFilePath')
  assert.equal(hookSupport('protect', 'before-tool', 'copilot'), 'noFilePath')
  // Patterns are file globs only
  assert.ok(validateHookDoc({ ...d, options: { patterns: ['a; rm -rf /'] } }).length > 0)
})

test("REQ-HOOKS-ACTIONS-14 session start: the branch, uncommitted changes and a note reach the agent in each tool's format", () => {
  const repo = mkdtempSync(join(tmpdir(), 'illithid-ctx-'))
  spawnSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: repo })
  writeFileSync(join(repo, 'a.ts'), 'x\n')
  const d = { ...doc('context', 'session-start'), body: 'Run npm test before you finish.' }
  const claude = run(renderActionScript('claude', 'ctx', d), 'claude', {}, { cwd: repo })
  assert.equal(claude.code, 0)
  assert.match(claude.out, /Git branch: feat\/x/)
  assert.match(claude.out, /\?\? a\.ts/)
  assert.match(claude.out, /Run npm test before you finish\./)
  const gemini = JSON.parse(
    run(renderActionScript('gemini', 'ctx', d), 'gemini', {}, { cwd: repo }).out
  ) as {
    hookSpecificOutput: { additionalContext: string }
  }
  assert.match(gemini.hookSpecificOutput.additionalContext, /Git branch: feat\/x\n/)
  const copilot = JSON.parse(
    run(renderActionScript('copilot', 'ctx', d), 'copilot', {}, { cwd: repo }).out
  ) as {
    additionalContext: string
  }
  assert.match(copilot.additionalContext, /Run npm test/)
  assert.equal(hookSupport('context', 'session-start', 'grok'), 'noContext')
  // Outside a repo with no note: nothing is said
  const empty = mkdtempSync(join(tmpdir(), 'illithid-ctx-empty-'))
  assert.equal(
    run(
      renderActionScript('claude', 'ctx', doc('context', 'session-start')),
      'claude',
      {},
      { cwd: empty }
    ).out,
    ''
  )
})

test('REQ-HOOKS-ACTIONS-15 format at the end of a reply runs once on the changed files, so Codex and Copilot can use it too', () => {
  const repo = mkdtempSync(join(tmpdir(), 'illithid-fmt-stop-'))
  spawnSync('git', ['init', '-q'], { cwd: repo })
  writeFileSync(join(repo, 'a.ts'), 'a\n')
  spawnSync('git', ['add', '.'], { cwd: repo })
  spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'x'], {
    cwd: repo
  })
  writeFileSync(join(repo, 'a.ts'), 'a2\n')
  writeFileSync(join(repo, 'new file.ts'), 'b\n')
  const bin = fakeBin('fmt')
  const d = doc('format', 'stop', { command: 'fmt --write' })
  assert.equal(
    run(renderActionScript('codex', 'fmt', d), 'codex', {}, { env: { PATH: bin.path }, cwd: repo })
      .code,
    0
  )
  const calls = bin.calls('fmt')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 1), ['--write'])
  assert.deepEqual(calls[0].slice(1).sort(), ['a.ts', 'new file.ts'])
  assert.equal(hookSupport('format', 'stop', 'codex'), 'ok')
  assert.equal(hookSupport('format', 'after-tool', 'codex'), 'noFilePath')
})

/** A git repo with one commit, a changed tracked file and a new untracked one */
function dirtyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'illithid-ckpt-'))
  const git = (...args: string[]): void => {
    spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: repo })
  }
  git('init', '-q')
  writeFileSync(join(repo, 'a.ts'), 'a\n')
  git('add', '.')
  git('commit', '-qm', 'first')
  writeFileSync(join(repo, 'a.ts'), 'a2\n')
  writeFileSync(join(repo, 'b.ts'), 'b\n')
  return repo
}
const gitOut = (repo: string, ...args: string[]): string =>
  spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim()

test('REQ-HOOKS-ACTIONS-16 checkpoint: a snapshot ref of the work tree (new files too) at the end of a reply, without touching files or the index', () => {
  const repo = dirtyRepo()
  const script = renderActionScript('claude', 'ckpt', doc('checkpoint', 'stop'))
  const status = gitOut(repo, 'status', '--porcelain')
  assert.equal(run(script, 'claude', {}, { cwd: repo }).code, 0)
  assert.equal(gitOut(repo, 'status', '--porcelain'), status, 'work tree and index unchanged')
  const refs = gitOut(repo, 'for-each-ref', '--format=%(refname)', 'refs/illithid/checkpoints')
    .split('\n')
    .filter(Boolean)
  assert.equal(refs.length, 1)
  assert.equal(gitOut(repo, 'show', `${refs[0]}:a.ts`), 'a2')
  assert.equal(gitOut(repo, 'show', `${refs[0]}:b.ts`), 'b')
  assert.equal(gitOut(repo, 'rev-list', '--count', 'HEAD'), '1', 'no commit on the branch')
  // Nothing changed since: no new snapshot
  run(script, 'claude', {}, { cwd: repo })
  assert.equal(
    gitOut(repo, 'for-each-ref', '--format=%(refname)', 'refs/illithid/checkpoints').split('\n')
      .length,
    1
  )
  // Not a git repo: nothing happens
  assert.equal(run(script, 'claude', {}, { cwd: mkdtempSync(join(tmpdir(), 'nogit-')) }).code, 0)
  assert.equal(hookSupport('checkpoint', 'stop', 'codex'), 'ok')
})

test('REQ-HOOKS-ACTIONS-17 checkpoint as a WIP commit: everything changed goes into one commit on the branch', () => {
  const repo = dirtyRepo()
  const script = renderActionScript('codex', 'ckpt', doc('checkpoint', 'stop', { mode: 'commit' }))
  assert.equal(
    run(
      script,
      'codex',
      {},
      {
        cwd: repo,
        env: {
          GIT_AUTHOR_NAME: 'a',
          GIT_AUTHOR_EMAIL: 'a@b',
          GIT_COMMITTER_NAME: 'a',
          GIT_COMMITTER_EMAIL: 'a@b'
        }
      }
    ).code,
    0
  )
  assert.equal(gitOut(repo, 'rev-list', '--count', 'HEAD'), '2')
  assert.match(gitOut(repo, 'log', '-1', '--format=%s'), /^WIP: checkpoint/)
  assert.equal(gitOut(repo, 'status', '--porcelain'), '')
})

test('REQ-HOOKS-ACTIONS-18 format runs at the end of a reply by default', () => {
  assert.equal(HOOK_ACTION_INFO.format.timings[0], 'stop')
})

test("REQ-HOOKS-ACTIONS-19 the all-tools script behaves like each tool's own script, picked by the tool name in $1", () => {
  const guard = doc('guard', 'before-tool')
  const all = renderUniversalScript('guard', guard)
  for (const tool of TOOLS) {
    const own = renderActionScript(tool, 'guard', guard)
    for (const cmd of ['git push --force origin main', 'ls -la']) {
      const a = run(all, tool, shell(tool, cmd))
      const b = run(own, tool, shell(tool, cmd))
      assert.equal(a.code, b.code, `${tool} ${cmd}`)
      assert.equal(a.err, b.err, `${tool} ${cmd}`)
      assert.equal(a.out, b.out, `${tool} ${cmd}`)
    }
  }
  // A tool the recipe can't run in does nothing
  const protect = renderUniversalScript('protect', doc('protect', 'before-tool'))
  assert.equal(run(protect, 'codex', { tool_input: { command: 'x' } }).code, 0)
  assert.equal(
    run(protect, 'claude', { tool_name: 'Edit', tool_input: { file_path: '/p/.env' } }).code,
    2
  )
  // Copilot's own reply format survives (check before finishing)
  const { dir, bin } = nodeProject()
  const v = run(
    renderUniversalScript('verify', doc('verify', 'stop')),
    'copilot',
    { sessionId: 'u1' },
    {
      env: { PATH: bin.path, FAIL: '1', TMPDIR: mkdtempSync(join(tmpdir(), 'illithid-tmp-')) },
      cwd: dir
    }
  )
  assert.equal((JSON.parse(v.out) as { decision: string }).decision, 'block')
  // An unknown tool name: nothing happens
  assert.equal(run(all, 'opencode' as HookTool, shell('claude', 'git push --force')).code, 0)
})

/**
 * Fake judging CLIs in each tool's output shape. FAKE_OK=true|false sets the verdict; every call records its arguments
 * and whether ILLITHID_JUDGE was set
 */
function fakeJudges(ok: boolean): { path: string; calls: (name: string) => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'illithid-fake-judge-'))
  const verdict = `{"ok": ${ok}, "reason": "Tests still fail"}`
  const esc = verdict.replace(/"/g, '\\"')
  const out: Record<string, string> = {
    claude: `printf '%s\\n' '{"type":"result","result":"","structured_output":${verdict}}'`,
    // Codex writes the last message to the -o file
    codex: `while [ $# -gt 0 ]; do [ "$1" = -o ] && { printf '%s' '${verdict}' > "$2"; shift; }; shift; done`,
    gemini: `printf '%s\\n' '{"response":"${esc}","stats":{}}'`,
    copilot: `printf '%s\\n' '{"type":"session.start"}' '{"type":"assistant.message","data":{"content":"${esc}"}}'`,
    grok: `printf '%s\\n' '{"result":${verdict}}'`
  }
  for (const [name, body] of Object.entries(out)) {
    const f = join(dir, name)
    writeFileSync(
      f,
      `#!/bin/sh\nprintf '%s|%s\\n' "\${ILLITHID_JUDGE:-}" "$*" >> '${dir}/${name}.calls'\n${body}\n`
    )
    chmodSync(f, 0o755)
  }
  return {
    path: `${dir}:/usr/bin:/bin`,
    calls: (n) => {
      const p = join(dir, `${n}.calls`)
      return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []
    }
  }
}

test('REQ-HOOKS-ACTIONS-20 AI judgment in every tool: the tool\'s own CLI judges with hooks off, and a "no" stops the agent the tool\'s way', () => {
  const d = { ...doc('ask', 'stop'), body: 'Keep working until the tests pass.' }
  const stopInput = (tool: HookTool): unknown =>
    tool === 'copilot' || tool === 'grok' ? { stopHookActive: false } : { stop_hook_active: false }
  for (const tool of TOOLS) {
    const no = fakeJudges(false)
    const r = run(renderActionScript(tool, 'tests', d), tool, stopInput(tool), {
      env: { PATH: no.path }
    })
    const [call] = no.calls(tool)
    assert.ok(call, `${tool} calls its own CLI`)
    assert.match(call, /^1\|/, `${tool}: the nested run is marked`)
    assert.match(call, /Keep working until the tests pass\./, tool)
    if (tool === 'copilot') {
      assert.equal(r.code, 0)
      assert.deepEqual(JSON.parse(r.out), { decision: 'block', reason: 'Tests still fail' })
    } else {
      assert.equal(r.code, 2, tool)
      assert.match(r.err, /Tests still fail/, tool)
    }
    const yes = fakeJudges(true)
    assert.equal(
      run(renderActionScript(tool, 'tests', d), tool, stopInput(tool), { env: { PATH: yes.path } })
        .code,
      0,
      tool
    )
  }
  // Hooks are off in the nested run where the CLI allows it
  const f = fakeJudges(false)
  run(renderActionScript('claude', 'tests', d), 'claude', {}, { env: { PATH: f.path } })
  run(renderActionScript('codex', 'tests', d), 'codex', {}, { env: { PATH: f.path } })
  assert.match(f.calls('claude')[0], /--settings \{"disableAllHooks":true\}/)
  assert.match(f.calls('claude')[0], /--model haiku/)
  assert.match(f.calls('codex')[0], /--disable hooks/)
})

test("REQ-HOOKS-ACTIONS-21 AI judgment lets things through when it can't judge, never loops, and can use another tool's CLI", () => {
  const d = { ...doc('ask', 'stop'), body: 'Keep working until the tests pass.' }
  const f = fakeJudges(false)
  // Inside a judging run: every Illithid hook steps aside
  assert.equal(
    run(
      renderActionScript('codex', 'tests', d),
      'codex',
      {},
      { env: { PATH: f.path, ILLITHID_JUDGE: '1' } }
    ).code,
    0
  )
  // Already continuing because of a stop hook
  assert.equal(
    run(
      renderActionScript('codex', 'tests', d),
      'codex',
      { stop_hook_active: true },
      { env: { PATH: f.path } }
    ).code,
    0
  )
  assert.equal(f.calls('codex').length, 0)
  // No CLI installed, or an answer that isn't a verdict
  assert.equal(
    run(renderActionScript('gemini', 'tests', d), 'gemini', {}, { env: { PATH: '/usr/bin:/bin' } })
      .code,
    0
  )
  const junk = mkdtempSync(join(tmpdir(), 'illithid-junk-'))
  writeFileSync(join(junk, 'gemini'), '#!/bin/sh\necho "rate limited"\n')
  chmodSync(join(junk, 'gemini'), 0o755)
  assert.equal(
    run(
      renderActionScript('gemini', 'tests', d),
      'gemini',
      {},
      { env: { PATH: `${junk}:/usr/bin:/bin` } }
    ).code,
    0
  )
  // Codex hook judged by Claude Code
  const g = fakeJudges(false)
  const r = run(
    renderActionScript('codex', 'tests', {
      ...d,
      options: hookOptions('ask', { judge: 'claude' })
    }),
    'codex',
    {},
    { env: { PATH: g.path } }
  )
  assert.equal(r.code, 2)
  assert.equal(g.calls('codex').length, 0)
  // One call (its prompt spans several lines of the record)
  assert.equal(g.calls('claude').filter((l) => /^1\|/.test(l)).length, 1)
  // Every tool can run it now; Claude Code keeps its built-in prompt hook
  assert.equal(hookSupport('ask', 'stop', 'codex'), 'ok')
  assert.equal(hookTriggers(doc('ask', 'stop')).codex?.timeout, 120)
})
