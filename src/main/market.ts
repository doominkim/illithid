/**
 * Marketplace handlers (main process only — the renderer CSP has no network access). Network work happens here,
 * library writes go through the caller's libWrite so they sync like any other edit.
 */
import {
  AWESOME_COPILOT_REPO,
  defaultSecretBackend,
  MarketError,
  marketCheckUpdates,
  marketCommitMcp,
  marketCommitMcpUpdate,
  marketCommitRule,
  marketCommitSkill,
  marketEnabled,
  marketInstallChoices,
  marketInstalledIndex,
  marketListRules,
  marketPopularServers,
  marketPopularSkills,
  marketPrepareRule,
  marketPrepareSkill,
  marketRankServers,
  marketSearchServers,
  marketFindSkills,
  marketServerDetail,
  marketSkillAudit,
  marketSuggestMcpName,
  readOrigins,
  type FetchFn,
  type MarketKind,
  type PreparedRule,
  type PreparedSkill,
  type RegistryServer
} from '../engine'
import type { MarketDetailView, MarketInstallOptions, MarketSearchView, Refused, WriteResult } from '../shared/api'

const CACHE_MS = 10 * 60 * 1000
const KINDS: readonly MarketKind[] = ['skill', 'mcp', 'rule']

type LibWrite = <T>(fn: () => T) => Promise<WriteResult<T> | Refused>

const fetchFn: FetchFn = (url, init) => fetch(url, init)

type Cache = Map<string, { at: number; value: Promise<unknown> }>

/** Search results (small) */
const cache: Cache = new Map()
/** Prepared downloads: skills hold file bytes (up to 20MB), so only the last few are kept. Install reuses what the detail showed */
const prepCache: Cache = new Map()
/** npm weekly downloads by package */
const downloads = new Map<string, number | undefined>()

function cachedIn<T>(c: Cache, max: number, key: string, load: () => Promise<T>): Promise<T> {
  const hit = c.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>
  const value = load()
  c.delete(key)
  c.set(key, { at: Date.now(), value })
  value.catch(() => c.delete(key))
  while (c.size > max) c.delete(c.keys().next().value as string)
  return value
}

const cached = <T>(key: string, load: () => Promise<T>): Promise<T> => cachedIn(cache, 200, key, load)
const prepared = <T>(key: string, load: () => Promise<T>): Promise<T> => cachedIn(prepCache, 5, key, load)

function fail(e: unknown): WriteResult<never> {
  if (e instanceof MarketError) return { ok: false, code: e.code, message: e.message }
  const err = e as NodeJS.ErrnoException
  return { ok: false, code: err.code ?? 'error', message: err.message ?? String(e) }
}

async function run<T>(home: string, fn: () => Promise<T>): Promise<WriteResult<T>> {
  if (!marketEnabled(home)) return { ok: false, code: 'disabled', message: 'Marketplace is off in settings' }
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    return fail(e)
  }
}

function kindOf(v: unknown): MarketKind {
  if (!KINDS.includes(v as MarketKind)) throw new MarketError('invalid', 'unknown kind')
  return v as MarketKind
}

function splitSkillId(id: string): { source: string; skillId: string } {
  const parts = String(id).split('/')
  if (parts.length !== 3) throw new MarketError('invalid', 'invalid skill id')
  return { source: `${parts[0]}/${parts[1]}`, skillId: parts[2] }
}

const prepSkill = (id: string): Promise<PreparedSkill> => {
  const { source, skillId } = splitSkillId(id)
  return prepared(`prep:skill:${id}`, () => marketPrepareSkill(fetchFn, source, skillId))
}
const prepServer = (id: string): Promise<RegistryServer> => prepared(`prep:mcp:${id}`, () => marketServerDetail(fetchFn, id))
const prepRule = (home: string, id: string): Promise<PreparedRule> =>
  prepared(`prep:rule:${id}`, () => marketPrepareRule(fetchFn, home, id))

/** What the detail view showed: install refuses if the source moved on since (reopen to review the new version) */
function refOf(kind: MarketKind, p: PreparedSkill | RegistryServer | PreparedRule): string {
  if (kind === 'skill') return (p as PreparedSkill).sha
  if (kind === 'mcp') return (p as RegistryServer).version
  return (p as PreparedRule).item.lastUpdated ?? ''
}

function assertRef(kind: MarketKind, p: PreparedSkill | RegistryServer | PreparedRule, expected: unknown): void {
  if (typeof expected === 'string' && expected !== refOf(kind, p))
    throw new MarketError('changed', 'the source changed since you opened it — reopen to review the new version')
}

