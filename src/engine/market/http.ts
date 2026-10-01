/**
 * Network helpers for the marketplace. Every call takes the fetch function as an argument so fixtures can inject responses
 * and nothing in the engine reaches the network on its own. GET only, no credentials.
 */

export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<Response>

export type MarketErrorCode =
  | 'network'
  | 'rateLimited'
  | 'notFound'
  | 'tooLarge'
  | 'invalid'
  | 'unsupported'
  | 'disabled'
  | 'changed'

export class MarketError extends Error {
  constructor(
    readonly code: MarketErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'MarketError'
  }
}

/** The MCP registry regularly takes 5–20s per search */
export const TIMEOUT_MS = 30_000
/** Default response cap (JSON listings, SKILL.md, rule bodies) */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

const USER_AGENT = 'Illithid'

async function request(
  fetchFn: FetchFn,
  url: string,
  headers: Record<string, string>,
  maxBytes: number
): Promise<Uint8Array> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: ctl.signal
    })
  } catch (e) {
    clearTimeout(timer)
    throw new MarketError(
      'network',
      `request failed: ${host(url)} (${(e as Error).name === 'AbortError' ? 'timeout' : 'unreachable'})`
    )
  }
  try {
    if (
      res.status === 429 ||
      (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')
    )
      throw new MarketError('rateLimited', `rate limited: ${host(url)}`)
    if (res.status === 404) throw new MarketError('notFound', `not found: ${host(url)}`)
    if (!res.ok) throw new MarketError('network', `${host(url)} returned ${res.status}`)
    const declared = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maxBytes)
      throw new MarketError('tooLarge', `response too large: ${host(url)}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > maxBytes)
      throw new MarketError('tooLarge', `response too large: ${host(url)}`)
    return buf
  } catch (e) {
    if (e instanceof MarketError) throw e
    throw new MarketError('network', `request failed: ${host(url)}`)
  } finally {
    clearTimeout(timer)
  }
}

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid url'
  }
}

export async function getBytes(
  fetchFn: FetchFn,
  url: string,
  maxBytes = MAX_RESPONSE_BYTES,
  headers: Record<string, string> = {}
): Promise<Uint8Array> {
  return request(fetchFn, url, headers, maxBytes)
}

export async function getText(
  fetchFn: FetchFn,
  url: string,
  maxBytes = MAX_RESPONSE_BYTES,
  headers: Record<string, string> = {}
): Promise<string> {
  return new TextDecoder().decode(await request(fetchFn, url, headers, maxBytes))
}

export async function getJson<T = unknown>(
  fetchFn: FetchFn,
  url: string,
  maxBytes = MAX_RESPONSE_BYTES,
  headers: Record<string, string> = {}
): Promise<T> {
  const text = await getText(fetchFn, url, maxBytes, { Accept: 'application/json', ...headers })
  try {
    return JSON.parse(text) as T
  } catch {
    throw new MarketError('invalid', `invalid JSON: ${host(url)}`)
  }
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** `owner/repo` on GitHub */
export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function assertRepo(repo: string): void {
  if (
    typeof repo !== 'string' ||
    !REPO_RE.test(repo) ||
    repo.split('/').some((s) => s === '.' || s === '..')
  )
    throw new MarketError('invalid', 'invalid repository')
}
