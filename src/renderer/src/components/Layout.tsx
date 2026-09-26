import { Alert, Box, Center, Loader, ScrollArea, Stack, Text } from '@mantine/core'
import { useTranslation } from 'react-i18next'

/** Full-height vertical stack. The last child (split area) takes the remaining height */
export function FillStack({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Stack h="100%" gap={0} style={{ minHeight: 0 }}>
      {children}
    </Stack>
  )
}

/** Left list card + right preview card. Each scrolls independently */
export function SplitPane({
  list,
  detail,
  listScroll = true,
  detailWidth = '50%'
}: {
  list: React.ReactNode
  detail: React.ReactNode
  /** When false, list scrolls itself (virtual list) */
  listScroll?: boolean
  detailWidth?: string
}): React.JSX.Element {
  return (
    <Box style={{ flex: 1, minHeight: 0, display: 'flex', gap: 14 }}>
      <Box className="ac-card" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {listScroll ? (
          <ScrollArea style={{ flex: 1 }} type="auto">
            {list}
          </ScrollArea>
        ) : (
          list
        )}
      </Box>
      <Box className="ac-card" style={{ width: detailWidth, minWidth: 0, display: 'flex', overflow: 'hidden' }}>
        <ScrollArea style={{ flex: 1 }} type="auto">
          <Box p="lg">{detail}</Box>
        </ScrollArea>
      </Box>
    </Box>
  )
}

export function Loading(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Center py={64}>
      <Stack align="center" gap="xs">
        <Loader size="sm" color="accent" />
        <Text size="sm" c="dimmed">
          {t('common.loading')}
        </Text>
      </Stack>
    </Center>
  )
}

export function ErrorAlert({ message }: { message: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Alert color="red" variant="light" radius="lg" title={t('common.error')}>
      {message}
    </Alert>
  )
}

export function NoSelection(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Text size="md" c="dimmed">
      {t('common.noSelection')}
    </Text>
  )
}

/** Name-value table for detail panels */
export function Fields({ rows }: { rows: [string, React.ReactNode][] }): React.JSX.Element {
  return (
    <Box
      component="dl"
      m={0}
      style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 20px' }}
    >
      {rows.map(([k, v]) => (
        <Box key={k} style={{ display: 'contents' }}>
          <Text component="dt" size="md" c="dimmed">
            {k}
          </Text>
          <Text component="dd" m={0} size="md" style={{ wordBreak: 'break-all' }}>
            {v}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
