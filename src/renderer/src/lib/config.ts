import { createContext, useContext } from 'react'
import type { ConfigView, ToolId } from '../../../shared/api'
import { DEFAULT_TOOLS_IN_USE } from '../../../engine/toolIds'
import { TOOLS } from './tools'

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

/** Tools in use on this device, in tool order (the default tools until config is loaded) */
export function useToolsInUse(): readonly ToolId[] {
  const inUse = useContext(ConfigContext).config?.inUse ?? DEFAULT_TOOLS_IN_USE
  return TOOLS.filter((t) => inUse.includes(t))
}
