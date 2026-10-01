import { useState } from 'react'
import {
  Autocomplete,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Group,
  SegmentedControl,
  Stack,
  Tabs,
  Text,
  TextInput
} from '@mantine/core'
import { FileText, Plug, Plus, ShieldAlert, ShieldCheck, ShieldX, Webhook } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { parseCommand, type PermissionDecision } from '../../../engine/permissions'
import type { CommandRule, McpRule, PermissionRules, PermissionsData } from '../../../shared/api'
import { ConfirmModal } from '../components/ConfirmModal'
import { DetailSheet, MetaItem } from '../components/DetailSheet'
import { EmptyState } from '../components/EmptyState'
import { ErrorAlert, Loading } from '../components/Layout'
import { ListCard, ListRow } from '../components/ListRow'
import { PageHeader, Toolbar } from '../components/PageHeader'
import { ReloadButton } from '../components/ReloadButton'
import { SearchInput } from '../components/SearchInput'
import { ToolPills } from '../components/ToolPills'
import { includesCI } from '../lib/format'
import { runWrite } from '../lib/mutate'
import { useNav } from '../lib/nav'
import { problemText } from '../lib/problemReason'
import { useReload } from '../lib/reload'
import { pillFromCellState, type PillMap, TOOLS } from '../lib/tools'
import { useApi } from '../lib/useApi'

const NEW = '__new__'
const ORDER: PermissionDecision[] = ['deny', 'ask', 'allow']

const DECISION_ICON: Record<PermissionDecision, React.ReactNode> = {
  deny: <ShieldX size={18} color="var(--mantine-color-red-6)" />,
  ask: <ShieldAlert size={18} color="var(--mantine-color-orange-6)" />,
  allow: <ShieldCheck size={18} color="var(--mantine-color-teal-6)" />
}

const commandText = (r: CommandRule): string => r.argv.join(' ')
/** A command has one rule: its words and whether it is exact identify it */
const ruleKey = (r: Pick<CommandRule, 'argv' | 'exact'>): string =>
  JSON.stringify([r.argv, r.exact])

