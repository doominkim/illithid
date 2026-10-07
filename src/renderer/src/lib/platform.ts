/** The OS the app runs on (from the preload's process info). Windows gets its own wording and a native title bar */
export const IS_WINDOWS = window.electron?.process?.platform === 'win32'

/** i18n key for platform-specific wording: `<key>Win` on Windows */
export const platformKey = (key: string): string => (IS_WINDOWS ? `${key}Win` : key)
