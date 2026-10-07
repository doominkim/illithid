import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { memorySecretBackend, syncAll, upsertMcpServer } from '../src/engine'
import { applyPreview } from '../src/main/preview'
import { baseEnv, buildDemoHome } from './readme-shots'

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'illithid-preview-details-'))
  buildDemoHome(h, { tools: 'all' })
  const path = join(h, '.config/illithid/config.json')
  writeFileSync(
    path,
    JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), toolsInUse: ['claude'] })
  )
  return h
}

test('apply preview names an MCP server that cannot be generated before the user applies', () => {
  const h = home()
  upsertMcpServer(h, 'unresolved-demo', {
    transport: 'stdio',
    command: 'fixture-mcp',
    env: { DEMO: 'secret:unresolved-demo/env/DEMO' }
  })
  const view = applyPreview(h, baseEnv(h), memorySecretBackend())
  assert.ok(view.errors.some((e) => e.includes('unresolved-demo') && e.includes('DEMO')))
  assert.ok(!JSON.stringify(view).includes('postgres://localhost:5432/demo'))
})

test('apply preview shows the actual generated MCP deny rule without exposing configuration values', () => {
  const h = home()
  upsertMcpServer(h, 'policy-demo', {
    transport: 'stdio',
    command: 'fixture-mcp',
    permissions: { default: 'deny' }
  })
  const view = applyPreview(h, baseEnv(h), memorySecretBackend())
  assert.ok(
    view.policies?.some(
      (p) =>
        p.tool === 'claude' && p.key === 'permissions.deny' && p.after.includes('mcp__policy-demo')
    )
  )
})

test('OpenCode permission rule reordering is visible even when individual actions stay equal', () => {
  const h = home()
  const config = join(h, '.config/illithid/config.json')
  writeFileSync(
    config,
    JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), toolsInUse: ['opencode'] })
  )
  const target = join(h, '.config/opencode/opencode.json')
  writeFileSync(target, JSON.stringify({ permission: { demo_read: 'allow', 'demo_*': 'deny' } }))
  upsertMcpServer(h, 'demo', {
    transport: 'stdio',
    command: 'fixture-mcp',
    permissions: { default: 'deny', tools: { read: 'allow' } }
  })
  const view = applyPreview(h, baseEnv(h), memorySecretBackend())
  assert.ok(
    view.policies?.some(
      (p) =>
        p.tool === 'opencode' && p.before[0] === 'demo_read: allow' && p.after[0] === 'demo_*: deny'
    )
  )
})

test('apply preview carries no conversion notes, even when the targets log some', () => {
  const h = home()
  const cfg = join(h, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({
      ...JSON.parse(readFileSync(cfg, 'utf8')),
      toolsInUse: ['claude', 'codex', 'opencode', 'gemini']
    })
  )
  // A library server already in Codex outside the markers: the Codex target logs that it takes it over
  writeFileSync(
    join(h, '.codex/config.toml'),
    'model = "gpt-5.5"\n\n[mcp_servers.playwright]\ncommand = "npx"\nargs = ["old"]\n'
  )
  const view = applyPreview(h, baseEnv(h), memorySecretBackend())
  assert.ok(view.items.some((i) => i.path === '~/.codex/config.toml'))
  assert.equal('notes' in view, false)
})

test('turning a tool on lists no OpenCode library reads; editing a library rule still does', () => {
  const h = home()
  const cfg = join(h, '.config/illithid/config.json')
  const setTools = (toolsInUse: string[]): void =>
    writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), toolsInUse }))
  setTools(['claude', 'opencode'])
  const r = syncAll(h, baseEnv(h), { allowReal: true, approvedOnce: true })
  assert.deepEqual(r.plan.errors, [])
  // Grok gets every rule and skill copied for the first time: the library itself is unchanged
  setTools(['claude', 'opencode', 'grok'])
  const added = applyPreview(h, baseEnv(h), memorySecretBackend())
  assert.ok(added.items.some((i) => i.tool === 'grok' && i.kind === 'rule' && i.action === 'add'))
  assert.deepEqual(added.libraryDirect, [])
  // A changed library rule reaches OpenCode by itself
  const rule = join(h, '.illithid/workspaces/default/rules/00-communication.md')
  writeFileSync(rule, readFileSync(rule, 'utf8') + '- Be brief.\n')
  const edited = applyPreview(h, baseEnv(h), memorySecretBackend())
  assert.deepEqual(
    edited.libraryDirect.map((x) => `${x.kind}:${x.name}`),
    ['rule:00-communication.md']
  )
})
