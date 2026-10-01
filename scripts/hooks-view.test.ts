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

test('REQ-HOOKS-VIEW-1 the hooks list shows each connected tool as waiting for sync, then synced', () => {
  const home = demoHome(['claude', 'codex', 'gemini'])
  createHook(home, 'notify', {
    description: 'Ping me',
    timing: 'stop',
    tools: ['claude', 'gemini'],
    script: 'exit 0\n'
  })
  let data = hooks(home, baseEnv(home))
  assert.equal(data.error, undefined)
  const [h] = data.hooks
  assert.equal(h.name, 'notify')
  assert.equal(h.description, 'Ping me')
  assert.equal(h.timing, 'stop')
  assert.deepEqual(h.tools, { claude: 'needsSync', gemini: 'needsSync', codex: 'notApplicable' })
  syncAll(home, baseEnv(home), { allowReal: true })
  data = hooks(home, baseEnv(home))
  assert.deepEqual(data.hooks[0].tools, {
    claude: 'synced',
    gemini: 'synced',
    codex: 'notApplicable'
  })
})
