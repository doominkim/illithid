import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import snapshot from '../data/model-prices.json'

export interface Rates {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  tiers?: (Rates & { tier: { type: string; size: number } })[]
  context_over_200k?: Rates
}
export type Catalog = Record<string, { models: Record<string, { cost?: Rates; date?: string }> }>
export interface PriceBook {
  providers: Catalog
  date: string
  source: 'cache' | 'snapshot'
}
export interface CostTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}
export interface ConvertedCost {
  needsReindex?: boolean
  total: number | null
  converted: number | null
  perRequest: number | null
  source: 'recorded' | 'converted' | 'mixed' | 'unpriced'
  priceSource: 'cache' | 'snapshot'
  date: string
  parts: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
}
export function readPriceBook(home: string): PriceBook {
  try {
    const path = join(home, '.cache/opencode/models.json')
    const providers: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!providers || typeof providers !== 'object' || Array.isArray(providers))
      throw new Error('Invalid catalog')
    return {
      providers: providers as Catalog,
      date: statSync(path).mtime.toISOString().slice(0, 10),
      source: 'cache'
    }
  } catch {
    return { providers: snapshot.providers as Catalog, date: snapshot.date, source: 'snapshot' }
  }
}
export const normalizedModel = (model: string): string =>
  model
    .split('/')
    .pop()!
    .replace(/-\d{8}$/, '')
interface ResolvedPrice {
  base: Rates | null
  source: PriceBook['source']
  date: string
}
const resolvedBooks = new WeakMap<PriceBook, Map<string, ResolvedPrice>>()
function resolvePrice(model: string, book: PriceBook): ResolvedPrice {
  const id = normalizedModel(model)
  let modelsForBook = resolvedBooks.get(book)
  if (!modelsForBook) {
    modelsForBook = new Map()
    resolvedBooks.set(book, modelsForBook)
  }
  const cached = modelsForBook.get(id)
  if (cached) return cached
  const provider = /^claude-/.test(id)
    ? 'anthropic'
    : /^(gpt-|o\d)/.test(id)
      ? 'openai'
      : /^grok-/.test(id)
        ? 'xai'
        : /^gemini-/.test(id)
          ? 'google'
          : undefined
  const findEntry = (catalog: Catalog): { cost?: Rates; date?: string } | undefined => {
    const models = provider ? (catalog[provider]?.models ?? {}) : {}
    return models[id] ?? Object.entries(models).find(([key]) => normalizedModel(key) === id)?.[1]
  }
  let entry = findEntry(book.providers)
  let source = book.source
  let date = book.date
  const valid = (): boolean =>
    !!entry?.cost && Number.isFinite(entry.cost.input) && Number.isFinite(entry.cost.output)
  if (!valid() && source === 'cache') {
    entry = findEntry(snapshot.providers as Catalog)
    source = 'snapshot'
    date = snapshot.date
  }
  const resolved: ResolvedPrice = {
    base: valid() ? entry!.cost! : null,
    source,
    date: source === 'snapshot' ? (entry?.date ?? date) : date
  }
  modelsForBook.set(id, resolved)
  return resolved
}
export function ratesFor(model: string, book: PriceBook, context = 0): Rates | null {
  const { base } = resolvePrice(model, book)
  if (!base) return null
  const tier = base.tiers
    ?.filter((t) => t.tier?.type === 'context' && context > t.tier.size)
    .sort((a, b) => b.tier.size - a.tier.size)[0]
  return tier
    ? { ...base, ...tier }
    : !base.tiers?.length && context > 200000 && base.context_over_200k
      ? { ...base, ...base.context_over_200k }
      : base
}
export function tokenCost(
  tokens: CostTokens,
  tool: string,
  rates: Rates | null
): ConvertedCost['parts'] {
  if (!rates) return null
  const values = {
    input: tokens.input,
    output: tokens.output + (tool === 'opencode' ? tokens.reasoning : 0),
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite
  }
  const prices = {
    input: rates.input,
    output: rates.output,
    cacheRead: rates.cache_read ?? (values.cacheRead > 0 ? NaN : 0),
    cacheWrite: rates.cache_write ?? (values.cacheWrite > 0 ? NaN : 0)
  }
  if (
    Object.values(values).every((v) => v === 0) ||
    Object.values(values).some((v) => !Number.isFinite(v) || v < 0) ||
    Object.values(prices).some((v) => !Number.isFinite(v) || v < 0)
  )
    return null
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, (v * prices[k as keyof typeof prices]) / 1e6])
  ) as NonNullable<ConvertedCost['parts']>
}
export function convertedCost(
  model: string,
  tool: string,
  tokens: CostTokens,
  requests: number,
  recorded: number | null,
  book: PriceBook,
  context = 0
): ConvertedCost {
  const resolved = resolvePrice(model, book)
  const parts = tokenCost(tokens, tool, ratesFor(model, book, context))
  const converted = parts ? Object.values(parts).reduce((a, b) => a + b, 0) : null
  const useRecorded =
    tool === 'opencode' && recorded !== null && Number.isFinite(recorded) && recorded >= 0
  const total = useRecorded ? recorded : converted
  return {
    total,
    converted,
    perRequest: total === null || requests <= 0 ? null : total / requests,
    source: useRecorded ? 'recorded' : total === null ? 'unpriced' : 'converted',
    priceSource: resolved.source,
    date: resolved.date,
    parts
  }
}
