import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyImport,
  createHook,
  hookTriggers,
  keepHookCopy,
  pendingSyncCount,
  planImport,
  readHook,
  readManifest,
  syncAll
} from '../src/engine'
import { baseEnv, buildDemoHome } from './readme-shots'

function demoHome(tools: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-hooks-import-'))
  buildDemoHome(home, { tools: 'all' })
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), toolsInUse: tools })
  )
  mkdirSync(join(home, 'bin'), { recursive: true })
  writeFileSync(join(home, 'bin/guard.sh'), '#!/bin/sh\necho guard\n')
  return home
}

const json = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8'))
const approved = (home: string): void => {
  const r = syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
  assert.equal(r.refused, undefined)
}

test('REQ-HOOKS-IMPORT-1 Claude hooks come in as library hooks and their originals are replaced on the next sync', () => {
  const home = demoHome(['claude'])
  const settings = join(home, '.claude/settings.json')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(
    settings,
    JSON.stringify({
      theme: 'dark',
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/guard.sh', timeout: 10 }] }
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }]
      }
    })
  )
  const plan = planImport(home, 'tool:claude')
  assert.deepEqual(plan.hooks.map((c) => c.name).sort(), ['claude-stop', 'guard'])
  const guard = plan.hooks.find((c) => c.name === 'guard')!.variants[0]
  assert.equal(guard.timing, 'before-tool')
  assert.deepEqual(guard.trigger, { event: 'PreToolUse', matcher: 'Bash', timeout: 10 })

  const results = applyImport(
    home,
    plan.hooks.map((c) => ({ kind: 'hook' as const, name: c.name })),
    'tool:claude'
  )
  assert.deepEqual(
    results.map((r) => r.status),
    ['imported', 'imported']
  )
  const lib = readHook(home, 'guard')
  assert.equal(lib.doc.action, 'script')
  assert.equal(lib.doc.when, 'before-tool')
  assert.deepEqual(hookTriggers(lib.doc).claude, {
    event: 'PreToolUse',
    matcher: 'Bash',
    timeout: 10
  })
  assert.equal(lib.scripts['run.sh'], '#!/bin/sh\necho guard\n')
  assert.match(
    readHook(home, 'claude-stop').scripts['run.sh'],
    /^#!\/usr\/bin\/env bash\nsay done\n/
  )
  // Nothing on the tool side changes until the sync
  assert.equal((json(settings) as { hooks: { Stop: unknown[] } }).hooks.Stop.length, 1)

  approved(home)
  const s = json(settings) as {
    theme: string
    hooks: Record<string, { hooks: { command: string }[] }[]>
  }
  assert.equal(s.theme, 'dark')
  assert.equal(s.hooks.PreToolUse.length, 1)
  assert.match(
    s.hooks.PreToolUse[0].hooks[0].command,
    /\/\.claude\/hooks\/illithid\/guard\/run\.sh' claude$/
  )
  assert.equal(s.hooks.Stop.length, 1)
  assert.match(s.hooks.Stop[0].hooks[0].command, /illithid\/claude-stop\/run\.sh' claude$/)
  assert.ok(existsSync(join(home, 'bin/guard.sh')), 'the original script file is left alone')
  const backups = join(home, '.config/illithid/backups/imported')
  assert.ok(existsSync(backups) && readdirSync(backups).length > 0)
  assert.equal(pendingSyncCount(home, baseEnv(home)), 0)
})

test('REQ-HOOKS-IMPORT-2 a hook running the same script as a library hook joins it instead of making a new one', () => {
  const home = demoHome(['claude', 'gemini'])
  createHook(home, 'guard', {
    description: '',
    when: 'before-tool',
    action: 'script',
    options: {},
    script: '#!/bin/sh\necho guard\n'
  })
  mkdirSync(join(home, '.gemini'), { recursive: true })
  writeFileSync(
    join(home, '.gemini/settings.json'),
    JSON.stringify({
      hooks: {
        BeforeTool: [
          {
            matcher: 'run_shell_command',
            hooks: [{ name: 'g', type: 'command', command: '$HOME/bin/guard.sh', timeout: 5000 }]
          }
        ]
      }
    })
  )
  const plan = planImport(home, 'tool:gemini')
  assert.equal(plan.hooks.length, 1)
  const [c] = plan.hooks
  assert.equal(c.name, 'guard')
  assert.equal(c.variants[0].joins, 'guard')
  assert.deepEqual(c.conflicts, [])
  applyImport(home, [{ kind: 'hook', name: 'guard' }], 'tool:gemini')
  const triggers = hookTriggers(readHook(home, 'guard').doc)
  assert.deepEqual(triggers.claude, { event: 'PreToolUse' })
  assert.deepEqual(triggers.gemini, {
    event: 'BeforeTool',
    matcher: 'run_shell_command',
    timeout: 5
  })
  assert.notEqual(readManifest(home).manifest.hooks?.guard?.gemini, false)
})

