/** skills.sh search, the install leaderboard and third-party audit results (public endpoints, no key) */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appConfigDir } from '../config'
import { atomicWrite } from '../write'
import { assertRepo, getJson, getText, isObj, MarketError, str, type FetchFn } from './http'

export const SKILLS_SH_API = 'https://skills.sh/api'
export const SKILLS_SH_HOME = 'https://skills.sh/'
export const POPULAR_TTL_MS = 60 * 60 * 1000
export const SKILL_AUDIT_API = 'https://add-skill.vercel.sh/audit'

export interface MarketSkillItem {
  /** `owner/repo/skillId` */
  id: string
  /** GitHub `owner/repo` */
  source: string
  skillId: string
  name: string
  installs: number
}

export const SKILL_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

/** Search skills. Queries shorter than 2 characters return nothing (the API refuses them) */
export async function searchSkills(fetchFn: FetchFn, q: string, limit = 100): Promise<MarketSkillItem[]> {
  const query = String(q ?? '').trim()
  if (query.length < 2) return []
  const url = `${SKILLS_SH_API}/search?q=${encodeURIComponent(query)}&limit=${Math.min(Math.max(limit, 1), 100)}`
  const body = await getJson(fetchFn, url)
  if (!isObj(body) || !Array.isArray(body.skills)) throw new MarketError('invalid', 'unexpected skills.sh response')
  const out: MarketSkillItem[] = []
  for (const s of body.skills) {
    if (!isObj(s)) continue
    const source = str(s.source)
    const skillId = str(s.skillId)
    if (!source || !skillId || !SKILL_ID_RE.test(skillId)) continue
    try {
      assertRepo(source)
    } catch {
      continue
    }
    out.push({
      id: `${source}/${skillId}`,
      source,
      skillId,
      name: str(s.name) ?? skillId,
      installs: typeof s.installs === 'number' ? s.installs : 0
    })
  }
  return byRelevance(out, query)
}

/**
 * skills.sh search is fuzzy and mixes in popular unrelated skills. Name matches come first, then repository matches,
 * then the rest; each group by installs
 */
export function byRelevance(items: MarketSkillItem[], q: string): MarketSkillItem[] {
  const needle = q.toLowerCase()
  const tier = (i: MarketSkillItem): number =>
    i.name.toLowerCase().includes(needle) || i.skillId.toLowerCase().includes(needle) ? 0 : i.source.toLowerCase().includes(needle) ? 1 : 2
  return items
    .map((item) => ({ item, t: tier(item) }))
    .sort((a, b) => a.t - b.t || b.item.installs - a.item.installs || a.item.id.localeCompare(b.item.id))
    .map((x) => x.item)
}

function byInstalls(items: MarketSkillItem[]): MarketSkillItem[] {
  return items.sort((a, b) => b.installs - a.installs || a.id.localeCompare(b.id))
}

/**
 * Leaderboard entries embedded in the skills.sh home page (the keyless API has no popular list).
 * Matches both the escaped (inside the page's JSON string payload) and plain forms
 */
export function parseLeaderboard(html: string): MarketSkillItem[] {
  const re = /\\?"source\\?":\\?"([^"\\]+)\\?",\\?"skillId\\?":\\?"([^"\\]+)\\?",\\?"name\\?":\\?"([^"\\]*)\\?",\\?"installs\\?":(\d+)/g
  const seen = new Map<string, MarketSkillItem>()
  for (const m of html.matchAll(re)) {
    const [, source, skillId, name, installs] = m
    if (!SKILL_ID_RE.test(skillId)) continue
    try {
      assertRepo(source)
    } catch {
      continue
    }
    const id = `${source}/${skillId}`
    const n = Number(installs)
    const prev = seen.get(id)
    if (!prev || prev.installs < n) seen.set(id, { id, source, skillId, name: name || skillId, installs: n })
  }
  return byInstalls([...seen.values()])
}

