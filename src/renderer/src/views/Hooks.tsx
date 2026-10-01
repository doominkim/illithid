import { useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Tabs,
  Text,
  Textarea,
  TextInput
} from '@mantine/core'
import { ArrowLeft, Download, FolderOpen, Layers, Plus, RefreshCw, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  actionMatcher,
  ENV_NAME_RE,
  HOOK_ACTION_INFO,
  HOOK_ACTIONS,
  hookSupport,
  NOTIFY_CHANNELS,
  NOTIFY_URL_ENV,
  PROTECT_PATTERN_RE,
  type NotifyChannel,
  type HookAction,
  type HookSupport
} from '../../../engine/hookActions'
import {
  defaultHookEvent,
  HOOK_CATALOG,
  HOOK_TOOLS,
  hookEventInfo,
  hookEventsFor,
  type HookTiming,
  type HookTool
} from '../../../engine/hookEvents'
import type {
  HookDoc,
  HookEditView,
  HookOptionValue,
  HookToolSettings,
  HookTrigger,
  HookView,
  ToolId
} from '../../../shared/api'
import { ConfirmModal } from '../components/ConfirmModal'
import { DetailSheet, MetaItem } from '../components/DetailSheet'
import { EmptyLibrary } from '../components/EmptyState'
import { EmptyState } from '../components/EmptyState'
import { CardGrid, ItemCard } from '../components/ItemCard'
import { ImportModal } from '../components/ImportModal'
import { ErrorAlert, Fields, Loading } from '../components/Layout'
import { Initial, ListCard, ListRow } from '../components/ListRow'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { PageHeader, Toolbar } from '../components/PageHeader'
import { ReloadButton } from '../components/ReloadButton'
import { SearchInput } from '../components/SearchInput'
import { ToolIcon } from '../components/ToolIcon'
import { ToolPills } from '../components/ToolPills'
import { ToolToggleRow } from '../components/ToolToggleRow'
import { ViewToggle } from '../components/ViewToggle'
import { useToolsInUse } from '../lib/config'
import { includesCI } from '../lib/format'
import { runWrite } from '../lib/mutate'
import { useNav, useNavSelect } from '../lib/nav'
import { problemText } from '../lib/problemReason'
import { useReload } from '../lib/reload'
import { useSync } from '../lib/sync'
import { useToggleBusy } from '../lib/toggleBusy'
import {
  grokReadsFromClaude,
  pillFromCellState,
  type PillMap,
  TOOL_NAME,
  TOOLS
} from '../lib/tools'
import { useApi } from '../lib/useApi'
import { LIBRARY_SCRIPT_RE } from '../../../engine/scriptNames'
import { useViewMode } from '../lib/viewMode'

const NEW = '__new__'
/** Actions a new hook can start from (log stays readable for existing hooks but is not offered) */
const NEW_HOOK_ACTIONS = HOOK_ACTIONS.filter((a) => a !== 'log')
const ALL = 'all'
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

type Options = Record<string, HookOptionValue>

const isHookTool = (tool: string): tool is HookTool =>
  (HOOK_TOOLS as readonly string[]).includes(tool)

/** "Reply finished → Notify: All done" */
function useSummary(): (h: {
  name: string
  description: string
  when: HookTiming
  action: HookAction
  options: Options
  body?: string
}) => string {
  const { t } = useTranslation()
  return (h) => {
    const o = h.options
    const firstLine = (h.body ?? '').trim().split('\n')[0]
    const detail: Record<HookAction, string> = {
      notify:
        o.channel && o.channel !== 'mac'
          ? t(`hooks.opt.channels.${String(o.channel)}`)
          : String(o.message || h.description || h.name),
      verify: String(o.command || t('hooks.opt.testCommandAuto')),
      protect: ((o.patterns as string[]) ?? []).join(', '),
      context: firstLine,
      checkpoint: t(`hooks.opt.modes.${String(o.mode || 'snapshot')}`),
      guard: ((o.patterns as string[]) ?? []).join(', '),
      ask: firstLine,
      format: String(o.command),
      log: String(o.path),
      script: String(o.use || '')
    }
    const head = `${t(`hooks.timing.${h.when}`)} → ${t(`hooks.actions.${h.action}.title`)}`
    const d = detail[h.action]
    return d ? `${head}: ${d}` : head
  }
}

