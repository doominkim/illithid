import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelSummary } from '../src/shared/api'
import {
  chartRows,
  seriesKey,
  effortOrder,
  providerColor
} from '../src/renderer/src/lib/leaderboard'
import { convertedCost, readPriceBook } from '../src/engine/search/modelPricing'
import { modelGroups } from '../src/renderer/src/lib/modelGroups'

const row = (overrides: Partial<ModelSummary> = {}): ModelSummary => ({
  tool: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'high',
  first: '2026-09-01',
  last: '2026-09-30',
  activeDays: 8,
  sessions: 2,
  subagentSessions: 0,
  requests: 30,
  turns: 40,
  toolCalls: 20,
  interrupts: 0,
  errors: { mistake: 0, command: 0, policy: 0, userReject: 0, other: 0 },
  tokens: { input: 1e6, cacheRead: 2e6, cacheWrite: 0, output: 1e6, reasoning: 0 },
  cost: null,
  pricing: convertedCost(
    'gpt-6.1-sol',
    'codex',
    { input: 1e6, cacheRead: 2e6, cacheWrite: 0, output: 1e6, reasoning: 0 },
    30,
    null,
    {
      ...readPriceBook('/fixture-no-cache'),
      providers: {
        ...readPriceBook('/fixture-no-cache').providers,
        openai: { models: { 'gpt-6.1-sol': { cost: { input: 2, output: 10, cache_read: 0.1 } } } }
      }
    }
  ),
  median: {
    responseSec: 45,
    toolsPerRequest: 2,
    turnsPerRequest: 3,
    outputPerRequest: 100,
    contextPerTurn: 1000
  },
  ...overrides
})

test('REQ-MODEL-EFFICIENCY-1 parents aggregate only common totals, preserving tool children', () => {
  const a = row(),
    b = row({ tool: 'opencode', effort: '', model: 'openai/gpt-6.1-sol-20260901' })
  const groups = modelGroups([a, b])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].requests, 60)
  assert.equal(groups[0].children.length, 2)
  assert.equal('median' in groups[0], false)
  assert.equal(modelGroups([a, row({ pricing: undefined })])[0].cost, null)
})

test('REQ-USAGE-LEADERBOARD-2 excludes insufficient samples, missing timing and unknown cost without changing source list', () => {
  const rows = [
    row(),
    row({ requests: 29 }),
    row({ model: 'unknown', pricing: undefined }),
    row({ median: { ...row().median, responseSec: null } })
  ]
  assert.equal(chartRows(rows).length, 1)
  assert.equal(rows.length, 4)
  assert.equal(chartRows([row({ requests: 0 })]).length, 0)
})

test('REQ-USAGE-LEADERBOARD-3 series isolate tools and effort order is stable; colors follow model provider', () => {
  assert.notEqual(seriesKey(row()), seriesKey(row({ tool: 'opencode' })))
  assert.equal(seriesKey(row()), seriesKey(row({ effort: 'medium' })))
  assert.ok(effortOrder('medium') < effortOrder('high'))
  assert.ok(effortOrder('high') < effortOrder('xhigh'))
  assert.notEqual(providerColor('claude-fable-5'), providerColor('gpt-6.1-sol'))
  assert.notEqual(providerColor('gemini-2.5-pro'), providerColor('gpt-6.1-sol'))
})
