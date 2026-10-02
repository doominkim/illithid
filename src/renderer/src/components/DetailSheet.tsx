import { ActionIcon, Box, Drawer, Group, Stack, Text, Title, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { ArrowLeft, Copy, FolderOpen, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface Props {
  opened: boolean
  onClose: () => void
  title: React.ReactNode
  description?: React.ReactNode
  /** Tag/badge line under the title */
  tags?: React.ReactNode
  /** Meta line such as path or file (icon + text) */
  meta?: React.ReactNode
  /** Header folder icon: show the item in Finder */
  onReveal?: () => void
  /** data-testid of the folder icon */
  revealTestId?: string
  /** Path copied by the header's copy-path icon */
  copyPath?: string
  /** Header delete icon (the caller confirms) */
  onDelete?: () => void
  /** data-testid of the delete icon */
  deleteTestId?: string
  /** Content max width (default 880 for reading and editing text) */
  maw?: number
  children?: React.ReactNode
}

/**
 * Detail panel covering everything right of the sidebar. Opens without an overlay so the sidebar stays usable.
 * The parent closes it on screen change.
 */
export function DetailSheet({
  opened,
  onClose,
  title,
  description,
  tags,
  meta,
  onReveal,
  revealTestId,
  copyPath,
  onDelete,
  deleteTestId,
  maw = 880,
  children
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const copy = (text: string): void => {
    navigator.clipboard.writeText(text).then(
      () => notifications.show({ message: t('common.copied'), color: 'accent', autoClose: 1500 }),
      () => notifications.show({ message: t('common.copyFailed'), color: 'red' })
    )
  }
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      withOverlay={false}
      withCloseButton={false}
      lockScroll={false}
      trapFocus={false}
      className="ac-sheet"
      transitionProps={{ duration: 0 }}
      styles={{
        content: { height: '100%', display: 'flex', flexDirection: 'column' },
        body: { padding: 0, flex: 1, minHeight: 0, overflowY: 'auto' }
      }}
    >
      <Box p={28} pt={48} mx="auto" maw={maw} data-testid="detail-sheet">
        <Group gap="sm" align="center" wrap="nowrap">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            onClick={onClose}
            aria-label={t('common.back')}
            style={{ flexShrink: 0 }}
          >
            <ArrowLeft size={20} />
          </ActionIcon>
          <Title order={1} style={{ wordBreak: 'break-word', flex: 1, minWidth: 0 }}>
            {title}
          </Title>
          {onReveal && (
            <Tooltip label={t('detail.reveal')} withArrow openDelay={300}>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="lg"
                onClick={onReveal}
                aria-label={t('detail.reveal')}
                style={{ flexShrink: 0 }}
                data-testid={revealTestId}
              >
                <FolderOpen size={18} />
              </ActionIcon>
            </Tooltip>
          )}
          {copyPath && (
            <Tooltip label={t('detail.copyPath')} withArrow openDelay={300}>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="lg"
                onClick={() => copy(copyPath)}
                aria-label={t('detail.copyPath')}
                style={{ flexShrink: 0 }}
                data-testid="detail-copy-path"
              >
                <Copy size={18} />
              </ActionIcon>
            </Tooltip>
          )}
          {onDelete && (
            <Tooltip label={t('detail.deleteItem')} withArrow openDelay={300}>
              <ActionIcon
                variant="subtle"
                color="red"
                size="lg"
                onClick={onDelete}
                aria-label={t('detail.deleteItem')}
                style={{ flexShrink: 0 }}
                data-testid={deleteTestId}
              >
                <Trash2 size={18} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        <Stack gap="sm" mt="sm" pl={44}>
          {description && (
            <Text size="lg" c="var(--ac-text-2)" lineClamp={4} style={{ lineHeight: 1.55 }}>
              {description}
            </Text>
          )}
          {tags && (
            <Group gap="xs" wrap="wrap">
              {tags}
            </Group>
          )}
          {meta && (
            <Group gap="lg" wrap="wrap">
              {meta}
            </Group>
          )}
        </Stack>
        <Box mt="lg" pl={44}>
          {children}
        </Box>
      </Box>
    </Drawer>
  )
}

/** One meta item: icon + mono text */
export function MetaItem({
  icon,
  children
}: {
  icon: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Group gap={6} wrap="nowrap" c="dimmed" style={{ minWidth: 0 }}>
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span>
      <Text size="sm" ff="monospace" c="dimmed" style={{ wordBreak: 'break-all' }}>
        {children}
      </Text>
    </Group>
  )
}
