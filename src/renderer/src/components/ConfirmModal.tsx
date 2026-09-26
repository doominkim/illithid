import { Button, Group, Modal, Stack, Text } from '@mantine/core'
import { useTranslation } from 'react-i18next'

interface Props {
  opened: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
  title: string
  message: React.ReactNode
  confirmLabel?: string
  /** Red for destructive actions */
  danger?: boolean
  loading?: boolean
}

/** Confirmation before destructive or hard-to-undo actions */
export function ConfirmModal({
  opened,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel,
  danger,
  loading
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Modal opened={opened} onClose={onClose} title={title} centered radius="lg" size="md">
      <Stack gap="md">
        <Text size="md" component="div">
          {message}
        </Text>
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose} disabled={loading}>
            {t('common.cancel')}
          </Button>
          <Button color={danger ? 'red' : 'accent'} onClick={() => void onConfirm()} loading={loading} data-testid="confirm-ok">
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
