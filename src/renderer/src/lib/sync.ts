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
  applyOnce: () => Promise<SyncStatusView | null>
  /** Open the apply preview (changes per tool → Apply) */
  openPreview: () => void
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

/** Items failed or refused in the last sync, queried by (kind, name, tool). Used for the red dot on cards */
export function useSyncFailures(): (kind: 'rule' | 'skill' | 'agent', name: string, tool: ToolId) => boolean {
  const { status } = useSync()
  return useMemo(() => {
    const bad = new Set<string>()
    const failed = (x: { status: string; reason?: string }): boolean =>
      x.status === 'failed' || (x.status === 'refused' && x.reason !== 'changedSinceCheck')
    for (const x of status?.rules ?? []) if (failed(x)) bad.add(`rule:claude:${x.name}`)
    for (const x of status?.skills ?? []) if (failed(x)) bad.add(`skill:${x.tool}:${x.name}`)
    for (const x of status?.agents ?? []) if (failed(x)) bad.add(`agent:${x.tool}:${x.name}`)
    return (kind: 'rule' | 'skill' | 'agent', name: string, tool: ToolId): boolean =>
      bad.has(`${kind}:${tool}:${name}`)
  }, [status])
}
