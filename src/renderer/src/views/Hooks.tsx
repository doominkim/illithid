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
import { Download, FolderOpen, Layers, Plus, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  actionMatcher,
  ENV_NAME_RE,
  HOOK_ACTION_INFO,
  hookSupport,
  JUDGE_CLIS,
  NOTIFY_CHANNELS,
  NOTIFY_URL_ENV,
  PROTECT_PATTERN_RE,
  type NotifyChannel,
  type ScriptTarget,
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
import { useToggleBusy } from '../lib/toggleBusy'
import {
  grokReadsFromClaude,
  pillFromCellState,
  type PillMap,
  TOOL_NAME,
  TOOLS
} from '../lib/tools'
import { useApi } from '../lib/useApi'
import { LIBRARY_SCRIPT_RE, SCRIPT_TEMPLATE } from '../../../engine/scriptNames'
import { useViewMode } from '../lib/viewMode'

const NEW = '__new__'

type Scope = ScriptTarget

/** What a hook reacts to at a tool call: its own target, or what its recipe is for */
function hookScope(action: HookAction, options: Options): Scope {
  if (action === 'script' || action === 'ask') return (options.target as Scope) || 'all'
  if (action === 'guard') return 'shell'
  if (action === 'protect' || action === 'format') return 'edit'
  return 'all'
}

/** i18n key of a timing as people see it: tool-call timings name the action (a shell command, a file edit, any action) */
function whenKey(when: HookTiming, scope: Scope): string {
  return when === 'before-tool' || when === 'after-tool'
    ? `hooks.when.${when}.${scope}`
    : `hooks.timing.${when}`
}

/** Timing and target as one choice, in the order people meet them */
const WHEN_CHOICES: readonly (readonly [HookTiming, Scope])[] = [
  ['prompt', 'all'],
  ['stop', 'all'],
  ['before-tool', 'edit'],
  ['after-tool', 'edit'],
  ['before-tool', 'shell'],
  ['after-tool', 'shell'],
  ['before-tool', 'all'],
  ['after-tool', 'all'],
  ['notification', 'all'],
  ['session-start', 'all'],
  ['session-end', 'all']
]

/** One select for when a script or plain-language check runs and on what. `action` limits it to the timings it can use */
function WhenSelect({
  action,
  when,
  target,
  onChange,
  testId
}: {
  action?: 'script' | 'ask'
  when: HookTiming
  target: Scope
  onChange: (when: HookTiming, target: Scope) => void
  testId: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const choices = WHEN_CHOICES.filter(
    ([w]) => !action || HOOK_ACTION_INFO[action].timings.includes(w)
  )
  const key = (w: HookTiming, sc: Scope): string =>
    w === 'before-tool' || w === 'after-tool' ? `${w}:${sc}` : w
  return (
    <Select
      label={t('hooks.timingLabel')}
      data={choices.map(([w, sc]) => ({ value: key(w, sc), label: t(whenKey(w, sc)) }))}
      value={key(when, target)}
      onChange={(v) => {
        if (!v) return
        const [w, sc] = v.split(':') as [HookTiming, Scope | undefined]
        onChange(w, sc ?? 'all')
      }}
      allowDeselect={false}
      description={t(`hooks.timingHint.${when}`)}
      data-testid={testId}
    />
  )
}
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
    const head = `${t(whenKey(h.when, hookScope(h.action, h.options)))} → ${t(`hooks.actions.${h.action}.title`)}`
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
  const isNew = selected === NEW

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
        includesCI(t(whenKey(h.when, hookScope(h.action, h.options))), q) ||
        includesCI(t(`hooks.actions.${h.action}.title`), q))
  )
  const current = data.hooks.find((h) => h.name === selected)
  const tags = (h: HookView): React.ReactNode => (
    <>
      <Badge variant="default" size="xs" fw={500} c="dimmed">
        {t(whenKey(h.when, hookScope(h.action, h.options)))}
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
    case 'ask':
      return (
        <Stack gap="sm">
          <Group grow align="flex-start">
            <Select
              label={t('hooks.opt.judge')}
              description={t('hooks.opt.judgeHint')}
              value={String(value.judge || 'same')}
              onChange={(v) => v && set('judge', v)}
              allowDeselect={false}
              data={JUDGE_CLIS.map((c) => ({
                value: c,
                label: c === 'same' ? t('hooks.opt.judgeSame') : TOOL_NAME[c]
              }))}
              data-testid="hook-option-judge"
            />
            <TextInput
              label={t('hooks.opt.model')}
              description={t('hooks.opt.modelHint')}
              placeholder={value.judge === 'claude' ? 'haiku' : undefined}
              value={String(value.model ?? '')}
              onChange={(e) => set('model', e.currentTarget.value.trim())}
              styles={mono}
              data-testid="hook-option-model"
            />
          </Group>
          {when === 'before-tool' && (
            <Text size="xs" c="orange" data-testid="hook-ask-slow">
              {t('hooks.opt.judgeSlow')}
            </Text>
          )}
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
    [t('hooks.timingLabel'), t(whenKey(doc.when, hookScope(doc.action, doc.options)))],
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
      {doc.action === 'script' &&
        Object.entries(edit.scripts).map(([file, content]) => (
          <Stack key={file} gap={6} data-testid="hook-overview-script">
            <SectionLabel>{o.use ? String(o.use) : file}</SectionLabel>
            <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {content}
            </Code>
          </Stack>
        ))}
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
          {doc.action === 'script' || doc.action === 'ask' ? (
            <WhenSelect
              action={doc.action}
              when={when}
              target={hookScope(doc.action, options)}
              onChange={(w, sc) => {
                setWhen(w)
                setOptions({ ...options, target: sc })
              }}
              testId="hook-when"
            />
          ) : (
            <Select
              label={t('hooks.timingLabel')}
              data={timings.map((x) => ({
                value: x,
                label: t(whenKey(x, hookScope(doc.action, options)))
              }))}
              value={when}
              onChange={(v) => v && setWhen(v as HookTiming)}
              allowDeselect={false}
              disabled={timings.length < 2}
              description={t(`hooks.timingHint.${when}`)}
              data-testid="hook-when"
            />
          )}
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
  const defaultMatcher = actionMatcher(doc.action, tool, doc.when, doc.options) ?? ''
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

/**
 * New hook: one form for every hook — when, which tool calls, and what to do (a command or script, or an AI judgment).
 * Built-in recipes (notify, verify, …) stay readable and editable for hooks that have them, but are not offered here
 */
function NewHookForm({
  tools,
  taken,
  onCreated,
  onCancel
}: {
  tools: HookTool[]
  taken: string[]
  onCreated: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'script' | 'ask'>('script')
  const [when, setWhen] = useState<HookTiming>('stop')
  const scriptOptions: Options = HOOK_ACTION_INFO.script.defaults
  const [askOptions, setAskOptions] = useState<Options>({ ...HOOK_ACTION_INFO.ask.defaults })
  // At a tool call: every action, shell commands or file edits
  const [target, setTarget] = useState<Scope>('all')
  // script: '' = written here, else a library script
  const [use, setUse] = useState('')
  const [script, setScript] = useState(SCRIPT_TEMPLATE)
  const [instruction, setInstruction] = useState('')
  const [timeout, setTimeoutValue] = useState<number | string>('')
  const [description, setDescription] = useState('')
  // null = the name follows the kind and timing until the user types one
  const [typedName, setTypedName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const libScripts = useApi('scripts', () => window.api.scripts()).data?.scripts ?? []

  const action: HookAction = mode
  // The timing comes first and decides what can be done: AI judgment is offered only where it can run
  const askAllowed = HOOK_ACTION_INFO.ask.timings.includes(when)
  const pickWhen = (w: HookTiming): void => {
    setWhen(w)
    if (!HOOK_ACTION_INFO.ask.timings.includes(w)) setMode('script')
  }
  const autoName = (() => {
    const base = `${mode}-${when}`
    let n = base
    for (let i = 2; taken.includes(n); i++) n = `${base}-${i}`
    return n
  })()
  const name = typedName ?? autoName
  const nameOk = NAME_RE.test(name) && !taken.includes(name)
  const runs = tools.filter((tool) => hookSupport(action, when, tool) === 'ok')
  const atToolCall = when === 'before-tool' || when === 'after-tool'
  const valid =
    nameOk &&
    (mode === 'ask' ? !!instruction.trim() : !!use || !!script.trim()) &&
    (timeout === '' || typeof timeout === 'number')
  const create = async (): Promise<void> => {
    setBusy(true)
    const seconds = typeof timeout === 'number' ? timeout : undefined
    const r = await runWrite(
      window.api.hookCreate(name, {
        description: description.trim(),
        when,
        action,
        options:
          mode === 'ask'
            ? { ...askOptions, target: atToolCall ? target : 'all' }
            : { ...scriptOptions, target: atToolCall ? target : 'all', use },
        body: mode === 'ask' ? instruction : '',
        ...(mode === 'script' && !use ? { script } : {}),
        ...(seconds
          ? { tools: Object.fromEntries(HOOK_TOOLS.map((tool) => [tool, { timeout: seconds }])) }
          : {})
      }),
      { success: t('hooks.created') }
    )
    setBusy(false)
    if (r) onCreated(name)
  }

  return (
    <Stack gap="md" maw={640}>
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
      <TextInput
        label={t('hooks.description')}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        data-testid="hook-new-description"
      />
      <WhenSelect
        when={when}
        target={target}
        onChange={(w, sc) => {
          pickWhen(w)
          setTarget(sc)
        }}
        testId="hook-new-timing"
      />
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          {t('hooks.doLabel')}
        </Text>
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v as 'script' | 'ask')}
          data={[
            { value: 'script', label: t('hooks.doScript') },
            ...(askAllowed ? [{ value: 'ask', label: t('hooks.doAsk') }] : [])
          ]}
          data-testid="hook-new-mode"
        />
      </Stack>
      {mode === 'script' ? (
        <Stack gap="sm">
          <Select
            label={t('hooks.useLabel')}
            data={[
              { value: '', label: t('hooks.useOwn') },
              ...libScripts.map((x) => ({ value: x.name, label: x.name }))
            ]}
            value={use}
            onChange={(v) => setUse(v ?? '')}
            allowDeselect={false}
            description={use ? t('hooks.libScriptHint') : undefined}
            data-testid="hook-new-use"
          />
          {!use && (
            <>
              <Textarea
                aria-label={t('hooks.script')}
                value={script}
                onChange={(e) => setScript(e.currentTarget.value)}
                autosize
                minRows={8}
                maxRows={24}
                styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                data-testid="hook-new-script"
              />
            </>
          )}
        </Stack>
      ) : (
        <Stack gap="sm">
          <InstructionField value={instruction} onChange={setInstruction} />
          <OptionFields action="ask" when={when} value={askOptions} onChange={setAskOptions} />
        </Stack>
      )}
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
      <NumberInput
        label={t('hooks.timeout')}
        placeholder={t('hooks.timeoutDefault')}
        description={t('hooks.timeoutAllHint')}
        value={timeout}
        onChange={setTimeoutValue}
        min={1}
        max={3600}
        allowDecimal={false}
        w={240}
        data-testid="hook-new-timeout"
      />
      <Group justify="flex-end" gap="xs">
        <Button size="xs" variant="default" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          size="xs"
          onClick={() => void create()}
          loading={busy}
          disabled={!valid}
          data-testid="hook-create"
        >
          {t('common.create')}
        </Button>
      </Group>
    </Stack>
  )
}

export default Hooks
