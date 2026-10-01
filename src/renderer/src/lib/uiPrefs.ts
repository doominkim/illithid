import type { MantineColorScheme, MantineColorSchemeManager } from '@mantine/core'
import type { UiPrefs, UiPrefsPatch } from '../../../shared/api'
import { mergeUiPrefs, UI_COLOR_SCHEMES, UI_LANGUAGES } from '../../../engine/uiPrefs'
import { migrateStorageKey } from './storage'

/**
 * Language, color scheme and grid/list per screen live in config.json `ui` (main process), not in localStorage: a second app
 * instance cannot open Chromium's storage and starts empty, and Chromium may recreate it. preload reads `ui` synchronously so
 * the first render already has it; every window hears changes through onUiPrefsEvent.
 */
const LANGUAGE_KEY = 'illithid-language'
const COLOR_SCHEME_KEY = 'illithid-color-scheme'
const VIEW_KEY_PREFIX = 'illithid-view:'

let prefs: UiPrefs = window.api.uiPrefsInitial ?? {}
const listeners = new Set<(p: UiPrefs) => void>()

window.api.onUiPrefsEvent((p) => {
  prefs = p
  for (const cb of listeners) cb(p)
})

export function uiPrefs(): UiPrefs {
  return prefs
}

export function setUiPrefs(patch: UiPrefsPatch): void {
  prefs = mergeUiPrefs(prefs, patch)
  void window.api.uiPrefsSet(patch)
}

export function onUiPrefsChange(cb: (p: UiPrefs) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * Values from before config.json held them (localStorage, including previous app names) move over once, for keys `ui` does
 * not have yet. localStorage is left as is.
 */
function migrateFromLocalStorage(): void {
  try {
    migrateStorageKey(LANGUAGE_KEY, ['harnesssync-language'])
    migrateStorageKey(COLOR_SCHEME_KEY, ['harnesssync-color-scheme'])
    const patch: UiPrefsPatch = {}
    const language = localStorage.getItem(LANGUAGE_KEY)
    if (!prefs.language && language && (UI_LANGUAGES as readonly string[]).includes(language))
      patch.language = language as UiPrefs['language']
    const scheme = localStorage.getItem(COLOR_SCHEME_KEY)
    if (!prefs.colorScheme && scheme && (UI_COLOR_SCHEMES as readonly string[]).includes(scheme))
      patch.colorScheme = scheme as UiPrefs['colorScheme']
    const views: Record<string, 'grid' | 'list'> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(VIEW_KEY_PREFIX)) continue
      const screen = key.slice(VIEW_KEY_PREFIX.length)
      const v = localStorage.getItem(key)
      if (!prefs.views?.[screen] && (v === 'grid' || v === 'list')) views[screen] = v
    }
    if (Object.keys(views).length) patch.views = views
    if (Object.keys(patch).length) setUiPrefs(patch)
  } catch {
    // Storage unavailable: nothing to move
  }
}
migrateFromLocalStorage()

/** Mantine color scheme stored in config.json `ui.colorScheme`, following changes made in other windows */
export function configColorSchemeManager(): MantineColorSchemeManager {
  let off: (() => void) | null = null
  return {
    get: (defaultValue) => prefs.colorScheme ?? defaultValue,
    set: (value: MantineColorScheme) => {
      if (value !== prefs.colorScheme) setUiPrefs({ colorScheme: value })
    },
    subscribe: (onUpdate) => {
      off?.()
      off = onUiPrefsChange((p) => p.colorScheme && onUpdate(p.colorScheme))
    },
    unsubscribe: () => {
      off?.()
      off = null
    },
    clear: () => setUiPrefs({ colorScheme: null })
  }
}
