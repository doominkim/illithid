import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classify, mcpKey } from '../src/engine/search/usage'
import { resolveMcpUsageServer } from '../src/renderer/src/lib/usageNavigation'

test('server-key MCP usage resolves only the unique normalized configured server', () => {
  for (const tool of ['claude', 'codex', 'gemini', 'grok']) {
    assert.equal(resolveMcpUsageServer(tool, 'brave_search', ['brave-search']), 'brave-search')
    assert.equal(
      resolveMcpUsageServer(tool, 'brave_search', ['brave-search', 'brave_search']),
      undefined
    )
    assert.equal(resolveMcpUsageServer(tool, 'brave_search', ['brave']), undefined)
    assert.equal(
      resolveMcpUsageServer(tool, 'postgres', ['postgres', 'postgres_query']),
      'postgres'
    )
  }
})

test('server-key MCP usage retains the reader case semantics and refuses missing names', () => {
  assert.equal(resolveMcpUsageServer('claude', 'Postgres', ['Postgres']), 'Postgres')
  assert.equal(resolveMcpUsageServer('codex', 'postgres', ['Postgres']), undefined)
  assert.equal(resolveMcpUsageServer('claude', 'missing', ['postgres']), undefined)
  assert.equal(resolveMcpUsageServer('claude', '', []), undefined)
  assert.equal(resolveMcpUsageServer('copilot', 'postgres', ['postgres']), undefined)
  assert.equal(resolveMcpUsageServer('unknown', 'postgres', ['postgres']), undefined)
})

test('OpenCode full tool usage resolves a unique server prefix with a nonempty tool suffix', () => {
  const [hit] = classify('opencode', { name: 'postgres_query', input: {} })
  assert.deepEqual(hit, { kind: 'mcpRaw', name: 'postgres_query' })
  const loggedName = mcpKey(hit.name)
  assert.equal(resolveMcpUsageServer('opencode', loggedName, ['postgres']), 'postgres')
  assert.equal(resolveMcpUsageServer('opencode', loggedName, ['redis']), undefined)
  assert.equal(resolveMcpUsageServer('opencode', 'postgres_', ['postgres']), undefined)
  assert.equal(resolveMcpUsageServer('opencode', 'postgres', ['postgres']), undefined)
})

test('OpenCode full tool names do not select a colliding whole-name server or longest prefix', () => {
  assert.equal(
    resolveMcpUsageServer('opencode', 'postgres_query', ['postgres', 'postgres_query']),
    undefined
  )
  assert.equal(
    resolveMcpUsageServer('opencode', 'postgres_query_read', ['postgres', 'postgres_query']),
    undefined
  )
  assert.equal(resolveMcpUsageServer('opencode', 'postgres_query', ['postgres_query']), undefined)
  assert.equal(
    resolveMcpUsageServer('opencode', 'postgres_query_read', ['postgres_query']),
    'postgres_query'
  )
})

test('OpenCode punctuation normalization preserves unique names and refuses normalization collisions', () => {
  const [hit] = classify('opencode', { name: 'docs.api_query', input: {} })
  assert.deepEqual(hit, { kind: 'mcpRaw', name: 'docs.api_query' })
  const loggedName = mcpKey(hit.name)
  assert.equal(loggedName, 'docs_api_query')
  assert.equal(resolveMcpUsageServer('opencode', loggedName, ['docs.api']), 'docs.api')
  assert.equal(resolveMcpUsageServer('opencode', loggedName, ['docs.api', 'docs_api']), undefined)
  assert.equal(
    resolveMcpUsageServer('opencode', 'brave_search_query', ['brave-search']),
    'brave-search'
  )
  // The reader does not emit dot-only tool names as MCP usage.
  assert.deepEqual(classify('opencode', { name: 'postgres.query', input: {} }), [])
})

test('OpenCode matching follows the reader case-insensitive prefix semantics', () => {
  assert.equal(resolveMcpUsageServer('opencode', 'POSTGRES_query', ['Postgres']), 'Postgres')
  assert.equal(
    resolveMcpUsageServer('opencode', 'postgres_query', ['Postgres', 'postgres']),
    undefined
  )
  assert.equal(
    resolveMcpUsageServer('opencode', 'postgres_query', ['postgres', 'postgres']),
    'postgres'
  )
  assert.equal(resolveMcpUsageServer('opencode', '', ['postgres']), undefined)
})
