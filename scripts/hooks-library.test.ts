import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHook,
  defaultHookEvent,
  LibraryError,
  libraryRoot,
  readHook,
  readHooks,
  createHookToolScript,
  deleteHook,
  dropHookToolScript,
  readManifest,
  saveHookDef,
  saveHookScript,
  setToggle
} from '../src/engine'
import { buildDemoHome } from './readme-shots'

function demoHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-hooks-lib-'))
  buildDemoHome(home, { tools: 'all' })
  return home
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

test('REQ-HOOKS-LIB-2 a new hook writes hook.json and its script, connected to the chosen tools', () => {
  const home = demoHome()
  createHook(home, 'guard', {
    description: 'Block dangerous commands',
    timing: 'before-tool',
    tools: ['claude', 'gemini', 'codex'],
    script: '#!/usr/bin/env bash\nexit 0\n'
  })
  const dir = join(libraryRoot(home), 'hooks/guard')
  assert.ok(existsSync(join(dir, 'hook.json')))
  assert.equal(readFileSync(join(dir, 'run.sh'), 'utf8'), '#!/usr/bin/env bash\nexit 0\n')
  const [hook] = readHooks(home)
  assert.equal(hook.name, 'guard')
  assert.equal(hook.def.timing, 'before-tool')
  assert.equal(hook.def.script, 'run.sh')
  assert.deepEqual(hook.def.triggers, {
    claude: { event: 'PreToolUse' },
    codex: { event: 'PreToolUse' },
    gemini: { event: 'BeforeTool' }
  })
  assert.equal(hook.scripts['run.sh'], '#!/usr/bin/env bash\nexit 0\n')
})

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return e instanceof LibraryError ? e.code : `not a LibraryError: ${String(e)}`
  }
  return undefined
}

test('REQ-HOOKS-LIB-3 invalid names, events, matchers and timeouts are refused', () => {
  const home = demoHome()
  const base = {
    description: '',
    timing: 'stop' as const,
    tools: ['claude' as const],
    script: 'exit 0\n'
  }
  assert.equal(
    code(() => createHook(home, 'Bad Name', base)),
    'invalidName'
  )
  assert.equal(
    code(() => createHook(home, 'n1', { ...base, tools: ['codex'], timing: 'notification' })),
    'invalidSchema'
  )
  createHook(home, 'ok', base)
  assert.equal(
    code(() => createHook(home, 'ok', base)),
    'exists'
  )
  const def = readHook(home, 'ok').def
  assert.equal(
    code(() => saveHookDef(home, 'ok', { ...def, triggers: { claude: { event: 'BeforeTool' } } })),
    'invalidSchema'
  )
  assert.equal(
    code(() =>
      saveHookDef(home, 'ok', { ...def, triggers: { claude: { event: 'Stop', matcher: 'Bash' } } })
    ),
    'invalidSchema'
  )
  assert.equal(
    code(() =>
      saveHookDef(home, 'ok', { ...def, triggers: { claude: { event: 'Stop', timeout: 0 } } })
    ),
    'invalidSchema'
  )
  assert.equal(
    code(() => saveHookDef(home, 'ok', { ...def, script: '../x.sh' })),
    'invalidSchema'
  )
  assert.equal(
    code(() => saveHookScript(home, 'ok', '../escape.sh', 'x')),
    'invalidName'
  )
})

test('REQ-HOOKS-LIB-4 triggers and scripts can be edited', () => {
  const home = demoHome()
  createHook(home, 'fmt', {
    description: 'Format',
    timing: 'after-tool',
    tools: ['claude', 'gemini'],
    script: 'exit 0\n'
  })
  const def = readHook(home, 'fmt').def
  saveHookDef(home, 'fmt', {
    ...def,
    description: 'Format edited files',
    triggers: {
      ...def.triggers,
      claude: { event: 'PostToolUse', matcher: 'Edit|Write', timeout: 30 }
    }
  })
  saveHookScript(home, 'fmt', 'run.sh', 'npx prettier --write "$1"\n')
  const h = readHook(home, 'fmt')
  assert.equal(h.def.description, 'Format edited files')
  assert.deepEqual(h.def.triggers.claude, {
    event: 'PostToolUse',
    matcher: 'Edit|Write',
    timeout: 30
  })
  assert.deepEqual(h.def.triggers.gemini, { event: 'AfterTool' })
  assert.equal(h.scripts['run.sh'], 'npx prettier --write "$1"\n')
})

test('REQ-HOOKS-LIB-5 a tool gets its own script copied from the shared one, and can go back to the shared one', () => {
  const home = demoHome()
  createHook(home, 'guard', {
    description: '',
    timing: 'before-tool',
    tools: ['claude', 'copilot'],
    script: 'shared\n'
  })
  const file = createHookToolScript(home, 'guard', 'copilot')
  assert.equal(file, 'run.copilot.sh')
  let h = readHook(home, 'guard')
  assert.deepEqual(h.def.toolScripts, { copilot: 'run.copilot.sh' })
  assert.equal(h.scripts['run.copilot.sh'], 'shared\n')
  assert.equal(statSync(join(libraryRoot(home), 'hooks/guard/run.copilot.sh')).mode & 0o111, 0o111)
  dropHookToolScript(home, 'guard', 'copilot')
  h = readHook(home, 'guard')
  assert.equal(h.def.toolScripts, undefined)
  assert.equal(existsSync(join(libraryRoot(home), 'hooks/guard/run.copilot.sh')), false)
})

test('REQ-HOOKS-LIB-6 hooks have per-tool on/off in illithid.json, and deleting moves the folder to the trash', () => {
  const home = demoHome()
  createHook(home, 'notify', {
    description: '',
    timing: 'stop',
    tools: ['claude', 'gemini'],
    script: 'x\n'
  })
  setToggle(home, 'hooks', 'notify', 'gemini', false)
  assert.deepEqual(readManifest(home).manifest.hooks, { notify: { gemini: false } })
  assert.throws(() => setToggle(home, 'hooks', 'notify', 'opencode', false))
  deleteHook(home, 'notify')
  assert.equal(existsSync(join(libraryRoot(home), 'hooks/notify')), false)
  assert.deepEqual(readHooks(home), [])
})