test('REQ-HOOKS-IMPORT-3 a Copilot hook comes in turned off for Copilot, its original file stays', () => {
  const home = demoHome(['copilot'])
  const mine = join(home, '.copilot/hooks/mine.json')
  mkdirSync(join(home, '.copilot/hooks'), { recursive: true })
  const original = JSON.stringify({
    version: 1,
    hooks: { sessionStart: [{ type: 'command', bash: 'echo hi', timeoutSec: 3 }] }
  })
  writeFileSync(mine, original)
  const plan = planImport(home, 'tool:copilot')
  const [c] = plan.hooks
  assert.equal(c.name, 'copilot-sessionstart')
  assert.ok(c.variants[0].warnings.includes('originalKept'))
  applyImport(home, [{ kind: 'hook', name: c.name }], 'tool:copilot')
  // On only for the tool it came from, and off there too while the original file stays
  const toggles = readManifest(home).manifest.hooks[c.name]
  assert.equal(toggles.copilot, false)
  assert.ok(Object.values(toggles).every((v) => v === false))
  approved(home)
  assert.equal(readFileSync(mine, 'utf8'), original)
  assert.equal(existsSync(join(home, '.copilot/hooks/illithid.json')), false)
})

test('REQ-HOOKS-KEEP-1 a script copy edited in a tool survives automatic syncs and can be kept as the library version', () => {
  const home = demoHome(['claude'])
  createHook(home, 'fmt', {
    description: '',
    when: 'after-tool',
    action: 'script',
    options: {},
    script: 'v1\n'
  })
  approved(home)
  const copy = join(home, '.claude/hooks/illithid/fmt/run.sh')
  writeFileSync(copy, 'edited in Claude\n')
  syncAll(home, baseEnv(home), { allowReal: true })
  assert.equal(readFileSync(copy, 'utf8'), 'edited in Claude\n')
  keepHookCopy(home, 'claude', 'fmt', 'run.sh')
  assert.equal(readHook(home, 'fmt').scripts['run.sh'], 'edited in Claude\n')
  assert.equal(pendingSyncCount(home, baseEnv(home)), 0)
})

test('REQ-HOOKS-IMPORT-4 a Claude Code prompt hook comes in as a natural-language check, its prompt kept as is', () => {
  const home = demoHome(['claude', 'gemini'])
  const settings = join(home, '.claude/settings.json')
  mkdirSync(join(home, '.claude'), { recursive: true })
  const prompt = 'Check the tests. $ARGUMENTS Reply {"decision":"block"} if they fail.'
  writeFileSync(
    settings,
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt, timeout: 20 }] }] } })
  )
  const plan = planImport(home, 'tool:claude')
  const [c] = plan.hooks
  assert.equal(c.variants[0].action, 'ask')
  applyImport(home, [{ kind: 'hook', name: c.name }], 'tool:claude')
  const doc = readHook(home, c.name).doc
  assert.equal(doc.action, 'ask')
  assert.equal(doc.options.verbatim, true)
  assert.equal(doc.body.trim(), prompt)
  approved(home)
  const stop = (json(settings) as { hooks: { Stop: { hooks: Record<string, unknown>[] }[] } }).hooks
    .Stop
  assert.equal(stop.length, 1)
  assert.equal(stop[0].hooks[0].prompt, prompt)
  assert.equal(stop[0].hooks[0].timeout, 20)
  assert.equal(stop[0].hooks[0].statusMessage, `Illithid · ${c.name}`)
})

test('REQ-HOOKS-IMPORT-5 a hooks folder that is not a hook (no HOOK.md) keeps its name; the import takes the next one', () => {
  const home = demoHome(['copilot'])
  const leftover = join(home, '.illithid/workspaces/default/hooks/copilot-sessionstart')
  mkdirSync(leftover, { recursive: true })
  writeFileSync(join(leftover, 'hook.json'), '{}')
  mkdirSync(join(home, '.copilot/hooks'), { recursive: true })
  writeFileSync(
    join(home, '.copilot/hooks/mine.json'),
    JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ type: 'command', bash: 'echo hi' }] }
    })
  )
  const [c] = planImport(home, 'tool:copilot').hooks
  assert.equal(c.name, 'copilot-sessionstart-2')
  assert.equal(c.status, 'new')
  const [r] = applyImport(home, [{ kind: 'hook', name: c.name }], 'tool:copilot')
  assert.equal(r.status, 'imported')
  assert.equal(readHook(home, 'copilot-sessionstart-2').doc.when, 'session-start')
  assert.equal(readFileSync(join(leftover, 'hook.json'), 'utf8'), '{}')
})
