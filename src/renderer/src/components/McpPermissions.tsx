import { useEffect, useState } from 'react'
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
  UnstyledButton
} from '@mantine/core'
import { ChevronDown, ChevronRight, ListRestart, Plug } from 'lucide-react'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import type {
  McpDecision,
  McpPermissions,
  McpToolInfo,
  PermissionsData,
  ToolId
} from '../../../shared/api'
import { useToolsInUse } from '../lib/config'
import { mcpRuleText } from '../lib/mcpRules'
import { runWrite } from '../lib/mutate'
import { includesCI } from '../lib/format'
import { ConfirmModal } from './ConfirmModal'
import { ErrorAlert, Loading } from './Layout'
import { ToolIcon } from './ToolIcon'

const DECISIONS: McpDecision[] = ['allow', 'ask', 'deny']
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/

/**
 * The permissions menu's MCP section: a default for every server, then each library server folded, opening to its own
 * default and a decision per tool. Each change is saved at once and reaches the tools on the next sync
 */
export function McpRulesSection({
  data,
  query,
  open,
  onFold,
  onChanged
}: {
  data: PermissionsData
  query: string
  open: ReadonlySet<string>
  onFold: (name: string) => void
  onChanged: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const servers = data.mcp.filter((m) => !query || includesCI(m.name, query))
  if (!data.mcp.length) return null

  const setAll = async (v: string): Promise<void> => {
    const r = await runWrite(window.api.mcpDefaultSave((v || null) as McpDecision | null), {
      success: t('mcp.perm.saved')
    })
    if (r !== null) onChanged()
  }

  return (
    <Stack gap={8} data-testid="perm-mcp-tools">
      <Text size="sm" fw={600} c="dimmed">
        {t('permissions.mcpTools')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('permissions.mcpToolsHint')}
      </Text>
      <Box className="ac-card" p="md">
        <Stack gap={6}>
          <Text size="sm" fw={500}>
            {t('permissions.mcpAll')}
          </Text>
          <SegmentedControl
            value={data.mcpDefault ?? ''}
            onChange={(v) => void setAll(v)}
            data={decisionChoices(t, t('mcp.perm.toolDefault'))}
            data-testid="perm-mcp-default"
          />
          <Text size="xs" c="dimmed">
            {t('permissions.mcpAllHint')}
          </Text>
          {data.mcpDefault === 'allow' && (
            <Text size="xs" c="var(--ac-warning)" data-testid="perm-mcp-allow-warning">
              {t('permissions.mcpAllowWarning')}
            </Text>
          )}
        </Stack>
      </Box>
      {servers.map((m) => {
        const opened = open.has(m.name)
        return (
          <Stack key={m.name} gap={8} data-testid="perm-mcp-server" data-server={m.name}>
            <Group gap={6} wrap="nowrap" align="flex-start">
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                onClick={() => onFold(m.name)}
                aria-label={t(opened ? 'permissions.collapse' : 'permissions.expand')}
              >
                {opened ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </ActionIcon>
              <UnstyledButton
                onClick={() => onFold(m.name)}
                style={{ minWidth: 0 }}
                data-testid="perm-mcp-server-open"
              >
                <Group gap={6} wrap="nowrap">
                  <Plug size={14} />
                  <Text size="sm" fw={600}>
                    {m.name}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed" data-testid="perm-mcp-summary">
                  {mcpRuleText(t, m)}
                </Text>
              </UnstyledButton>
            </Group>
            {opened && (
              <Box className="ac-card" p="md">
                <McpServerRules name={m.name} allDefault={data.mcpDefault} onChanged={onChanged} />
              </Box>
            )}
          </Stack>
        )
      })}
    </Stack>
  )
}

function decisionChoices(
  t: (k: string) => string,
  first: string
): { value: string; label: string }[] {
  return [
    { value: '', label: first },
    ...DECISIONS.map((d) => ({ value: d, label: t(`permissions.decision.${d}`) }))
  ]
}

/** One server's default and its tools' decisions. Notes say where a tool can't follow a rule */
function McpServerRules({
  name,
  allDefault,
  onChanged
}: {
  name: string
  allDefault?: McpDecision
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const inUse = useToolsInUse()
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
    if (r === null) return
    load()
    onChanged()
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
  const effective = rules.default ?? allDefault
  const hasRules = !!effective || Object.keys(rules.tools ?? {}).length > 0
  const allowUnderStricter =
    (effective === 'ask' || effective === 'deny') &&
    Object.values(rules.tools ?? {}).includes('allow')
  const notes: [string, string][] = []
  if (allowUnderStricter && inUse.includes('claude'))
    notes.push(['claude', t('mcp.perm.noteClaude')])
  if (effective === 'deny' && inUse.includes('codex'))
    notes.push(['codex', t('mcp.perm.noteCodex')])
  if (hasRules && name.includes('_') && inUse.includes('gemini'))
    notes.push(['gemini', t('mcp.perm.noteGemini')])
  if (hasRules && inUse.includes('copilot')) notes.push(['copilot', t('mcp.perm.noteCopilot')])

  return (
    <Stack gap="md" data-testid="mcp-permissions">
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          {t('mcp.perm.default')}
        </Text>
        <SegmentedControl
          value={rules.default ?? ''}
          onChange={setDefault}
          data={decisionChoices(
            t,
            allDefault
              ? t('mcp.perm.useAll', { decision: t(`permissions.decision.${allDefault}`) })
              : t('mcp.perm.toolDefault')
          )}
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
          onClick={() => (info.transport === 'stdio' ? setConfirmFetch(true) : void fetchTools())}
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
                    data={decisionChoices(t, t('mcp.perm.useDefault'))}
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
        message={t('mcp.perm.fetchConfirm', { command: info.command ?? '' })}
      />
    </Stack>
  )
}
