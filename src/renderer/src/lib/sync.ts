import { createContext, useContext, useMemo } from 'react'
import type { SyncPendingView, SyncStatusView, ToolId } from '../../../shared/api'

export interface SyncCtx {
  status?: SyncStatusView
  /** Reload syncStatus */
  refresh: () => void
  /** Sync now (source → tools). Rescans all screens when done */
  syncNow: () => Promise<SyncStatusView | null>
  busy: boolean
  /** Pending and failed counts (sidebar sync button) */
  pending?: SyncPendingView
  /** One real apply now (user click only) */
  /** fingerprint = the reviewed preview's plan; a changed plan is refused (planChanged) and nothing is written */
  applyOnce: (fingerprint: string) => Promise<SyncStatusView | null>
  /** Open the apply preview (changes per tool → Apply) */
  /** onCancel runs when the preview is dismissed without applying (cancel, close button, Esc) */
  openPreview: (opts?: { onCancel?: () => void }) => void
}

export const SyncContext = createContext<SyncCtx>({
  refresh: () => {},
  syncNow: async () => null,
  busy: false,
  applyOnce: async () => null,
  openPreview: () => {}
})

export function useSync(): SyncCtx {
  return useContext(SyncContext)
}

/**
 * Items failed or refused in the last sync, queried by (kind, name, tool): the reason (code or message), or null when the item
 * did not fail. Shown in the tool pill's tooltip
 */
export function useSyncFailures(): (kind: 'rule' | 'skill' | 'agent', name: string, tool: ToolId) => string | null {
  const { status } = useSync()
  return useMemo(() => {
    const bad = new Map<string, string>()
    const failed = (x: { status: string; reason?: string }): boolean =>
      x.status === 'failed' || (x.status === 'refused' && x.reason !== 'changedSinceCheck')
    for (const x of status?.rules ?? []) if (failed(x)) bad.set(`rule:${x.tool ?? 'claude'}:${x.name}`, x.reason || x.status)
    for (const x of status?.skills ?? []) if (failed(x)) bad.set(`skill:${x.tool}:${x.name}`, x.reason || x.status)
    for (const x of status?.agents ?? []) if (failed(x)) bad.set(`agent:${x.tool}:${x.name}`, x.reason || x.status)
    return (kind: 'rule' | 'skill' | 'agent', name: string, tool: ToolId): string | null =>
      bad.get(`${kind}:${tool}:${name}`) ?? null
  }, [status])
}
