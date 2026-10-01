import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import {
  createHook,
  createHookToolScript,
  deleteHook,
  pendingSyncCount,
  readHook,
  saveHookDef,
  setToggle,
  syncAll
} from '../src/engine'
import { applyPreview } from '../src/main/preview'
import { baseEnv, buildDemoHome } from './readme-shots'

function demoHome(tools: string[] = ['claude', 'codex', 'gemini', 'copilot']): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-hooks-sync-'))
  buildDemoHome(home, { tools: 'all' })
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), toolsInUse: tools })
  )
  return home
}

const sync = (home: string): void => {
  const r = syncAll(home, baseEnv(home), { allowReal: true })
  assert.equal(r.refused, undefined)
  assert.deepEqual(r.plan.errors, [])
}

const json = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8'))

test('REQ-HOOKS-SYNC-1 Claude gets its own entry next to the user hooks, and an executable script copy', () => {
  const home = demoHome()
  const settings = join(home, '.claude/settings.json')
  mkdirSync(join(home, '.claude'), { recursive: true })
  const userHook = { matcher: 'Write', hooks: [{ type: 'command', command: '~/bin/mine.sh' }] }
  writeFileSync(
    settings,
    JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [userHook] } }, null, 2)
  )
  createHook(home, 'guard', {
    description: '',
    timing: 'before-tool',
    tools: ['claude'],
    script: '#!/bin/sh\nexit 0\n'
  })
  const def = readHook(home, 'guard').def
  saveHookDef(home, 'guard', {
    ...def,
    triggers: { claude: { event: 'PreToolUse', matcher: 'Bash', timeout: 10 } }
  })
  sync(home)
  const s = json(settings) as { theme: string; hooks: { PreToolUse: unknown[] } }
  const copy = join(home, '.claude/hooks/illithid/guard/run.sh')
  assert.equal(s.theme, 'dark')
  assert.deepEqual(s.hooks.PreToolUse, [
    userHook,
    { matcher: 'Bash', hooks: [{ type: 'command', command: `'${copy}' claude`, timeout: 10 }] }
  ])
  assert.equal(readFileSync(copy, 'utf8'), '#!/bin/sh\nexit 0\n')
  assert.equal(statSync(copy).mode & 0o777, 0o755)
})

test('REQ-HOOKS-SYNC-2 each tool gets its own format: Gemini ms and a name, Copilot a flat list, Codex a TOML block', () => {
  const home = demoHome()
  const codexToml = join(home, '.codex/config.toml')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(codexToml, 'model = "gpt-5"\n')
  createHook(home, 'fmt', {
    description: '',
    timing: 'after-tool',
    tools: ['codex', 'gemini', 'copilot'],
    script: 'exit 0\n'
  })
  const def = readHook(home, 'fmt').def
  saveHookDef(home, 'fmt', {
    ...def,
    triggers: {
      codex: { event: 'PostToolUse', matcher: 'apply_patch', timeout: 30 },
      gemini: { event: 'AfterTool', matcher: 'write_file|replace', timeout: 30 },
      copilot: { event: 'postToolUse', matcher: 'edit', timeout: 30 }
    }
  })
  sync(home)
  const copy = (tool: string): string =>
    `'${join(home, `.${tool}/hooks/illithid/fmt/run.sh`)}' ${tool}`
  const gemini = json(join(home, '.gemini/settings.json')) as { hooks: Record<string, unknown> }
  assert.deepEqual(gemini.hooks.AfterTool, [
    {
      matcher: 'write_file|replace',
      hooks: [{ name: 'illithid-fmt', type: 'command', command: copy('gemini'), timeout: 30000 }]
    }
  ])
  assert.deepEqual(json(join(home, '.copilot/hooks/illithid.json')), {
    version: 1,
    hooks: {
      postToolUse: [{ type: 'command', bash: copy('copilot'), matcher: 'edit', timeoutSec: 30 }]
    }
  })
  // smol-toml returns null-prototype objects; compare plain values
  const toml = JSON.parse(JSON.stringify(parseToml(readFileSync(codexToml, 'utf8')))) as Record<
    string,
    unknown
  >
  assert.equal(toml.model, 'gpt-5')
  assert.deepEqual(toml.hooks, {
    PostToolUse: [
      { matcher: 'apply_patch', hooks: [{ type: 'command', command: copy('codex'), timeout: 30 }] }
    ]
  })
  for (const tool of ['codex', 'gemini', 'copilot'])
    assert.ok(existsSync(join(home, `.${tool}/hooks/illithid/fmt/run.sh`)), tool)
  assert.equal(pendingSyncCount(home, baseEnv(home)), 0)
})