function Hooks(): React.JSX.Element {
  const { t } = useTranslation()
  const inUse = useToolsInUse()
  const hookTools = HOOK_TOOLS.filter((tool) => inUse.includes(tool))
  const { request } = useNav()
  const reload = useReload()
  const summary = useSummary()
  const { data, error } = useApi('hooks', () => window.api.hooks())
  const [query, setQuery] = useState('')
  const [toolFilter, setToolFilter] = useState<string>(ALL)
  const [view, setView] = useViewMode('hooks')
  const [selected, setSelected] = useState<string | null>(request.select ?? null)
  const pending = useToggleBusy()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  useNavSelect(setSelected)
  // NEW, or NEW:<action> to open the new hook form on that action (from the scripts menu)
  const isNew = selected === NEW || !!selected?.startsWith(`${NEW}:`)
  const startAction =
    selected?.startsWith(`${NEW}:`) &&
    (HOOK_ACTIONS as readonly string[]).includes(selected.slice(NEW.length + 1))
      ? (selected.slice(NEW.length + 1) as HookAction)
      : null

  if (error) return <ErrorAlert message={error} />
  if (!data) return <Loading />

  // A tool runs the hook when it is a hook tool in use that supports the action at that timing
  const runsIn = (h: HookView, tool: ToolId): boolean =>
    isHookTool(tool) && inUse.includes(tool) && !h.unsupported?.[tool]
  const enabled = (name: string, tool: ToolId): boolean => data.toggles[name]?.[tool] !== false
  const reads = data.grokReadsClaude !== false
  const pillsOf = (h: HookView): PillMap =>
    Object.fromEntries(
      TOOLS.map((tool) => {
        if (!runsIn(h, tool)) return [tool, { on: false, na: true }]
        const st = h.tools[tool] ?? 'notApplicable'
        const onFor = (x: ToolId): boolean => runsIn(h, x) && enabled(h.name, x)
        // Off for Grok but on for Claude Code: Grok still runs it from Claude's settings
        if (!enabled(h.name, tool))
          return [
            tool,
            tool === 'grok' && grokReadsFromClaude(inUse, onFor, reads)
              ? {
                  on: false,
                  pending: st === 'needsSync',
                  via: true,
                  hint: t('hooks.grokViaClaude')
                }
              : { on: false, pending: st === 'needsSync' }
          ]
        // On for both: the app writes only Claude's entry, Grok runs that one
        if (tool === 'grok' && reads && inUse.includes('claude') && onFor('claude'))
          return [tool, { on: true, via: true, hint: t('hooks.grokViaClaude') }]
        return [
          tool,
          {
            ...pillFromCellState(st),
            on: true,
            na: false,
            ...(st === 'error' ? { hint: problemText(t, h.reasons?.[tool]) } : {})
          }
        ]
      })
    ) as PillMap

  const toggle = async (h: HookView, tool: ToolId): Promise<void> => {
    await pending.run(h.name, tool, () =>
      runWrite(window.api.toggle('hooks', h.name, tool, !enabled(h.name, tool)), {
        success: t('toggles.saved')
      })
    )
    reload()
  }
  const toggleAll = async (h: HookView, on: boolean): Promise<void> => {
    for (const tool of hookTools)
      if (runsIn(h, tool) && enabled(h.name, tool) !== on)
        await runWrite(window.api.toggle('hooks', h.name, tool, on))
    reload()
  }
  const remove = async (): Promise<void> => {
    if (!current) return
    const r = await runWrite(window.api.hookDelete(current.name), { success: t('hooks.deleted') })
    setConfirmDelete(false)
    if (r) {
      setSelected(null)
      reload()
    }
  }

  const q = query.trim().toLowerCase()
  const list = data.hooks.filter(
    (h) =>
      (toolFilter === ALL || runsIn(h, toolFilter as ToolId)) &&
      (!q ||
        includesCI(h.name, q) ||
        includesCI(h.description, q) ||
        includesCI(t(`hooks.timing.${h.when}`), q) ||
        includesCI(t(`hooks.actions.${h.action}.title`), q))
  )
  const current = data.hooks.find((h) => h.name === selected)
  const tags = (h: HookView): React.ReactNode => (
    <>
      <Badge variant="default" size="xs" fw={500} c="dimmed">
        {t(`hooks.timing.${h.when}`)}
      </Badge>
      <Badge variant="light" size="xs" fw={500}>
        {t(`hooks.actions.${h.action}.title`)}
      </Badge>
    </>
  )
  const cardTools = (h: HookView): ToolId[] => hookTools.filter((tool) => runsIn(h, tool))

  return (
    <Stack gap={0} style={{ flex: 1 }}>
      <PageHeader
        title={t('nav.hooks')}
        count={data.hooks.length}
        actions={
          <>
            <Button
              size="xs"
              leftSection={<Plus size={13} />}
              onClick={() => setSelected(NEW)}
              data-testid="hook-new"
            >
              {t('hooks.new')}
            </Button>
            <Button
              size="xs"
              variant="default"
              leftSection={<Download size={13} />}
              onClick={() => setImportOpen(true)}
              data-testid="hook-import"
            >
              {t('common.import')}
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
          <>
            <SearchInput value={query} onChange={setQuery} placeholder={t('hooks.search')} />
            <Select
              w={170}
              allowDeselect={false}
              value={toolFilter}
              onChange={(v) => setToolFilter(v ?? ALL)}
              aria-label={t('hooks.allTools')}
              data-testid="hook-tool-filter"
              data={[
                { value: ALL, label: t('hooks.allTools') },
                ...hookTools.map((x) => ({ value: x, label: TOOL_NAME[x] }))
              ]}
              leftSection={
                toolFilter === ALL ? (
                  <Layers size={13} />
                ) : (
                  <ToolIcon tool={toolFilter as ToolId} size={13} />
                )
              }
              renderOption={({ option }) => (
                <Group gap={6} wrap="nowrap">
                  {option.value === ALL ? (
                    <Layers size={13} />
                  ) : (
                    <ToolIcon tool={option.value as ToolId} size={13} />
                  )}
                  <span>{option.label}</span>
                </Group>
              )}
            />
          </>
        }
        right={<ViewToggle value={view} onChange={setView} />}
      />
      {data.hooks.length === 0 ? (
        <EmptyLibrary onImport={() => setImportOpen(true)} />
      ) : list.length === 0 ? (
        <EmptyState title={t('common.noResults')} />
      ) : view === 'grid' ? (
        <CardGrid>
          {list.map((h) => (
            <ItemCard
              key={h.name}
              name={h.name}
              badges={tags(h)}
              description={h.description || summary(h)}
              switchChecked={
                cardTools(h).length > 0 && cardTools(h).every((x) => enabled(h.name, x))
              }
              switchIndeterminate={cardTools(h).some((x) => enabled(h.name, x))}
              onSwitch={(v) => void toggleAll(h, v)}
              footerRight={
                <ToolPills
                  pills={pillsOf(h)}
                  size={18}
                  onToggle={(tool) => void toggle(h, tool)}
                  busy={pending.of(h.name)}
                />
              }
              selected={h.name === selected}
              onClick={() => setSelected(h.name)}
            />
          ))}
        </CardGrid>
      ) : (
        <ListCard>
          {list.map((h) => (
            <ListRow
              key={h.name}
              avatar={<Initial text={h.name} />}
              title={h.name}
              tags={tags(h)}
              subtitle={h.description || summary(h)}
              right={
                <ToolPills
                  pills={pillsOf(h)}
                  size={18}
                  onToggle={(tool) => void toggle(h, tool)}
                  busy={pending.of(h.name)}
                />
              }
              active={h.name === selected}
              onClick={() => setSelected(h.name)}
            />
          ))}
        </ListCard>
      )}

      <ImportModal
        opened={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={reload}
        kind="hook"
      />
      <DetailSheet opened={isNew} onClose={() => setSelected(null)} title={t('hooks.new')}>
        {isNew && (
          <NewHookForm
            key={selected}
            initialAction={startAction}
            tools={hookTools}
            taken={data.hooks.map((h) => h.name)}
            onCreated={(name) => {
              reload()
              setSelected(name)
            }}
            onCancel={() => setSelected(null)}
          />
        )}
      </DetailSheet>

      <DetailSheet
        opened={!!current}
        onClose={() => setSelected(null)}
        title={current?.name ?? ''}
        description={current?.description || undefined}
        tags={current && tags(current)}
        meta={
          current &&
          data.dir && (
            <MetaItem icon={<FolderOpen size={14} />}>{`${data.dir}/${current.name}/`}</MetaItem>
          )
        }
        copyPath={current && data.dir ? `${data.dir}/${current.name}` : undefined}
        onDelete={() => setConfirmDelete(true)}
        deleteTestId="hook-delete"
      >
        {current && (
          <HookDetail
            key={current.name}
            hook={current}
            tools={hookTools}
            pills={pillsOf(current)}
            onToggle={(tool) => void toggle(current, tool)}
            busy={pending.of(current.name)}
            onChanged={reload}
          />
        )}
      </DetailSheet>

      <ConfirmModal
        opened={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        danger
        title={t('hooks.deleteTitle')}
        confirmLabel={t('common.delete')}
        message={t('hooks.deleteBody', { name: current?.name ?? '' })}
      />
    </Stack>
  )
}

/** Section label used in detail sheets (same style as "Enabled in") */
function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Text size="sm" fw={600} c="dimmed">
      {children}
    </Text>
  )
}

