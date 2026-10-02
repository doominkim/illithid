import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  Textarea,
  TextInput
} from '@mantine/core'
import { Download, FolderOpen, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentDoc, ToolId } from '../../../shared/api'
import { effortsFor, MODEL_CATALOG } from '../../../shared/modelCatalog'
import { ConfirmModal } from '../components/ConfirmModal'
import { FormFooter } from '../components/FormFooter'
import { DetailSheet, MetaItem } from '../components/DetailSheet'
import { EmptyLibrary, EmptyState } from '../components/EmptyState'
import { ImportModal } from '../components/ImportModal'
import { CardGrid, ItemCard } from '../components/ItemCard'
import { ErrorAlert, Fields, Loading } from '../components/Layout'
import { Initial, ListCard, ListRow } from '../components/ListRow'
import { Markdown } from '../components/Markdown'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { PageHeader, ShownCount, Toolbar } from '../components/PageHeader'
import { ReloadButton } from '../components/ReloadButton'
import { useReload } from '../lib/reload'
import { SearchInput } from '../components/SearchInput'
import { ToolIcon } from '../components/ToolIcon'
import { ToolPills } from '../components/ToolPills'
import { ToolToggleRow } from '../components/ToolToggleRow'
import { ViewToggle } from '../components/ViewToggle'
import { includesCI } from '../lib/format'
import { isRefused, runWrite } from '../lib/mutate'
import { useNav, useNavSelect } from '../lib/nav'
import { useSyncFailures } from '../lib/sync'
import { useToolsInUse } from '../lib/config'
import {
  grokReadsFromClaude,
  pillFromCellState,
  type PillMap,
  TOOL_NAME,
  TOOLS
} from '../lib/tools'
import { lastSyncFailedText, problemText } from '../lib/problemReason'
import { useToggleBusy } from '../lib/toggleBusy'
import { useApi } from '../lib/useApi'
import { useViewMode } from '../lib/viewMode'

interface Row {
  name: string
  description: string
  pills: PillMap
}

type ToolSettings = AgentDoc['tools']

/** Select value for "default" (= key omitted) */
const DEFAULT = '__default__'

