import { useCallback, useState } from 'react'
import type { ToolId } from '../../../shared/api'

export interface ToggleBusy {
  /** Tools of this item with a toggle save in flight */
  of: (name: string) => ToolId[]
  /** Track one toggle save (per request — another toggle finishing never clears this one) */
  run: <T>(name: string, tool: ToolId, fn: () => Promise<T>) => Promise<T>
}

/** Per-request busy state for tool toggle pills (cards and detail sheets) */
export function useToggleBusy(): ToggleBusy {
  const [keys, setKeys] = useState<readonly string[]>([])
  const of = useCallback(
    (name: string): ToolId[] => keys.filter((k) => k.startsWith(`${name}\u0000`)).map((k) => k.split('\u0000')[1] as ToolId),
    [keys]
  )
  const run = useCallback(async <T,>(name: string, tool: ToolId, fn: () => Promise<T>): Promise<T> => {
    const key = `${name}\u0000${tool}`
    setKeys((ks) => [...ks, key])
    try {
      return await fn()
    } finally {
      setKeys((ks) => {
        const i = ks.indexOf(key)
        return i < 0 ? ks : [...ks.slice(0, i), ...ks.slice(i + 1)]
      })
    }
  }, [])
  return { of, run }
}
