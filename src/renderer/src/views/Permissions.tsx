import { useState } from 'react'
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
  UnstyledButton
} from '@mantine/core'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Plus,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Webhook
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { commandLine, parseCommand, type PermissionDecision } from '../../../engine/permissions'
import type { CommandRule, PermissionRules, RuleGroup, ToolId } from '../../../shared/api'
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
import { useToggleBusy } from '../lib/toggleBusy'
import { pillFromCellState, type PillMap, TOOLS } from '../lib/tools'
import { useApi } from '../lib/useApi'

const NEW = '__new__'
const ORDER: PermissionDecision[] = ['deny', 'ask', 'allow']

const DECISION_ICON: Record<PermissionDecision, React.ReactNode> = {
  deny: <ShieldX size={18} color="var(--mantine-color-red-6)" />,
  ask: <ShieldAlert size={18} color="var(--mantine-color-orange-6)" />,
  allow: <ShieldCheck size={18} color="var(--mantine-color-teal-6)" />
}

const DECISION_COLOR: Record<PermissionDecision, string> = {
  deny: 'red',
  ask: 'orange',
  allow: 'teal'
}

/** Right padding of a list row (.ac-row) plus the card border, so a group's pills line up with its rules' */
const ROW_PAD = 15

const commandText = (r: CommandRule): string => r.argv.join(' ')
/** A command has one rule: its words and whether it is exact identify it */
const ruleKey = (r: Pick<CommandRule, 'argv' | 'exact'>): string =>
  JSON.stringify([r.argv, r.exact])
/** Block first, then ask, then allow; file order within each */
const byDecision = (rules: CommandRule[]): CommandRule[] =>
  ORDER.flatMap((d) => rules.filter((r) => r.decision === d))

