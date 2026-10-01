import { Box, Button, Stack, Text } from '@mantine/core'
import { Download, Inbox } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** Empty state: icon + title + hint. Usable inside cards or panels */
export function EmptyState({
  title,
  hint,
  icon,
  action
}: {
  title: React.ReactNode
  hint?: React.ReactNode
  icon?: React.ReactNode
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <Box py={36} px="md">
      <Stack align="center" gap={6}>
        <Box
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--ac-surface-active)',
            color: 'var(--ac-text-muted)'
          }}
        >
          {icon ?? <Inbox size={18} />}
        </Box>
        <Text fw={600} size="lg" mt={4}>
          {title}
        </Text>
        {hint && (
          <Text size="md" c="dimmed" ta="center" maw={420}>
            {hint}
          </Text>
        )}
        {action && <Box mt="xs">{action}</Box>}
      </Stack>
    </Box>
  )
}

/** Empty library list: title + Import button */
export function EmptyLibrary({
  onImport,
  icon
}: {
  onImport: () => void
  icon?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <EmptyState
      title={t('common.empty')}
      icon={icon}
      action={
        <Button
          size="xs"
          variant="default"
          leftSection={<Download size={13} />}
          onClick={onImport}
          data-testid="empty-import"
        >
          {t('common.import')}
        </Button>
      }
    />
  )
}
