/**
 * New version check: the latest GitHub release of the app, compared with the running version. GET only, no credentials;
 * the fetch function is injected (like the marketplace) so nothing here reaches the network on its own.
 */
import { existsSync } from 'node:fs'
import { getJson, isObj, str, type FetchFn } from './market/http'

export const RELEASES_API = 'https://api.github.com/repos/doominkim/illithid/releases/latest'
export const BREW_UPGRADE = 'brew upgrade --cask doominkim/tap/illithid'
/** Homebrew cask folders (Apple Silicon, Intel) */
const CASKROOMS = ['/opt/homebrew/Caskroom/illithid', '/usr/local/Caskroom/illithid']

export interface UpdateInfo {
  /** Latest version without the leading v */
  version: string
  /** Release notes (markdown) */
  notes: string
  /** Release page */
  url: string
}

/** Numeric x.y.z parts; anything after `-` (pre-release) is ignored */
function parts(v: string): number[] {
  return v
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map((x) => Number.parseInt(x, 10) || 0)
}

/** >0 when a is newer than b */
export function compareVersions(a: string, b: string): number {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** The latest release if it is newer than `current`, otherwise null. Drafts and pre-releases never count */
export async function latestUpdate(fetchFn: FetchFn, current: string): Promise<UpdateInfo | null> {
  const r = await getJson(fetchFn, RELEASES_API, 1024 * 1024, {
    Accept: 'application/vnd.github+json'
  })
  if (!isObj(r) || r.draft === true || r.prerelease === true) return null
  const tag = str(r.tag_name)
  if (!tag || !/^v?\d+\.\d+\.\d+/.test(tag)) return null
  const version = tag.replace(/^v/, '')
  if (compareVersions(version, current) <= 0) return null
  const url = str(r.html_url) ?? `https://github.com/doominkim/illithid/releases/tag/${tag}`
  return { version, notes: str(r.body) ?? '', url }
}

/** Installed through the Homebrew cask (update with brew), from the DMG, or with the Windows setup installer */
export function installKind(
  exists: (p: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform
): 'brew' | 'dmg' | 'nsis' {
  if (platform === 'win32') return 'nsis'
  return CASKROOMS.some((p) => exists(p)) ? 'brew' : 'dmg'
}