function Permissions(): React.JSX.Element {
  const { t } = useTranslation()
  const reload = useReload()
  const { navigate } = useNav()
  const { data, error } = useApi('permissions', () => window.api.permissions())
  const [query, setQuery] = useState('')
  // ruleKey of the open rule, null when closed
  const [selected, setSelected] = useState<string | null>(null)
  // name of the open group, NEW for new rules, null when closed
  const [groupSel, setGroupSel] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmGroupDelete, setConfirmGroupDelete] = useState(false)
  const busy = useToggleBusy()

  if (error) return <ErrorAlert message={error} />
  if (!data) return <Loading />

  const commands = data.rules.commands
  const groups = data.rules.groups ?? []
  const save = async (next: PermissionRules, success: string): Promise<boolean> => {
    const r = await runWrite(window.api.permissionsSave(next), { success })
    if (r) reload()
    return r !== null
  }
  const openRule = (key: string | null): void => {
    setGroupSel(null)
    setSelected(key)
  }
  const openGroup = (name: string | null): void => {
    setSelected(null)
    setGroupSel(name)
  }
  const remove = async (): Promise<void> => {
    if (!current) return
    const ok = await save(
      { groups, commands: commands.filter((r) => r !== current) },
      t('permissions.deleted')
    )
    setConfirmDelete(false)
    if (ok) setSelected(null)
  }
  const removeGroup = async (): Promise<void> => {
    if (!currentGroup) return
    const ok = await save(
      {
        groups: groups.filter((g) => g !== currentGroup),
        commands: commands.filter((r) => r.group !== currentGroup.name)
      },
      t('permissions.groupDeleted')
    )
    setConfirmGroupDelete(false)
    if (ok) setGroupSel(null)
  }
  const fold = (name: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  /** Copilot keeps only block rules, and Grok reads Claude Code's: those pills can't be turned */
  const turnable = (r: CommandRule, tool: ToolId): boolean => {
    const st = data.tools[tool]
    if (!st || st === 'notApplicable' || st === 'viaClaude') return false
    return tool !== 'copilot' || r.decision === 'deny'
  }
  const isOn = (r: CommandRule, tool: ToolId): boolean => !r.off?.includes(tool)
  const withTool = (r: CommandRule, tool: ToolId, on: boolean): CommandRule => {
    const off = (r.off ?? []).filter((x) => x !== tool)
    if (!on) off.push(tool)
    const next: CommandRule = { ...r, off }
    if (!off.length) delete next.off
    return next
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
          return [tool, { on: isOn(r, 'claude'), via: true, hint: t('permissions.grokViaClaude') }]
        if (tool === 'copilot' && r.decision !== 'deny')
          return [tool, { on: false, hint: t('permissions.copilotNo') }]
        if (!isOn(r, tool)) return [tool, { on: false, pending: st === 'needsSync' }]
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

  /** A group's pill per tool: on when all its rules that tool can take are on */
  const groupPills = (rules: CommandRule[]): PillMap =>
    Object.fromEntries(
      TOOLS.map((tool) => {
        const st = data.tools[tool]
        if (st === 'viaClaude') {
          const on = rules.filter((r) => isOn(r, 'claude')).length
          return [
            tool,
            { on: on === rules.length, via: true, hint: t('permissions.grokViaClaude') }
          ]
        }
        const can = rules.filter((r) => turnable(r, tool))
        if (!can.length)
          // Shown like its rules' pills: Copilot with only ask or allow rules is off, not hidden
          return [
            tool,
            tool === 'copilot' && st
              ? { on: false, hint: t('permissions.copilotNo') }
              : { on: false, na: true }
          ]
        const on = can.filter((r) => isOn(r, tool)).length
        return [
          tool,
          {
            on: on === can.length,
            pending: st === 'needsSync',
            ...(on > 0 && on < can.length
              ? { hint: t('permissions.groupPartial', { on, count: can.length }) }
              : {})
          }
        ]
      })
    ) as PillMap

  const turn = async (key: string, tool: ToolId, next: CommandRule[]): Promise<void> => {
    await busy.run(key, tool, () =>
      runWrite(window.api.permissionsSave({ groups, commands: next }), {
        success: t('toggles.saved')
      })
    )
    reload()
  }
  const toggleRule = (r: CommandRule, tool: ToolId): void => {
    if (!turnable(r, tool)) return
    void turn(
      ruleKey(r),
      tool,
      commands.map((x) => (x === r ? withTool(x, tool, !isOn(x, tool)) : x))
    )
  }
  const toggleGroup = (g: RuleGroup, tool: ToolId): void => {
    const can = commands.filter((r) => r.group === g.name && turnable(r, tool))
    if (!can.length) return
    // All on → all off; otherwise all on
    const on = !can.every((r) => isOn(r, tool))
    void turn(
      `group:${g.name}`,
      tool,
      commands.map((x) => (can.includes(x) ? withTool(x, tool, on) : x))
    )
  }

  const q = query.trim().toLowerCase()
  const ruleMatches = (r: CommandRule): boolean =>
    includesCI(commandText(r), q) || includesCI(r.description ?? '', q)
  const groupMatches = (g: RuleGroup): boolean =>
    includesCI(g.name, q) || includesCI(g.description ?? '', q)
  const sections = [
    ...groups.map((g) => {
      const all = commands.filter((r) => r.group === g.name)
      return { group: g, rows: !q || groupMatches(g) ? all : all.filter(ruleMatches) }
    }),
    {
      group: null,
      rows: commands.filter((r) => !r.group && (!q || ruleMatches(r)))
    }
  ].filter((s) => s.rows.length)
  const current = commands.find((r) => ruleKey(r) === selected)
  const currentGroup = groups.find((g) => g.name === groupSel)

  const ruleRow = (r: CommandRule): React.JSX.Element => (
    <ListRow
      key={ruleKey(r)}
      avatar={DECISION_ICON[r.decision]}
      title={commandText(r)}
      tags={
        <>
          <Badge
            variant="light"
            color={DECISION_COLOR[r.decision]}
            size="xs"
            fw={500}
            data-testid={`perm-badge-${r.decision}`}
          >
            {t(`permissions.decision.${r.decision}`)}
          </Badge>
          {r.exact && (
            <Badge variant="default" size="xs" fw={500} c="dimmed">
              {t('permissions.exact')}
            </Badge>
          )}
        </>
      }
      subtitle={r.description || undefined}
      right={
        <ToolPills
          pills={pillsOf(r)}
          size={18}
          onToggle={(tool) => toggleRule(r, tool)}
          busy={busy.of(ruleKey(r))}
        />
      }
      active={ruleKey(r) === selected}
      onClick={() => openRule(ruleKey(r))}
    />
  )

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
              onClick={() => openGroup(NEW)}
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
        ) : sections.length === 0 ? (
          <EmptyState title={t('common.noResults')} />
        ) : (
          sections.map(({ group: g, rows }) => {
            if (!g)
              return (
                <Stack key="" gap={8} data-testid="perm-ungrouped">
                  {groups.length > 0 && (
                    <Text size="sm" fw={600} c="dimmed">
                      {`${t('permissions.ungrouped')} ${rows.length}`}
                    </Text>
                  )}
                  <ListCard>{byDecision(rows).map(ruleRow)}</ListCard>
                </Stack>
              )
            const closed = collapsed.has(g.name) && !q
            return (
              <Stack key={g.name} gap={8} data-testid="perm-group" data-group={g.name}>
                <Group gap={6} wrap="nowrap" align="flex-start">
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    onClick={() => fold(g.name)}
                    aria-label={t(closed ? 'permissions.expand' : 'permissions.collapse')}
                  >
                    {closed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </ActionIcon>
                  <UnstyledButton
                    onClick={() => openGroup(g.name)}
                    style={{ minWidth: 0 }}
                    data-testid="perm-group-open"
                  >
                    <Text size="sm" fw={600}>
                      {g.name}{' '}
                      <Text span size="sm" c="dimmed">
                        {rows.length}
                      </Text>
                    </Text>
                    {g.description && (
                      <Text size="xs" c="dimmed">
                        {g.description}
                      </Text>
                    )}
                  </UnstyledButton>
                  <Box style={{ flex: 1 }} />
                  <Box data-testid="perm-group-tools" pr={ROW_PAD}>
                    <ToolPills
                      pills={groupPills(commands.filter((r) => r.group === g.name))}
                      size={18}
                      onToggle={(tool) => toggleGroup(g, tool)}
                      busy={busy.of(`group:${g.name}`)}
                    />
                  </Box>
                </Group>
                {!closed && <ListCard>{byDecision(rows).map(ruleRow)}</ListCard>}
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
        opened={!!current}
        onClose={() => setSelected(null)}
        title={current ? commandText(current) : ''}
        meta={<MetaItem icon={<FileText size={14} />}>{data.file}</MetaItem>}
        onDelete={() => setConfirmDelete(true)}
        deleteTestId="perm-delete"
      >
        {current && (
          <Stack gap="lg">
            <ToolPills
              pills={pillsOf(current)}
              size={20}
              onToggle={(tool) => toggleRule(current, tool)}
              busy={busy.of(ruleKey(current))}
            />
            <RuleForm
              key={selected}
              initial={current}
              taken={commands.filter((r) => r !== current)}
              groups={groups}
              onSubmit={async (rule) => {
                const ok = await save(
                  { groups, commands: commands.map((r) => (r === current ? rule : r)) },
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

      <DetailSheet
        opened={groupSel === NEW}
        onClose={() => setGroupSel(null)}
        title={t('permissions.new')}
      >
        {groupSel === NEW && (
          <GroupForm
            members={[]}
            taken={commands}
            takenNames={groups.map((g) => g.name)}
            onSubmit={async (group, rules) => {
              const ok = await save(
                {
                  groups: group ? [...groups, group] : groups,
                  commands: [...commands, ...rules]
                },
                t('permissions.created')
              )
              if (ok) setGroupSel(null)
            }}
            onCancel={() => setGroupSel(null)}
            submitLabel={t('common.create')}
            submitTestId="perm-create"
          />
        )}
      </DetailSheet>

      <DetailSheet
        opened={!!currentGroup}
        onClose={() => setGroupSel(null)}
        title={currentGroup?.name ?? ''}
        meta={<MetaItem icon={<FileText size={14} />}>{data.file}</MetaItem>}
        onDelete={() => setConfirmGroupDelete(true)}
        deleteTestId="perm-group-delete"
      >
        {currentGroup && (
          <GroupForm
            key={groupSel}
            initial={currentGroup}
            members={commands.filter((r) => r.group === currentGroup.name)}
            taken={commands.filter((r) => r.group !== currentGroup.name)}
            takenNames={groups.filter((g) => g !== currentGroup).map((g) => g.name)}
            onSubmit={async (group, rules) => {
              if (!group) return
              const ok = await save(
                {
                  groups: groups.map((g) => (g === currentGroup ? group : g)),
                  commands: [...commands.filter((r) => r.group !== currentGroup.name), ...rules]
                },
                t('permissions.groupSaved')
              )
              if (ok) setGroupSel(group.name)
            }}
            submitLabel={t('common.save')}
            submitTestId="perm-group-save"
          />
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
      <ConfirmModal
        opened={confirmGroupDelete}
        onClose={() => setConfirmGroupDelete(false)}
        onConfirm={removeGroup}
        danger
        title={t('permissions.groupDeleteTitle')}
        confirmLabel={t('common.delete')}
        message={t('permissions.groupDeleteBody', {
          name: currentGroup?.name ?? '',
          count: currentGroup ? commands.filter((r) => r.group === currentGroup.name).length : 0
        })}
      />
    </Stack>
  )
}

function DecisionPicker({
  value,
  onChange,
  testId
}: {
  value: PermissionDecision
  onChange: (d: PermissionDecision) => void
  testId: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4}>
      <SegmentedControl
        value={value}
        onChange={(v) => onChange(v as PermissionDecision)}
        data={ORDER.map((d) => ({ value: d, label: t(`permissions.decision.${d}`) }))}
        data-testid={testId}
      />
      <Text size="xs" c="dimmed">
        {t(`permissions.decisionHint.${value}`)}
      </Text>
    </Stack>
  )
}

/** Edits one rule: command, decision, exact, group, description */
function RuleForm({
  initial,
  taken,
  groups,
  onSubmit,
  submitLabel,
  submitTestId
}: {
  initial: CommandRule
  /** The other rules (a command may have one rule) */
  taken: CommandRule[]
  groups: RuleGroup[]
  onSubmit: (rule: CommandRule) => Promise<void>
  submitLabel: string
  submitTestId: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState(commandText(initial))
  const [decision, setDecision] = useState<PermissionDecision>(initial.decision)
  const [exact, setExact] = useState(initial.exact)
  const [group, setGroup] = useState<string | null>(initial.group ?? null)
  const [description, setDescription] = useState(initial.description ?? '')
  const [busy, setBusy] = useState(false)
  const argv = parseCommand(text)
  const dup = taken.some(
    (r) => r.exact === exact && JSON.stringify(r.argv) === JSON.stringify(argv)
  )
  const rule: CommandRule = {
    decision,
    argv,
    exact,
    ...(description.trim() ? { description: description.trim() } : {}),
    ...(group ? { group } : {})
  }
  const dirty = JSON.stringify(rule) !== JSON.stringify(initial)
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
        <DecisionPicker value={decision} onChange={setDecision} testId="perm-decision" />
      </Stack>
      <Checkbox
        label={t('permissions.exactLabel')}
        description={t('permissions.exactHint')}
        checked={exact}
        onChange={(e) => setExact(e.currentTarget.checked)}
        data-testid="perm-exact"
      />
      {(groups.length > 0 || group) && (
        <Select
          label={t('permissions.group')}
          placeholder={t('permissions.ungrouped')}
          data={groups.map((g) => g.name)}
          value={group}
          onChange={setGroup}
          clearable
          data-testid="perm-rule-group"
        />
      )}
      <TextInput
        label={t('permissions.description')}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Group justify="flex-end" gap="xs">
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

/**
 * New rules, or a group's rules: group name, description, default decision and the commands, one per line. Each line gets its
 * own decision and exact switch; a line starts with the default, and a line that was already a rule keeps its decision, exact,
 * description and the tools it is off for.
 * New rules may leave the group name empty: they go in no group, and the description goes on each rule
 */
function GroupForm({
  initial,
  members,
  taken,
  takenNames,
  onSubmit,
  onCancel,
  submitLabel,
  submitTestId
}: {
  initial?: RuleGroup
  /** The group's rules as saved */
  members: CommandRule[]
  /** Rules outside the group (a command may have one rule) */
  taken: CommandRule[]
  /** Names of the other groups */
  takenNames: string[]
  /** group is null for new rules with no group name */
  onSubmit: (group: RuleGroup | null, rules: CommandRule[]) => Promise<void>
  onCancel?: () => void
  submitLabel: string
  submitTestId: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [decision, setDecision] = useState<PermissionDecision>(initial?.decision ?? 'deny')
  const [text, setText] = useState(members.map((r) => commandLine(r.argv)).join('\n'))
  // Decisions picked per line (JSON of its words); a saved rule starts with its own
  const [picks, setPicks] = useState<Record<string, PermissionDecision>>(() =>
    Object.fromEntries(members.map((r) => [JSON.stringify(r.argv), r.decision]))
  )
  // "Only this exact command" per line; a saved rule starts with its own
  const [exacts, setExacts] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(members.map((r) => [JSON.stringify(r.argv), r.exact]))
  )
  const [busy, setBusy] = useState(false)

  const trimmed = name.trim()
  const nameTaken = takenNames.includes(trimmed)
  const seen = new Set<string>()
  const lines = text
    .split('\n')
    .map(parseCommand)
    .filter((argv) => argv.length)
    .map((argv) => {
      const key = JSON.stringify(argv)
      const member = members.find((r) => JSON.stringify(r.argv) === key)
      const exact = exacts[key] ?? false
      const dup =
        seen.has(key) || taken.some((r) => r.exact === exact && JSON.stringify(r.argv) === key)
      seen.add(key)
      const own = trimmed ? member?.description : description.trim()
      const rule: CommandRule = {
        decision: picks[key] ?? decision,
        argv,
        exact,
        ...(own ? { description: own } : {}),
        ...(trimmed ? { group: trimmed } : {}),
        ...(member?.off ? { off: member.off } : {})
      }
      return { key, rule, dup }
    })
  const group: RuleGroup | null = trimmed
    ? {
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        decision
      }
    : null
  const rules = lines.map((l) => l.rule)
  const dirty = !initial || JSON.stringify([group, rules]) !== JSON.stringify([initial, members])
  // A group keeps its name; new rules may have none
  const valid =
    (!!trimmed || !initial) && !nameTaken && lines.length > 0 && !lines.some((l) => l.dup)
  const submit = async (): Promise<void> => {
    setBusy(true)
    await onSubmit(group, rules)
    setBusy(false)
  }
  return (
    <Stack gap="md" maw={560}>
      <TextInput
        label={t('permissions.groupName')}
        description={initial ? undefined : t('permissions.groupNameHint')}
        placeholder={t('permissions.groupNamePlaceholder')}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        error={nameTaken ? t('permissions.groupNameTaken') : undefined}
        data-testid="perm-group-name"
      />
      <TextInput
        label={t('permissions.description')}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        data-testid="perm-group-description"
      />
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          {t('permissions.groupDecision')}
        </Text>
        <DecisionPicker value={decision} onChange={setDecision} testId="perm-group-decision" />
      </Stack>
      <Textarea
        label={t('permissions.groupCommands')}
        description={t('permissions.groupCommandsHint')}
        placeholder={'git push --force\ngit reset --hard'}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        autosize
        minRows={3}
        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
        data-testid="perm-group-commands"
      />
      {lines.length > 0 && (
        <Stack gap={6} data-testid="perm-group-lines">
          {lines.map(({ key, rule, dup }, i) => (
            <Group key={`${i}:${key}`} gap="xs" wrap="nowrap" data-testid="perm-line">
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Code>{commandLine(rule.argv)}</Code>
                {dup && (
                  <Text size="xs" c="red" data-testid="perm-line-duplicate">
                    {t('permissions.duplicate')}
                  </Text>
                )}
              </Box>
              <Tooltip label={t('permissions.exactLabel')} withArrow openDelay={300}>
                <Checkbox
                  size="xs"
                  label={t('permissions.exact')}
                  checked={rule.exact}
                  onChange={(e) => {
                    const on = e.currentTarget.checked
                    setExacts((x) => ({ ...x, [key]: on }))
                  }}
                  data-testid="perm-line-exact"
                />
              </Tooltip>
              <SegmentedControl
                size="xs"
                value={rule.decision}
                onChange={(v) => setPicks((p) => ({ ...p, [key]: v as PermissionDecision }))}
                data={ORDER.map((d) => ({ value: d, label: t(`permissions.decision.${d}`) }))}
              />
            </Group>
          ))}
        </Stack>
      )}
      <Group justify="flex-end" gap="xs">
        {onCancel && (
          <Button size="xs" variant="default" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
        <Button
          size="xs"
          loading={busy}
          disabled={!valid || !dirty}
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
