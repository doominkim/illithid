import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Group,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput
} from '@mantine/core'
import { ListRestart } from 'lucide-react'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import type {
  McpDecision,
  McpPermissions,
  McpServerView,
  McpToolInfo,
  ToolId
} from '../../../shared/api'
import { useToolsInUse } from '../lib/config'
import { runWrite } from '../lib/mutate'
import { ConfirmModal } from './ConfirmModal'
import { ErrorAlert, Loading } from './Layout'
import { ToolIcon } from './ToolIcon'

const DECISIONS: McpDecision[] = ['allow', 'ask', 'deny']
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/

/**
 * An MCP server's tool rules: a default for the server and a decision per tool. Each change is saved at once and reaches the
 * tools on the next sync. Notes say where a tool can't follow a rule
 */
export function McpPermissionsTab({ server }: { server: McpServerView }): React.JSX.Element {
  const { t } = useTranslation()
  const inUse = useToolsInUse()
  const name = server.name
  const [info, setInfo] = useState<McpToolInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [added, setAdded] = useState<string[]>([])
  const [newTool, setNewTool] = useState('')
  const [confirmFetch, setConfirmFetch] = useState(false)
  const [fetching, setFetching] = useState(false)

  const load = (): void => {
    void window.api.mcpToolInfo(name).then((r) => {
      if (r.ok) setInfo(r.value)
      else setErr(r.message)
    })
  }
  useEffect(load, [name])

  if (err) return <ErrorAlert message={err} />
  if (!info) return <Loading />

  const rules = info.permissions
  const tools = [...new Set([...info.tools, ...added])].sort()
  const save = async (next: McpPermissions): Promise<void> => {
    const r = await runWrite(window.api.mcpPermissionsSave(name, next), {
      success: t('mcp.perm.saved')
    })
    if (r !== null) load()
  }
  const setDefault = (v: string): void => {
    const { default: _, ...rest } = rules
    void _
    void save(v ? { ...rest, default: v as McpDecision } : rest)
  }
  const setTool = (tool: string, v: string): void => {
    const next = { ...(rules.tools ?? {}) }
    if (v) next[tool] = v as McpDecision
    else delete next[tool]
    void save({ ...rules, tools: next })
  }
  const add = (): void => {
    const tool = newTool.trim()
    if (!TOOL_NAME_RE.test(tool) || tools.includes(tool)) return
    setAdded((a) => [...a, tool])
    setNewTool('')
  }
  const fetchTools = async (): Promise<void> => {
    setConfirmFetch(false)
    setFetching(true)
    const r = await runWrite(window.api.mcpFetchTools(name))
    setFetching(false)
    if (r === null) return
    notifications.show({ message: t('mcp.perm.fetched', { count: r.length }), color: 'accent' })
    load()
  }

  // Where a tool can't follow the rules (only for tools in use)
  const hasRules = !!rules.default || Object.keys(rules.tools ?? {}).length > 0
  const allowUnderStricter =
    (rules.default === 'ask' || rules.default === 'deny') &&
    Object.values(rules.tools ?? {}).includes('allow')
  const notes: [string, string][] = []
  if (allowUnderStricter && inUse.includes('claude'))
    notes.push(['claude', t('mcp.perm.noteClaude')])
  if (rules.default === 'deny' && inUse.includes('codex'))
    notes.push(['codex', t('mcp.perm.noteCodex')])
  if (hasRules && name.includes('_') && inUse.includes('gemini'))
    notes.push(['gemini', t('mcp.perm.noteGemini')])
  if (hasRules && inUse.includes('copilot')) notes.push(['copilot', t('mcp.perm.noteCopilot')])

  const choices = (first: string): { value: string; label: string }[] => [
    { value: '', label: first },
    ...DECISIONS.map((d) => ({ value: d, label: t(`permissions.decision.${d}`) }))
  ]

  return (
    <Stack gap="md" data-testid="mcp-permissions">
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          {t('mcp.perm.default')}
        </Text>
        <SegmentedControl
          value={rules.default ?? ''}
          onChange={setDefault}
          data={choices(t('mcp.perm.toolDefault'))}
          data-testid="mcp-perm-default"
        />
        <Text size="xs" c="dimmed">
          {t('mcp.perm.defaultHint')}
        </Text>
      </Stack>

      {notes.length > 0 && (
        <Stack gap={4}>
          {notes.map(([tool, text]) => (
            <Group key={tool} gap={6} wrap="nowrap" data-testid={`mcp-perm-note-${tool}`}>
              <ToolIcon tool={tool as ToolId} size={14} />
              <Text size="xs" c="dimmed">
                {text}
              </Text>
            </Group>
          ))}
        </Stack>
      )}

      <Group justify="space-between" align="flex-end">
        <Text size="sm" fw={500}>
          {t('mcp.perm.tools')}
        </Text>
        <Button
          size="xs"
          variant="default"
          leftSection={<ListRestart size={13} />}
          loading={fetching}
          onClick={() => (server.transport === 'stdio' ? setConfirmFetch(true) : void fetchTools())}
          data-testid="mcp-perm-fetch"
        >
          {t('mcp.perm.fetch')}
        </Button>
      </Group>
      {tools.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('mcp.perm.noTools')}
        </Text>
      ) : (
        <Table verticalSpacing={6} highlightOnHover>
          <Table.Tbody>
            {tools.map((tool) => (
              <Table.Tr key={tool}>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" ff="monospace">
                      {tool}
                    </Text>
                    {info.codexOnly[tool] && !rules.tools?.[tool] && (
                      <Badge variant="default" size="xs" fw={500} c="dimmed">
                        Codex: {info.codexOnly[tool]}
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td align="right">
                  <SegmentedControl
                    size="xs"
                    value={rules.tools?.[tool] ?? ''}
                    onChange={(v) => setTool(tool, v)}
                    data={choices(t('mcp.perm.useDefault'))}
                    data-testid={`mcp-perm-tool-${tool}`}
                  />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <TextInput
        placeholder={t('mcp.perm.addPlaceholder')}
        value={newTool}
        onChange={(e) => setNewTool(e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Enter' && add()}
        error={
          newTool.trim() && !TOOL_NAME_RE.test(newTool.trim()) ? t('mcp.perm.badName') : undefined
        }
        w={320}
        data-testid="mcp-perm-add"
      />
      <Text size="xs" c="dimmed">
        {t('mcp.perm.toolsHint')}
      </Text>

      <ConfirmModal
        opened={confirmFetch}
        onClose={() => setConfirmFetch(false)}
        onConfirm={fetchTools}
        title={t('mcp.perm.fetch')}
        confirmLabel={t('mcp.perm.fetchRun')}
        message={t('mcp.perm.fetchConfirm', {
          command: [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
        })}
      />
    </Stack>
  )
}
