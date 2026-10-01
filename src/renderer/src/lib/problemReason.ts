import type { TFunction } from 'i18next'

/**
 * Text for why a tool pill shows a problem. Known reason codes (invalidName, sourceUnreadable, …) read as a sentence; anything
 * else — an unknown code or an engine error message — is shown as is so the user can still act on it
 */
export function problemText(t: TFunction, reason: string | null | undefined): string | undefined {
  if (!reason) return undefined
  return /^[A-Za-z]+$/.test(reason) ? t(`sync.why.${reason}`, { defaultValue: reason }) : reason
}

/** Hint for an item the last sync failed or refused */
export function lastSyncFailedText(t: TFunction, reason: string): string {
  return t('sync.why.lastSyncFailed', { reason: problemText(t, reason) })
}
