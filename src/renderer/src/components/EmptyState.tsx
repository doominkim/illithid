import { Box, Stack, Text } from '@mantine/core'
import { Inbox } from 'lucide-react'

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
