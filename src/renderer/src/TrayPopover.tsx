import { useCallback, useEffect, useState } from 'react'
import { Box, Button, CopyButton, Divider, Group, ScrollArea, Select, Stack, Text, UnstyledButton } from '@mantine/core'
import type { TraySession, UpdateView, WorkspaceView } from '../../shared/api'
import { ToolIcon } from './components/ToolIcon'

const TOOL_SHORT: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini', copilot: 'Copilot', grok: 'Grok' }

function ago(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000))
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

/** Menu bar popover (always English): update, recent sessions with Copy, workspace, Open / Settings / Quit */
export function TrayPopover(): React.JSX.Element {
  const [sessions, setSessions] = useState<TraySession[]>([])
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([])
  const [update, setUpdate] = useState<UpdateView | null>(null)
  // Re-render the relative times when the popover opens
  const [, setNow] = useState(0)

  const load = useCallback(() => {
    window.api.traySessions().then(setSessions, () => {})
    window.api.workspaces().then(setWorkspaces, () => {})
    window.api.updateStatus().then(setUpdate, () => {})
    setNow(Date.now())
  }, [])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; load also refreshes the relative times
    load()
    window.addEventListener('focus', load)
    const offSessions = window.api.onTraySessions(setSessions)
    const offUpdate = window.api.onUpdateEvent(setUpdate)
    return () => {
      window.removeEventListener('focus', load)
      offSessions()
      offUpdate()
    }
  }, [load])

  const active = workspaces.find((w) => w.active)
  return (
    <Stack gap={0} h="100vh" style={{ overflow: 'hidden' }} data-testid="tray-popover">
      {update && (
        <Box px="sm" pt="sm">
          <Button fullWidth size="xs" variant="light" onClick={() => void window.api.trayCommand({ kind: 'update' })}>
            Update to {update.version}…
          </Button>
        </Box>
      )}
      <Text size="xs" fw={600} c="dimmed" tt="uppercase" px="sm" pt="sm" pb={4}>
        Recent sessions
      </Text>
      <ScrollArea style={{ flex: 1 }} px={6}>
        {sessions.length === 0 ? (
          <Text size="sm" c="dimmed" px={6} py="xs">
            No sessions yet
          </Text>
        ) : (
          sessions.map((s) => (
            <Group key={s.resumeCommand} gap={8} wrap="nowrap" px={6} py={5} className="ac-tray-row">
              <ToolIcon tool={s.tool} size={16} />
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" truncate="end" title={s.title}>
                  {s.title.replace(/\s+/g, ' ')}
                </Text>
                <Text size="xs" c="dimmed">
                  {[TOOL_SHORT[s.tool] ?? s.tool, ago(s.updatedAt)].filter(Boolean).join(' · ')}
                </Text>
              </Box>
              <CopyButton value={s.resumeCommand}>
                {({ copied, copy }) => (
                  <Button size="compact-xs" variant={copied ? 'light' : 'default'} color={copied ? 'accent' : undefined} onClick={copy} title={s.resumeCommand}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
            </Group>
          ))
        )}
      </ScrollArea>
      <Divider />
      <Group px="sm" py={8} gap="xs" wrap="nowrap">
        <Text size="sm" c="dimmed">
          Workspace
        </Text>
        <Select
          size="xs"
          style={{ flex: 1 }}
          allowDeselect={false}
          value={active?.id ?? null}
          data={workspaces.map((w) => ({ value: w.id, label: w.name }))}
          onChange={(id) => {
            if (id && id !== active?.id) void window.api.trayCommand({ kind: 'workspace', id })
          }}
          comboboxProps={{ withinPortal: true }}
        />
      </Group>
      <Divider />
      <Group px={6} py={6} gap={0} justify="space-between">
        <Group gap={0}>
          <UnstyledButton className="ac-tray-action" onClick={() => void window.api.trayCommand({ kind: 'open' })}>
            Open Illithid
          </UnstyledButton>
          <UnstyledButton className="ac-tray-action" onClick={() => void window.api.trayCommand({ kind: 'settings' })}>
            Settings
          </UnstyledButton>
        </Group>
        <UnstyledButton className="ac-tray-action" onClick={() => void window.api.trayCommand({ kind: 'quit' })}>
          Quit
        </UnstyledButton>
      </Group>
    </Stack>
  )
}
