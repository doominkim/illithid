import { createContext, useContext, useEffect, useRef, useState } from 'react'

/** Caches results per channel for the app session so switching screens does not rescan. */
const cache = new Map<string, Promise<unknown>>()

export const RefreshContext = createContext(0)

export function clearApiCache(): void {
  cache.clear()
}

export interface ApiState<T> {
  data?: T
  error?: string
  loading: boolean
}

/** Strips the Electron invoke error prefix ("Error invoking remote method ...: Error: ") */
function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function useApi<T>(key: string, load: () => Promise<T>): ApiState<T> {
  const tick = useContext(RefreshContext)
  const [state, setState] = useState<ApiState<T>>({ loading: true })
  const lastKey = useRef(key)

  useEffect(() => {
    let alive = true
    let p = cache.get(key) as Promise<T> | undefined
    if (!p) {
      p = load()
      cache.set(key, p)
      p.catch(() => cache.delete(key))
    }
    // On reload keep showing the previous result; for a different key wait with it cleared
    const sameKey = lastKey.current === key
    lastKey.current = key
    setState((s) => ({ data: sameKey ? s.data : undefined, loading: true }))
    p.then(
      (data) => alive && setState({ data, loading: false }),
      (e) => alive && setState({ error: cleanError(e), loading: false })
    )
    return () => {
      alive = false
    }
    // load is identified by key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick])

  return state
}
