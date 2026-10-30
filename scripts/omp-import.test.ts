import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  applyImport,
  createRule,
  planImport,
  readManifest,
  readMcpServer,
  readPermissions,
  readRule
} from '../src/engine'
import { copyRuleContent } from '../src/engine/ruleSync'
import { readState } from '../src/engine/state'
import { buildDemoHome } from './readme-shots'

function ompHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-omp-import-'))
  buildDemoHome(home)
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), toolsInUse: ['omp'] })
  )
  mkdirSync(join(home, '.omp/agent'), { recursive: true })
  return home
}
function put(home: string, rel: string, text: string): string {
  const p = join(home, '.omp/agent', rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
  return p
}

test('omp always-on rules import, become app copies, and are not offered again', () => {
  const home = ompHome()
  const original = put(home, 'rules/style.md', '---\nalwaysApply: true\n---\n\n# Style\n\nTabs.\n')
  put(home, 'rules/legacy.mdc', '---\nalwaysApply: true\n---\n\nOld rule.\n')
  put(home, 'rules/notes.txt', 'not a rule\n')
  const plan = planImport(home, 'tool:omp')
  const style = plan.rules.find((r) => r.name === 'style.md')
  assert.equal(style?.portability, 'ok', JSON.stringify(style))
  assert.ok(
    plan.rules.some((r) => r.name === 'legacy.md'),
    'a .mdc rule comes in as <name>.md'
  )
  assert.ok(!plan.rules.some((r) => r.name.startsWith('notes')))

  const result = applyImport(
    home,
    [
      { kind: 'rule', name: 'style.md' },
      { kind: 'rule', name: 'legacy.md' }
    ],
    'tool:omp'
  )
  const byName = Object.fromEntries(result.map((r) => [r.name, r]))
  assert.equal(byName['style.md'].status, 'imported', JSON.stringify(result))
  // Same bytes as the copy sync would write at the same path: adopted, the original stays in place
  assert.deepEqual(byName['style.md'].adopted, ['omp'])
  assert.equal(readFileSync(original, 'utf8'), readRule(home, 'style.md'))
  assert.ok(readState(home).state.toolRules?.omp?.['style.md'])
  // The .mdc original would load next to the app's legacy.md copy: retired on the next sync
  assert.deepEqual(byName['legacy.md'].converted, ['omp'])
  // Imported rules start on for omp only
  const m = readManifest(home).manifest.rules['style.md']
  assert.notEqual(m?.omp, false)
  assert.equal(m?.claude, false)

  const again = planImport(home, 'tool:omp')
  assert.ok(!again.rules.some((r) => r.name === 'style.md'), JSON.stringify(again.rules))
})

test('an omp rule that is not always-on is warned, and its original is kept as a user file', () => {
  const home = ompHome()
  const conditional =
    '---\ndescription: Read when touching SQL\nglobs: ["**/*.sql"]\n---\n\nUse CTEs.\n'
  const original = put(home, 'rules/sql.md', conditional)
  put(home, 'rules/trigger.md', '---\ncondition: "git push --force"\n---\n\nNever force push.\n')
  put(home, 'rules/off.md', '---\nalwaysApply: true\nenabled: false\n---\n\nDisabled.\n')
  put(home, 'rules/bare.md', 'No frontmatter: omp never uses it.\n')
  const plan = planImport(home, 'tool:omp')
  for (const name of ['sql.md', 'trigger.md', 'off.md', 'bare.md']) {
    const c = plan.rules.find((r) => r.name === name)
    assert.equal(c?.portability, 'warn', name)
    assert.ok(c?.reasons.includes('conditionalRule'), name)
  }
  const [r] = applyImport(home, [{ kind: 'rule', name: 'sql.md' }], 'tool:omp')
  assert.equal(r.status, 'imported', JSON.stringify(r))
  // The app copy would add alwaysApply: true — replacing the original would turn it always-on, so it stays the user's
  assert.deepEqual(r.userOwned, ['omp'])
  assert.equal(r.converted, undefined)
  assert.equal(readFileSync(original, 'utf8'), conditional)
  assert.equal(readState(home).state.toolRules?.omp?.['sql.md'], undefined)
})

test('copies of library rules and the memory copy in ~/.omp/agent/rules are not import material', () => {
  const home = ompHome()
  createRule(home, 'team.md', '# Team\n\nBe kind.\n')
  // An untracked file equal to what sync writes for the library rule, and the app's memory index copy
  put(home, 'rules/team.md', copyRuleContent('omp', '# Team\n\nBe kind.\n'))
  put(home, 'rules/illithid-memory.md', '# Memory\n')
  const plan = planImport(home, 'tool:omp')
  assert.deepEqual(
    plan.rules.map((r) => r.name),
    [],
    JSON.stringify(plan.rules.map((r) => r.variants[0].path))
  )
})

test('~/.omp/agent/AGENTS.md and RULES.md come in as tool notes, all tools off', () => {
  const home = ompHome()
  const agentsMd = put(home, 'AGENTS.md', '# My omp notes\n\nPrefer bun.\n')
  put(home, 'RULES.md', 'Always run tests.\n')
  const plan = planImport(home, 'tool:omp')
  for (const name of ['omp-agents-md.md', 'omp-rules-md.md']) {
    const c = plan.rules.find((r) => r.name === name)
    assert.equal(c?.portability, 'warn', name)
    assert.deepEqual(c?.reasons, ['toolNotes'])
  }
  const [r] = applyImport(home, [{ kind: 'rule', name: 'omp-agents-md.md' }], 'tool:omp')
  assert.equal(r.status, 'imported', JSON.stringify(r))
  assert.equal(r.converted, undefined)
  assert.equal(readRule(home, 'omp-agents-md.md'), '# My omp notes\n\nPrefer bun.\n')
  assert.ok(existsSync(agentsMd), 'copied, never moved')
  const m = readManifest(home).manifest.rules['omp-agents-md.md'] ?? {}
  assert.ok(!Object.values(m).some((v) => v === true), JSON.stringify(m))
})

test('omp mcp.json servers convert to library servers; omp-only keys are reported', () => {
  const home = ompHome()
  const source = JSON.stringify({
    $schema: 'https://example.invalid/mcp-schema.json',
    disabledServers: ['remote'],
    mcpServers: {
      local: {
        command: 'npx',
        args: ['-y', 'some-mcp'],
        env: { API_KEY: 'sk-live-abcdef1234567890abcdef' },
        cwd: '/tmp',
        timeout: 30000
      },
      remote: {
        type: 'sse',
        url: 'https://mcp.example.com/sse',
        headers: { Authorization: 'Bearer ${REMOTE_TOKEN}' },
        auth: { type: 'oauth' }
      },
      broken: { type: 'http' }
    }
  })
  const path = put(home, 'mcp.json', source)
  const plan = planImport(home, 'tool:omp')
  const local = plan.mcp.find((x) => x.name === 'local')?.variants[0]
  assert.ok(local)
  assert.equal(local.server.transport, 'stdio')
  assert.equal(local.server.command, 'npx')
  assert.deepEqual(local.server.args, ['-y', 'some-mcp'])
  assert.equal(local.server.timeoutMs, 30000)
  // The literal env value never appears in the plan
  assert.match(String(local.server.env?.API_KEY), /^\$\{/)
  assert.ok(local.warnings.includes('dropped cwd (no library equivalent)'), local.warnings.join())
  const remote = plan.mcp.find((x) => x.name === 'remote')?.variants[0]
  assert.equal(remote?.server.transport, 'http')
  assert.equal(remote?.server.url, 'https://mcp.example.com/sse')
  assert.ok(remote?.warnings.some((w) => w.includes('sse')))
  assert.ok(remote?.warnings.includes('dropped auth (no library equivalent)'))
  assert.ok(remote?.warnings.includes('was disabled in omp (disabledServers)'))
  assert.ok(!plan.mcp.some((x) => x.name === 'broken'))

  const [r] = applyImport(home, [{ kind: 'mcp', name: 'local', replace: [] }], 'tool:omp')
  assert.equal(r.status, 'imported', JSON.stringify(r))
  assert.equal(readMcpServer(home, 'local').command, 'npx')
  assert.equal(readFileSync(path, 'utf8'), source, 'import never rewrites mcp.json')
})

test('omp bash.patterns become library command rules; other wildcards are warned', () => {
  const home = ompHome()
  put(
    home,
    'config.yml',
    [
      '# my settings',
      'tools:',
      '  approval:',
      '    mcp__github_delete_repo: deny',
      'bash:',
      '  patterns:',
      '    - { match: "git push --force", approval: deny }',
      '    - { match: "git push --force *", approval: deny }',
      '    - { match: "rm *", approval: prompt }',
      '    - { match: "git   status", approval: allow }',
      '    - { match: "git status *", approval: allow }',
      '    - { match: "npm test", approval: allow }',
      '    - { match: "ls *", approval: deny }',
      '    - { match: "ls", approval: allow }',
      '    - { match: "curl *://evil*", approval: deny }',
      '    - { match: "npm test", approval: deny }',
      ''
    ].join('\n')
  )
  const plan = planImport(home, 'tool:omp')
  assert.equal(plan.permissions.length, 1, JSON.stringify(plan.notes))
  const v = plan.permissions[0].variants[0]
  assert.deepEqual(v.allowlist, {
    bash: [
      ['git', 'status'],
      { argv: ['npm', 'test'], claudeExact: true },
      { argv: ['ls'], claudeExact: true }
    ],
    bashAsk: [['rm']],
    bashDeny: [['git', 'push', '--force'], ['ls']],
    claudeOnly: { allow: [], deny: [] }
  })
  assert.ok(
    v.warnings.some((w) => w.includes('curl *://evil*')),
    v.warnings.join('\n')
  )
  assert.ok(
    plan.notes.some((n) => n.includes('tools.approval')),
    plan.notes.join('\n')
  )

  const [r] = applyImport(
    home,
    [{ kind: 'permissions', name: 'permissions', overwrite: true }],
    'tool:omp'
  )
  assert.equal(r.status, 'imported', JSON.stringify(r))
  const lib = readPermissions(home)
  assert.deepEqual(lib?.bashDeny, [['git', 'push', '--force'], ['ls']])
  assert.deepEqual(lib?.bashAsk, [['rm']])
})

test('omp agents import with model and thinking level; restricted agents are refused', () => {
  const home = ompHome()
  put(
    home,
    'agents/helper.md',
    '---\nname: helper\ndescription: Helps\nmodel: [anthropic/claude-sonnet-5, openai/gpt-6-sol]\nthinking-level: high\nblocking: true\n---\n\nYou help.\n'
  )
  put(
    home,
    'agents/plain.md',
    '---\nname: plain\ndescription: Plain\nmodel: "a/b, c/d"\n---\n\nBody\n'
  )
  put(
    home,
    'agents/narrow.md',
    '---\nname: narrow\ndescription: Narrow\ntools: [read, grep]\n---\n\nRead only.\n'
  )
  put(
    home,
    'agents/spawner.md',
    '---\nname: spawner\ndescription: Spawns\nspawns: [scout]\n---\n\nDelegate.\n'
  )
  put(home, 'agents/renamed.md', '---\nname: other\ndescription: Renamed\n---\n\nBody\n')
  const plan = planImport(home, 'tool:omp')
  const agent = (n: string): (typeof plan.agents)[number] | undefined =>
    plan.agents.find((a) => a.name === n)
  const helper = agent('helper')?.variants[0]
  assert.equal(helper?.model, 'anthropic/claude-sonnet-5')
  assert.equal(helper?.effort, 'high')
  assert.deepEqual(helper?.warnings, ['blocking', 'model fallbacks'])
  assert.equal(helper?.portability, 'warn')
  assert.equal(agent('plain')?.variants[0].model, 'a/b')
  for (const n of ['narrow', 'spawner']) {
    assert.equal(agent(n)?.portability, 'toolOnly', n)
    assert.ok(agent(n)?.reasons.includes('restrictedAgent'), n)
  }
  assert.ok(agent('renamed')?.reasons.includes('nameMismatch'))

  const result = applyImport(
    home,
    [
      { kind: 'agent', name: 'helper' },
      { kind: 'agent', name: 'narrow' }
    ],
    'tool:omp'
  )
  assert.equal(result[0].status, 'imported', JSON.stringify(result))
  assert.equal(result[1].status, 'refused')
  const lib = readFileSync(join(home, '.illithid/workspaces/default/agents/helper.md'), 'utf8')
  assert.match(lib, /omp:\n\s+model: anthropic\/claude-sonnet-5\n\s+effort: high/)
})