test('REQ-HOOKS-SYNC-3 turning a tool off or deleting the hook removes only the app entry and backs up the script copy', () => {
  const home = demoHome()
  const settings = join(home, '.claude/settings.json')
  mkdirSync(join(home, '.claude'), { recursive: true })
  const userHook = { hooks: [{ type: 'command', command: 'say done' }] }
  writeFileSync(settings, JSON.stringify({ hooks: { Stop: [userHook] } }, null, 2))
  createHook(home, 'notify', {
    description: '',
    timing: 'stop',
    tools: ['claude', 'gemini'],
    script: 'exit 0\n'
  })
  sync(home)
  assert.equal((json(settings) as { hooks: { Stop: unknown[] } }).hooks.Stop.length, 2)
  setToggle(home, 'hooks', 'notify', 'claude', false)
  assert.ok(pendingSyncCount(home, baseEnv(home)) > 0)
  sync(home)
  assert.deepEqual((json(settings) as { hooks: unknown }).hooks, { Stop: [userHook] })
  assert.equal(existsSync(join(home, '.claude/hooks/illithid/notify/run.sh')), false)
  assert.ok(existsSync(join(home, '.config/illithid/backups/deleted')))
  deleteHook(home, 'notify')
  sync(home)
  assert.equal((json(join(home, '.gemini/settings.json')) as { hooks?: unknown }).hooks, undefined)
  assert.equal(existsSync(join(home, '.gemini/hooks/illithid/notify/run.sh')), false)
  assert.equal(pendingSyncCount(home, baseEnv(home)), 0)
})

test('REQ-HOOKS-SYNC-4 a tool-specific script is copied and run only for that tool', () => {
  const home = demoHome()
  createHook(home, 'guard', {
    description: '',
    timing: 'before-tool',
    tools: ['claude', 'copilot'],
    script: 'shared\n'
  })
  createHookToolScript(home, 'guard', 'copilot')
  sync(home)
  const flat = json(join(home, '.copilot/hooks/illithid.json')) as {
    hooks: { preToolUse: { bash: string }[] }
  }
  assert.equal(
    flat.hooks.preToolUse[0].bash,
    `'${join(home, '.copilot/hooks/illithid/guard/run.copilot.sh')}' copilot`
  )
  assert.ok(existsSync(join(home, '.copilot/hooks/illithid/guard/run.copilot.sh')))
  assert.equal(existsSync(join(home, '.copilot/hooks/illithid/guard/run.sh')), false)
  assert.ok(existsSync(join(home, '.claude/hooks/illithid/guard/run.sh')))
})

test('REQ-HOOKS-SYNC-5 Grok runs Claude Code hooks by default, so it gets its own entry only when it stops reading them', () => {
  const home = demoHome(['claude', 'grok'])
  createHook(home, 'notify', {
    description: '',
    timing: 'stop',
    tools: ['claude', 'grok'],
    script: 'exit 0\n'
  })
  sync(home)
  assert.ok(existsSync(join(home, '.claude/hooks/illithid/notify/run.sh')))
  assert.equal(existsSync(join(home, '.grok/hooks/illithid.json')), false)
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(cfg, JSON.stringify({ ...json(cfg), grokReadsClaude: false }))
  sync(home)
  const grok = json(join(home, '.grok/hooks/illithid.json')) as { hooks: { Stop: unknown[] } }
  assert.deepEqual(grok.hooks.Stop, [
    {
      hooks: [
        { type: 'command', command: `'${join(home, '.grok/hooks/illithid/notify/run.sh')}' grok` }
      ]
    }
  ])
  const compat = parseToml(readFileSync(join(home, '.grok/config.toml'), 'utf8')) as {
    compat: { claude: Record<string, boolean> }
  }
  assert.equal(compat.compat.claude.hooks, false)
  assert.equal(pendingSyncCount(home, baseEnv(home)), 0)
})

test('REQ-HOOKS-SYNC-6 the apply preview lists hook entries and script copies; an approved apply restores a copy edited in the tool after a backup', () => {
  const home = demoHome()
  createHook(home, 'guard', {
    description: '',
    timing: 'before-tool',
    tools: ['claude', 'codex'],
    script: 'v1\n'
  })
  let view = applyPreview(home, baseEnv(home))
  const rows = (tool: string): string[] =>
    view.items.filter((x) => x.tool === tool).map((x) => `${x.kind}:${x.action}:${x.name}`)
  assert.ok(rows('claude').includes('hook:add:guard'), rows('claude').join(' '))
  assert.ok(rows('claude').includes('hookScript:add:guard/run.sh'), rows('claude').join(' '))
  assert.ok(view.items.some((x) => x.tool === 'codex' && x.kind === 'hook' && x.codexTrust))
  sync(home)
  const copy = join(home, '.claude/hooks/illithid/guard/run.sh')
  writeFileSync(copy, 'edited in the tool\n')
  view = applyPreview(home, baseEnv(home))
  assert.ok(rows('claude').includes('hookScript:update:guard/run.sh'), rows('claude').join(' '))
  // Automatic syncs leave the edited copy for the preview; an approved apply restores the library version
  sync(home)
  assert.equal(readFileSync(copy, 'utf8'), 'edited in the tool\n')
  syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
  assert.equal(readFileSync(copy, 'utf8'), 'v1\n')
  assert.equal(
    readFileSync(join(home, '.config/illithid/backups/hooks/claude/guard/run.sh'), 'utf8'),
    'edited in the tool\n'
  )
})