/** Why each hook tool in use can't run the action at the timing (nothing for the ones that can) */
function Unsupported({
  action,
  when,
  tools,
  testPrefix
}: {
  action: HookAction
  when: HookTiming
  tools: HookTool[]
  testPrefix: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  // One line per reason: "Codex, Gemini CLI: no judgment hooks"
  const byReason = new Map<HookSupport, HookTool[]>()
  for (const tool of tools) {
    const why = hookSupport(action, when, tool)
    if (why !== 'ok') byReason.set(why, [...(byReason.get(why) ?? []), tool])
  }
  if (!byReason.size) return null
  return (
    <Stack gap={4}>
      {[...byReason].map(([why, list]) => (
        <Group key={why} gap={6} wrap="nowrap" data-testid={`${testPrefix}-${why}`}>
          {list.map((tool) => (
            <ToolIcon key={tool} tool={tool} size={14} />
          ))}
          <Text size="xs" c="dimmed">
            {t(`hooks.unsupported.${why}`, {
              tool: list.map((tool) => TOOL_NAME[tool]).join(', ')
            })}
          </Text>
        </Group>
      ))}
    </Stack>
  )
}

/** The action's options (notify texts, guard patterns, format command, log path) */
function OptionFields({
  action,
  when,
  value,
  onChange,
  placeholderMessage
}: {
  action: HookAction
  when: HookTiming
  value: Options
  onChange: (next: Options) => void
  placeholderMessage?: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const set = (k: string, v: HookOptionValue): void => onChange({ ...value, [k]: v })
  const mono = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } }
  const lines = (k: string, label: string, hint: string, testId: string): React.JSX.Element => (
    <Textarea
      label={label}
      description={hint}
      value={((value[k] as string[]) ?? []).join('\n')}
      onChange={(e) =>
        set(
          k,
          e.currentTarget.value.split('\n').filter((x, i, all) => x.trim() || i === all.length - 1)
        )
      }
      autosize
      minRows={3}
      styles={mono}
      data-testid={testId}
    />
  )
  switch (action) {
    case 'notify': {
      const channel = String(value.channel || 'mac') as NotifyChannel
      return (
        <Stack gap="sm">
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              {t('hooks.opt.channel')}
            </Text>
            <SegmentedControl
              value={channel}
              onChange={(v) => set('channel', v)}
              data={NOTIFY_CHANNELS.map((c) => ({ value: c, label: t(`hooks.opt.channels.${c}`) }))}
              data-testid="hook-option-channel"
            />
          </Stack>
          {channel !== 'mac' && (
            <TextInput
              label={t('hooks.opt.urlEnv')}
              description={t(`hooks.opt.urlEnvHint.${channel}`)}
              placeholder={NOTIFY_URL_ENV[channel]}
              value={String(value.urlEnv ?? '')}
              onChange={(e) => set('urlEnv', e.currentTarget.value.trim())}
              error={
                value.urlEnv && !ENV_NAME_RE.test(String(value.urlEnv))
                  ? t('hooks.opt.urlEnvInvalid')
                  : undefined
              }
              styles={mono}
              data-testid="hook-option-urlenv"
            />
          )}
          <TextInput
            label={t('hooks.opt.title')}
            value={String(value.title ?? '')}
            onChange={(e) => set('title', e.currentTarget.value)}
            data-testid="hook-option-title"
          />
          <TextInput
            label={t('hooks.opt.message')}
            value={String(value.message ?? '')}
            placeholder={
              when === 'notification' ? t('hooks.opt.messageFromTool') : placeholderMessage
            }
            onChange={(e) => set('message', e.currentTarget.value)}
            data-testid="hook-option-message"
          />
          <Checkbox
            label={t('hooks.opt.project')}
            checked={value.project !== false}
            onChange={(e) => set('project', e.currentTarget.checked)}
            data-testid="hook-option-project"
          />
          {channel === 'mac' && (
            <Checkbox
              label={t('hooks.opt.sound')}
              checked={value.sound === true}
              onChange={(e) => set('sound', e.currentTarget.checked)}
              data-testid="hook-option-sound"
            />
          )}
        </Stack>
      )
    }
    case 'verify':
      return (
        <TextInput
          label={t('hooks.opt.testCommand')}
          description={t('hooks.opt.testCommandHint')}
          placeholder={t('hooks.opt.testCommandAuto')}
          value={String(value.command ?? '')}
          onChange={(e) => set('command', e.currentTarget.value)}
          styles={mono}
          data-testid="hook-option-command"
        />
      )
    case 'protect':
      return lines(
        'patterns',
        t('hooks.opt.protectPatterns'),
        t('hooks.opt.protectPatternsHint'),
        'hook-option-patterns'
      )
    case 'checkpoint':
      return (
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            {t('hooks.opt.mode')}
          </Text>
          <SegmentedControl
            value={String(value.mode || 'snapshot')}
            onChange={(v) => set('mode', v)}
            data={['snapshot', 'commit'].map((m) => ({
              value: m,
              label: t(`hooks.opt.modes.${m}`)
            }))}
            data-testid="hook-option-mode"
          />
          <Text size="xs" c="dimmed">
            {t(`hooks.opt.modeHint.${String(value.mode || 'snapshot')}`)}
          </Text>
        </Stack>
      )
    case 'context':
      return (
        <Checkbox
          label={t('hooks.opt.git')}
          checked={value.git !== false}
          onChange={(e) => set('git', e.currentTarget.checked)}
          data-testid="hook-option-git"
        />
      )
    case 'guard':
      return lines(
        'patterns',
        t('hooks.opt.patterns'),
        t('hooks.opt.patternsHint'),
        'hook-option-patterns'
      )
    case 'format':
      return (
        <TextInput
          label={t('hooks.opt.command')}
          description={
            when === 'stop' ? t('hooks.opt.commandHintStop') : t('hooks.opt.commandHint')
          }
          value={String(value.command ?? '')}
          onChange={(e) => set('command', e.currentTarget.value)}
          styles={mono}
          data-testid="hook-option-command"
        />
      )
    case 'log':
      return (
        <TextInput
          label={t('hooks.opt.path')}
          value={String(value.path ?? '')}
          onChange={(e) => set('path', e.currentTarget.value)}
          styles={mono}
          data-testid="hook-option-path"
        />
      )
    default:
      return null
  }
}

