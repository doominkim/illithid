import { Group } from '@mantine/core'

/** A form's cancel / submit buttons, kept in view at the bottom of the sheet however long the form is */
export function FormFooter({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Group className="ac-form-footer" justify="flex-end" gap="xs">
      {children}
    </Group>
  )
}
