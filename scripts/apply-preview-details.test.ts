import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { memorySecretBackend, upsertMcpServer } from '../src/engine'
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
