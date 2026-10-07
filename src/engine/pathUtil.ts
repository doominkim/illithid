/**
 * Path checks that hold on macOS and Windows. Comparing with a hard-coded `/` misses Windows paths (`C:\Users\…`), and Windows
 * paths compare case-insensitively. Dependency-free so the renderer can use it too.
 */
import { posix, win32 } from 'node:path'

export type Platform = NodeJS.Platform

const pathOf = (platform: Platform): typeof posix => (platform === 'win32' ? win32 : posix)

/** p is strictly inside root (root itself is not) */
export function isUnder(root: string, p: string, platform: Platform = process.platform): boolean {
  const lib = pathOf(platform)
  const rel = lib.relative(lib.resolve(root), lib.resolve(p))
  return !!rel && rel !== '..' && !rel.startsWith('..' + lib.sep) && !lib.isAbsolute(rel)
}

/** p is root or inside it */
export function isUnderOrSame(
  root: string,
  p: string,
  platform: Platform = process.platform
): boolean {
  const lib = pathOf(platform)
  return lib.relative(lib.resolve(root), lib.resolve(p)) === '' || isUnder(root, p, platform)
}

/** Forward slashes (for display, globs and ids that must not depend on the platform) */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Display path with the home prefix replaced by `~` */
export function homeTilde(home: string, p: string, platform: Platform = process.platform): string {
  const lib = pathOf(platform)
  if (lib.relative(home, p) === '') return '~'
  return isUnder(home, p, platform) ? '~' + lib.sep + lib.relative(home, p) : p
}

/** `~` forms a config file may hold for a path under home (native separator and forward slashes); none outside home */
export function tildeAliases(
  home: string,
  p: string,
  platform: Platform = process.platform
): string[] {
  if (!isUnder(home, p, platform)) return []
  const rel = pathOf(platform).relative(home, p)
  return [...new Set([`~${pathOf(platform).sep}${rel}`, `~/${toPosix(rel)}`])]
}
