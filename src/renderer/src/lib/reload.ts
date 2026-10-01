import { createContext, useContext } from 'react'

/** Reload (clear cache and rescan). Used by header action buttons */
export const ReloadContext = createContext<() => void>(() => {})

/** Clear the cache so every screen reloads (after writes) */
export function useReload(): () => void {
  return useContext(ReloadContext)
}