/** Guard patterns without blank lines; null when an option is left empty that must not be */
function cleanOptions(action: HookAction, o: Options): Options | null {
  if (action === 'guard' || action === 'protect') {
    const patterns = ((o.patterns as string[]) ?? []).map((x) => x.trim()).filter(Boolean)
    if (action === 'protect' && !patterns.every((p) => PROTECT_PATTERN_RE.test(p))) return null
    return patterns.length ? { ...o, patterns } : null
  }
  if (action === 'notify' && o.urlEnv && !ENV_NAME_RE.test(String(o.urlEnv))) return null
  if (action === 'format' && !String(o.command ?? '').trim()) return null
  if (action === 'log' && !String(o.path ?? '').trim()) return null
  return o
}

function ContextNoteField({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Textarea
      label={t('hooks.contextNote')}
      description={t('hooks.contextNoteHint')}
      placeholder={t('hooks.contextNoteExample')}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      autosize
      minRows={3}
      maxRows={14}
      data-testid="hook-context-note"
    />
  )
}

function InstructionField({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Textarea
      label={t('hooks.instruction')}
      description={t('hooks.instructionHint')}
      placeholder={t('hooks.instructionExample')}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      autosize
      minRows={4}
      maxRows={14}
      data-testid="hook-instruction"
    />
  )
}

