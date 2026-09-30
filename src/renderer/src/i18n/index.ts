import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { onUiPrefsChange, setUiPrefs, uiPrefs } from '../lib/uiPrefs'
import en from './en.json'
import ko from './ko.json'
import zh from './zh.json'
import ja from './ja.json'

export const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'ko', label: '\uD55C\uAD6D\uC5B4' }, // Korean autonym
  { value: 'zh', label: '简体中文' },
  { value: 'ja', label: '日本語' }
] as const

export type Language = (typeof LANGUAGES)[number]['value']

const SUPPORTED = LANGUAGES.map((l) => l.value) as readonly string[]

/** The language chosen in config.json `ui.language` (see lib/uiPrefs), else the system language */
function detectLanguage(): Language {
  const stored = uiPrefs().language
  if (stored && SUPPORTED.includes(stored)) return stored
  const prefix = navigator.language.toLowerCase().split('-')[0]
  if (SUPPORTED.includes(prefix)) return prefix as Language
  return 'en'
}

const HTML_LANG: Record<Language, string> = { en: 'en', ko: 'ko', zh: 'zh-Hans', ja: 'ja' }

const initial = detectLanguage()
document.documentElement.lang = HTML_LANG[initial]

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = HTML_LANG[lng as Language] ?? lng
})

/** Only a language the user picked is stored. Without a choice, navigator.language keeps applying. */
export function setLanguage(lng: Language): void {
  setUiPrefs({ language: lng })
  void i18n.changeLanguage(lng)
}

// A language picked in another window (main window vs menu bar popover)
onUiPrefsChange((p) => {
  if (p.language && p.language !== i18n.language) void i18n.changeLanguage(p.language)
})

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ko: { translation: ko },
    zh: { translation: zh },
    ja: { translation: ja }
  },
  lng: initial,
  fallbackLng: 'en',
  interpolation: { escapeValue: false }
})

export default i18n
