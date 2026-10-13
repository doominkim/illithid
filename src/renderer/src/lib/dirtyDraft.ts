import { createContext, useContext, useEffect, useId } from 'react'

const drafts = new Set<string>()

/** Mounted raw editors register drafts before a transition can discard them. */
export function useDirtyDraft(dirty: boolean): void {
  const id = useId()
  useEffect(() => {
    if (dirty) drafts.add(id)
    else drafts.delete(id)
    return () => {
      drafts.delete(id)
    }
  }, [id, dirty])
}

export function hasDirtyDrafts(): boolean {
  return drafts.size > 0
}

/** Requests explicit discard consent before a transition unmounts a raw editor. */
export const DraftGuardContext = createContext<(transition: () => void) => void>((transition) =>
  transition()
)

export function useDraftGuard(): (transition: () => void) => void {
  return useContext(DraftGuardContext)
}
