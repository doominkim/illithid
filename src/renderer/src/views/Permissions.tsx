import { useState } from 'react'
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Group,
  SegmentedControl,
  Stack,
  Text,
  TextInput
} from '@mantine/core'
import { FileText, Plus, ShieldAlert, ShieldCheck, ShieldX, Webhook } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { parseCommand, type PermissionDecision } from '../../../engine/permissions'
import type { CommandRule, PermissionRules } from '../../../shared/api'
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
        count={commands.length}
        actions={
          <>
            <Button
              size="xs"
              leftSection={<Plus size={13} />}
              onClick={() => setSelected(NEW)}
              data-testid="perm-new"
            >
              {t('permissions.new')}
            </Button>
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

export default Permissions