function Permissions(): React.JSX.Element {
  const { t } = useTranslation()
  const reload = useReload()
  const { navigate } = useNav()
  const { data, error } = useApi('permissions', () => window.api.permissions())
  const [query, setQuery] = useState('')
  // ruleKey of the open rule, NEW for a new rule, null when closed
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [tab, setTab] = useState<string | null>('commands')
  const [mcpSelected, setMcpSelected] = useState<string | null>(null)

  if (error) return <ErrorAlert message={error} />
  if (!data) return <Loading />

  const commands = data.rules.commands
  const save = async (next: PermissionRules, success: string): Promise<boolean> => {
    const r = await runWrite(window.api.permissionsSave(next), { success })
    if (r) reload()
    return r !== null
  }
  const remove = async (): Promise<void> => {
    if (!current) return
    const ok = await save(
      { ...data.rules, commands: commands.filter((r) => r !== current) },
      t('permissions.deleted')
    )
    setConfirmDelete(false)
    if (ok) setSelected(null)
  }

  const pillsOf = (r: CommandRule): PillMap =>
    Object.fromEntries(
      TOOLS.map((tool) => {
        const st = data.tools[tool]
        if (!st || st === 'notApplicable') {
          // Copilot keeps no ask or allow rules
          if (tool === 'copilot' && st && r.decision !== 'deny')
            return [tool, { on: false, hint: t('permissions.copilotNo') }]
          return [tool, { on: false, na: true }]
        }
        if (st === 'viaClaude')
          return [tool, { on: true, via: true, hint: t('permissions.grokViaClaude') }]
        if (tool === 'copilot' && r.decision !== 'deny')
          return [tool, { on: false, hint: t('permissions.copilotNo') }]
        const hint =
          st === 'error'
            ? problemText(t, data.reasons?.[tool])
            : tool === 'copilot'
              ? t('permissions.copilotHook')
              : tool === 'codex' && r.exact
                ? t('permissions.codexPrefix')
                : undefined
        return [tool, { ...pillFromCellState(st), on: true, ...(hint ? { hint } : {}) }]
      })
    ) as PillMap

  const q = query.trim().toLowerCase()
  const shown = commands
    .map((r) => ({ r }))
    .filter(({ r }) => !q || includesCI(commandText(r), q) || includesCI(r.note ?? '', q))
  const current = commands.find((r) => ruleKey(r) === selected)

  return (
    <Stack gap={0} style={{ flex: 1 }}>
      <PageHeader
        title={t('nav.permissions')}
        count={commands.length + data.rules.mcp.length}
        actions={
          <>
            {tab === 'mcp' ? (
              <Button
                size="xs"
                leftSection={<Plus size={13} />}
                onClick={() => setMcpSelected(NEW)}
                data-testid="perm-mcp-new"
              >
                {t('permissions.mcpNew')}
              </Button>
            ) : (
              <Button
                size="xs"
                leftSection={<Plus size={13} />}
                onClick={() => setSelected(NEW)}
                data-testid="perm-new"
              >
                {t('permissions.new')}
              </Button>
            )}
            <ReloadButton />
          </>
        }
      />
      {data.error && (
        <Box mb="md">
          <ErrorAlert message={data.error} />
        </Box>
      )}
      <Toolbar
        left={
          <SearchInput value={query} onChange={setQuery} placeholder={t('permissions.search')} />
        }
      />
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="commands" data-testid="perm-tab-commands">
            {`${t('permissions.tabCommands')} ${commands.length}`}
          </Tabs.Tab>
          <Tabs.Tab value="mcp" data-testid="perm-tab-mcp">
            {`${t('permissions.tabMcp')} ${data.rules.mcp.length}`}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="mcp">
          <McpRules
            data={data}
            query={query}
            selected={mcpSelected}
            setSelected={setMcpSelected}
            save={save}
          />
        </Tabs.Panel>
        <Tabs.Panel value="commands">
          <Stack gap="lg">
            {commands.length === 0 ? (
              <EmptyState title={t('permissions.empty')} hint={t('permissions.emptyHint')} />
            ) : shown.length === 0 ? (
              <EmptyState title={t('common.noResults')} />
            ) : (
              ORDER.map((d) => {
                const rows = shown.filter(({ r }) => r.decision === d)
                if (!rows.length) return null
                return (
                  <Stack key={d} gap={8} data-testid={`perm-group-${d}`}>
                    <Text size="sm" fw={600} c="dimmed">
                      {`${t(`permissions.decision.${d}`)} ${rows.length}`}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t(`permissions.decisionHint.${d}`)}
                    </Text>
                    <ListCard>
                      {rows.map(({ r }) => (
                        <ListRow
                          key={ruleKey(r)}
                          avatar={DECISION_ICON[d]}
                          title={commandText(r)}
                          tags={
                            r.exact ? (
                              <Badge variant="default" size="xs" fw={500} c="dimmed">
                                {t('permissions.exact')}
                              </Badge>
                            ) : undefined
                          }
                          subtitle={r.note || undefined}
                          right={<ToolPills pills={pillsOf(r)} size={18} />}
                          active={ruleKey(r) === selected}
                          onClick={() => setSelected(ruleKey(r))}
                        />
                      ))}
                    </ListCard>
                  </Stack>
                )
              })
            )}

            {data.guards.length > 0 && (
              <Stack gap={8} data-testid="perm-guard-hooks">
                <Text size="sm" fw={600} c="dimmed">
                  {t('permissions.guards')}
                </Text>
                <Text size="xs" c="dimmed">
                  {t('permissions.guardsHint')}
                </Text>
                <ListCard>
                  {data.guards.map((g) => (
                    <ListRow
                      key={g.name}
                      avatar={<Webhook size={18} />}
                      title={g.name}
                      subtitle={g.patterns.join(', ')}
                      onClick={() => navigate('hooks', { select: g.name })}
                    />
                  ))}
                </ListCard>
              </Stack>
            )}

            <Stack gap={4}>
              {data.claudeOnly > 0 && (
                <Text size="xs" c="dimmed">
                  {t('permissions.claudeOnly', { count: data.claudeOnly })}
                </Text>
              )}
              <Text size="xs" c="dimmed">
                {t('permissions.restartHint')}
              </Text>
            </Stack>
          </Stack>
        </Tabs.Panel>
      </Tabs>

      <DetailSheet
        opened={selected === NEW}
        onClose={() => setSelected(null)}
        title={t('permissions.new')}
      >
        {selected === NEW && (
          <RuleForm
            taken={commands}
            onSubmit={async (rule) => {
              const ok = await save(
                { ...data.rules, commands: [...commands, rule] },
                t('permissions.created')
              )
              if (ok) setSelected(null)
            }}
            onCancel={() => setSelected(null)}
            submitLabel={t('common.create')}
            submitTestId="perm-create"
          />
        )}
      </DetailSheet>

      <DetailSheet
        opened={!!current}
        onClose={() => setSelected(null)}
        title={current ? commandText(current) : ''}
        meta={<MetaItem icon={<FileText size={14} />}>{data.file}</MetaItem>}
        onDelete={() => setConfirmDelete(true)}
        deleteTestId="perm-delete"
      >
        {current && (
          <Stack gap="lg">
            <ToolPills pills={pillsOf(current)} size={20} />
            <RuleForm
              key={selected}
              initial={current}
              taken={commands.filter((r) => r !== current)}
              onSubmit={async (rule) => {
                const ok = await save(
                  { ...data.rules, commands: commands.map((r) => (r === current ? rule : r)) },
                  t('permissions.saved')
                )
                if (ok) setSelected(ruleKey(rule))
              }}
              submitLabel={t('common.save')}
              submitTestId="perm-save"
            />
          </Stack>
        )}
      </DetailSheet>

      <ConfirmModal
        opened={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        danger
        title={t('permissions.deleteTitle')}
        confirmLabel={t('common.delete')}
        message={t('permissions.deleteBody', { command: current ? commandText(current) : '' })}
      />
    </Stack>
  )
}

