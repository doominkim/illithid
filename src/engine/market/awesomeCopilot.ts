/** github/awesome-copilot instructions (MIT) as rule sources. The index is cached for a day under the app config folder */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import { appConfigDir } from '../config'
import { atomicWrite } from '../write'
import { getJson, getText, isObj, MarketError, str, type FetchFn } from './http'

export const AWESOME_COPILOT_INDEX = 'https://awesome-copilot.github.com/data/instructions.json'
export const AWESOME_COPILOT_RAW = 'https://raw.githubusercontent.com/github/awesome-copilot/main'
export const AWESOME_COPILOT_REPO = 'https://github.com/github/awesome-copilot'
export const INDEX_TTL_MS = 24 * 60 * 60 * 1000

export interface MarketRuleItem {
  id: string
  title: string
  description: string
  applyTo?: string
  path: string
  lastUpdated?: string
}

export const RULE_PATH_RE = /^instructions\/[A-Za-z0-9._-]+\.instructions\.md$/
const RULE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/

function cachePath(home: string): string {
  return join(appConfigDir(home), 'cache', 'awesome-copilot-instructions.json')
}

function parseIndex(body: unknown): MarketRuleItem[] {
  if (!isObj(body) || !Array.isArray(body.items))
    throw new MarketError('invalid', 'unexpected rule index')
  const out: MarketRuleItem[] = []
  for (const x of body.items) {
    if (!isObj(x)) continue
    const id = str(x.id)
    const path = str(x.path)
    if (!id || !path || !RULE_ID_RE.test(id) || !RULE_PATH_RE.test(path)) continue
    out.push({
      id,
      title: str(x.title) ?? id,
      description: str(x.description) ?? '',
      applyTo: str(x.applyTo),
      path,
      lastUpdated: str(x.lastUpdated)
    })
  }
  return out.sort((a, b) => a.title.localeCompare(b.title))
}

/** The rule list, from cache when younger than a day (force = refetch) */
export async function listInstructions(
  fetchFn: FetchFn,
  home: string,
  opts: { force?: boolean; now?: number } = {}
): Promise<MarketRuleItem[]> {
  const now = opts.now ?? Date.now()
  const p = cachePath(home)
  if (!opts.force && existsSync(p)) {
    try {
      const c = JSON.parse(readFileSync(p, 'utf8')) as { fetchedAt?: number; body?: unknown }
      if (typeof c.fetchedAt === 'number' && now - c.fetchedAt < INDEX_TTL_MS)
        return parseIndex(c.body)
    } catch {
      // broken cache: refetch
    }
  }
  const body = await getJson(fetchFn, AWESOME_COPILOT_INDEX)
  const items = parseIndex(body)
  try {
    atomicWrite(p, JSON.stringify({ fetchedAt: now, body }), { mode: 0o600 })
  } catch {
    // cache is optional
  }
  return items
}

/** Rule body with the Copilot frontmatter (description · applyTo) removed */
export async function instructionBody(fetchFn: FetchFn, path: string): Promise<string> {
  if (!RULE_PATH_RE.test(path)) throw new MarketError('invalid', 'invalid rule path')
  const text = await getText(fetchFn, `${AWESOME_COPILOT_RAW}/${path}`, 1024 * 1024)
  let body = text
  try {
    body = matter(text).content
  } catch {
    // leave as is
  }
  return body.replace(/^\s*\n/, '').replace(/\s*$/, '\n')
}
