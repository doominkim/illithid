import { useState } from 'react'
import type { ViewMode } from '../components/ViewToggle'

/** Grid or list for one screen, remembered across screens and restarts (list until changed) */
export function useViewMode(screen: string): [ViewMode, (v: ViewMode) => void] {
  const key = `illithid-view:${screen}`
  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem(key) === 'grid' ? 'grid' : 'list'))
  const set = (v: ViewMode): void => {
    localStorage.setItem(key, v)
    setView(v)
  }
  return [view, set]
}
