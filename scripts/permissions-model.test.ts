import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  commandLine,
  parseCommand,
  permissionRules,
  readPermissions,
  savePermissionRules,
  type CommandRule,
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
      { decision: 'deny', argv: ['git', 'push', '--force'], exact: false, description: 'never' },
      { decision: 'ask', argv: ['rm'], exact: false }
    ]
  }
  savePermissionRules(home, next)
  assert.deepEqual(json(home), {
    bash: [['git', 'status'], { argv: ['npm', 'test'], claudeExact: true }],
    bashAsk: [['rm']],
    bashDeny: [{ argv: ['git', 'push', '--force'], description: 'never' }],
    claudeOnly: { allow: ['WebFetch'], deny: [], ask: ['Edit'] },
    _comment: 'mine'
  })
  // Read back grouped: allow, ask, deny
  assert.deepEqual(permissionRules(readPermissions(home)!), {
    commands: [next.commands[0], next.commands[1], next.commands[3], next.commands[2]],
    groups: []
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

test('REQ-PERM-MODEL-5 a rule note from an older file reads as its description and is saved as description', () => {
  const home = demoHome()
  writeFileSync(
    file(home),
    JSON.stringify({
      bash: [],
      bashDeny: [{ argv: ['git', 'reset', '--hard'], note: 'loses work' }],
      claudeOnly: { allow: [], deny: [] }
    })
  )
  const rules = permissionRules(readPermissions(home)!)
  assert.deepEqual(rules.commands, [
    { decision: 'deny', argv: ['git', 'reset', '--hard'], exact: false, description: 'loses work' }
  ])
  savePermissionRules(home, rules)
  assert.deepEqual(json(home).bashDeny, [
    { argv: ['git', 'reset', '--hard'], description: 'loses work' }
  ])
})

test('REQ-PERM-MODEL-6 rules keep their group; groups keep their order, description and default, and a group with no rules goes', () => {
  const home = demoHome()
  const rules: PermissionRules = {
    groups: [
      { name: 'git', description: 'Hard to undo', decision: 'deny' },
      { name: 'empty', decision: 'ask' },
      { name: 'files', decision: 'ask' }
    ],
    commands: [
      { decision: 'allow', argv: ['git', 'status'], exact: false, group: 'git' },
      { decision: 'deny', argv: ['git', 'push', '--force'], exact: false, group: 'git' },
      { decision: 'ask', argv: ['rm'], exact: false, group: 'files' },
      { decision: 'deny', argv: ['shutdown'], exact: true }
    ]
  }
  savePermissionRules(home, rules)
  assert.deepEqual(json(home), {
    bash: [{ argv: ['git', 'status'], group: 'git' }],
    bashAsk: [{ argv: ['rm'], group: 'files' }],
    bashDeny: [
      { argv: ['git', 'push', '--force'], group: 'git' },
      { argv: ['shutdown'], claudeExact: true }
    ],
    claudeOnly: { allow: [], deny: [] },
    groups: [
      { name: 'git', description: 'Hard to undo', decision: 'deny' },
      { name: 'files', decision: 'ask' }
    ]
  })
  const back = permissionRules(readPermissions(home)!)
  assert.deepEqual(back.groups, [
    { name: 'git', description: 'Hard to undo', decision: 'deny' },
    { name: 'files', decision: 'ask' }
  ])
  assert.deepEqual(
    back.commands.map((r) => [r.argv.join(' '), r.group]),
    [
      ['git status', 'git'],
      ['rm', 'files'],
      ['git push --force', 'git'],
      ['shutdown', undefined]
    ]
  )
})

test('REQ-PERM-MODEL-7 a hand-written group name with no group entry still reads as a group; bad groups are refused', () => {
  const home = demoHome()
  writeFileSync(
    file(home),
    JSON.stringify({
      bash: [],
      bashDeny: [{ argv: ['dd'], group: 'disk' }],
      claudeOnly: { allow: [], deny: [] }
    })
  )
  assert.deepEqual(permissionRules(readPermissions(home)!).groups, [
    { name: 'disk', decision: 'deny' }
  ])

  const cmd: CommandRule = { decision: 'deny', argv: ['x'], exact: false }
  const bad: PermissionRules[] = [
    { groups: [{ name: ' ', decision: 'deny' }], commands: [{ ...cmd, group: ' ' }] },
    {
      groups: [
        { name: 'a', decision: 'deny' },
        { name: 'a', decision: 'ask' }
      ],
      commands: [{ ...cmd, group: 'a' }]
    },
    { groups: [], commands: [{ ...cmd, group: 'nope' }] },
    { groups: [{ name: 'a', decision: 'nope' as 'deny' }], commands: [{ ...cmd, group: 'a' }] }
  ]
  for (const rules of bad)
    assert.throws(() => savePermissionRules(home, rules), { code: 'invalidSchema' })
})

test('REQ-PERM-MODEL-8 a rule written back as a line types the same words again', () => {
  for (const argv of [
    ['git', 'push', '--force'],
    ['rm', '-rf', '/tmp/a b'],
    ['psql', '-c', 'DROP TABLE x'],
    ['echo', "it's"],
    ['echo', 'say "hi"', 'a\\b'],
    ['printf', '']
  ])
    assert.deepEqual(parseCommand(commandLine(argv)), argv)
  assert.equal(commandLine(['git', 'push', '--force']), 'git push --force')
  assert.equal(commandLine(['rm', '/tmp/a b']), "rm '/tmp/a b'")
})

test('REQ-PERM-MODEL-9 a rule keeps the tools it is off for; an unknown tool is refused', () => {
  const home = demoHome()
  savePermissionRules(home, {
    commands: [
      {
        decision: 'deny',
        argv: ['git', 'push', '--force'],
        exact: false,
        off: ['codex', 'gemini']
      },
      { decision: 'allow', argv: ['ls'], exact: false, off: [] }
    ]
  })
  assert.deepEqual(json(home).bashDeny, [
    { argv: ['git', 'push', '--force'], off: ['codex', 'gemini'] }
  ])
  assert.deepEqual(json(home).bash, [['ls']])
  assert.deepEqual(permissionRules(readPermissions(home)!).commands[1], {
    decision: 'deny',
    argv: ['git', 'push', '--force'],
    exact: false,
    off: ['codex', 'gemini']
  })
  assert.throws(
    () =>
      savePermissionRules(home, {
        commands: [{ decision: 'deny', argv: ['x'], exact: false, off: ['nope' as 'codex'] }]
      }),
    { code: 'invalidSchema' }
  )
})
