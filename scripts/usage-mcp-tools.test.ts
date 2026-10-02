import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, searchIndexPath } from '../src/engine/search/sessionIndex'
import { classify, ensureUsage, mcpToolNames } from '../src/engine/search/usage'

test('REQ-USAGE-MCP-TOOLS-1 an MCP call keeps its tool name, whatever form each tool writes it in', () => {
  const item = (tool: string, call: Parameters<typeof classify>[1]): string | undefined =>
    classify(tool, call).find((x) => x.kind === 'mcp')?.item
  assert.equal(item('claude', { name: 'mcp__kaneo__get_task', input: {} }), 'get_task')
  assert.equal(
    item('codex', { name: 'web_search', namespace: 'mcp__brave_search', input: {} }),
    'web_search'
  )
  assert.equal(item('gemini', { name: 'kaneo__list_tasks', input: {} }), 'list_tasks')
  assert.equal(
    item('grok', { name: 'use_tool', input: { tool_name: 'kaneo__create_task' } }),
    'create_task'
  )
})

test('REQ-USAGE-MCP-TOOLS-2 the tools a server was called with, from every tool, under its name or key', () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-usage-tools-'))
  const db = openDb(searchIndexPath(home))
  ensureUsage(db)
  const ins = db.prepare(
    'insert into usage(sid, tool, kind, name, item, model, day, n) values (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const rows: [string, string, string, string][] = [
    ['claude', 'mcp', 'brave_search', 'web_search'],
    ['codex', 'mcp', 'brave-search', 'local_search'],
    ['claude', 'mcp', 'brave_search', 'web_search'],
    ['opencode', 'mcpRaw', 'brave-search_image_search', ''],
    ['claude', 'mcp', 'kaneo', 'get_task'],
    ['opencode', 'mcpRaw', 'brave-searchx_tool', '']
  ]
  rows.forEach(([tool, kind, name, it], i) =>
    ins.run(i, tool, kind, name, it, 'm', '2026-10-01', 1)
  )
  db.close()
  assert.deepEqual(mcpToolNames(home, 'brave-search'), [
    'image_search',
    'local_search',
    'web_search'
  ])
  assert.deepEqual(mcpToolNames(home, 'kaneo'), ['get_task'])
  assert.deepEqual(mcpToolNames(home, 'unused'), [])
})
