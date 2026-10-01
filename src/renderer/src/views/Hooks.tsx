import { useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Tabs,
  Text,
  TextInput
} from '@mantine/core'
import { Download, FolderOpen, Layers, Plus, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  HOOK_CATALOG,
  HOOK_TIMINGS,
  HOOK_TOOLS,
  hookEventInfo,
  hookEventsFor,
  type HookTiming,
  type HookTool
} from '../../../engine/hookEvents'
import type { HookDef, HookEditView, HookTrigger, HookView, ToolId } from '../../../shared/api'
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
import { useViewMode } from '../lib/viewMode'

const NEW = '__new__'
const ALL = 'all'
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Starting scripts for a new hook. The first argument is the tool that ran the hook; its JSON input is on stdin */
const TEMPLATES: Record<'blank' | 'guard' | 'notify' | 'log', string> = {
  blank:
    '#!/usr/bin/env bash\n# $1 is the tool that ran this hook (claude, codex, gemini, copilot, grok).\n# The tool sends its JSON input on stdin; field names differ per tool.\ninput="$(cat)"\nexit 0\n',
  guard:
    '#!/usr/bin/env bash\n# Blocks dangerous shell commands before they run. $1 = tool.\ninput="$(cat)"\ncmd="$(printf \'%s\' "$input" | jq -r \'.tool_input.command // .toolInput.command // (.toolArgs | fromjson? | .command) // empty\')"\ncase "$cmd" in\n  *"rm -rf /"* | *"git push --force"* | *"git reset --hard"*)\n    echo "Blocked: $cmd" >&2\n    exit 2\n    ;;\nesac\nexit 0\n',
  notify:
    '#!/usr/bin/env bash\n# Shows a macOS notification. $1 = tool.\nosascript -e "display notification \\"Done\\" with title \\"${1:-agent}\\""\nexit 0\n',
  log: '#!/usr/bin/env bash\n# Appends the time, tool and folder to a log file. $1 = tool.\nmkdir -p "$HOME/.local/state/agent-hooks"\nprintf \'%s\\t%s\\t%s\\n\' "$(date -u +%FT%TZ)" "${1:-}" "$PWD" >> "$HOME/.local/state/agent-hooks/log.tsv"\nexit 0\n'
}

const isHookTool = (tool: string): tool is HookTool =>
  (HOOK_TOOLS as readonly string[]).includes(tool)

