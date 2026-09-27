import { useEffect, useMemo, useState } from 'react'
import { Box, Button, Group, Modal, Select, Stack, Tabs, Text, Textarea, TextInput } from '@mantine/core'
import { Download, FolderOpen, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SkillDoc, ToolId } from '../../../shared/api'
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
import { ToolPills } from '../components/ToolPills'
import { ViewToggle, type ViewMode } from '../components/ViewToggle'
import { includesCI } from '../lib/format'
import { isRefused, runWrite } from '../lib/mutate'
import { useNav, useNavSelect } from '../lib/nav'
import { useSyncFailures } from '../lib/sync'
import { dotOfPills, pillFromCellState, SKILL_TOGGLE_TOOLS as TOGGLE_TOOLS, TOOLS, type PillMap } from '../lib/tools'
import { useApi } from '../lib/useApi'


interface Row {
  name: string
  description: string
  pills: PillMap
}

function Skills(): React.JSX.Element {
  const { t } = useTranslation()
  const { request } = useNav()
  const reload = useReload()
  const { data, error } = useApi('skills', () => window.api.skills())
  const failedIn = useSyncFailures()
  const [query, setQuery] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [view, setView] = useState<ViewMode>('grid')
  const [selected, setSelected] = useState<string | null>(request.select ?? null)
  const [busy, setBusy] = useState<{ name: string; tool: ToolId } | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  /** Keep the detail open right after a rename until the list is reloaded */
  const [renamed, setRenamed] = useState<{ from: string; to: string } | null>(null)
  useNavSelect(setSelected)

  const enabled = (name: string, tool: ToolId): boolean => data?.toggles[name]?.[tool] !== false

  const rows = useMemo<Row[]>(() => {
    if (!data) return []
    return data.names.map((name) => {
      const pills = Object.fromEntries(
        TOOLS.map((tool) => {
          const st = data.state[name]?.[tool]
          const on = !TOGGLE_TOOLS.includes(tool) || data.toggles[name]?.[tool] !== false
          if (!on) return [tool, { on: false }]
          if (failedIn('skill', name, tool)) return [tool, { on: true, problem: true }]
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
  const prev = renamed && renamed.to === selected ? rows.find((r) => r.name === renamed.from) : undefined
  const current = rows.find((r) => r.name === selected) ?? (prev && { ...prev, name: renamed!.to })

  const toggle = async (name: string, tool: ToolId, on: boolean): Promise<void> => {
    if (!TOGGLE_TOOLS.includes(tool)) return
    setBusy({ name, tool })
    await runWrite(window.api.toggle('skills', name, tool, on), { success: t('toggles.saved') })
    setBusy(null)
    reload()
  }
  const toggleAll = async (name: string, on: boolean): Promise<void> => {
    for (const tool of TOGGLE_TOOLS) if (enabled(name, tool) !== on) await runWrite(window.api.toggle('skills', name, tool, on))
    reload()
  }
  const create = async (): Promise<void> => {
    const r = await runWrite(window.api.skillCreate(newName.trim(), newDesc.trim()), { success: t('skills.created') })
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
    const r = await runWrite(window.api.skillDelete(current.name), { success: t('skills.deleted') })
    setConfirmDelete(false)
    if (r) {
      setSelected(null)
      reload()
    }
  }

  const pillToggle = (r: Row) => (tool: ToolId) => {
    if (TOGGLE_TOOLS.includes(tool)) void toggle(r.name, tool, !enabled(r.name, tool))
  }

  return (
    <Stack gap={0} style={{ flex: 1 }}>
      <PageHeader
        title={t('nav.skills')}
        count={rows.length}
        actions={
          <>
            <Button size="xs" leftSection={<Plus size={13} />} onClick={() => setCreating(true)} data-testid="skill-new">
              {t('skills.new')}
            </Button>
            <Button size="xs" variant="default" leftSection={<Download size={13} />} onClick={() => setImportOpen(true)} data-testid="skill-import">
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
        left={<SearchInput value={query} onChange={setQuery} placeholder={t('skills.search')} />}
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
              switchChecked={TOGGLE_TOOLS.every((tool) => enabled(r.name, tool))}
              switchIndeterminate={TOGGLE_TOOLS.some((tool) => enabled(r.name, tool))}
              onSwitch={(v) => void toggleAll(r.name, v)}
              footerRight={<ToolPills pills={r.pills} size={18} onToggle={pillToggle(r)} busy={busy?.name === r.name ? busy.tool : null} />}
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
              right={<ToolPills pills={r.pills} size={18} onToggle={pillToggle(r)} busy={busy?.name === r.name ? busy.tool : null} />}
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
              <MetaItem icon={<FolderOpen size={14} />}>{`${data.dir}/${current.name}`}</MetaItem>
              <Button size="compact-xs" variant="subtle" color="red" leftSection={<Trash2 size={12} />} onClick={() => setConfirmDelete(true)} data-testid="skill-delete">
                {t('common.delete')}
              </Button>
            </>
          )
        }
      >
        {current && (
          <SkillEditor
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

      <ImportModal opened={importOpen} onClose={() => setImportOpen(false)} onImported={reload} kind="skill" />
      <Modal opened={creating} onClose={() => setCreating(false)} title={t('skills.new')} centered radius="lg">
        <Stack gap="md">
          <TextInput label={t('common.name')} description={t('skills.nameHint')} placeholder="my-skill" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} data-autofocus />
          <Textarea label={t('agents.description')} value={newDesc} onChange={(e) => setNewDesc(e.currentTarget.value)} autosize minRows={2} />
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
        title={t('skills.deleteTitle')}
        confirmLabel={t('common.delete')}
        message={t('skills.deleteBody', { name: current?.name ?? '' })}
      />
    </Stack>
  )
}

/** Skill detail: rename + SKILL.md (description, body) + extra files */
function SkillEditor({
  name,
  onSaved,
  onRenamed
}: {
  name: string
  onSaved: () => void
  onRenamed: (to: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<string | null>('doc')
  const [files, setFiles] = useState<string[]>([])
  const [doc, setDoc] = useState<SkillDoc | null>(null)
  const [docErr, setDocErr] = useState<string | null>(null)
  const [desc, setDesc] = useState('')
  const [nameDraft, setNameDraft] = useState(name)
  const [renameErr, setRenameErr] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.api.skillFiles(name).then((r) => {
      if (!alive) return
      if (r.ok) setFiles(r.value)
      else setErr(r.message)
    })
    window.api.skillDoc(name).then((r) => {
      if (!alive) return
      if (r.ok) {
        setDoc(r.value)
        setDesc(r.value.description)
      } else setDocErr(r.message)
    })
    return () => {
      alive = false
    }
  }, [name])

  // SKILL.md is edited via the description and body fields. If the frontmatter cannot be parsed, fall back to raw editing
  const others = docErr ? files : files.filter((f) => f !== 'SKILL.md')
  const trimmed = nameDraft.trim()

  const rename = async (): Promise<void> => {
    setRenaming(true)
    setRenameErr(null)
    const res = await window.api.skillRename(name, trimmed)
    setRenaming(false)
    if (isRefused(res)) return setRenameErr(res.message || t(`refused.${res.refused}`))
    if (!res.ok) return setRenameErr(res.message)
    const v = await runWrite(Promise.resolve(res), { success: t('skills.renamed') })
    if (v) onRenamed(v.name)
  }

  const saveDoc = async (body: string): Promise<boolean> => {
    const r = await runWrite(window.api.skillDocSave(name, { description: desc, body }), { success: t('editor.saved') })
    if (r === null) return false
    setDoc((d) => (d ? { ...d, description: desc, body } : d))
    onSaved()
    return true
  }

  if (err) return <ErrorAlert message={err} />
  return (
    <Stack gap="md">
      <Box>
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
            data-testid="skill-name"
          />
          <Button
            variant="default"
            disabled={!trimmed || trimmed === name}
            loading={renaming}
            onClick={() => void rename()}
            mb={renameErr ? 22 : 0}
            data-testid="skill-rename"
          >
            {t('skills.rename')}
          </Button>
        </Group>
      </Box>

      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="doc">SKILL.md</Tabs.Tab>
          {others.length > 0 && <Tabs.Tab value="files">{`${t('skills.files')} ${others.length}`}</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="doc">
          {docErr ? (
            <ErrorAlert message={docErr} />
          ) : !doc ? (
            <Loading />
          ) : (
            <Stack gap="md">
              <Box className="ac-card" p="md">
                <Group justify="space-between" mb="xs">
                  <Text size="sm" fw={600}>
                    {t('skills.description')}
                  </Text>
                  <Text size="sm" c="dimmed" data-testid="skill-desc-count">
                    {desc.length}
                  </Text>
                </Group>
                <Textarea
                  value={desc}
                  onChange={(e) => setDesc(e.currentTarget.value)}
                  autosize
                  minRows={2}
                  maxRows={12}
                  error={!desc.trim()}
                  data-testid="skill-desc"
                />
              </Box>
              <MarkdownEditor
                key={name}
                title={t('skills.body')}
                value={doc.body}
                extraDirty={desc !== doc.description}
                onRevert={() => setDesc(doc.description)}
                onSave={saveDoc}
              />
            </Stack>
          )}
        </Tabs.Panel>
        {others.length > 0 && (
          <Tabs.Panel value="files">
            <SkillFileEditor name={name} files={others} onSaved={onSaved} />
          </Tabs.Panel>
        )}
      </Tabs>
    </Stack>
  )
}

/** Extra file picker + raw editor */
function SkillFileEditor({ name, files, onSaved }: { name: string; files: string[]; onSaved: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [rel, setRel] = useState<string>(files[0])
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setText(null)
    setErr(null)
    window.api.skillFileRead(name, rel).then((r) => {
      if (!alive) return
      if (r.ok) setText(r.value)
      else setErr(r.message)
    })
    return () => {
      alive = false
    }
  }, [name, rel])

  return (
    <Stack gap="sm">
      <Select data={files} value={rel} onChange={(v) => v && setRel(v)} allowDeselect={false} w={320} leftSection={<FolderOpen size={14} />} />
      {err ? (
        <ErrorAlert message={err} />
      ) : text === null ? (
        <Loading />
      ) : (
        <MarkdownEditor
          key={`${name}/${rel}`}
          value={text}
          onSave={async (next) => {
            const r = await runWrite(window.api.skillFileSave(name, rel, next), { success: t('editor.saved') })
            if (r !== null) {
              setText(next)
              onSaved()
            }
            return r !== null
          }}
        />
      )}
    </Stack>
  )
}

export default Skills
