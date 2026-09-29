import { ActionIcon, Box, Drawer, Group, Menu, Stack, Text, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { ArrowLeft, Copy, MoreHorizontal, Trash2 } from 'lucide-react'
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
  /** Path offered by "Copy path" in the ⋯ menu */
  copyPath?: string
  /** "Delete…" in the ⋯ menu (the caller confirms) */
  onDelete?: () => void
  /** data-testid of the Delete menu item */
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
          <ActionIcon variant="subtle" color="gray" size="lg" onClick={onClose} aria-label={t('common.back')} style={{ flexShrink: 0 }}>
            <ArrowLeft size={20} />
          </ActionIcon>
          <Title order={1} style={{ wordBreak: 'break-word', flex: 1, minWidth: 0 }}>
            {title}
          </Title>
          {(copyPath || onDelete) && (
            <Menu position="bottom-end" width={200} shadow="md">
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" size="lg" aria-label={t('detail.more')} style={{ flexShrink: 0 }} data-testid="detail-more">
                  <MoreHorizontal size={20} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {copyPath && (
                  <Menu.Item leftSection={<Copy size={14} />} onClick={() => copy(copyPath)}>
                    {t('detail.copyPath')}
                  </Menu.Item>
                )}
                {copyPath && onDelete && <Menu.Divider />}
                {onDelete && (
                  <Menu.Item color="red" leftSection={<Trash2 size={14} />} onClick={onDelete} data-testid={deleteTestId}>
                    {t('detail.deleteItem')}
                  </Menu.Item>
                )}
              </Menu.Dropdown>
            </Menu>
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
