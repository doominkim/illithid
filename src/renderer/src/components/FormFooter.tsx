import { useContext } from 'react'
import { createPortal } from 'react-dom'
import { Group } from '@mantine/core'
import { SheetFooterContext } from './sheetFooter'

/**
 * A form's cancel / submit buttons. Inside a DetailSheet they sit in a bar across the bottom of the sheet, always in view;
 * elsewhere, at the end of the form
 */
export function FormFooter({ children }: { children: React.ReactNode }): React.JSX.Element {
  const sheet = useContext(SheetFooterContext)
  if (!sheet?.slot)
    return (
      <Group justify="flex-end" gap="xs">
        {children}
      </Group>
    )
  return createPortal(
    <div className="ac-form-footer">
      <Group justify="flex-end" gap="xs" mx="auto" maw={sheet.maw} px={28}>
        {children}
      </Group>
    </div>,
    sheet.slot
  )
}