function Agents(): React.JSX.Element {
  const { t } = useTranslation()
  // Card switch and all-on/off cover the tools in use only (others are off by design and never written)
  const inUse = useToolsInUse()
  const cardTools = TOOLS.filter((tool) => inUse.includes(tool))
  const { request } = useNav()
  const reload = useReload()
  const { data, error } = useApi('agents', () => window.api.agents())
  const failedIn = useSyncFailures()
  const [query, setQuery] = useState('')
  const [view, setView] = useViewMode('agents')
  const [selected, setSelected] = useState<string | null>(request.select ?? null)
  const pending = useToggleBusy()
  const [importOpen, setImportOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newBody, setNewBody] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renamed, setRenamed] = useState<{ from: string; to: string } | null>(null)
  useNavSelect(setSelected)

  const enabled = (name: string, tool: ToolId): boolean => data?.toggles[name]?.[tool] !== false

  const rows = useMemo<Row[]>(() => {
    if (!data) return []
    return data.names.map((name) => {
      const pills = Object.fromEntries(
        TOOLS.map((tool) => {
          const on = data.toggles[name]?.[tool] !== false
          const st = data.state[name]?.[tool]
          if (!on)
            return [
              tool,
              // Grok has no switch for Claude agents: they reach Grok whatever config.grokReadsClaude says
              tool === 'grok' &&
              grokReadsFromClaude(inUse, (x) => data.toggles[name]?.[x] !== false)
                ? { on: false, via: true, hint: t('combo.readsClaude') }
                : { on: false }
            ]
          const failure = failedIn('agent', name, tool)
          if (failure)
            return [tool, { on: true, problem: true, hint: lastSyncFailedText(t, failure) }]
          if (st === 'skipped') return [tool, pillFromCellState(st)]
          return [
            tool,
            {
              ...pillFromCellState(st ?? 'synced'),
              on: true,
              ...(st === 'error' ? { hint: problemText(t, data.reasons?.[name]?.[tool]) } : {})
            }
          ]
        })
      ) as PillMap
      return { name, description: data.descriptions[name] ?? '', pills }
    })
  }, [data, failedIn, inUse, t])

  if (error) return <ErrorAlert message={error} />
  if (!data) return <Loading />

  const q = query.trim().toLowerCase()
  const visible = rows.filter((r) => !q || includesCI(r.name, q) || includesCI(r.description, q))
  const prev =
    renamed && renamed.to === selected ? rows.find((r) => r.name === renamed.from) : undefined
  const current = rows.find((r) => r.name === selected) ?? (prev && { ...prev, name: renamed!.to })

  const toggle = async (name: string, tool: ToolId, on: boolean): Promise<void> => {
    await pending.run(name, tool, () =>
      runWrite(window.api.toggle('agents', name, tool, on), { success: t('toggles.saved') })
    )
    reload()
  }
  const toggleAll = async (name: string, on: boolean): Promise<void> => {
    for (const tool of cardTools)
      if (enabled(name, tool) !== on) await runWrite(window.api.toggle('agents', name, tool, on))
    reload()
  }
  const create = async (): Promise<void> => {
    const r = await runWrite(window.api.agentCreate(newName.trim(), newDesc.trim(), newBody), {
      success: t('agents.created')
    })
    if (r !== null) {
      setCreating(false)
      setSelected(newName.trim())
      setNewName('')
      setNewDesc('')
      setNewBody('')
      reload()
    }
  }
  const remove = async (): Promise<void> => {
    if (!current) return
    const r = await runWrite(window.api.agentDelete(current.name), { success: t('agents.deleted') })
    setConfirmDelete(false)
    if (r) {
      setSelected(null)
      reload()
    }
  }
  const pillToggle = (r: Row) => (tool: ToolId) => void toggle(r.name, tool, !enabled(r.name, tool))

  return (
    <Stack gap={0} style={{ flex: 1 }}>
      <PageHeader
        title={t('nav.agents')}
        count={rows.length}
        actions={
          <>
            <Button
              size="xs"
              leftSection={<Plus size={13} />}
              onClick={() => {
                setSelected(null)
                setCreating(true)
              }}
              data-testid="agent-new"
            >
              {t('agents.new')}
            </Button>
            <Button
              size="xs"
              variant="default"
              leftSection={<Download size={13} />}
              onClick={() => setImportOpen(true)}
              data-testid="agent-import"
            >
              {t('common.import')}
            </Button>
            <ReloadButton />
          </>
        }
      />
      {data.syncError && (
        <Box mb="md">
          <ErrorAlert message={data.syncError} />
        </Box>
      )}
      <Toolbar
        left={<SearchInput value={query} onChange={setQuery} placeholder={t('agents.search')} />}
        right={
          <>
            <ShownCount shown={visible.length} total={rows.length} />
            <ViewToggle value={view} onChange={setView} />
          </>
        }
      />

      {rows.length === 0 ? (
        <EmptyLibrary onImport={() => setImportOpen(true)} />
      ) : visible.length === 0 ? (
        <EmptyState title={t('common.noResults')} />
      ) : view === 'grid' ? (
        <CardGrid>
          {visible.map((r) => (
            <ItemCard
              key={r.name}
              name={r.name}
              description={r.description}
              switchChecked={
                cardTools.length > 0 && cardTools.every((tool) => enabled(r.name, tool))
              }
              switchIndeterminate={cardTools.some((tool) => enabled(r.name, tool))}
              onSwitch={(v) => void toggleAll(r.name, v)}
              footerRight={
                <ToolPills
                  pills={r.pills}
                  size={18}
                  onToggle={pillToggle(r)}
                  busy={pending.of(r.name)}
                />
              }
              selected={r.name === selected}
              onClick={() => setSelected(r.name)}
            />
          ))}
        </CardGrid>
      ) : (
        <ListCard>
          {visible.map((r) => (
            <ListRow
              key={r.name}
              avatar={<Initial text={r.name} />}
              title={r.name}
              subtitle={r.description}
              right={
                <ToolPills
                  pills={r.pills}
                  size={18}
                  onToggle={pillToggle(r)}
                  busy={pending.of(r.name)}
                />
              }
              active={r.name === selected}
              onClick={() => setSelected(r.name)}
            />
          ))}
        </ListCard>
      )}

      <DetailSheet
        opened={!!current}
        onClose={() => setSelected(null)}
        title={current?.name ?? ''}
        description={current?.description || undefined}
        meta={
          current && (
            <MetaItem icon={<FolderOpen size={14} />}>{`${data.dir}/${current.name}.md`}</MetaItem>
          )
        }
        copyPath={current ? `${data.dir}/${current.name}.md` : undefined}
        onDelete={() => setConfirmDelete(true)}
        deleteTestId="agent-delete"
      >
        {current && (
          <Stack gap="lg">
            <ToolToggleRow
              pills={current.pills}
              onToggle={pillToggle(current)}
              busy={pending.of(current.name)}
              testId="agent-detail-tools"
            />
            <AgentEditor
              key={current.name}
              name={current.name}
              onSaved={reload}
              onRenamed={(to) => {
                setRenamed({ from: current.name, to })
                setSelected(to)
                reload()
              }}
            />
          </Stack>
        )}
      </DetailSheet>

      <ImportModal
        opened={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={reload}
        kind="agent"
      />
      <DetailSheet opened={creating} onClose={() => setCreating(false)} title={t('agents.new')}>
        <Stack gap="md" maw={640}>
          <TextInput
            label={t('common.name')}
            description={t('skills.nameHint')}
            placeholder="my-agent"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            data-autofocus
          />
          <Textarea
            label={t('agents.description')}
            value={newDesc}
            onChange={(e) => setNewDesc(e.currentTarget.value)}
            autosize
            minRows={2}
          />
          <Textarea
            label={t('agents.instructions')}
            value={newBody}
            onChange={(e) => setNewBody(e.currentTarget.value)}
            placeholder={t('agents.instructionsPlaceholder')}
            autosize
            minRows={10}
            maxRows={24}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            data-testid="agent-new-body"
          />
          <FormFooter>
            <Button size="xs" variant="default" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              size="xs"
              disabled={!newName.trim() || !newDesc.trim()}
              onClick={() => void create()}
            >
              {t('common.create')}
            </Button>
          </FormFooter>
        </Stack>
      </DetailSheet>
      <ConfirmModal
        opened={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        danger
        title={t('agents.deleteTitle')}
        confirmLabel={t('common.delete')}
        message={t('agents.deleteBody', { name: current?.name ?? '' })}
      />
    </Stack>
  )
}

/** Options + the current value if not in the list (preserved) */
function options(
  base: { value: string; label: string }[],
  current: string | undefined,
  defaultLabel: string
): { value: string; label: string }[] {
  const out = [{ value: DEFAULT, label: defaultLabel }, ...base]
  if (current && !base.some((o) => o.value === current))
    out.push({ value: current, label: current })
  return out
}

function sameTools(a: ToolSettings, b: ToolSettings): boolean {
  return TOOLS.every(
    (tool) =>
      (a[tool]?.model ?? '') === (b[tool]?.model ?? '') &&
      (a[tool]?.effort ?? '') === (b[tool]?.effort ?? '')
  )
}

/** Model and effort picker for one tool */
function ToolCard({
  tool,
  value,
  onChange
}: {
  tool: ToolId
  value: { model?: string; effort?: string }
  onChange: (v: { model?: string; effort?: string }) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const def = t('agents.default')
  const models = options(MODEL_CATALOG[tool].models, value.model, def)
  const efforts = options(
    effortsFor(tool, value.model).map((e) => ({ value: e, label: e })),
    value.effort,
    def
  )
  const setModel = (m: string | undefined): void => {
    // Reset effort to default if the new model does not accept it
    const keep =
      value.effort && effortsFor(tool, m).includes(value.effort) ? value.effort : undefined
    onChange({ ...(m ? { model: m } : {}), ...(keep ? { effort: keep } : {}) })
  }
  return (
    <Box className="ac-card" p="md" data-testid={`agent-tool-${tool}`}>
      <Group gap={8} wrap="nowrap" mb="sm">
        <ToolIcon tool={tool} size={20} />
        <Text fw={600}>{TOOL_NAME[tool]}</Text>
      </Group>
      <Stack gap="xs">
        <Select
          label={t('agents.model')}
          data={models}
          value={value.model ?? DEFAULT}
          onChange={(v) => setModel(v && v !== DEFAULT ? v : undefined)}
          allowDeselect={false}
          data-testid={`agent-model-${tool}`}
        />
        {(MODEL_CATALOG[tool].efforts.length > 0 || value.effort) && (
          <Select
            label={t('agents.effort')}
            data={efforts}
            value={value.effort ?? DEFAULT}
            onChange={(v) =>
              onChange({
                ...(value.model ? { model: value.model } : {}),
                ...(v && v !== DEFAULT ? { effort: v } : {})
              })
            }
            allowDeselect={false}
            data-testid={`agent-effort-${tool}`}
          />
        )}
      </Stack>
    </Box>
  )
}

/** Agent detail tabs: Preview (per-tool model/effort, instructions) / Edit (rename, description, per-tool model/effort, instructions) */
function AgentEditor({
  name,
  onSaved,
  onRenamed
}: {
  name: string
  onSaved: () => void
  onRenamed: (to: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const shown = useToolsInUse()
  const [doc, setDoc] = useState<AgentDoc | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [desc, setDesc] = useState('')
  const [tools, setTools] = useState<ToolSettings>({})
  const [nameDraft, setNameDraft] = useState(name)
  const [renameErr, setRenameErr] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)

  useEffect(() => {
    let alive = true
    window.api.agentDoc(name).then((r) => {
      if (!alive) return
      if (r.ok) {
        setDoc(r.value)
        setDesc(r.value.description)
        setTools(r.value.tools)
      } else setErr(r.message)
    })
    return () => {
      alive = false
    }
  }, [name])

  const trimmed = nameDraft.trim()
  const rename = async (): Promise<void> => {
    setRenaming(true)
    setRenameErr(null)
    const res = await window.api.agentRename(name, trimmed)
    setRenaming(false)
    if (isRefused(res)) return setRenameErr(res.message || t(`refused.${res.refused}`))
    if (!res.ok) return setRenameErr(res.message)
    const v = await runWrite(Promise.resolve(res), { success: t('agents.renamed') })
    if (v) onRenamed(v.name)
  }

  const save = async (body: string): Promise<boolean> => {
    const r = await runWrite(window.api.agentDocSave(name, { description: desc, body, tools }), {
      success: t('editor.saved')
    })
    if (r === null) return false
    setDoc((d) => (d ? { ...d, description: desc, body, tools } : d))
    onSaved()
    return true
  }

  if (err) return <ErrorAlert message={err} />
  if (!doc) return <Loading />
  const cols = {
    base: 1,
    md: Math.max(1, shown.length <= 3 ? shown.length : 2),
    xl: Math.max(1, shown.length)
  }
  return (
    <Tabs defaultValue="preview" keepMounted={false}>
      <Tabs.List mb="md">
        <Tabs.Tab value="preview">{t('detail.source')}</Tabs.Tab>
        <Tabs.Tab value="edit" data-testid="tab-edit">
          {t('detail.edit')}
        </Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="preview">
        <Stack gap="md">
          <Box className="ac-card" p="lg">
            <Text size="sm" fw={600} c="dimmed" mb="xs">
              {t('agents.instructions')}
            </Text>
            <Markdown text={doc.body} />
          </Box>
          <SimpleGrid cols={cols} spacing="md">
            {shown.map((tool) => (
              <ToolSummary key={tool} tool={tool} value={doc.tools[tool] ?? {}} />
            ))}
          </SimpleGrid>
        </Stack>
      </Tabs.Panel>
      <Tabs.Panel value="edit">
        <Stack gap="md">
          <Group gap="xs" align="flex-end">
            <TextInput
              label={t('common.name')}
              value={nameDraft}
              onChange={(e) => {
                setNameDraft(e.currentTarget.value)
                setRenameErr(null)
              }}
              w={320}
              error={renameErr ?? undefined}
              data-testid="agent-name"
            />
            <Button
              variant="default"
              disabled={!trimmed || trimmed === name}
              loading={renaming}
              onClick={() => void rename()}
              mb={renameErr ? 22 : 0}
              data-testid="agent-rename"
            >
              {t('skills.rename')}
            </Button>
          </Group>

          <Box className="ac-card" p="md">
            <Text size="sm" fw={600} mb="xs">
              {t('agents.description')}
            </Text>
            <Textarea
              value={desc}
              onChange={(e) => setDesc(e.currentTarget.value)}
              autosize
              minRows={2}
              maxRows={12}
              error={!desc.trim()}
              data-testid="agent-desc"
            />
          </Box>

          <SimpleGrid cols={cols} spacing="md">
            {shown.map((tool) => (
              <ToolCard
                key={tool}
                tool={tool}
                value={tools[tool] ?? {}}
                onChange={(v) => setTools((m) => ({ ...m, [tool]: v }))}
              />
            ))}
          </SimpleGrid>

          <MarkdownEditor
            key={name}
            title={t('agents.instructions')}
            value={doc.body}
            extraDirty={desc !== doc.description || !sameTools(tools, doc.tools)}
            onRevert={() => {
              setDesc(doc.description)
              setTools(doc.tools)
            }}
            onSave={save}
          />
        </Stack>
      </Tabs.Panel>
    </Tabs>
  )
}

/** Read-only model and effort of one tool (Preview tab) */
function ToolSummary({
  tool,
  value
}: {
  tool: ToolId
  value: { model?: string; effort?: string }
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Box className="ac-card" p="md" data-testid={`agent-summary-${tool}`}>
      <Group gap={8} wrap="nowrap" mb="sm">
        <ToolIcon tool={tool} size={20} />
        <Text fw={600}>{TOOL_NAME[tool]}</Text>
      </Group>
      <Fields
        rows={[
          [t('agents.model'), value.model ?? t('agents.default')],
          ...(MODEL_CATALOG[tool].efforts.length > 0 || value.effort
            ? [[t('agents.effort'), value.effort ?? t('agents.default')] as [string, string]]
            : [])
        ]}
      />
    </Box>
  )
}

export default Agents
