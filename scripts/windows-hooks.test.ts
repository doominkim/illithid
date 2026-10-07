import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHook, planHookSync, savePermissionRules, syncAll } from '../src/engine'
import { hooks as hooksView, permissions as permissionsView } from '../src/main/reads'
import { baseEnv, buildDemoHome } from './readme-shots'

// Hooks are generated as /bin/sh scripts: on Windows they are not written at all (phase 1)
before(() => {
  process.env.ILLITHID_TEST_PLATFORM = 'win32'
})
after(() => {
  delete process.env.ILLITHID_TEST_PLATFORM
})

function demoHome(tools: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-win-hooks-'))
  buildDemoHome(home, { tools: 'all' })
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), toolsInUse: tools })
  )
  return home
}

test('on Windows no hook reaches a tool and the Hooks view says why', () => {
  const home = demoHome(['claude', 'copilot'])
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ theme: 'dark' }))
  createHook(home, 'guard', { description: '', when: 'before-tool', action: 'guard', options: {} })
  // A deny rule would become Copilot's check hook on macOS
  savePermissionRules(home, {
    commands: [{ decision: 'deny', argv: ['git', 'push', '--force'], exact: false }]
  })
  assert.deepEqual(planHookSync(home, baseEnv(home)), [])
  const r = syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
  assert.equal(r.refused, undefined)
  assert.deepEqual(r.plan.errors, [])
  const settings = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'))
  assert.equal(settings.hooks, undefined)
  assert.equal(existsSync(join(home, '.claude/hooks/illithid')), false)
  assert.equal(existsSync(join(home, '.copilot/hooks/illithid.json')), false)

  const view = hooksView(home, baseEnv(home))
  assert.equal(view.platformUnsupported, true)
  const guard = view.hooks.find((h) => h.name === 'guard')!
  assert.equal(guard.tools.claude, 'notApplicable')
  assert.equal(guard.unsupported?.claude, 'windows')
  assert.equal(permissionsView(home, baseEnv(home)).tools.copilot, 'notApplicable')
})