function Hooks(): React.JSX.Element {
  const { t } = useTranslation()
  const inUse = useToolsInUse()
  const hookTools = HOOK_TOOLS.filter((tool) => inUse.includes(tool))
  const { request } = useNav()
  const reload = useReload()
  const { data, error } = useApi('hooks', () => window.api.hooks())
  const [query, setQuery] = useState('')
  const [toolFilter, setToolFilter] = useState<string>(ALL)
  const [view, setView] = useViewMode('hooks')
  const [selected, setSelected] = useState<string | null>(request.select ?? null)
  const pending = useToggleBusy()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  useNavSelect(setSelected)

  if (error) return <ErrorAlert message={error} />
  if (!data) return <Loading />

  const connected = (h: HookView, tool: ToolId): boolean => isHookTool(tool) && !!h.triggers[tool]
  const enabled = (name: string, tool: ToolId): boolean => data.toggles[name]?.[tool] !== false
  const reads = data.grokReadsClaude !== false
  const pillsOf = (h: HookView): PillMap =>
    Object.fromEntries(
      TOOLS.map((tool) => {
        if (!connected(h, tool)) return [tool, { on: false, na: true }]
        const st = h.tools[tool] ?? 'notApplicable'
        const onFor = (x: ToolId): boolean => connected(h, x) && enabled(h.name, x)
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
      if (connected(h, tool) && enabled(h.name, tool) !== on)
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
      (toolFilter === ALL || connected(h, toolFilter as ToolId)) &&
      (!q ||
        includesCI(h.name, q) ||
        includesCI(h.description, q) ||
        includesCI(t(`hooks.timing.${h.timing}`), q))
  )
  const current = data.hooks.find((h) => h.name === selected)
  const timingTag = (h: { timing: HookTiming }): React.ReactNode => (
    <Badge variant="default" size="xs" fw={500} c="dimmed">
      {t(`hooks.timing.${h.timing}`)}
    </Badge>
  )
  const cardConnected = (h: HookView): ToolId[] => hookTools.filter((tool) => connected(h, tool))

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
              badges={timingTag(h)}
              description={h.description || h.script}
              switchChecked={
                cardConnected(h).length > 0 && cardConnected(h).every((x) => enabled(h.name, x))
              }
              switchIndeterminate={cardConnected(h).some((x) => enabled(h.name, x))}
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
              tags={timingTag(h)}
              subtitle={h.description || h.script}
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
      <DetailSheet
        opened={selected === NEW}
        onClose={() => setSelected(null)}
        title={t('hooks.new')}
      >
        <NewHookForm
          tools={hookTools}
          onCreated={(name) => {
            reload()
            setSelected(name)
          }}
          onCancel={() => setSelected(null)}
        />
      </DetailSheet>

      <DetailSheet
        opened={!!current}
        onClose={() => setSelected(null)}
        title={current?.name ?? ''}
        description={current?.description || undefined}
        tags={current && timingTag(current)}
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
  const [edit, setEdit] = useState<HookEditView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<HookTool | null>(null)
  const [tab, setTab] = useState<string | null>(null)
  // Reload hook.json and scripts whenever the list changes (after a save, toggle or sync)
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
  const def = edit.def

  const saveDef = async (next: HookDef): Promise<boolean> => {
    const r = await runWrite(window.api.hookSave(hook.name, next), { success: t('hooks.saved') })
    if (r) onChanged()
    return r !== null
  }
  const setTrigger = async (tool: HookTool, trigger: HookTrigger | null): Promise<void> => {
    const triggers = { ...def.triggers }
    if (trigger) triggers[tool] = trigger
    else delete triggers[tool]
    if (await saveDef({ ...def, triggers })) setOpen(trigger ? open : null)
  }
  const setOwnScript = async (tool: HookTool, own: boolean): Promise<void> => {
    const r = own
      ? await runWrite(window.api.hookToolScriptCreate(hook.name, tool), {
          success: t('hooks.ownCreated', { tool: TOOL_NAME[tool] })
        })
      : await runWrite(window.api.hookToolScriptDrop(hook.name, tool), {
          success: t('hooks.ownDropped', { tool: TOOL_NAME[tool] })
        })
    if (r) {
      setTab(own ? `own:${tool}` : 'shared')
      onChanged()
    }
  }
  const saveScript = async (file: string, text: string): Promise<boolean> => {
    const r = await runWrite(window.api.hookScriptSave(hook.name, file, text), {
      success: t('hooks.scriptSaved')
    })
    if (r) onChanged()
    return r !== null
  }

  const connectedTools = tools.filter((tool) => def.triggers[tool])
  const runners = (file: string): HookTool[] =>
    connectedTools.filter((tool) => (def.toolScripts?.[tool] ?? def.script) === file)
  const scriptTabs: { value: string; file: string; label: string; tool?: HookTool }[] = [
    { value: 'shared', file: def.script, label: t('hooks.shared') },
    ...tools
      .filter((tool) => def.toolScripts?.[tool])
      .map((tool) => ({
        value: `own:${tool}`,
        file: def.toolScripts![tool]!,
        label: t('hooks.own', { tool: TOOL_NAME[tool] }),
        tool
      }))
  ]
  const activeTab = scriptTabs.some((x) => x.value === tab) ? tab! : 'shared'

  const keepCopy = async (tool: HookTool, file: string): Promise<void> => {
    const r = await runWrite(window.api.hookKeepCopy(hook.name, tool, file), {
      success: t('hooks.kept', { tool: TOOL_NAME[tool] })
    })
    if (r) onChanged()
  }
  const edited = (Object.entries(hook.edited ?? {}) as [ToolId, string][]).filter(([tool]) =>
    isHookTool(tool)
  ) as [HookTool, string][]

  return (
    <Stack gap="lg">
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
      <ToolToggleRow
        pills={pills}
        tools={connectedTools}
        onToggle={onToggle}
        busy={busy}
        testId="hook-detail-tools"
      />

      <Stack gap={8}>
        <SectionLabel>{t('hooks.triggers')}</SectionLabel>
        <Text size="xs" c="dimmed">
          {t('hooks.triggersHint')}
        </Text>
        <Box data-testid="hook-triggers">
          <ListCard>
            {tools.map((tool) => {
              const trigger = def.triggers[tool]
              const events = hookEventsFor(tool, def.timing)
              const own = def.toolScripts?.[tool]
              const row = (
                <ListRow
                  key={tool}
                  avatar={<ToolIcon tool={tool} size={20} />}
                  title={TOOL_NAME[tool]}
                  tags={
                    trigger ? (
                      <>
                        <Badge variant="default" size="xs" fw={500} ff="monospace">
                          {trigger.event}
                        </Badge>
                        {trigger.matcher && (
                          <Badge variant="default" size="xs" fw={500} ff="monospace" c="dimmed">
                            {trigger.matcher}
                          </Badge>
                        )}
                        <Badge variant="light" size="xs" fw={500} color={own ? 'grape' : 'accent'}>
                          {own ? t('hooks.own', { tool: TOOL_NAME[tool] }) : t('hooks.shared')}
                        </Badge>
                      </>
                    ) : undefined
                  }
                  subtitle={
                    events.length === 0
                      ? t('hooks.noEvent', { tool: TOOL_NAME[tool] })
                      : trigger
                        ? (own ?? def.script)
                        : t('hooks.notConnected')
                  }
                  style={events.length === 0 ? { opacity: 0.6 } : undefined}
                  right={
                    events.length === 0 ? undefined : trigger ? (
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
                    ) : (
                      <Button
                        size="compact-xs"
                        variant="default"
                        onClick={(e) => {
                          e.stopPropagation()
                          void setTrigger(tool, { event: events[0].event })
                        }}
                        data-testid={`hook-trigger-connect-${tool}`}
                      >
                        {t('hooks.connect')}
                      </Button>
                    )
                  }
                />
              )
              return open === tool && trigger ? (
                <Box key={tool}>
                  {row}
                  <TriggerForm
                    tool={tool}
                    timing={def.timing}
                    trigger={trigger}
                    own={!!own}
                    onSave={(next) => setTrigger(tool, next)}
                    onOwn={(v) => setOwnScript(tool, v)}
                    onDisconnect={() => setTrigger(tool, null)}
                    onCancel={() => setOpen(null)}
                  />
                </Box>
              ) : (
                row
              )
            })}
          </ListCard>
        </Box>
        <Text size="xs" c="dimmed">
          {t('hooks.argHint')}
        </Text>
        {def.triggers.codex && (
          <Text size="xs" c="dimmed" data-testid="hook-codex-trust">
            {t('hooks.codexTrust')}
          </Text>
        )}
      </Stack>

      <Stack gap={8}>
        <SectionLabel>{t('hooks.scripts')}</SectionLabel>
        <Tabs value={activeTab} onChange={setTab} keepMounted={false}>
          <Tabs.List>
            {scriptTabs.map((x) => (
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
          {scriptTabs.map((x) => (
            <Tabs.Panel key={x.value} value={x.value} pt="md">
              <Stack gap="sm">
                <Group justify="space-between" wrap="nowrap">
                  <Group gap={8} wrap="wrap">
                    <Text size="xs" c="dimmed">
                      {t('hooks.usedBy')}
                    </Text>
                    {runners(x.file).map((tool) => (
                      <Group key={tool} gap={4} wrap="nowrap">
                        <ToolIcon tool={tool} size={14} />
                        <Text size="xs">{TOOL_NAME[tool]}</Text>
                      </Group>
                    ))}
                    {runners(x.file).length === 0 && (
                      <Text size="xs" c="dimmed">
                        {t('common.none')}
                      </Text>
                    )}
                  </Group>
                  {x.tool && (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="gray"
                      leftSection={<Undo2 size={12} />}
                      onClick={() => void setOwnScript(x.tool!, false)}
                      data-testid={`hook-script-drop-${x.tool}`}
                    >
                      {t('hooks.dropOwn')}
                    </Button>
                  )}
                </Group>
                <MarkdownEditor
                  value={edit.scripts[x.file] ?? ''}
                  minRows={12}
                  onSave={(text) => saveScript(x.file, text)}
                />
              </Stack>
            </Tabs.Panel>
          ))}
        </Tabs>
      </Stack>
    </Stack>
  )
}

function TriggerForm({
  tool,
  timing,
  trigger,
  own,
  onSave,
  onOwn,
  onDisconnect,
  onCancel
}: {
  tool: HookTool
  timing: HookTiming
  trigger: HookTrigger
  own: boolean
  onSave: (t: HookTrigger) => Promise<void>
  onOwn: (own: boolean) => Promise<void>
  onDisconnect: () => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [event, setEvent] = useState(trigger.event)
  const [matcher, setMatcher] = useState(trigger.matcher ?? '')
  const [timeout, setTimeoutValue] = useState<number | string>(trigger.timeout ?? '')
  const info = hookEventInfo(tool, event)
  const events = hookEventsFor(tool, timing).map((e) => e.event)
  const next: HookTrigger = {
    event,
    ...(info?.matcher && matcher.trim() ? { matcher: matcher.trim() } : {}),
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
        </Group>
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
        <Group justify="space-between">
          <Button
            size="xs"
            variant="subtle"
            color="red"
            onClick={() => void onDisconnect()}
            data-testid={`hook-trigger-disconnect-${tool}`}
          >
            {t('hooks.disconnect')}
          </Button>
          <Group gap="xs">
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
        </Group>
      </Stack>
    </Box>
  )
}

function NewHookForm({
  tools,
  onCreated,
  onCancel
}: {
  tools: HookTool[]
  onCreated: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [timing, setTiming] = useState<HookTiming | null>(null)
  const [template, setTemplate] = useState<keyof typeof TEMPLATES>('blank')
  // null = every tool in use that has an event for the timing
  const [picked, setPicked] = useState<HookTool[] | null>(null)
  const [busy, setBusy] = useState(false)
  const supported = timing ? tools.filter((tool) => hookEventsFor(tool, timing).length > 0) : []
  const chosen = (picked ?? supported).filter((tool) => supported.includes(tool))
  const nameOk = NAME_RE.test(name)
  const create = async (): Promise<void> => {
    if (!timing) return
    setBusy(true)
    const r = await runWrite(
      window.api.hookCreate(name, {
        description,
        timing,
        tools: chosen,
        script: TEMPLATES[template]
      }),
      { success: t('hooks.created') }
    )
    setBusy(false)
    if (r) onCreated(name)
  }
  return (
    <Stack gap="md" maw={560}>
      <Select
        label={t('hooks.timingLabel')}
        placeholder={t('hooks.timingPick')}
        data={HOOK_TIMINGS.map((x) => ({ value: x, label: t(`hooks.timing.${x}`) }))}
        value={timing}
        onChange={(v) => setTiming(v as HookTiming | null)}
        allowDeselect={false}
        description={timing ? t(`hooks.timingHint.${timing}`) : undefined}
        data-testid="hook-new-timing"
      />
      <TextInput
        label={t('common.name')}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        error={name && !nameOk ? t('mcp.nameInvalid') : undefined}
        data-testid="hook-new-name"
      />
      <TextInput
        label={t('hooks.description')}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Select
        label={t('hooks.template')}
        data={(Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]).map((k) => ({
          value: k,
          label: t(`hooks.templates.${k}`)
        }))}
        value={template}
        onChange={(v) => v && setTemplate(v as keyof typeof TEMPLATES)}
        allowDeselect={false}
      />
      <Stack gap={6}>
        <Text size="sm" fw={500}>
          {t('hooks.tools')}
        </Text>
        {tools.map((tool) => {
          const ev = timing ? hookEventsFor(tool, timing)[0] : undefined
          return (
            <Checkbox
              key={tool}
              disabled={!ev}
              checked={chosen.includes(tool)}
              onChange={(e) => {
                const on = e.currentTarget.checked
                setPicked((on ? [...chosen, tool] : chosen.filter((x) => x !== tool)).sort())
              }}
              label={
                <Group gap={6} wrap="nowrap">
                  <ToolIcon tool={tool} size={14} />
                  <span>{TOOL_NAME[tool]}</span>
                  {ev ? (
                    <Badge variant="default" size="xs" fw={500} ff="monospace">
                      {ev.event}
                    </Badge>
                  ) : (
                    timing && (
                      <Text span size="xs" c="dimmed">
                        {t('hooks.noEvent', { tool: TOOL_NAME[tool] })}
                      </Text>
                    )
                  )}
                </Group>
              }
              data-testid={`hook-new-tool-${tool}`}
            />
          )
        })}
      </Stack>
      <Group justify="flex-end" gap="xs">
        <Button size="xs" variant="default" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          size="xs"
          onClick={() => void create()}
          loading={busy}
          disabled={!timing || !nameOk || chosen.length === 0}
          data-testid="hook-create"
        >
          {t('common.create')}
        </Button>
      </Group>
    </Stack>
  )
}

export default Hooks