/** Most-installed skills (cached for an hour under the app config folder). Empty when the page can't be read */
export async function popularSkills(fetchFn: FetchFn, home: string, now = Date.now()): Promise<MarketSkillItem[]> {
  const p = join(appConfigDir(home), 'cache', 'skills-sh-popular.json')
  if (existsSync(p)) {
    try {
      const c = JSON.parse(readFileSync(p, 'utf8')) as { fetchedAt?: number; items?: MarketSkillItem[] }
      if (typeof c.fetchedAt === 'number' && now - c.fetchedAt < POPULAR_TTL_MS && Array.isArray(c.items)) return c.items
    } catch {
      // refetch
    }
  }
  const items = parseLeaderboard(await getText(fetchFn, SKILLS_SH_HOME, 8 * 1024 * 1024, { Accept: 'text/html' }))
  if (!items.length) throw new MarketError('invalid', 'skills.sh leaderboard not found')
  try {
    atomicWrite(p, JSON.stringify({ fetchedAt: now, items }), { mode: 0o600 })
  } catch {
    // cache is optional
  }
  return items
}

/**
 * Search plus substring matches from the leaderboard (the API matches whole words: "nest" misses most "nestjs" skills).
 * When anything matches by name or repository, the unrelated popular hits the fuzzy search mixes in are dropped
 */
export async function findSkills(fetchFn: FetchFn, home: string, q: string): Promise<MarketSkillItem[]> {
  const query = String(q ?? '').trim()
  // The API favours whole-word hits ("nest" finds one nestjs skill, "nes" finds dozens): also ask with the last letter
  // dropped and keep only its results that contain the full query
  const shorter = query.length >= 3 ? query.slice(0, -1) : ''
  const [api, prefix, top] = await Promise.all([
    searchSkills(fetchFn, query),
    shorter ? searchSkills(fetchFn, shorter).catch(() => [] as MarketSkillItem[]) : Promise.resolve([] as MarketSkillItem[]),
    popularSkills(fetchFn, home).catch(() => [] as MarketSkillItem[])
  ])
  const needle = query.toLowerCase()
  const merged = new Map(api.map((i) => [i.id, i]))
  for (const i of [...prefix, ...top]) if (!merged.has(i.id) && i.id.toLowerCase().includes(needle)) merged.set(i.id, i)
  const ranked = byRelevance([...merged.values()], query)
  const relevant = ranked.filter((i) => i.id.toLowerCase().includes(needle))
  return relevant.length ? relevant : ranked
}

export interface AuditPartner {
  risk?: string
  score?: number
  alerts?: number
  analyzedAt?: string
}

/** Audit results by partner (open set), or null when none exist. Failures are not fatal for the caller */
export async function skillAudit(fetchFn: FetchFn, source: string, skillId: string): Promise<Record<string, AuditPartner> | null> {
  assertRepo(source)
  if (!SKILL_ID_RE.test(skillId)) throw new MarketError('invalid', 'invalid skill id')
  const url = `${SKILL_AUDIT_API}?source=${encodeURIComponent(source)}&skills=${encodeURIComponent(skillId)}`
  let body: unknown
  try {
    body = await getJson(fetchFn, url, 256 * 1024)
  } catch (e) {
    if (e instanceof MarketError && e.code === 'notFound') return null
    throw e
  }
  if (!isObj(body) || !isObj(body[skillId])) return null
  const out: Record<string, AuditPartner> = {}
  for (const [partner, v] of Object.entries(body[skillId] as Record<string, unknown>)) {
    if (!isObj(v)) continue
    out[partner] = {
      risk: str(v.risk),
      score: typeof v.score === 'number' ? v.score : undefined,
      alerts: typeof v.alerts === 'number' ? v.alerts : undefined,
      analyzedAt: str(v.analyzedAt)
    }
  }
  return Object.keys(out).length ? out : null
}
