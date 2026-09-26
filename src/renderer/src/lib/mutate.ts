import { notifications } from '@mantine/notifications'
import i18n from '../i18n'
import type { Refused, SyncStatusView, WriteResult } from '../../../shared/api'
import { clearApiCache } from './useApi'

export function isRefused(v: unknown): v is Refused {
  return !!v && typeof v === 'object' && 'refused' in (v as object)
}

interface Opts {
  /** Success notification text. No notification if omitted */
  success?: string
  /** Clear the cache on success so the next render rescans (default true) */
  invalidate?: boolean
}

/**
 * Handles write IPC results in one place: errors and refusals become notifications, success returns the value.
 * Refusal (allowRealApply off) is yellow, errors are red.
 */
export async function runWrite<T>(
  p: Promise<WriteResult<T> | Refused>,
  opts: Opts = {}
): Promise<T | null> {
  const t = i18n.t.bind(i18n)
  let r: WriteResult<T> | Refused
  try {
    r = await p
  } catch (e) {
    notifications.show({ color: 'red', title: t('common.error'), message: String((e as Error).message ?? e) })
    return null
  }
  if (isRefused(r)) {
    notifications.show({
      color: 'yellow',
      title: t(`refused.${r.refused}`),
      message: r.refused === 'allowRealApplyOff' ? t('refused.allowRealApplyHint') : r.message
    })
    return null
  }
  if (!r.ok) {
    notifications.show({ color: 'red', title: t(`libError.${r.code}`, { defaultValue: r.code }), message: r.message })
    return null
  }
  if (opts.invalidate !== false) clearApiCache()
  if (opts.success) notifications.show({ color: 'accent', message: opts.success, autoClose: 2000 })
  // Auto-sync result after a library write
  if ('sync' in r && r.sync) {
    notifySync(r.sync)
    window.dispatchEvent(new Event(LIBRARY_CHANGED))
  }
  return r.value as T
}

/** Library write succeeded (to recount pending applies) */
export const LIBRARY_CHANGED = 'illithid:libraryChanged'

/** Sync result notification (written count or errors) */
export function notifySync(s: SyncStatusView): void {
  const t = i18n.t.bind(i18n)
  if (s.wrote) {
    const n = s.targets.filter((x) => x.status === 'written').length + [...s.rules, ...s.skills, ...(s.agents ?? [])].filter((x) => x.status === 'done').length
    if (s.errorCount) notifications.show({ color: 'red', title: t('sync.syncedWithErrors', { n: s.errorCount }), message: s.errors.join(' · ') })
    else notifications.show({ color: 'accent', message: t('sync.syncedNow', { n }), autoClose: 2500 })
  } else if (s.refused === 'realHomeNotAllowed') {
    notifications.show({ color: 'yellow', title: t('sync.savedOnly'), message: t('refused.allowRealApplyHint') })
  }
}
