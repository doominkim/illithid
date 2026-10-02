import { createContext } from 'react'

/** Where a form in a DetailSheet puts its buttons: a bar across the bottom of the sheet (see FormFooter) */
export const SheetFooterContext = createContext<{ slot: HTMLElement | null; maw: number } | null>(
  null
)