function HookDetail({
  hook,
  tools,
  pills,
  onToggle,
  busy,
  onChanged
}: {
  hook: HookView
  tools: HookTool[]
  pills: PillMap
  onToggle: (tool: ToolId) => void
  busy: readonly ToolId[]
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const summary = useSummary()
  const { openPreview } = useSync()
  const [edit, setEdit] = useState<HookEditView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<string | null>('preview')
  // Reload HOOK.md and scripts whenever the list changes (after a save, toggle or sync)
  useEffect(() => {
    let alive = true
    window.api.hookRead(hook.name).then((r) => {
      if (!alive) return
      if (r.ok) setEdit(r.value)
      else setErr(r.message)
    })
    return () => {
      alive = false
    }
  }, [hook])

  if (err) return <ErrorAlert message={err} />
  if (!edit) return <Loading />
  const doc = edit.doc

  const saveDoc = async (next: HookDoc): Promise<boolean> => {
    const r = await runWrite(window.api.hookSave(hook.name, next), { success: t('hooks.saved') })
    if (r) onChanged()
    return r !== null
  }
  const keepCopy = async (tool: HookTool, file: string): Promise<void> => {
    const r = await runWrite(window.api.hookKeepCopy(hook.name, tool, file), {
      success: t('hooks.kept', { tool: TOOL_NAME[tool] })
    })
    if (r) onChanged()
  }
  const edited = (Object.entries(hook.edited ?? {}) as [ToolId, string][]).filter(([tool]) =>
    isHookTool(tool)
  ) as [HookTool, string][]
  const runTools = tools.filter((tool) => edit.runs[tool])
  const waiting = runTools.some((tool) => hook.tools[tool] === 'needsSync')

  return (
    <Stack gap="lg">
      <Text size="md" data-testid="hook-summary">
        {summary({ ...hook, body: doc.body })}
      </Text>
      {edited.map(([tool, file]) => (
        <Alert
          key={tool}
          color="yellow"
          variant="light"
          title={t('hooks.edited', { tool: TOOL_NAME[tool] })}
          data-testid={`hook-edited-${tool}`}
        >
          <Group justify="space-between" wrap="nowrap" gap="md">
            <Text size="sm">{t('hooks.editedHint')}</Text>
            <Button
              size="xs"
              variant="default"
              onClick={() => void keepCopy(tool, file)}
              data-testid={`hook-keep-${tool}`}
            >
              {t('preview.keepEdited')}
            </Button>
          </Group>
        </Alert>
      ))}
      <Stack gap={8}>
        <ToolToggleRow
          pills={pills}
          tools={runTools}
          onToggle={onToggle}
          busy={busy}
          testId="hook-detail-tools"
        />
        {waiting && (
          <Group>
            <Button
              size="compact-xs"
              variant="default"
              leftSection={<RefreshCw size={12} />}
              onClick={() => openPreview()}
              data-testid="hook-sync"
            >
              {t('hooks.syncNow')}
            </Button>
          </Group>
        )}
        <Unsupported
          action={doc.action}
          when={doc.when}
          tools={tools}
          testPrefix="hook-unsupported"
        />
        {hook.tools.codex !== undefined && edit.runs.codex && (
          <Text size="xs" c="dimmed" data-testid="hook-codex-trust">
            {t('hooks.codexTrust')}
          </Text>
        )}
      </Stack>

      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="preview" data-testid="hook-tab-preview">
            {t('hooks.tabOverview')}
          </Tabs.Tab>
          <Tabs.Tab value="edit" data-testid="hook-tab-edit">
            {t('detail.edit')}
          </Tabs.Tab>
          <Tabs.Tab value="advanced" data-testid="hook-tab-advanced">
            {t('hooks.tabAdvanced')}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="preview">
          <HookOverview edit={edit} />
        </Tabs.Panel>
        <Tabs.Panel value="edit">
          <HookEditForm
            key={JSON.stringify(edit.doc)}
            name={hook.name}
            edit={edit}
            onSave={saveDoc}
            onChanged={onChanged}
          />
        </Tabs.Panel>
        <Tabs.Panel value="advanced">
          <HookAdvanced
            name={hook.name}
            edit={edit}
            tools={runTools}
            onSave={saveDoc}
            onChanged={onChanged}
          />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  )
}

function HookOverview({ edit }: { edit: HookEditView }): React.JSX.Element {
  const { t } = useTranslation()
  const doc = edit.doc
  const o = doc.options
  const yesNo = (v: boolean): string => (v ? t('detail.on') : t('detail.off'))
  const rows: [string, React.ReactNode][] = [
    [t('hooks.timingLabel'), t(`hooks.timing.${doc.when}`)],
    [t('hooks.actionLabel'), t(`hooks.actions.${doc.action}.title`)]
  ]
  if (doc.action === 'notify')
    rows.push(
      [t('hooks.opt.title'), String(o.title)],
      [t('hooks.opt.message'), String(o.message || doc.description || edit.name)],
      [t('hooks.opt.sound'), yesNo(o.sound === true)]
    )
  if (doc.action === 'notify' && o.channel !== 'mac')
    rows.push([
      t('hooks.opt.channel'),
      `${t(`hooks.opt.channels.${String(o.channel)}`)} · $${String(o.urlEnv || NOTIFY_URL_ENV[o.channel as 'ntfy' | 'slack'])}`
    ])
  if (doc.action === 'verify')
    rows.push([
      t('hooks.opt.testCommand'),
      o.command ? <Code key="v">{String(o.command)}</Code> : t('hooks.opt.testCommandAuto')
    ])
  if (doc.action === 'context') rows.push([t('hooks.opt.git'), yesNo(o.git !== false)])
  if (doc.action === 'checkpoint')
    rows.push([t('hooks.opt.mode'), t(`hooks.opt.modes.${String(o.mode || 'snapshot')}`)])
  if (doc.action === 'guard' || doc.action === 'protect')
    rows.push([
      doc.action === 'protect' ? t('hooks.opt.protectPatterns') : t('hooks.opt.patterns'),
      <Group key="p" gap={4}>
        {(o.patterns as string[]).map((p) => (
          <Code key={p}>{p}</Code>
        ))}
      </Group>
    ])
  if (doc.action === 'format')
    rows.push([t('hooks.opt.command'), <Code key="c">{String(o.command)}</Code>])
  if (doc.action === 'log') rows.push([t('hooks.opt.path'), <Code key="l">{String(o.path)}</Code>])
  if (doc.action === 'script')
    rows.push([
      t('hooks.scripts'),
      o.use ? `${t('hooks.libScript')}: ${String(o.use)}` : Object.keys(edit.scripts).join(', ')
    ])
  return (
    <Stack gap="md">
      <Box className="ac-card" p="md">
        <Fields rows={rows} />
      </Box>
      {doc.body.trim() && (
        <Stack gap={6}>
          <SectionLabel>
            {doc.action === 'ask'
              ? t('hooks.instruction')
              : doc.action === 'context'
                ? t('hooks.contextNote')
                : t('hooks.notes')}
          </SectionLabel>
          <Box className="ac-card" p="md">
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {doc.body.trim()}
            </Text>
          </Box>
        </Stack>
      )}
    </Stack>
  )
}

function HookEditForm({
  name,
  edit,
  onSave,
  onChanged
}: {
  name: string
  edit: HookEditView
  onSave: (doc: HookDoc) => Promise<boolean>
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const doc = edit.doc
  const [description, setDescription] = useState(doc.description)
  const [when, setWhen] = useState<HookTiming>(doc.when)
  const [options, setOptions] = useState<Options>(doc.options)
  const [body, setBody] = useState(doc.body)
  const [saving, setSaving] = useState(false)
  const clean = cleanOptions(doc.action, options)
  const dirty =
    description !== doc.description ||
    when !== doc.when ||
    body !== doc.body ||
    JSON.stringify(options) !== JSON.stringify(doc.options)
  const valid = !!clean && (doc.action !== 'ask' || !!body.trim())
  const save = async (): Promise<void> => {
    if (!clean) return
    setSaving(true)
    await onSave({ ...doc, description: description.trim(), when, options: clean, body })
    setSaving(false)
  }
  const revert = (): void => {
    setDescription(doc.description)
    setWhen(doc.when)
    setOptions(doc.options)
    setBody(doc.body)
  }
  const timings = HOOK_ACTION_INFO[doc.action].timings
  return (
    <Stack gap="lg">
      <Box className="ac-card" p="md">
        <Stack gap="sm">
          <TextInput
            label={t('hooks.description')}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            data-testid="hook-description"
          />
          <Select
            label={t('hooks.timingLabel')}
            data={timings.map((x) => ({ value: x, label: t(`hooks.timing.${x}`) }))}
            value={when}
            onChange={(v) => v && setWhen(v as HookTiming)}
            allowDeselect={false}
            disabled={timings.length < 2}
            description={t(`hooks.timingHint.${when}`)}
            data-testid="hook-when"
          />
          <OptionFields
            action={doc.action}
            when={when}
            value={options}
            onChange={setOptions}
            placeholderMessage={description || name}
          />
          {doc.action === 'ask' ? (
            <InstructionField value={body} onChange={setBody} />
          ) : doc.action === 'context' ? (
            <ContextNoteField value={body} onChange={setBody} />
          ) : (
            <Textarea
              label={t('hooks.notes')}
              value={body}
              onChange={(e) => setBody(e.currentTarget.value)}
              autosize
              minRows={2}
              maxRows={10}
            />
          )}
          <Group justify="flex-end" gap="xs">
            <Button
              size="xs"
              variant="default"
              leftSection={<Undo2 size={12} />}
              disabled={!dirty}
              onClick={revert}
            >
              {t('editor.revert')}
            </Button>
            <Button
              size="xs"
              disabled={!dirty || !valid}
              loading={saving}
              onClick={() => void save()}
              data-testid="hook-save"
            >
              {t('common.save')}
            </Button>
          </Group>
        </Stack>
      </Box>
      {doc.action === 'script' && (
        <ScriptEditors name={name} edit={edit} onSave={onSave} onChanged={onChanged} />
      )}
    </Stack>
  )
}

/** Script action: run.sh and the tool-only scripts */
function ScriptEditors({
  name,
  edit,
  onSave,
  onChanged
}: {
  name: string
  edit: HookEditView
  onSave: (doc: HookDoc) => Promise<boolean>
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { navigate } = useNav()
  const doc = edit.doc
  const use = typeof doc.options.use === 'string' ? doc.options.use : ''
  const libScripts = useApi('scripts', () => window.api.scripts()).data?.scripts ?? []
  const [tab, setTab] = useState<string | null>(null)
  const files: { value: string; file: string; label: string; tool?: HookTool }[] = [
    {
      value: 'shared',
      file: use ? `${use}.sh` : 'run.sh',
      label: use ? t('hooks.libScript') : t('hooks.shared')
    },
    ...HOOK_TOOLS.filter((tool) => doc.toolScripts?.[tool]).map((tool) => ({
      value: `own:${tool}`,
      file: doc.toolScripts![tool]!,
      label: t('hooks.own', { tool: TOOL_NAME[tool] }),
      tool
    }))
  ]
  const active = files.some((x) => x.value === tab) ? tab! : 'shared'
  const save = async (file: string, text: string): Promise<boolean> => {
    const r = await runWrite(window.api.hookScriptSave(name, file, text), {
      success: t('hooks.scriptSaved')
    })
    if (r) onChanged()
    return r !== null
  }
  const dropOwn = async (tool: HookTool): Promise<void> => {
    const r = await runWrite(window.api.hookToolScriptDrop(name, tool), {
      success: t('hooks.ownDropped', { tool: TOOL_NAME[tool] })
    })
    if (r) {
      setTab('shared')
      onChanged()
    }
  }
  return (
    <Stack gap={8}>
      <SectionLabel>{t('hooks.scripts')}</SectionLabel>
      <Text size="xs" c="dimmed">
        {t('hooks.argHint')}
      </Text>
      <Select
        aria-label={t('hooks.useLabel')}
        data={[
          { value: '', label: t('hooks.useOwn') },
          ...libScripts.map((x) => ({ value: x.name, label: x.name }))
        ]}
        value={use}
        onChange={(v) => void onSave({ ...doc, options: { ...doc.options, use: v ?? '' } })}
        allowDeselect={false}
        maw={360}
        data-testid="hook-script-use"
      />
      <Tabs value={active} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          {files.map((x) => (
            <Tabs.Tab key={x.value} value={x.value} data-testid={`hook-script-tab-${x.value}`}>
              <Group gap={6} wrap="nowrap">
                <span>{x.label}</span>
                <Text span size="xs" c="dimmed" ff="monospace">
                  {x.file}
                </Text>
              </Group>
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {files.map((x) => (
          <Tabs.Panel key={x.value} value={x.value} pt="md">
            <Stack gap="sm">
              {x.tool && (
                <Group justify="flex-end">
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    leftSection={<Undo2 size={12} />}
                    onClick={() => void dropOwn(x.tool!)}
                    data-testid={`hook-script-drop-${x.tool}`}
                  >
                    {t('hooks.dropOwn')}
                  </Button>
                </Group>
              )}
              {x.value === 'shared' && use ? (
                <Stack gap="xs" data-testid="hook-lib-script">
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="xs" c="dimmed">
                      {t('hooks.libScriptHint')}
                    </Text>
                    <Button
                      size="compact-xs"
                      variant="default"
                      onClick={() => navigate('scripts', { select: use })}
                      data-testid="hook-open-script"
                    >
                      {t('hooks.openScript')}
                    </Button>
                  </Group>
                  <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    {edit.scripts['run.sh'] ?? ''}
                  </Code>
                </Stack>
              ) : (
                <MarkdownEditor
                  value={edit.scripts[x.file] ?? ''}
                  minRows={12}
                  onSave={(text) => save(x.file, text)}
                />
              )}
            </Stack>
          </Tabs.Panel>
        ))}
      </Tabs>
    </Stack>
  )
}

/** Per tool: event, matcher and timeout, and what the tool runs (generated script or Claude Code prompt) */
function HookAdvanced({
  name,
  edit,
  tools,
  onSave,
  onChanged
}: {
  name: string
  edit: HookEditView
  tools: HookTool[]
  onSave: (doc: HookDoc) => Promise<boolean>
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const doc = edit.doc
  const [open, setOpen] = useState<HookTool | null>(null)
  const [shown, setShown] = useState<HookTool | null>(null)
  const [converting, setConverting] = useState<HookTool | null>(null)
  const setSettings = async (tool: HookTool, s: HookToolSettings): Promise<void> => {
    const all = { ...doc.tools }
    if (Object.keys(s).length) all[tool] = s
    else delete all[tool]
    const next: HookDoc = { ...doc, tools: all }
    if (!Object.keys(all).length) delete next.tools
    if (await onSave(next)) setOpen(null)
  }
  const setOwn = async (tool: HookTool, own: boolean): Promise<void> => {
    const r = own
      ? await runWrite(window.api.hookToolScriptCreate(name, tool), {
          success: t('hooks.ownCreated', { tool: TOOL_NAME[tool] })
        })
      : await runWrite(window.api.hookToolScriptDrop(name, tool), {
          success: t('hooks.ownDropped', { tool: TOOL_NAME[tool] })
        })
    if (r) onChanged()
  }
  const [convertTo, setConvertTo] = useState<'own' | 'library'>('own')
  const [scriptName, setScriptName] = useState(name)
  const libraryNameOk = LIBRARY_SCRIPT_RE.test(scriptName)
  const convert = async (): Promise<void> => {
    if (!converting || (convertTo === 'library' && !libraryNameOk)) return
    const r = await runWrite(
      window.api.hookConvert(name, converting, convertTo === 'library' ? scriptName : undefined),
      { success: t('hooks.converted') }
    )
    setConverting(null)
    if (r) onChanged()
  }
  const builtIn = doc.action !== 'ask' && doc.action !== 'script'

  return (
    <Stack gap={8}>
      <Text size="xs" c="dimmed">
        {t('hooks.triggersHint')}
      </Text>
      {tools.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('hooks.noTools')}
        </Text>
      ) : (
        <Box data-testid="hook-triggers">
          <ListCard>
            {tools.map((tool) => {
              const run = edit.runs[tool]!
              const trigger = run.trigger
              const own = doc.toolScripts?.[tool]
              return (
                <Box key={tool}>
                  <ListRow
                    avatar={<ToolIcon tool={tool} size={20} />}
                    title={TOOL_NAME[tool]}
                    tags={
                      <>
                        <Badge variant="default" size="xs" fw={500} ff="monospace">
                          {trigger.event}
                        </Badge>
                        {trigger.matcher && (
                          <Badge variant="default" size="xs" fw={500} ff="monospace" c="dimmed">
                            {trigger.matcher}
                          </Badge>
                        )}
                        {trigger.timeout !== undefined && (
                          <Badge variant="default" size="xs" fw={500} c="dimmed">
                            {`${trigger.timeout}s`}
                          </Badge>
                        )}
                      </>
                    }
                    subtitle={run.prompt !== undefined ? t('hooks.promptHook') : run.file}
                    right={
                      <Group gap={4} wrap="nowrap">
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="gray"
                          onClick={(e) => {
                            e.stopPropagation()
                            setShown(shown === tool ? null : tool)
                          }}
                          data-testid={`hook-script-show-${tool}`}
                        >
                          {shown === tool ? t('hooks.hide') : t('hooks.show')}
                        </Button>
                        <Button
                          size="compact-xs"
                          variant="default"
                          onClick={(e) => {
                            e.stopPropagation()
                            setOpen(open === tool ? null : tool)
                          }}
                          data-testid={`hook-trigger-edit-${tool}`}
                        >
                          {t('hooks.edit')}
                        </Button>
                      </Group>
                    }
                  />
                  {open === tool && (
                    <TriggerForm
                      tool={tool}
                      doc={doc}
                      trigger={trigger}
                      own={doc.action === 'script' ? !!own : undefined}
                      onSave={(s) => setSettings(tool, s)}
                      onOwn={(v) => setOwn(tool, v)}
                      onCancel={() => setOpen(null)}
                    />
                  )}
                  {shown === tool && (
                    <Box
                      px="md"
                      py="sm"
                      style={{ borderBottom: '1px solid var(--ac-border-subtle)' }}
                      data-testid={`hook-script-${tool}`}
                    >
                      <Stack gap={6}>
                        <Text size="xs" c="dimmed">
                          {run.prompt !== undefined
                            ? t('hooks.promptGenerated')
                            : builtIn
                              ? t('hooks.generated')
                              : run.file}
                        </Text>
                        <Code
                          block
                          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 320 }}
                        >
                          {run.prompt ?? run.content ?? ''}
                        </Code>
                        {builtIn && (
                          <Group justify="flex-end">
                            <Button
                              size="compact-xs"
                              variant="default"
                              onClick={() => setConverting(tool)}
                              data-testid={`hook-convert-${tool}`}
                            >
                              {t('hooks.convert')}
                            </Button>
                          </Group>
                        )}
                      </Stack>
                    </Box>
                  )}
                </Box>
              )
            })}
          </ListCard>
        </Box>
      )}
      <ConfirmModal
        opened={!!converting}
        onClose={() => setConverting(null)}
        onConfirm={convert}
        title={t('hooks.convertTitle')}
        confirmLabel={t('hooks.convert')}
        message={
          <Stack gap="sm">
            <Text size="sm">
              {t('hooks.convertBody', { tool: converting ? TOOL_NAME[converting] : '' })}
            </Text>
            <SegmentedControl
              value={convertTo}
              onChange={(v) => setConvertTo(v as 'own' | 'library')}
              data={[
                { value: 'own', label: t('hooks.convertOwn') },
                { value: 'library', label: t('hooks.convertLibrary') }
              ]}
              data-testid="hook-convert-to"
            />
            {convertTo === 'library' && (
              <TextInput
                label={t('hooks.scriptName')}
                value={scriptName}
                onChange={(e) => setScriptName(e.currentTarget.value)}
                error={scriptName && !libraryNameOk ? t('mcp.nameInvalid') : undefined}
                data-testid="hook-convert-name"
              />
            )}
          </Stack>
        }
      />
    </Stack>
  )
}

function TriggerForm({
  tool,
  doc,
  trigger,
  own,
  onSave,
  onOwn,
  onCancel
}: {
  tool: HookTool
  doc: HookDoc
  trigger: HookTrigger
  /** Script action only: whether the tool has its own script */
  own?: boolean
  onSave: (s: HookToolSettings) => Promise<void>
  onOwn: (own: boolean) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [event, setEvent] = useState(trigger.event)
  const [matcher, setMatcher] = useState(trigger.matcher ?? '')
  const [timeout, setTimeoutValue] = useState<number | string>(trigger.timeout ?? '')
  const info = hookEventInfo(tool, event)
  const events = hookEventsFor(tool, doc.when).map((e) => e.event)
  // Keep only what differs from the timing and action defaults, so later default changes still apply
  const defaultMatcher = actionMatcher(doc.action, tool, doc.when) ?? ''
  const next: HookToolSettings = {
    ...(event !== defaultHookEvent(tool, doc.when) ? { event } : {}),
    ...(info?.matcher && matcher.trim() !== defaultMatcher ? { matcher: matcher.trim() } : {}),
    ...(typeof timeout === 'number' ? { timeout } : {})
  }
  return (
    <Box
      px="md"
      py="md"
      style={{ borderBottom: '1px solid var(--ac-border-subtle)', background: 'var(--ac-bg)' }}
      data-testid={`hook-trigger-form-${tool}`}
    >
      <Stack gap="sm">
        <Group grow align="flex-start">
          <Select
            label={t('hooks.event')}
            data={events.includes(trigger.event) ? events : [trigger.event, ...events]}
            value={event}
            onChange={(v) => v && setEvent(v)}
            allowDeselect={false}
          />
          <TextInput
            label={t('hooks.matcher')}
            value={info?.matcher ? matcher : ''}
            onChange={(e) => setMatcher(e.currentTarget.value)}
            disabled={!info?.matcher}
            placeholder={info?.matcher ? t('hooks.matcherAll') : t('hooks.matcherNone')}
            description={info?.matcher ? t('hooks.matcherHint') : undefined}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
        </Group>
        <Group grow align="flex-start">
          <NumberInput
            label={t('hooks.timeout')}
            value={timeout}
            onChange={setTimeoutValue}
            min={1}
            max={3600}
            allowDecimal={false}
            placeholder={t('hooks.timeoutDefault')}
            description={HOOK_CATALOG[tool].timeoutUnit === 'ms' ? t('hooks.timeoutMs') : undefined}
          />
          {own !== undefined ? (
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                {t('hooks.script')}
              </Text>
              <SegmentedControl
                value={own ? 'own' : 'shared'}
                onChange={(v) => void onOwn(v === 'own')}
                data={[
                  { value: 'shared', label: t('hooks.shared') },
                  { value: 'own', label: t('hooks.own', { tool: TOOL_NAME[tool] }) }
                ]}
                data-testid={`hook-trigger-script-${tool}`}
              />
            </Stack>
          ) : (
            <Box />
          )}
        </Group>
        {doc.action === 'script' && (
          <Box className="ac-card" p="sm">
            <Fields
              rows={[
                [t('hooks.input'), t(`hooks.toolInput.${tool}`)],
                [
                  t('hooks.blockHow'),
                  info?.canBlock ? t(`hooks.toolBlock.${tool}`) : t('hooks.blockNo')
                ]
              ]}
            />
          </Box>
        )}
        <Group justify="flex-end" gap="xs">
          <Button size="xs" variant="default" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            size="xs"
            onClick={() => void onSave(next)}
            data-testid={`hook-trigger-save-${tool}`}
          >
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </Box>
  )
}

/** New hook: pick what it does, then a short form */
function NewHookForm({
  initialAction,
  tools,
  taken,
  onCreated,
  onCancel
}: {
  /** Open on this action's form instead of the action cards */
  initialAction?: HookAction | null
  tools: HookTool[]
  taken: string[]
  onCreated: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [action, setAction] = useState<HookAction | null>(initialAction ?? null)
  const [when, setWhen] = useState<HookTiming>(
    initialAction ? HOOK_ACTION_INFO[initialAction].timings[0] : 'stop'
  )
  const [options, setOptions] = useState<Options>(
    initialAction ? { ...HOOK_ACTION_INFO[initialAction].defaults } : {}
  )
  const [body, setBody] = useState('')
  const [description, setDescription] = useState('')
  // null = the name follows the action and timing until the user types one
  const [typedName, setTypedName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // script: a library script to run instead of the hook's own run.sh ('' = its own)
  const [use, setUse] = useState('')
  const libScripts = useApi('scripts', () => window.api.scripts()).data?.scripts ?? []

  const pick = (a: HookAction): void => {
    setAction(a)
    setWhen(HOOK_ACTION_INFO[a].timings[0])
    setOptions({ ...HOOK_ACTION_INFO[a].defaults })
    setBody('')
  }

  if (!action)
    return (
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('hooks.pickAction')}
        </Text>
        <CardGrid>
          {NEW_HOOK_ACTIONS.map((a) => (
            <ItemCard
              key={a}
              testId={`hook-action-${a}`}
              name={t(`hooks.actions.${a}.title`)}
              description={t(`hooks.actions.${a}.desc`)}
              badges={
                a === 'ask' ? (
                  <Badge variant="light" size="xs" fw={500} color="orange">
                    {t('hooks.claudeOnly')}
                  </Badge>
                ) : a === 'script' ? (
                  <Badge variant="default" size="xs" fw={500} c="dimmed">
                    {t('hooks.advanced')}
                  </Badge>
                ) : undefined
              }
              onClick={() => pick(a)}
            />
          ))}
        </CardGrid>
      </Stack>
    )

  const autoName = (() => {
    const base = `${action}-${when}`
    let n = base
    for (let i = 2; taken.includes(n); i++) n = `${base}-${i}`
    return n
  })()
  const name = typedName ?? autoName
  const nameOk = NAME_RE.test(name) && !taken.includes(name)
  const clean = cleanOptions(action, options)
  const runs = tools.filter((tool) => hookSupport(action, when, tool) === 'ok')
  const timings = HOOK_ACTION_INFO[action].timings
  const create = async (): Promise<void> => {
    if (!clean) return
    setBusy(true)
    const r = await runWrite(
      window.api.hookCreate(name, {
        description: description.trim(),
        when,
        action,
        options: action === 'script' ? { ...clean, use } : clean,
        body
      }),
      { success: t('hooks.created') }
    )
    setBusy(false)
    if (r) onCreated(name)
  }

  return (
    <Stack gap="md" maw={560}>
      <Group gap="xs">
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          leftSection={<ArrowLeft size={12} />}
          onClick={() => setAction(null)}
          data-testid="hook-new-back"
        >
          {t('hooks.back')}
        </Button>
        <Text size="sm" fw={600}>
          {t(`hooks.actions.${action}.title`)}
        </Text>
      </Group>
      <Select
        label={t('hooks.timingLabel')}
        data={timings.map((x) => ({ value: x, label: t(`hooks.timing.${x}`) }))}
        value={when}
        onChange={(v) => v && setWhen(v as HookTiming)}
        allowDeselect={false}
        disabled={timings.length < 2}
        description={t(`hooks.timingHint.${when}`)}
        data-testid="hook-new-timing"
      />
      <OptionFields
        action={action}
        when={when}
        value={options}
        onChange={setOptions}
        placeholderMessage={description || name}
      />
      {action === 'ask' && <InstructionField value={body} onChange={setBody} />}
      {action === 'context' && <ContextNoteField value={body} onChange={setBody} />}
      {action === 'script' && (
        <Select
          label={t('hooks.useLabel')}
          description={use ? t('hooks.libScriptHint') : t('hooks.scriptStarter')}
          data={[
            { value: '', label: t('hooks.useOwn') },
            ...libScripts.map((x) => ({ value: x.name, label: x.name }))
          ]}
          value={use}
          onChange={(v) => setUse(v ?? '')}
          allowDeselect={false}
          data-testid="hook-new-use"
        />
      )}
      <TextInput
        label={t('hooks.description')}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <TextInput
        label={t('common.name')}
        value={name}
        onChange={(e) => setTypedName(e.currentTarget.value)}
        error={
          name && !NAME_RE.test(name)
            ? t('mcp.nameInvalid')
            : taken.includes(name)
              ? t('hooks.nameTaken')
              : undefined
        }
        data-testid="hook-new-name"
      />
      <Stack gap={6}>
        <Text size="sm" fw={500}>
          {t('hooks.runsIn')}
        </Text>
        <Group gap={10}>
          {runs.map((tool) => (
            <Group key={tool} gap={4} wrap="nowrap">
              <ToolIcon tool={tool} size={14} />
              <Text size="sm">{TOOL_NAME[tool]}</Text>
            </Group>
          ))}
          {runs.length === 0 && (
            <Text size="sm" c="dimmed">
              {t('common.none')}
            </Text>
          )}
        </Group>
        <Unsupported action={action} when={when} tools={tools} testPrefix="hook-new-unsupported" />
      </Stack>
      <Group justify="flex-end" gap="xs">
        <Button size="xs" variant="default" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          size="xs"
          onClick={() => void create()}
          loading={busy}
          disabled={!nameOk || !clean || (action === 'ask' && !body.trim())}
          data-testid="hook-create"
        >
          {t('common.create')}
        </Button>
      </Group>
    </Stack>
  )
}

export default Hooks
