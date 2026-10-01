import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHook, syncAll } from '../src/engine'
import { hooks } from '../src/main/reads'
import { baseEnv, buildDemoHome } from './readme-shots'

function demoHome(tools: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-hooks-view-'))
  buildDemoHome(home, { tools: 'all' })
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), toolsInUse: tools })
  )
  return home
}

test('REQ-HOOKS-VIEW-1 the hooks list shows each tool that can run the hook as waiting for sync, then synced', () => {
  const home = demoHome(['claude', 'codex', 'gemini'])
  createHook(home, 'notify', {
    description: 'Ping me',
    when: 'stop',
    action: 'notify',
    options: { message: 'Done' }
  })
  let data = hooks(home, baseEnv(home))
  assert.equal(data.error, undefined)
  const [h] = data.hooks
  assert.equal(h.name, 'notify')
  assert.equal(h.description, 'Ping me')
  assert.equal(h.when, 'stop')
  assert.equal(h.action, 'notify')
  assert.deepEqual(h.options, {
    title: 'Illithid',
    message: 'Done',
    sound: false,
    channel: 'mac',
    urlEnv: '',
    project: true
  })
  assert.equal(h.unsupported, undefined)
  assert.deepEqual(h.tools, { claude: 'needsSync', codex: 'needsSync', gemini: 'needsSync' })
  syncAll(home, baseEnv(home), { allowReal: true })
  data = hooks(home, baseEnv(home))
  assert.deepEqual(data.hooks[0].tools, { claude: 'synced', codex: 'synced', gemini: 'synced' })
})

test('REQ-HOOKS-VIEW-2 a tool that cannot run the action is not applicable, with the reason', () => {
  const home = demoHome(['claude', 'codex', 'gemini'])
  createHook(home, 'fmt', { description: '', when: 'after-tool', action: 'format', options: {} })
  createHook(home, 'tests', {
    description: '',
    when: 'stop',
    action: 'ask',
    options: {},
    body: 'Keep going until the tests pass.'
  })
  const data = hooks(home, baseEnv(home))
  const fmt = data.hooks.find((h) => h.name === 'fmt')!
  assert.deepEqual(fmt.unsupported, { codex: 'noFilePath' })
  assert.equal(fmt.tools.codex, 'notApplicable')
  assert.equal(fmt.tools.gemini, 'needsSync')
  const ask = data.hooks.find((h) => h.name === 'tests')!
  // An AI check runs everywhere now (a judging script outside Claude Code)
  assert.equal(ask.unsupported, undefined)
  assert.equal(ask.tools.claude, 'needsSync')
  assert.equal(ask.tools.codex, 'needsSync')
})
