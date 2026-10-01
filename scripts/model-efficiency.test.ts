import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  convertedCost,
  ratesFor,
  readPriceBook,
  type PriceBook
} from '../src/engine/search/modelPricing'
const book: PriceBook = {
  source: 'snapshot',
  date: '2026-09-06',
  providers: {
    openai: {
      models: {
        'gpt-test': {
          cost: {
            input: 1,
            output: 2,
            cache_read: 0.1,
            tiers: [{ input: 3, output: 4, tier: { type: 'context', size: 200000 } }]
          }
        }
      }
    }
  }
}
test('REQ-MODEL-EFFICIENCY-3 matching, context tiers, reasoning, unknown and recorded cost', () => {
  const tokens = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0, reasoning: 1e6 }
  assert.equal(convertedCost('openai/gpt-test-20260901', 'codex', tokens, 2, null, book).total, 3.1)
  assert.equal(convertedCost('gpt-test', 'codex', tokens, 2, null, book, 200001).total, 7.1)
  assert.equal(ratesFor('gpt-test', book, 200000)?.input, 1)
  assert.equal(convertedCost('gpt-test', 'opencode', tokens, 2, null, book).total, 5.1)
  assert.equal(convertedCost('missing', 'codex', tokens, 2, null, book).total, null)
  assert.equal(convertedCost('missing', 'opencode', tokens, 2, 0, book).source, 'recorded')
  assert.equal(convertedCost('gpt-test', 'opencode', tokens, 2, 0.2, book).total, 0.2)
  assert.equal(readPriceBook('/nonexistent-fixture').source, 'snapshot')
})

test('REQ-MODEL-EFFICIENCY-3 absent token prices and unmeasured tokens never appear free', () => {
  const missing: PriceBook = {
    ...book,
    providers: { openai: { models: { 'gpt-test': { cost: { input: 1, output: 2 } } } } }
  }
  const tokens = { input: 0, output: 0, cacheRead: 1e6, cacheWrite: 0, reasoning: 0 }
  assert.equal(convertedCost('gpt-test', 'codex', tokens, 30, null, missing).total, null)
  assert.equal(
    convertedCost('gpt-test', 'codex', { ...tokens, cacheRead: 0 }, 30, null, missing).total,
    null
  )
  assert.equal(
    convertedCost('gpt-test', 'opencode', { ...tokens, cacheRead: 0 }, 30, 0, missing).total,
    0
  )
})

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureModelStats,
  ModelStatsCounter,
  modelList,
  modelDetail
} from '../src/engine/search/modelStats'
import { openDb, searchIndexPath } from '../src/engine/search/sessionIndex'

test('REQ-MODEL-EFFICIENCY-3 REQ-MODEL-EFFICIENCY-4 injected catalog, per-turn tier, request distribution and daily sums', () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-efficiency-'))
  mkdirSync(join(home, '.cache/opencode'), { recursive: true })
  writeFileSync(join(home, '.cache/opencode/models.json'), JSON.stringify(book.providers))
  const db = openDb(searchIndexPath(home))
  ensureModelStats(db)
  const counter = new ModelStatsCounter('codex')
  for (let i = 0; i < 30; i++) {
    const at = new Date(Date.UTC(2026, 8, 20, 0, i)).toISOString()
    counter.prompt(at)
    counter.turn({
      model: 'gpt-test',
      effort: 'high',
      at,
      usage: { input: 300000, cacheRead: 0, cacheWrite: 0, output: 1000, reasoning: 100 }
    })
    counter.requestEnd(at)
  }
  counter.turn({
    model: 'gpt-test',
    effort: 'high',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  })
  counter.write(db, 1)
  db.close()
  const list = modelList(home)!
  assert.equal(list[0].pricing?.priceSource, 'cache')
  assert.ok(Math.abs(list[0].pricing!.total! - 27.12) < 1e-9)
  const detail = modelDetail(home, { tool: 'codex', model: 'gpt-test', effort: 'high' })!
  assert.equal(detail.costDist?.n, 30)
  assert.ok(Math.abs(detail.costDist!.median - 0.904) < 1e-9)
  assert.ok(Math.abs(detail.costDaily![0].cost! - 27.12) < 1e-9)
})

