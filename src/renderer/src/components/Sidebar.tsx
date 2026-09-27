import { Box, Button, Stack, Text, UnstyledButton } from '@mantine/core'
import {
  Bot,
  BookOpen,
  Brain,
  FolderOpen,
  CloudUpload,
  MessagesSquare,
  Plug,
  RefreshCw,
  Settings,
  Sparkles,
  Users
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { type Menu, PRIMARY, useNav } from '../lib/nav'
import { useSync } from '../lib/sync'
import { TOOL_NAME } from '../lib/tools'
import { WorkspaceBar } from './WorkspaceBar'

const ICON: Record<Menu, React.ComponentType<{ size?: number }>> = {
  rules: BookOpen,
  memory: Brain,
  skills: Sparkles,
  mcp: Plug,
  agents: Users,
  artifacts: FolderOpen,
  sessions: MessagesSquare,
  backup: CloudUpload,
  settings: Settings
}

function NavItem({
  menu,
  active,
  onClick,
  right,
  icon,
  label
}: {
  menu?: Menu
  active: boolean
  onClick: () => void
  right?: React.ReactNode
  icon: React.ReactNode
  label: string
}): React.JSX.Element {
  return (
    <UnstyledButton className="ac-nav" data-active={active || undefined} data-menu={menu} onClick={onClick}>
      <span className="ac-nav-icon">{icon}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {right}
    </UnstyledButton>
  )
}

/** Tools whose own first-run file is still missing (not an error): short yellow hint under the sync button */
function NotInitializedHint(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { status } = useSync()
  const tools = [...new Set((status?.notInitialized ?? []).map((x) => x.tool))]
  if (!tools.length) return null
  return (
    <Stack gap={2} mt={-4} mb={10} px={4} data-testid="sync-not-initialized">
      {tools.map((tool) => (
        <Text key={tool} size="xs" c="yellow.8">
          {t('sync.notInitialized', { tool: TOOL_NAME[tool] })}
        </Text>
      ))}
    </Stack>
  )
}

/** Sync status button: 0 pending = gray disabled, n pending = green, last sync failed = red (failed + pending). Click = apply preview → apply */
function SyncButton(): React.JSX.Element {
  const { t } = useTranslation()
  const { pending, busy, openPreview } = useSync()
  const failed = pending?.failed ?? 0
  const n = failed + (pending?.pending ?? 0)
  const color = failed ? 'red' : n ? 'green' : 'gray'
  return (
    <Button
      fullWidth
      size="xs"
      mb={10}
      variant="light"
      color={color}
      justify="flex-start"
      leftSection={<RefreshCw size={14} />}
      disabled={!n && !busy}
      loading={busy}
      onClick={openPreview}
      aria-label={t('sync.buttonAria')}
      data-testid="sync-button"
      data-state={failed ? 'failed' : n ? 'pending' : 'synced'}
    >
      {n ? t('sync.button', { n }) : t('sync.buttonSynced')}
    </Button>
  )
}

export function Sidebar({ onWorkspaceChange }: { onWorkspaceChange: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { request, navigate } = useNav()
  const active = request.menu

  const menuItem = (menu: Menu, right?: React.ReactNode): React.JSX.Element => {
    const Icon = ICON[menu]
    return (
      <NavItem
        key={menu}
        menu={menu}
        active={active === menu}
        onClick={() => navigate(menu, { tool: null })}
        icon={<Icon size={16} />}
        label={t(`nav.${menu}`)}
        right={right}
      />
    )
  }

  return (
    <Box
      component="nav"
      style={{
        width: 220,
        flexShrink: 0,
        height: '100%',
        background: 'var(--ac-sidebar-bg)',
        borderRight: '1px solid var(--ac-border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        padding: '48px 10px 10px'
      }}
    >
      <WorkspaceBar onChanged={onWorkspaceChange} />
      <SyncButton />
      <NotInitializedHint />
      <Stack gap={2}>
        {PRIMARY.map((m) =>
          m === 'artifacts' ? (
            <Box key="sep" pt={10} mt={8} style={{ borderTop: '1px solid var(--ac-border-subtle)' }}>
              {menuItem(m)}
            </Box>
          ) : (
            menuItem(m)
          )
        )}
      </Stack>


      <Box style={{ flex: 1 }} />

      <Box pt={10} style={{ borderTop: '1px solid var(--ac-border-subtle)' }}>
        <Stack gap={2}>
          {menuItem('backup')}
          {menuItem('settings')}
        </Stack>
      </Box>
      <Box px={8} pt={8}>
        <Text size="xs" c="dimmed">
          <Bot size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          {t('sidebar.shortcut')}
        </Text>
      </Box>
    </Box>
  )
}
