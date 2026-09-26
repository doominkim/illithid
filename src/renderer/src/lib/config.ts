import { createContext, useContext } from 'react'
import type { ConfigView } from '../../../shared/api'

export interface ConfigCtx {
  config?: ConfigView
  allowRealApply: boolean
  /** Reload configGet */
  refresh: () => void
}

export const ConfigContext = createContext<ConfigCtx>({ allowRealApply: false, refresh: () => {} })

export function useConfig(): ConfigCtx {
  return useContext(ConfigContext)
}
