/**
 * MCP ranking. The registry has no usage data, so npm weekly downloads stand in: search results are sorted by them,
 * and the default list is the most-downloaded MCP packages on npm that also have an official registry entry
 * (generated at release time — the registry is too slow to build it on first open).
 */
import { getJson, isObj, str, type FetchFn } from './http'
import { searchServers, type MarketMcpItem } from './mcpRegistry'
import { MCP_POPULAR } from './mcpPopular.generated'

export const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search'
export const NPM_DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week'
const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** Weekly downloads of one npm package, or undefined when unknown */
export async function npmWeekly(fetchFn: FetchFn, pkg: string): Promise<number | undefined> {
  if (!NPM_NAME_RE.test(pkg)) return undefined
  try {
    const body = await getJson(fetchFn, `${NPM_DOWNLOADS}/${pkg}`, 64 * 1024)
    return isObj(body) && typeof body.downloads === 'number' ? body.downloads : undefined
  } catch {
    return undefined
  }
}

async function inBatches<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

/** Sort by weekly downloads (npm packages with counts first, then the rest in registry order). `known` caches counts */
export async function rankServers(
  fetchFn: FetchFn,
  items: MarketMcpItem[],
  known: Map<string, number | undefined> = new Map()
): Promise<MarketMcpItem[]> {
  const todo = [
    ...new Set(items.map((i) => i.npm).filter((n): n is string => !!n && !known.has(n)))
  ]
  const counts = await inBatches(todo, 8, (n) => npmWeekly(fetchFn, n))
  todo.forEach((n, i) => known.set(n, counts[i]))
  const withCounts = items.map((i, idx) => ({
    item: { ...i, downloads: i.npm ? known.get(i.npm) : undefined },
    idx
  }))
  return withCounts
    .sort((a, b) => (b.item.downloads ?? -1) - (a.item.downloads ?? -1) || a.idx - b.idx)
    .map((x) => x.item)
}

interface NpmHit {
  name: string
  weekly: number
  /** GitHub `owner/repo` from the package links */
  repo?: string
}

async function npmSearch(fetchFn: FetchFn, text: string): Promise<NpmHit[]> {
  const body = await getJson(
    fetchFn,
    `${NPM_SEARCH}?text=${encodeURIComponent(text)}&size=250`,
    8 * 1024 * 1024
  )
  if (!isObj(body) || !Array.isArray(body.objects)) return []
  const out: NpmHit[] = []
  for (const o of body.objects) {
    if (!isObj(o) || !isObj(o.package)) continue
    const name = str(o.package.name)
    const weekly =
      isObj(o.downloads) && typeof o.downloads.weekly === 'number' ? o.downloads.weekly : 0
    const link = isObj(o.package.links) ? str(o.package.links.repository) : undefined
    const repo = link ? /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_-]+)/.exec(link)?.[1] : undefined
    if (name && NPM_NAME_RE.test(name)) out.push({ name, weekly, repo })
  }
  return out
}

/** Registry search terms for an npm package: GitHub owner/repo (registry names are often io.github.<owner>/<repo>), then the unscoped name */
function termsOf(h: NpmHit): string[] {
  const unscoped = h.name.includes('/') ? h.name.split('/')[1] : h.name
  return [...new Set([h.repo, unscoped].filter((x): x is string => !!x))]
}

/**
 * Most-downloaded MCP servers on npm that have an installable official registry entry. Slow (one or two registry
 * searches per candidate), so it runs at release time (scripts/gen-mcp-popular.ts) and the app ships the result
 */
export async function collectPopularServers(
  fetchFn: FetchFn,
  opts: {
    limit?: number
    candidates?: number
    onProgress?: (done: number, total: number) => void
  } = {}
): Promise<MarketMcpItem[]> {
  const limit = opts.limit ?? 60
  const hits = new Map<string, NpmHit>()
  for (const q of [
    'mcp server',
    'mcp-server',
    'keywords:mcp-server',
    'keywords:mcp',
    'keywords:modelcontextprotocol'
  ])
    for (const h of await npmSearch(fetchFn, q).catch(() => [] as NpmHit[])) {
      const prev = hits.get(h.name)
      hits.set(h.name, {
        name: h.name,
        weekly: Math.max(prev?.weekly ?? 0, h.weekly),
        repo: h.repo ?? prev?.repo
      })
    }
  const candidates = [...hits.values()]
    .sort((a, b) => b.weekly - a.weekly)
    .slice(0, opts.candidates ?? limit * 4)
  let done = 0
  const found = await inBatches(candidates, 10, async (h) => {
    try {
      for (const term of termsOf(h)) {
        const r = await searchServers(fetchFn, term, undefined, 100)
        const item = r.items.find((i) => i.npm === h.name && i.installable)
        if (item) return { ...item, downloads: h.weekly }
      }
      return undefined
    } catch {
      return undefined
    } finally {
      opts.onProgress?.(++done, candidates.length)
    }
  })
  const seen = new Set<string>()
  const items: MarketMcpItem[] = []
  for (const i of found) {
    if (!i || seen.has(i.name)) continue
    seen.add(i.name)
    items.push(i)
    if (items.length >= limit) break
  }
  return items
}

/** The shipped popular list (generated at release time) */
export function popularServers(): MarketMcpItem[] {
  return MCP_POPULAR.map((i) => ({ ...i, kinds: [...i.kinds] }))
}
