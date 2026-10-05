import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureModelStats, ModelStatsCounter, modelList } from '../src/engine/search/modelStats'
import { openDb, searchIndexPath } from '../src/engine/search/sessionIndex'

test('tool-only Gemini and Grok logs expose unsupported metrics instead of measured zeroes', () => {
  for (const tool of ['gemini', 'grok']) {
    const home = mkdtempSync(join(tmpdir(), 'illithid-metric-support-'))
    const cache = join(home, '.cache/opencode')
    mkdirSync(cache, { recursive: true })
    writeFileSync(
      join(cache, 'models.json'),
      JSON.stringify({
        fixture: { models: { 'fixture-model': { cost: { input: 1, output: 2 } } } }
      })
    )
    const db = openDb(searchIndexPath(home))
    ensureModelStats(db)
    const counter = new ModelStatsCounter(tool)
    counter.call({
      name: 'read_file',
      input: {},
      model: 'fixture-model',
      at: '2026-10-05T00:00:00Z'
    })
    counter.write(db, 1)
    db.close()
    const summary = modelList(home)![0]
    assert.equal(summary.toolCalls, 1)
    assert.equal(summary.pricing?.total, null)
    assert.equal(summary.pricing?.converted, null)
    assert.deepEqual(summary.metrics, {
      requests: false,
      turns: false,
      tokens: false,
      interrupts: false,
      errors: false
    })
  }
})