test('REQ-STATS-MEDIAN-COST-1 REQ-STATS-MEDIAN-COST-2 per-request median ignores one long request and needs 30 completed requests', () => {
  const run = (requests: number): ReturnType<typeof modelList> => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-median-cost-'))
    mkdirSync(join(home, '.cache/opencode'), { recursive: true })
    writeFileSync(join(home, '.cache/opencode/models.json'), JSON.stringify(book.providers))
    const db = openDb(searchIndexPath(home))
    ensureModelStats(db)
    const counter = new ModelStatsCounter('codex')
    for (let i = 0; i < requests; i++) {
      const at = new Date(Date.UTC(2026, 8, 20, 0, i)).toISOString()
      counter.prompt(at)
      // One very long request (100x the tokens) among ordinary ones
      const scale = i === 0 ? 100 : 1
      counter.turn({
        model: 'gpt-test',
        effort: 'high',
        at,
        usage: { input: 300000 * scale, cacheRead: 0, cacheWrite: 0, output: 1000, reasoning: 0 }
      })
      counter.requestEnd(at)
    }
    counter.write(db, 1)
    db.close()
    const list = modelList(home)!
    if (requests >= 30) {
      const detail = modelDetail(home, { tool: 'codex', model: 'gpt-test', effort: 'high' })!
      assert.equal(list[0].pricing?.medianPerRequest, detail.costDist?.median)
    }
    return list
  }
  const pricing = run(30)![0].pricing!
  assert.ok(Math.abs(pricing.medianPerRequest! - 0.904) < 1e-9, String(pricing.medianPerRequest))
  assert.ok(pricing.perRequest! > pricing.medianPerRequest! * 4, String(pricing.perRequest))
  assert.equal(run(29)![0].pricing?.medianPerRequest, null)
})

test('REQ-MODEL-EFFICIENCY-3 partial OpenCode recorded cost is labeled mixed', () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-mixed-cost-'))
  mkdirSync(join(home, '.cache/opencode'), { recursive: true })
  writeFileSync(join(home, '.cache/opencode/models.json'), JSON.stringify(book.providers))
  const db = openDb(searchIndexPath(home))
  ensureModelStats(db)
  const counter = new ModelStatsCounter('opencode')
  for (let i = 0; i < 2; i++) {
    const at = new Date(Date.UTC(2026, 8, 20, 0, i)).toISOString()
    counter.prompt(at)
    counter.turn({
      model: 'gpt-test',
      at,
      cost: i === 0 ? 0.5 : undefined,
      usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 1000, reasoning: 0 }
    })
    counter.requestEnd(at)
  }
  counter.write(db, 1)
  db.close()
  const m = modelList(home)![0]
  assert.equal(m.pricing?.source, 'mixed')
  assert.ok(Math.abs(m.pricing!.total! - 0.503) < 1e-9)
  assert.ok(Math.abs(m.pricing!.converted! - 0.006) < 1e-9)
})

test('REQ-MODEL-EFFICIENCY-3 old cache falls back per model with accurate source and date', () => {
  const old: PriceBook = { source: 'cache', date: '2026-09-06', providers: {} }
  const tokens = { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 0, reasoning: 0 }
  const c = convertedCost('gpt-6.1-sol', 'codex', tokens, 30, null, old)
  assert.equal(c.priceSource, 'snapshot')
  assert.equal(c.date, '2026-09-30')
  assert.ok(Math.abs(c.total! - 0.0121) < 1e-10)
  assert.equal(ratesFor('gpt-6.1-sol', old, 272001)?.input, 4)
  assert.equal(ratesFor('gpt-6-sol', old)?.input, 2)
  const custom: PriceBook = {
    ...old,
    providers: {
      openai: { models: { 'gpt-6.1-sol': { cost: { input: 1, output: 1, cache_read: 1 } } } }
    }
  }
  assert.equal(convertedCost('gpt-6.1-sol', 'codex', tokens, 30, null, custom).priceSource, 'cache')
})

test('REQ-MODEL-EFFICIENCY-8 resolves each model once per price book', () => {
  let scans = 0
  const models = new Proxy(
    { 'gpt-cached-20260901': { cost: { input: 1, output: 2 } } },
    {
      ownKeys(target) {
        scans++
        return Reflect.ownKeys(target)
      }
    }
  )
  const cachedBook: PriceBook = {
    source: 'snapshot',
    date: '2026-09-30',
    providers: { openai: { models } }
  }
  const tokens = { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  for (let i = 0; i < 1000; i++) {
    assert.equal(convertedCost('openai/gpt-cached', 'codex', tokens, 1, null, cachedBook).total, 1)
  }
  assert.equal(scans, 1)
  const otherBook: PriceBook = {
    ...cachedBook,
    providers: { openai: { models: { 'gpt-cached': { cost: { input: 3, output: 2 } } } } }
  }
  assert.equal(convertedCost('gpt-cached', 'codex', tokens, 1, null, otherBook).total, 3)
})

test('REQ-MODEL-EFFICIENCY-13 Opus 5.5 official prices fill missing cache entry', () => {
  const old: PriceBook = { source: 'cache', date: '2026-09-06', providers: {} }
  const tokens = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6, reasoning: 0 }
  const cost = convertedCost('anthropic/claude-opus-5-5-20260922', 'claude', tokens, 30, null, old)
  assert.equal(cost.total, 29.2)
  assert.equal(cost.priceSource, 'snapshot')
  assert.equal(cost.date, '2026-09-30')
  assert.equal(ratesFor('claude-opus-5-5', old, 500000)?.input, 4)
})
