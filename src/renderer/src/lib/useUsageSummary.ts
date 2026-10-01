import { useEffect, useState } from 'react'
import type { UsageKind, UsageSummary } from '../../../shared/api'

/**
 * Last-30-days usage for every name in a list, in one request. undefined while loading, null until the usage index exists;
 * reloads when an index run finishes. The previous result stays on screen while a changed list reloads
 */
export function useUsageSummary(kind: UsageKind, names: string[]): Record<string, UsageSummary> | null | undefined {
  const key = JSON.stringify([kind, [...names].sort()])
  const [result, setResult] = useState<Record<string, UsageSummary> | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    const [k, list] = JSON.parse(key) as [UsageKind, string[]]
    const load = (): void => {
      window.api.usageSummary(k, list).then(
        (v) => alive && setResult(v),
        () => alive && setResult(null)
      )
    }
    load()
    const off = window.api.onSearchIndexEvent((v) => {
      if (alive && !v.running) load()
    })
    return () => {
      alive = false
      off()
    }
  }, [key])
  return result
}
