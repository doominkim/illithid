import { useState } from 'react'
import type { ViewMode } from '../components/ViewToggle'
import { setUiPrefs, uiPrefs } from './uiPrefs'

/** Grid or list for one screen, kept in config.json `ui.views` across screens, restarts and updates (list until changed) */
export function useViewMode(screen: string): [ViewMode, (v: ViewMode) => void] {
  const [view, setView] = useState<ViewMode>(() =>
    uiPrefs().views?.[screen] === 'grid' ? 'grid' : 'list'
  )
  const set = (v: ViewMode): void => {
    setUiPrefs({ views: { [screen]: v } })
    setView(v)
  }
  return [view, set]
}
