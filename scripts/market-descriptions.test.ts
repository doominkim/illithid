import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRuleDescriptions } from '../src/engine'
import { commitMcp, commitRule, type RegistryServer } from '../src/engine/market'
import { buildDemoHome } from './readme-shots'

const LIB = '.illithid/workspaces/default'

test('REQ-MARKET-DESC-1 a rule or MCP server installed from the market keeps the market description', () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-market-desc-'))
  buildDemoHome(home, { tools: 'all' })

  const item = {
    id: 'go',
    title: 'Go',
    description: 'Go coding rules',
    path: 'instructions/go.instructions.md'
  }
  commitRule(home, { item, body: '# Go\n\nUse gofmt.\n', name: 'go.md' }, 'go.md')
  assert.equal(readFileSync(join(home, LIB, 'rules/go.md'), 'utf8'), '# Go\n\nUse gofmt.\n')
  assert.equal(readRuleDescriptions(home)['go.md'], 'Go coding rules')
  // An update brings the market's newer description
  commitRule(
    home,
    { item: { ...item, description: 'Go rules v2' }, body: '# Go 2\n', name: 'go.md' },
    'go.md',
    { update: true }
  )
  assert.equal(readRuleDescriptions(home)['go.md'], 'Go rules v2')

  const server: RegistryServer = {
    name: 'io.example/docs',
    description: 'Library docs lookup',
    version: '1.0.0',
    packages: [],
    remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
    status: 'active'
  }
  commitMcp(home, server, 'remote:0', {}, 'docs')
  const def = JSON.parse(readFileSync(join(home, LIB, 'mcps/docs.json'), 'utf8')) as {
    url?: string
    _?: { description?: string }
  }
  assert.equal(def.url, 'https://example.com/mcp')
  assert.equal(def._?.description, 'Library docs lookup')
})
