import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHook,
  createHookToolScript,
  defaultHookEvent,
  deleteHook,
  dropHookToolScript,
  hookOptions,
  hookSupport,
  hookTriggers,
  LibraryError,
  libraryRoot,
  readHook,
  readHooks,
  readManifest,
  saveHookDoc,
  saveHookScript,
  setToggle,
  validateHookDoc,
  type HookDoc
} from '../src/engine'
import { buildDemoHome } from './readme-shots'

function demoHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-hooks-lib-'))
  buildDemoHome(home, { tools: 'all' })
  return home
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return e instanceof LibraryError ? e.code : `not a LibraryError: ${String(e)}`
  }
  return undefined
}

test('REQ-HOOKS-LIB-1 each tool maps a timing to its own native event', () => {
  // Expected names come from each tool's hook docs (see src/engine/hookEvents.ts sources)
  assert.equal(defaultHookEvent('claude', 'before-tool'), 'PreToolUse')
  assert.equal(defaultHookEvent('gemini', 'before-tool'), 'BeforeTool')
  assert.equal(defaultHookEvent('copilot', 'before-tool'), 'preToolUse')
  assert.equal(defaultHookEvent('gemini', 'stop'), 'AfterAgent')
  assert.equal(defaultHookEvent('copilot', 'stop'), 'agentStop')
  assert.equal(defaultHookEvent('codex', 'notification'), null)
})

test('REQ-HOOKS-LIB-2 each action says which tools can run it and why not', () => {
  assert.equal(hookSupport('guard', 'before-tool', 'copilot'), 'ok')
  // Codex apply_patch hands over no file path
  assert.equal(hookSupport('format', 'after-tool', 'codex'), 'noFilePath')
  // Only Claude Code has LLM-judged (prompt) hooks
  // Every tool can judge: Claude Code with its prompt hook, the others by asking a CLI
  assert.equal(hookSupport('ask', 'stop', 'gemini'), 'ok')
  assert.equal(hookSupport('ask', 'stop', 'claude'), 'ok')
  assert.equal(hookSupport('notify', 'notification', 'codex'), 'noEvent')
  assert.equal(hookSupport('guard', 'stop', 'claude'), 'wrongTiming')
})

test('REQ-HOOKS-LIB-3 a new hook is one HOOK.md with when, action and options; no script for built-in actions', () => {
  const home = demoHome()
  createHook(home, 'done', {
    description: 'Tell me when the reply is done',
    when: 'stop',
    action: 'notify',
    options: { message: 'Done' }
  })
  const dir = join(libraryRoot(home), 'hooks/done')
  assert.ok(existsSync(join(dir, 'HOOK.md')))
  assert.equal(existsSync(join(dir, 'run.sh')), false)
  assert.match(readFileSync(join(dir, 'HOOK.md'), 'utf8'), /^---\nname: done\n/)
  const [h] = readHooks(home)
  assert.equal(h.name, 'done')
  assert.equal(h.doc.when, 'stop')
  assert.equal(h.doc.action, 'notify')
  // Missing options get the action defaults
  assert.deepEqual(h.doc.options, {
    title: 'Illithid',
    message: 'Done',
    sound: false,
    channel: 'mac',
    urlEnv: '',
    project: true
  })
})

test('REQ-HOOKS-LIB-4 triggers come from the action: the shell tool of each tool for guard, nothing where unsupported', () => {
  const home = demoHome()
  createHook(home, 'guard', { description: '', when: 'before-tool', action: 'guard', options: {} })
  createHook(home, 'fmt', {
    description: '',
    when: 'after-tool',
    action: 'format',
    options: { command: 'npx prettier --write' }
  })
  assert.deepEqual(hookTriggers(readHook(home, 'guard').doc), {
    claude: { event: 'PreToolUse', matcher: 'Bash' },
    codex: { event: 'PreToolUse', matcher: 'Bash' },
    gemini: { event: 'BeforeTool', matcher: 'run_shell_command' },
    copilot: { event: 'preToolUse', matcher: 'bash' },
    grok: { event: 'PreToolUse', matcher: 'run_terminal_command' },
    qwen: { event: 'PreToolUse', matcher: 'run_shell_command' }
  })
  const fmt = hookTriggers(readHook(home, 'fmt').doc)
  assert.deepEqual(fmt.claude, { event: 'PostToolUse', matcher: 'Write|Edit' })
  assert.equal(fmt.codex, undefined)
  // Advanced per-tool settings override the action's
  const doc = readHook(home, 'fmt').doc
  saveHookDoc(home, 'fmt', { ...doc, tools: { gemini: { timeout: 10 } } })
  assert.deepEqual(hookTriggers(readHook(home, 'fmt').doc).gemini, {
    event: 'AfterTool',
    matcher: 'write_file|replace',
    timeout: 10
  })
})

test('REQ-HOOKS-LIB-5 ask keeps its instruction in the body; script keeps a run.sh', () => {
  const home = demoHome()
  createHook(home, 'tests-pass', {
    description: '',
    when: 'stop',
    action: 'ask',
    options: {},
    body: 'Keep working until the tests pass.'
  })
  assert.equal(readHook(home, 'tests-pass').doc.body, 'Keep working until the tests pass.\n')
  createHook(home, 'mine', {
    description: '',
    when: 'session-start',
    action: 'script',
    options: {},
    script: '#!/bin/sh\necho hi\n'
  })
  const mine = readHook(home, 'mine')
  assert.equal(mine.scripts['run.sh'], '#!/bin/sh\necho hi\n')
  // Windows has no exec bits
  if (process.platform !== 'win32')
    assert.equal(statSync(join(libraryRoot(home), 'hooks/mine/run.sh')).mode & 0o111, 0o111)
  saveHookScript(home, 'mine', 'run.sh', '#!/bin/sh\necho bye\n')
  assert.equal(readHook(home, 'mine').scripts['run.sh'], '#!/bin/sh\necho bye\n')
  // A tool-only script stays an advanced option of the script action
  assert.equal(createHookToolScript(home, 'mine', 'copilot'), 'run.copilot.sh')
  assert.deepEqual(readHook(home, 'mine').doc.toolScripts, { copilot: 'run.copilot.sh' })
  dropHookToolScript(home, 'mine', 'copilot')
  assert.equal(readHook(home, 'mine').doc.toolScripts, undefined)
})

