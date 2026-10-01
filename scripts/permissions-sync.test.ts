import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { pendingSyncCount, savePermissionRules, syncAll, type PermissionRules } from '../src/engine'
import { baseEnv, buildDemoHome } from './readme-shots'

function demoHome(tools: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-perm-sync-'))
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

const RULES: PermissionRules = {
  commands: [
    { decision: 'allow', argv: ['git', 'status'], exact: false },
    { decision: 'allow', argv: ['npm', 'test'], exact: true },
    { decision: 'ask', argv: ['rm'], exact: false },
    { decision: 'deny', argv: ['git', 'push', '--force'], exact: false }
  ],
  mcp: []
}

test('REQ-PERM-SYNC-1 Claude Code gets allow, ask and deny Bash rules next to its own keys', () => {
  const home = demoHome(['claude'])
  const settings = join(home, '.claude/settings.json')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(settings, JSON.stringify({ theme: 'dark', permissions: { defaultMode: 'plan' } }))
  savePermissionRules(home, RULES)
  sync(home)
  const s = JSON.parse(readFileSync(settings, 'utf8')) as {
    theme: string
    permissions: Record<string, unknown>
  }
  assert.equal(s.theme, 'dark')
  assert.deepEqual(s.permissions, {
    defaultMode: 'plan',
    allow: ['Bash(git status:*)', 'Bash(npm test)'],
    deny: ['Bash(git push --force:*)'],
    ask: ['Bash(rm:*)']
  })
  assert.equal(pendingSyncCount(home, baseEnv(home)), 0)
})

test('REQ-PERM-SYNC-2 Codex gets prefix rules with allow, prompt and forbidden; hand-written rules stay', () => {
  const home = demoHome(['codex'])
  const rules = join(home, '.codex/rules/default.rules')
  mkdirSync(join(home, '.codex/rules'), { recursive: true })
  writeFileSync(rules, 'prefix_rule(pattern=["ls"], decision="allow")\n')
  savePermissionRules(home, RULES)
  sync(home)
  const text = readFileSync(rules, 'utf8')
  assert.match(text, /^prefix_rule\(pattern=\["ls"\], decision="allow"\)\n/)
  for (const line of [
    'prefix_rule(pattern=["git", "status"], decision="allow")',
    'prefix_rule(pattern=["npm", "test"], decision="allow")',
    'prefix_rule(pattern=["rm"], decision="prompt")',
    'prefix_rule(pattern=["git", "push", "--force"], decision="forbidden")'
  ])
    assert.ok(text.includes(line), line)
})

test('REQ-PERM-SYNC-3 Gemini CLI gets its own policy file: a word-bounded regex per rule, deny above ask above allow', () => {
  const home = demoHome(['gemini'])
  savePermissionRules(home, RULES)
  sync(home)
  const file = join(home, '.gemini/policies/illithid.toml')
  const policy = JSON.parse(JSON.stringify(parseToml(readFileSync(file, 'utf8')))) as {
    rule: { toolName: string; commandRegex: string; decision: string; priority: number }[]
  }
  assert.deepEqual(policy.rule, [
    {
      toolName: 'run_shell_command',
      commandRegex: '^git push --force(\\s|$)',
      decision: 'deny',
      priority: 300
    },
    {
      toolName: 'run_shell_command',
      commandRegex: '^rm(\\s|$)',
      decision: 'ask_user',
      priority: 200
    },
    {
      toolName: 'run_shell_command',
      commandRegex: '^git status(\\s|$)',
      decision: 'allow',
      priority: 100
    },
    { toolName: 'run_shell_command', commandRegex: '^npm test$', decision: 'allow', priority: 100 }
  ])
  const re = new RegExp(policy.rule[0].commandRegex)
  assert.ok(re.test('git push --force origin main'))
  assert.ok(!re.test('git push --force-with-lease'))
  assert.equal(pendingSyncCount(home, baseEnv(home)), 0)
  // No rules left: the app's file goes empty
  savePermissionRules(home, { commands: [], mcp: [] })
  sync(home)
  assert.equal((parseToml(readFileSync(file, 'utf8')) as { rule?: unknown[] }).rule, undefined)
})

test('REQ-PERM-SYNC-4 Copilot keeps no deny rules, so deny rules become an Illithid check hook that blocks them', () => {
  const home = demoHome(['copilot'])
  savePermissionRules(home, RULES)
  sync(home)
  const hooks = JSON.parse(readFileSync(join(home, '.copilot/hooks/illithid.json'), 'utf8')) as {
    hooks: { preToolUse: { bash: string }[] }
  }
  const copy = join(home, '.copilot/hooks/illithid/_permissions/run.sh')
  assert.deepEqual(hooks.hooks.preToolUse, [
    { type: 'command', bash: `'${copy}' copilot`, matcher: 'bash' }
  ])
  const run = (command: string): number =>
    spawnSync(copy, ['copilot'], {
      input: JSON.stringify({ toolName: 'bash', toolArgs: JSON.stringify({ command }) }),
      encoding: 'utf8'
    }).status ?? -1
  assert.equal(run('git push --force origin main'), 2)
  assert.equal(run('cd x && git push --force'), 2)
  assert.equal(run('git push --force-with-lease'), 0)
  assert.equal(run('git status'), 0)
  assert.equal(pendingSyncCount(home, baseEnv(home)), 0)
  // No deny rules: the check hook and its copy go
  savePermissionRules(home, {
    commands: RULES.commands.filter((r) => r.decision !== 'deny'),
    mcp: []
  })
  sync(home)
  assert.equal(existsSync(copy), false)
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, '.copilot/hooks/illithid.json'), 'utf8')).hooks,
    {}
  )
})
