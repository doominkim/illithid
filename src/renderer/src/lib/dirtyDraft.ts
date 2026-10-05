import { useEffect, useId } from 'react'

const drafts = new Set<string>()

/** Mounted raw editors register their drafts so workspace switching can warn before discarding them. */
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
