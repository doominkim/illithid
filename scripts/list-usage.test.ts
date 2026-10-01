import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, searchIndexPath } from '../src/engine/search/sessionIndex'
import { ensureUsage, usageOf, usageSummaries } from '../src/engine/search/usage'

const NOW = Date.parse('2026-09-30T12:00:00')
const day = (ago: number): string => {
  const d = new Date(NOW)
  d.setDate(d.getDate() - ago)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function homeWithUsage(): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-list-usage-'))
  const db = openDb(searchIndexPath(home))
  ensureUsage(db)
  const ins = db.prepare('insert into usage(sid, tool, kind, name, model, day, n) values (?, ?, ?, ?, ?, ?, ?)')
  const rows: [string, string, string, string, number, number][] = [
    // tool, kind, name, model, days ago, n
    ['claude', 'skill', 'pdf', 'claude-opus-5-5', 0, 3],
    ['codex', 'skill', 'pdf', 'gpt-6.1-sol', 2, 1],
    ['claude', 'skill', 'pdf', 'claude-opus-5-5', 45, 9], // outside 30 days
    ['claude', 'skill', 'docx', 'claude-opus-5-5', 5, 2],
    // MCP server "brave-search": Claude/Codex store the key, OpenCode stores <server>_<tool> (case may differ)
    ['claude', 'mcp', 'brave_search', 'claude-opus-5-5', 1, 4],
    ['codex', 'mcp', 'brave-search', 'gpt-6.1-sol', 1, 1],
    ['opencode', 'mcpRaw', 'brave-search_web_search', 'gpt-6.1-sol', 3, 2],
    ['opencode', 'mcpRaw', 'Brave_Search_local', 'gpt-6.1-sol', 4, 1],
    ['claude', 'mcp', 'kaneo', 'claude-opus-5-5', 10, 6],
    // A different server whose name only shares a prefix must not count
    ['opencode', 'mcpRaw', 'brave-searchx_tool', 'gpt-6.1-sol', 1, 5]
  ]
  rows.forEach(([tool, kind, name, model, ago, n], i) => ins.run(i, tool, kind, name, model, day(ago), n))
  db.close()
  return home
}

test('REQ-LIST-USAGE-3 list values equal the detail usage, including MCP name rules', () => {
  const home = homeWithUsage()
  for (const [kind, names] of [
    ['skill', ['pdf', 'docx', 'unused']],
    ['mcp', ['brave-search', 'kaneo', 'unused']]
  ] as const) {
    const summaries = usageSummaries(home, kind, [...names], { now: NOW })!
    for (const name of names) {
      const detail = usageOf(home, kind, name, { now: NOW })!
      assert.equal(summaries[name].recent, detail.recent, `${kind} ${name} recent`)
      assert.deepEqual(summaries[name].daily, detail.daily.map((d) => d.n), `${kind} ${name} daily`)
    }
  }
  const mcp = usageSummaries(home, 'mcp', ['brave-search'], { now: NOW })!
  assert.equal(mcp['brave-search'].recent, 8)
  assert.equal(mcp['brave-search'].daily.length, 30)
})

test('REQ-LIST-USAGE-4 one call returns every requested name; no index reads as null', () => {
  const home = homeWithUsage()
  const all = usageSummaries(home, 'skill', ['pdf', 'docx', 'unused'], { now: NOW })!
  assert.deepEqual(Object.keys(all).sort(), ['docx', 'pdf', 'unused'])
  assert.equal(all.pdf.recent, 4)
  assert.equal(all.unused.recent, 0)
  assert.ok(all.unused.daily.every((n) => n === 0))
  assert.equal(usageSummaries(mkdtempSync(join(tmpdir(), 'illithid-no-index-')), 'skill', ['pdf'], { now: NOW }), null)
})