test('REQ-HOOKS-LIB-6 invalid names, timings, options and empty instructions are refused', () => {
  const home = demoHome()
  const base = { description: '', when: 'stop' as const, action: 'notify' as const, options: {} }
  assert.equal(
    code(() => createHook(home, 'Bad Name', base)),
    'invalidName'
  )
  assert.equal(
    code(() => createHook(home, 'g', { ...base, action: 'guard' })),
    'invalidSchema'
  )
  assert.equal(
    code(() => createHook(home, 'a', { ...base, action: 'ask', body: '  ' })),
    'invalidSchema'
  )
  assert.equal(
    code(() =>
      createHook(home, 'p', {
        ...base,
        when: 'before-tool',
        action: 'guard',
        options: { patterns: 'rm' }
      })
    ),
    'invalidSchema'
  )
  createHook(home, 'ok', base)
  assert.equal(
    code(() => createHook(home, 'ok', base)),
    'exists'
  )
  const doc = readHook(home, 'ok').doc
  assert.equal(
    code(() => saveHookDoc(home, 'ok', { ...doc, tools: { claude: { event: 'BeforeTool' } } })),
    'invalidSchema'
  )
  assert.equal(
    code(() => saveHookDoc(home, 'ok', { ...doc, tools: { claude: { timeout: 0 } } })),
    'invalidSchema'
  )
  assert.equal(
    code(() => saveHookScript(home, 'ok', 'run.sh', 'x')),
    'notFound'
  )
})

test('REQ-HOOKS-LIB-7 hooks have per-tool on/off in illithid.json, and deleting moves the folder to the trash', () => {
  const home = demoHome()
  createHook(home, 'notify', { description: '', when: 'stop', action: 'notify', options: {} })
  setToggle(home, 'hooks', 'notify', 'gemini', false)
  assert.deepEqual(readManifest(home).manifest.hooks, { notify: { gemini: false } })
  assert.throws(() => setToggle(home, 'hooks', 'notify', 'opencode', false))
  deleteHook(home, 'notify')
  assert.equal(existsSync(join(libraryRoot(home), 'hooks/notify')), false)
  assert.deepEqual(readHooks(home), [])
})

test('REQ-HOOKS-LIB-8 a script hook before or after a tool call can target shell commands, file edits or every call', () => {
  const doc = (target?: string): HookDoc => ({
    description: '',
    when: 'before-tool',
    action: 'script',
    options: hookOptions('script', target ? { target } : {}),
    body: ''
  })
  // Every call: no matcher
  assert.deepEqual(hookTriggers(doc()).claude, { event: 'PreToolUse' })
  assert.deepEqual(hookTriggers(doc('shell')), {
    claude: { event: 'PreToolUse', matcher: 'Bash' },
    codex: { event: 'PreToolUse', matcher: 'Bash' },
    gemini: { event: 'BeforeTool', matcher: 'run_shell_command' },
    copilot: { event: 'preToolUse', matcher: 'bash' },
    grok: { event: 'PreToolUse', matcher: 'run_terminal_command' },
    qwen: { event: 'PreToolUse', matcher: 'run_shell_command' }
  })
  assert.deepEqual(hookTriggers(doc('edit')), {
    claude: { event: 'PreToolUse', matcher: 'Write|Edit' },
    codex: { event: 'PreToolUse', matcher: 'apply_patch' },
    gemini: { event: 'BeforeTool', matcher: 'write_file|replace' },
    copilot: { event: 'preToolUse', matcher: 'edit|create' },
    grok: { event: 'PreToolUse', matcher: 'search_replace' },
    qwen: { event: 'PreToolUse', matcher: 'edit|write_file' }
  })
  // Format still can't run in Codex (no file path), the script hook can
  assert.equal(hookSupport('format', 'after-tool', 'codex'), 'noFilePath')
  // Outside tool calls the target means nothing
  assert.deepEqual(hookTriggers({ ...doc('shell'), when: 'stop' }).claude, { event: 'Stop' })
  assert.ok(validateHookDoc({ ...doc(), options: { target: 'files' } }).length > 0)
})

test("REQ-HOOKS-LIB-9 a plain-language check before shell commands only reaches each tool's shell tool", () => {
  const doc: HookDoc = {
    description: '',
    when: 'before-tool',
    action: 'ask',
    options: hookOptions('ask', { target: 'shell' }),
    body: 'Never push to main.'
  }
  const t = hookTriggers(doc)
  assert.deepEqual(t.claude, { event: 'PreToolUse', matcher: 'Bash', timeout: 120 })
  assert.deepEqual(t.gemini, { event: 'BeforeTool', matcher: 'run_shell_command', timeout: 120 })
  // Default: every action
  assert.deepEqual(hookTriggers({ ...doc, options: hookOptions('ask', {}) }).claude, {
    event: 'PreToolUse',
    timeout: 120
  })
})