/** Command, decision, exact, note */
function RuleForm({
  initial,
  taken,
  onSubmit,
  onCancel,
  submitLabel,
  submitTestId
}: {
  initial?: CommandRule
  /** The other rules (a command may have one rule) */
  taken: CommandRule[]
  onSubmit: (rule: CommandRule) => Promise<void>
  onCancel?: () => void
  submitLabel: string
  submitTestId: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState(initial ? commandText(initial) : '')
  const [decision, setDecision] = useState<PermissionDecision>(initial?.decision ?? 'deny')
  const [exact, setExact] = useState(initial?.exact ?? false)
  const [note, setNote] = useState(initial?.note ?? '')
  const [busy, setBusy] = useState(false)
  const argv = parseCommand(text)
  const dup = taken.some(
    (r) => r.exact === exact && JSON.stringify(r.argv) === JSON.stringify(argv)
  )
  const rule: CommandRule = {
    decision,
    argv,
    exact,
    ...(note.trim() ? { note: note.trim() } : {})
  }
  const dirty = !initial || JSON.stringify(rule) !== JSON.stringify(initial)
  const submit = async (): Promise<void> => {
    setBusy(true)
    await onSubmit(rule)
    setBusy(false)
  }
  return (
    <Stack gap="md" maw={560}>
      <Stack gap={6}>
        <TextInput
          label={t('permissions.command')}
          description={t('permissions.commandHint')}
          placeholder="git push --force"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          error={dup ? t('permissions.duplicate') : undefined}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          data-testid="perm-command"
        />
        {argv.length > 0 && (
          <Group gap={4} data-testid="perm-argv">
            {argv.map((a, i) => (
              <Code key={i}>{a}</Code>
            ))}
          </Group>
        )}
      </Stack>
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          {t('permissions.decisionLabel')}
        </Text>
        <SegmentedControl
          value={decision}
          onChange={(v) => setDecision(v as PermissionDecision)}
          data={ORDER.map((d) => ({ value: d, label: t(`permissions.decision.${d}`) }))}
          data-testid="perm-decision"
        />
        <Text size="xs" c="dimmed">
          {t(`permissions.decisionHint.${decision}`)}
        </Text>
      </Stack>
      <Checkbox
        label={t('permissions.exactLabel')}
        description={t('permissions.exactHint')}
        checked={exact}
        onChange={(e) => setExact(e.currentTarget.checked)}
        data-testid="perm-exact"
      />
      <TextInput
        label={t('permissions.note')}
        value={note}
        onChange={(e) => setNote(e.currentTarget.value)}
      />
      <Group justify="flex-end" gap="xs">
        {onCancel && (
          <Button size="xs" variant="default" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
        <Button
          size="xs"
          loading={busy}
          disabled={!argv.length || dup || !dirty}
          onClick={() => void submit()}
          data-testid={submitTestId}
        >
          {submitLabel}
        </Button>
      </Group>
    </Stack>
  )
}

const mcpKey = (m: Pick<McpRule, 'server' | 'tool'>): string => JSON.stringify([m.server, m.tool])

/** MCP tool rules: same groups, form and sheets as the command rules */
function McpRules({
  data,
  query,
  selected,
  setSelected,
  save
}: {
  data: PermissionsData
  query: string
  selected: string | null
  setSelected: (key: string | null) => void
  save: (next: PermissionRules, success: string) => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const rules = data.rules.mcp
  const current = rules.find((m) => mcpKey(m) === selected)
  const toolText = (m: McpRule): string => (m.tool === '*' ? t('permissions.allMcpTools') : m.tool)

  const pillsOf = (m: McpRule): PillMap =>
    Object.fromEntries(
      TOOLS.map((tool) => {
        const st = data.tools[tool]
        if (!st) return [tool, { on: false, na: true }]
        if (st === 'viaClaude')
          return [tool, { on: true, via: true, hint: t('permissions.grokViaClaude') }]
        const off = (hint: string): [string, { on: false; hint: string }] => [
          tool,
          { on: false, hint }
        ]
        if (tool === 'copilot') return off(t('permissions.copilotMcpNo'))
        if (tool === 'codex' && !data.servers.includes(m.server))
          return off(t('permissions.codexMcpUnmanaged'))
        if (tool === 'codex' && m.decision === 'allow') return off(t('permissions.codexMcpAllow'))
        if (tool === 'gemini' && m.server.includes('_'))
          return off(t('permissions.geminiUnderscore'))
        if (tool !== 'claude' && tool !== 'codex' && tool !== 'gemini')
          return [tool, { on: false, na: true }]
        if (st === 'notApplicable') return [tool, { on: true }]
        return [
          tool,
          {
            ...pillFromCellState(st),
            on: true,
            ...(st === 'error' ? { hint: problemText(t, data.reasons?.[tool]) } : {})
          }
        ]
      })
    ) as PillMap

  const q = query.trim().toLowerCase()
  const shown = rules.filter((m) => !q || includesCI(m.server, q) || includesCI(m.tool, q))
  const remove = async (): Promise<void> => {
    if (!current) return
    const ok = await save(
      { ...data.rules, mcp: rules.filter((m) => m !== current) },
      t('permissions.deleted')
    )
    setConfirmDelete(false)
    if (ok) setSelected(null)
  }

  return (
    <Stack gap="lg">
      {rules.length === 0 ? (
        <EmptyState title={t('permissions.mcpEmpty')} hint={t('permissions.mcpEmptyHint')} />
      ) : shown.length === 0 ? (
        <EmptyState title={t('common.noResults')} />
      ) : (
        ORDER.map((d) => {
          const rows = shown.filter((m) => m.decision === d)
          if (!rows.length) return null
          return (
            <Stack key={d} gap={8} data-testid={`perm-mcp-group-${d}`}>
              <Text size="sm" fw={600} c="dimmed">
                {`${t(`permissions.decision.${d}`)} ${rows.length}`}
              </Text>
              <ListCard>
                {rows.map((m) => (
                  <ListRow
                    key={mcpKey(m)}
                    avatar={DECISION_ICON[d]}
                    title={toolText(m)}
                    tags={
                      <Badge variant="default" size="xs" fw={500} leftSection={<Plug size={10} />}>
                        {m.server}
                      </Badge>
                    }
                    right={<ToolPills pills={pillsOf(m)} size={18} />}
                    active={mcpKey(m) === selected}
                    onClick={() => setSelected(mcpKey(m))}
                  />
                ))}
              </ListCard>
            </Stack>
          )
        })
      )}
      <Text size="xs" c="dimmed">
        {t('permissions.mcpHint')}
      </Text>

      <DetailSheet
        opened={selected === NEW}
        onClose={() => setSelected(null)}
        title={t('permissions.mcpNew')}
      >
        {selected === NEW && (
          <McpRuleForm
            servers={data.servers}
            taken={rules}
            onSubmit={async (rule) => {
              const ok = await save(
                { ...data.rules, mcp: [...rules, rule] },
                t('permissions.created')
              )
              if (ok) setSelected(null)
            }}
            onCancel={() => setSelected(null)}
            submitLabel={t('common.create')}
            submitTestId="perm-mcp-create"
          />
        )}
      </DetailSheet>
      <DetailSheet
        opened={!!current}
        onClose={() => setSelected(null)}
        title={current ? `${current.server} · ${toolText(current)}` : ''}
        meta={<MetaItem icon={<FileText size={14} />}>{data.file}</MetaItem>}
        onDelete={() => setConfirmDelete(true)}
        deleteTestId="perm-mcp-delete"
      >
        {current && (
          <Stack gap="lg">
            <ToolPills pills={pillsOf(current)} size={20} />
            <McpRuleForm
              key={selected}
              initial={current}
              servers={data.servers}
              taken={rules.filter((m) => m !== current)}
              onSubmit={async (rule) => {
                const ok = await save(
                  { ...data.rules, mcp: rules.map((m) => (m === current ? rule : m)) },
                  t('permissions.saved')
                )
                if (ok) setSelected(mcpKey(rule))
              }}
              submitLabel={t('common.save')}
              submitTestId="perm-mcp-save"
            />
          </Stack>
        )}
      </DetailSheet>
      <ConfirmModal
        opened={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        danger
        title={t('permissions.deleteTitle')}
        confirmLabel={t('common.delete')}
        message={t('permissions.deleteBody', {
          command: current ? `${current.server} · ${toolText(current)}` : ''
        })}
      />
    </Stack>
  )
}

/** Server, tool ('*' = every tool), decision */
function McpRuleForm({
  initial,
  servers,
  taken,
  onSubmit,
  onCancel,
  submitLabel,
  submitTestId
}: {
  initial?: McpRule
  servers: string[]
  taken: McpRule[]
  onSubmit: (rule: McpRule) => Promise<void>
  onCancel?: () => void
  submitLabel: string
  submitTestId: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [server, setServer] = useState(initial?.server ?? '')
  const [tool, setTool] = useState(initial && initial.tool !== '*' ? initial.tool : '')
  const [decision, setDecision] = useState<PermissionDecision>(initial?.decision ?? 'deny')
  const [busy, setBusy] = useState(false)
  const rule: McpRule = { decision, server: server.trim(), tool: tool.trim() || '*' }
  const dup = taken.some((m) => mcpKey(m) === mcpKey(rule))
  const dirty = !initial || JSON.stringify(rule) !== JSON.stringify(initial)
  const submit = async (): Promise<void> => {
    setBusy(true)
    await onSubmit(rule)
    setBusy(false)
  }
  const mono = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } }
  return (
    <Stack gap="md" maw={560}>
      <Autocomplete
        label={t('permissions.server')}
        data={servers}
        value={server}
        onChange={setServer}
        styles={mono}
        data-testid="perm-mcp-server"
      />
      <TextInput
        label={t('permissions.tool')}
        description={t('permissions.toolHint')}
        placeholder={t('permissions.allMcpTools')}
        value={tool}
        onChange={(e) => setTool(e.currentTarget.value)}
        error={dup ? t('permissions.duplicate') : undefined}
        styles={mono}
        data-testid="perm-mcp-tool"
      />
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          {t('permissions.decisionLabel')}
        </Text>
        <SegmentedControl
          value={decision}
          onChange={(v) => setDecision(v as PermissionDecision)}
          data={ORDER.map((d) => ({ value: d, label: t(`permissions.decision.${d}`) }))}
          data-testid="perm-mcp-decision"
        />
        <Text size="xs" c="dimmed">
          {t(`permissions.decisionHint.${decision}`)}
        </Text>
      </Stack>
      <Group justify="flex-end" gap="xs">
        {onCancel && (
          <Button size="xs" variant="default" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
        <Button
          size="xs"
          loading={busy}
          disabled={!rule.server || dup || !dirty}
          onClick={() => void submit()}
          data-testid={submitTestId}
        >
          {submitLabel}
        </Button>
      </Group>
    </Stack>
  )
}

export default Permissions
