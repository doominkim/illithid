import { useState } from 'react'
import type { UsageSummary } from '../../../shared/api'
import { setUiPrefs, uiPrefs } from './uiPrefs'

export type ListSort = 'name' | 'usage'

/** Name or most-used order for one screen, kept in config.json `ui.sorts` (name until changed) */
export function useListSort(screen: string): [ListSort, (v: ListSort) => void] {
  const [sort, setSort] = useState<ListSort>(() => (uiPrefs().sorts?.[screen] === 'usage' ? 'usage' : 'name'))
  const set = (v: ListSort): void => {
    setUiPrefs({ sorts: { [screen]: v } })
    setSort(v)
  }
  return [sort, set]
}

/** Most calls in the last 30 days first, then by name; the given order when usage is unknown or sorting by name */
export function sortByUsage<T extends { name: string }>(items: T[], sort: ListSort, usage: Record<string, UsageSummary> | null | undefined): T[] {
  if (sort !== 'usage' || !usage) return items
  return [...items].sort((a, b) => (usage[b.name]?.recent ?? 0) - (usage[a.name]?.recent ?? 0) || a.name.localeCompare(b.name))
}
