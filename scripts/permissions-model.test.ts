import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseCommand,
  permissionRules,
  readPermissions,
  savePermissionRules,
  type PermissionRules
} from '../src/engine'
import { buildDemoHome } from './readme-shots'

const LIB = '.illithid/workspaces/default'

function demoHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-perm-model-'))
  buildDemoHome(home, { tools: 'all' })
  return home
}

const file = (home: string): string => join(home, LIB, 'permissions.json')
const json = (home: string): Record<string, unknown> => JSON.parse(readFileSync(file(home), 'utf8'))

test('REQ-PERM-MODEL-1 an existing permissions.json reads as allow rules, and saving a deny rule keeps everything else as it was', () => {
  const home = demoHome()
  writeFileSync(
    file(home),
    JSON.stringify({
      bash: [['git', 'status'], { argv: ['npm', 'test'], claudeExact: true }],
      claudeOnly: { allow: ['WebFetch'], deny: [], ask: ['Edit'] },
      _comment: 'mine'
    })
  )
  const rules = permissionRules(readPermissions(home)!)
  assert.deepEqual(rules.commands, [
    { decision: 'allow', argv: ['git', 'status'], exact: false },
    { decision: 'allow', argv: ['npm', 'test'], exact: true }
  ])

  const next: PermissionRules = {
    commands: [
      ...rules.commands,
      { decision: 'deny', argv: ['git', 'push', '--force'], exact: false, note: 'never' },
      { decision: 'ask', argv: ['rm'], exact: false }
    ]
  }
  savePermissionRules(home, next)
  assert.deepEqual(json(home), {
    bash: [['git', 'status'], { argv: ['npm', 'test'], claudeExact: true }],
    bashAsk: [['rm']],
    bashDeny: [{ argv: ['git', 'push', '--force'], note: 'never' }],
    claudeOnly: { allow: ['WebFetch'], deny: [], ask: ['Edit'] },
    _comment: 'mine'
  })
  // Read back grouped: allow, ask, deny
  assert.deepEqual(permissionRules(readPermissions(home)!), {
    commands: [next.commands[0], next.commands[1], next.commands[3], next.commands[2]]
  })
})

test('REQ-PERM-MODEL-2 with no permissions.json, saving rules creates one', () => {
  const home = demoHome()
  savePermissionRules(home, {
    commands: [{ decision: 'deny', argv: ['git', 'reset', '--hard'], exact: false }]
  })
  assert.deepEqual(json(home), {
    bash: [],
    bashDeny: [['git', 'reset', '--hard']],
    claudeOnly: { allow: [], deny: [] }
  })
})

test('REQ-PERM-MODEL-3 broken or conflicting rules are refused and nothing is written', () => {
  const home = demoHome()
  savePermissionRules(home, {
    commands: [{ decision: 'allow', argv: ['ls'], exact: false }]
  })
  const before = readFileSync(file(home), 'utf8')
  const bad: PermissionRules[] = [
    { commands: [{ decision: 'deny', argv: [], exact: false }] },
    { commands: [{ decision: 'nope' as 'deny', argv: ['x'], exact: false }] },
    {
      commands: [
        { decision: 'allow', argv: ['git', 'push'], exact: false },
        { decision: 'deny', argv: ['git', 'push'], exact: false }
      ]
    }
  ]
  for (const rules of bad)
    assert.throws(() => savePermissionRules(home, rules), { code: 'invalidSchema' })
  assert.equal(readFileSync(file(home), 'utf8'), before)
  // A hand-edited file with a broken deny list is reported, not read
  writeFileSync(
    file(home),
    JSON.stringify({ bash: [], bashDeny: [[]], claudeOnly: { allow: [], deny: [] } })
  )
  assert.throws(() => readPermissions(home), { code: 'invalidSchema' })
})

test('REQ-PERM-MODEL-4 a typed command becomes argv the way a shell splits it', () => {
  assert.deepEqual(parseCommand('git push --force'), ['git', 'push', '--force'])
  assert.deepEqual(parseCommand('  rm  -rf "/tmp/a b" '), ['rm', '-rf', '/tmp/a b'])
  assert.deepEqual(parseCommand(`psql -c 'DROP TABLE x'`), ['psql', '-c', 'DROP TABLE x'])
  assert.deepEqual(parseCommand(''), [])
})
