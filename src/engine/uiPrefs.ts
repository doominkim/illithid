/**
 * Renderer preferences kept in config.json `ui` (language, color scheme, grid/list per screen).
 * They used to live only in Chromium localStorage, which a second app instance cannot open and Chromium may recreate empty.
 */
export const UI_LANGUAGES = ['en', 'ko', 'zh', 'ja'] as const
export type UiLanguage = (typeof UI_LANGUAGES)[number]
export const UI_COLOR_SCHEMES = ['light', 'dark', 'auto'] as const
export type UiColorScheme = (typeof UI_COLOR_SCHEMES)[number]
export type UiViewMode = 'grid' | 'list'
export type UiListSort = 'name' | 'usage'

export interface UiPrefs {
  language?: UiLanguage
  colorScheme?: UiColorScheme
  /** Grid or list per screen key (skills, mcp, ...) */
  views?: Record<string, UiViewMode>
  /** List order per screen key (skills, mcp) */
  sorts?: Record<string, UiListSort>
}

/** Patch for uiPrefsSet: null removes a key, views merge per screen */
export interface UiPrefsPatch {
  language?: UiLanguage | null
  colorScheme?: UiColorScheme | null
  views?: Record<string, UiViewMode>
  sorts?: Record<string, UiListSort>
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function uiPrefsErrors(v: unknown): string[] {
  if (!isObj(v)) return ['ui must be an object']
  const errs: string[] = []
  if (v.language !== undefined && !(UI_LANGUAGES as readonly unknown[]).includes(v.language))
    errs.push(`ui.language must be ${UI_LANGUAGES.join(' | ')}`)
  if (v.colorScheme !== undefined && !(UI_COLOR_SCHEMES as readonly unknown[]).includes(v.colorScheme))
    errs.push(`ui.colorScheme must be ${UI_COLOR_SCHEMES.join(' | ')}`)
  if (v.views !== undefined && (!isObj(v.views) || !Object.values(v.views).every((x) => x === 'grid' || x === 'list')))
    errs.push('ui.views must map screens to grid | list')
  if (v.sorts !== undefined && (!isObj(v.sorts) || !Object.values(v.sorts).every((x) => x === 'name' || x === 'usage')))
    errs.push('ui.sorts must map screens to name | usage')
  return errs
}

export function mergeUiPrefs(cur: UiPrefs | undefined, patch: UiPrefsPatch): UiPrefs {
  const next: UiPrefs = { ...cur }
  if (patch.language !== undefined) {
    if (patch.language === null) delete next.language
    else next.language = patch.language
  }
  if (patch.colorScheme !== undefined) {
    if (patch.colorScheme === null) delete next.colorScheme
    else next.colorScheme = patch.colorScheme
  }
  if (patch.views) next.views = { ...cur?.views, ...patch.views }
  if (patch.sorts) next.sorts = { ...cur?.sorts, ...patch.sorts }
  return next
}
