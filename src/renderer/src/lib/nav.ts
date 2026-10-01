import { createContext, useContext, useEffect } from 'react'
import type { ToolId } from '../../../shared/api'

export const PRIMARY = [
  'rules',
  'skills',
  'mcp',
  'hooks',
  'permissions',
  'agents',
  'market',
  'artifacts',
  'sessions',
  'stats',
  'memory'
] as const
export const SECONDARY = ['backup', 'settings'] as const
export type Menu = (typeof PRIMARY)[number] | (typeof SECONDARY)[number]

/** Navigation request. With select, the target screen opens that item's detail */
export interface NavRequest {
  menu: Menu
  select?: string
  /** Dashboard tool filter */
  tool?: ToolId | null
  seq: number
}

export interface Nav {
  request: NavRequest
  navigate: (menu: Menu, opts?: { select?: string; tool?: ToolId | null }) => void
}

export const NavContext = createContext<Nav>({
  request: { menu: 'rules', seq: 0 },
  navigate: () => {}
})

export function useNav(): Nav {
  return useContext(NavContext)
}

/** Moves a select request from Spotlight or the dashboard into the screen's selection state */
export function useNavSelect(setSelected: (id: string) => void): void {
  const { request } = useNav()
  useEffect(() => {
    if (request.select) setSelected(request.select)
    // Only when seq changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.seq])
}
