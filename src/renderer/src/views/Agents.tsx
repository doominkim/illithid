import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Group,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput
} from '@mantine/core'
import { Download, FolderOpen, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentDoc, ToolId } from '../../../shared/api'
import { effortsFor, MODEL_CATALOG } from '../../../shared/modelCatalog'
import { ConfirmModal } from '../components/ConfirmModal'
import { DetailSheet, MetaItem } from '../components/DetailSheet'
import { EmptyLibrary, EmptyState } from '../components/EmptyState'
import { ImportModal } from '../components/ImportModal'
import { CardGrid, ItemCard } from '../components/ItemCard'
import { ErrorAlert, Loading } from '../components/Layout'
import { Initial, ListCard, ListRow } from '../components/ListRow'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { PageHeader, Toolbar } from '../components/PageHeader'
import { ReloadButton, useReload } from '../components/ReloadButton'
import { SearchInput } from '../components/SearchInput'
import { ToolIcon } from '../components/ToolIcon'
import { ToolPills } from '../components/ToolPills'
import { ViewToggle, type ViewMode } from '../components/ViewToggle'
import { includesCI } from '../lib/format'
import { isRefused, runWrite } from '../lib/mutate'
import { useNav, useNavSelect } from '../lib/nav'
import { useSyncFailures } from '../lib/sync'
import { useToolsInUse } from '../lib/config'
import { dotOfPills, pillFromCellState, TOOL_NAME, TOOLS, type PillMap } from '../lib/tools'
import { useApi } from '../lib/useApi'

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
  const { request } = useNav()
  const reload = useReload()
  const { data, error } = useApi('agents', () => window.api.agents())
  const failedIn = useSyncFailures()
  const [query, setQuery] = useState('')
  const [view, setView] = useState<ViewMode>('grid')
  const [selected, setSelected] = useState<string | null>(request.select ?? null)
  const [busy, setBusy] = useState<{ name: string; tool: ToolId } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
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
          if (!on) return [tool, { on: false }]
          if (failedIn('agent', name, tool)) return [tool, { on: true, problem: true }]
          if (st === 'skipped') return [tool, pillFromCellState(st)]
          return [tool, { ...pillFromCellState(st ?? 'synced'), on: true }]
        })
      ) as PillMap
      return { name, description: data.descriptions[name] ?? '', pills }
    })
  }, [data, failedIn])

  if (error) return <ErrorAlert message={error} />
  if (!data) return <Loading />

  const q = query.trim().toLowerCase()
  const visible = rows.filter((r) => !q || includesCI(r.name, q) || includesCI(r.description, q))
  const prev =
    renamed && renamed.to === selected ? rows.find((r) => r.name === renamed.from) : undefined
  const current = rows.find((r) => r.name === selected) ?? (prev && { ...prev, name: renamed!.to })

  const toggle = async (name: string, tool: ToolId, on: boolean): Promise<void> => {
    setBusy({ name, tool })
    await runWrite(window.api.toggle('agents', name, tool, on), { success: t('toggles.saved') })
    setBusy(null)
    reload()
  }
  const toggleAll = async (name: string, on: boolean): Promise<void> => {
    for (const tool of TOOLS)
      if (enabled(name, tool) !== on) await runWrite(window.api.toggle('agents', name, tool, on))
    reload()
  }
  const create = async (): Promise<void> => {
    const r = await runWrite(window.api.agentCreate(newName.trim(), newDesc.trim()), {
      success: t('agents.created')
    })
    if (r !== null) {
      setCreating(false)
      setSelected(newName.trim())
      setNewName('')
      setNewDesc('')
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
              onClick={() => setCreating(true)}
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
            <Text size="sm" c="dimmed">
              {t('common.shown', { shown: visible.length, total: rows.length })}
            </Text>
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
              dot={dotOfPills(r.pills)}
              switchChecked={TOOLS.every((tool) => enabled(r.name, tool))}
              switchIndeterminate={TOOLS.some((tool) => enabled(r.name, tool))}
              onSwitch={(v) => void toggleAll(r.name, v)}
              footerRight={
                <ToolPills
                  pills={r.pills}
                  size={18}
                  onToggle={pillToggle(r)}
                  busy={busy?.name === r.name ? busy.tool : null}
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
                  busy={busy?.name === r.name ? busy.tool : null}
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
            <>
              <MetaItem
                icon={<FolderOpen size={14} />}
              >{`${data.dir}/${current.name}.md`}</MetaItem>
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                leftSection={<Trash2 size={12} />}
                onClick={() => setConfirmDelete(true)}
                data-testid="agent-delete"
              >
                {t('common.delete')}
              </Button>
            </>
          )
        }
      >
        {current && (
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
        )}
      </DetailSheet>

      <ImportModal
        opened={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={reload}
        kind="agent"
      />
      <Modal
        opened={creating}
        onClose={() => setCreating(false)}
        title={t('agents.new')}
        centered
        radius="lg"
      >
        <Stack gap="md">
          <TextInput
            label={t('common.name')}
            description={t('skills.nameHint')}
            placeholder="reviewer"
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
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={!newName.trim() || !newDesc.trim()} onClick={() => void create()}>
              {t('common.create')}
            </Button>
          </Group>
        </Stack>
      </Modal>
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

/** Agent detail: rename + description + per-tool model/effort + instructions */
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
  return (
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

      <SimpleGrid cols={{ base: 1, md: Math.max(1, shown.length <= 3 ? shown.length : 2), xl: Math.max(1, shown.length) }} spacing="md">
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
  )
}

export default Agents