export function marketHandlers(home: string, libWrite: LibWrite) {
  return {
    marketSearch: async (kind: unknown, q: unknown, cursor?: unknown): Promise<WriteResult<MarketSearchView>> =>
      run(home, async () => {
        const k = kindOf(kind)
        const query = typeof q === 'string' ? q.trim() : ''
        const installed = marketInstalledIndex(home)
        if (k === 'skill') {
          // Under 2 characters the search API refuses: show the install leaderboard instead
          const skills =
            query.length < 2
              ? await marketPopularSkills(fetchFn, home)
              : await cached(`search:skill:${query}`, () => marketFindSkills(fetchFn, home, query))
          return { skills, installed }
        }
        if (k === 'rule') return { rules: await marketListRules(fetchFn, home), installed }
        const c = typeof cursor === 'string' && cursor ? cursor : undefined
        if (!query && !c) return { mcp: marketPopularServers(), installed }
        const r = await cached(`search:mcp:${query}:${c ?? ''}`, async () => {
          const page = await marketSearchServers(fetchFn, query, c)
          return { ...page, items: await marketRankServers(fetchFn, page.items, downloads) }
        })
        return { mcp: r.items, nextCursor: r.nextCursor, installed }
      }),

    marketDetail: async (kind: unknown, id: unknown): Promise<WriteResult<MarketDetailView>> =>
      run(home, async () => {
        const k = kindOf(kind)
        const sid = String(id ?? '')
        const installedAs = marketInstalledIndex(home)[`${k}:${sid}`]
        if (k === 'skill') {
          const p = await prepSkill(sid)
          const audit = await marketSkillAudit(fetchFn, p.source, p.skillId).catch(() => null)
          const md = p.files.find((f) => f.rel === 'SKILL.md' || f.rel === 'skill.md')
          return {
            kind: 'skill',
            id: sid,
            source: p.source,
            skillId: p.skillId,
            name: p.name,
            description: p.description,
            skillMd: md ? new TextDecoder().decode(md.data) : '',
            files: p.files.map((f) => ({ rel: f.rel, size: f.data.byteLength })),
            skipped: p.skipped,
            audit,
            ref: p.sha,
            installedAs
          }
        }
        if (k === 'mcp') {
          const s = await prepServer(sid)
          return {
            kind: 'mcp',
            id: sid,
            title: s.title,
            description: s.description,
            version: s.version,
            repo: s.repository?.url,
            website: s.websiteUrl,
            choices: marketInstallChoices(s),
            name: marketSuggestMcpName(s.name),
            ref: s.version,
            installedAs
          }
        }
        const r = await prepRule(home, sid)
        return {
          kind: 'rule',
          id: sid,
          title: r.item.title,
          description: r.item.description,
          applyTo: r.item.applyTo,
          body: r.body,
          name: r.name,
          url: `${AWESOME_COPILOT_REPO}/blob/main/${r.item.path}`,
          ref: r.item.lastUpdated ?? '',
          installedAs
        }
      }),

    marketInstall: async (kind: unknown, id: unknown, opts: unknown): Promise<WriteResult<{ name: string; warnings?: string[] }> | Refused> => {
      if (!marketEnabled(home)) return { ok: false, code: 'disabled', message: 'Marketplace is off in settings' }
      const o = (opts ?? {}) as MarketInstallOptions
      const name = typeof o.name === 'string' ? o.name.trim() : ''
      let k: MarketKind
      try {
        k = kindOf(kind)
      } catch (e) {
        return fail(e)
      }
      const sid = String(id ?? '')
      try {
        if (k === 'skill') {
          const p = await prepSkill(sid)
          assertRef(k, p, o.ref)
          return libWrite(() => marketCommitSkill(home, p, name))
        }
        if (k === 'mcp') {
          const s = await prepServer(sid)
          assertRef(k, s, o.ref)
          const values = o.values && typeof o.values === 'object' ? (o.values as Record<string, string>) : {}
          return libWrite(() => marketCommitMcp(home, s, String(o.choice ?? ''), values, name, defaultSecretBackend()))
        }
        const r = await prepRule(home, sid)
        assertRef(k, r, o.ref)
        return libWrite(() => marketCommitRule(home, r, name))
      } catch (e) {
        return fail(e)
      }
    },

    marketUpdates: async () => run(home, () => marketCheckUpdates(fetchFn, home)),

    marketUpdate: async (kind: unknown, name: unknown): Promise<WriteResult<{ name: string }> | Refused> => {
      if (!marketEnabled(home)) return { ok: false, code: 'disabled', message: 'Marketplace is off in settings' }
      try {
        const k = kindOf(kind)
        const n = String(name ?? '')
        const origin = readOrigins(home)[`${k}:${n}`]
        if (!origin) throw new MarketError('notFound', 'not installed from the marketplace')
        prepCache.delete(`prep:${k}:${origin.id}`)
        if (k === 'skill') {
          const p = await prepSkill(origin.id)
          return libWrite(() => marketCommitSkill(home, p, n, { update: true }))
        }
        if (k === 'mcp') {
          const s = await prepServer(origin.id)
          return libWrite(() => marketCommitMcpUpdate(home, n, s))
        }
        await marketListRules(fetchFn, home, { force: true })
        const r = await prepRule(home, origin.id)
        return libWrite(() => marketCommitRule(home, r, n, { update: true }))
      } catch (e) {
        return fail(e)
      }
    }
  }
}
