import { useMemo, useState } from 'react'
import { Badge, Box, Button, Group, Stack, Tabs, TextInput } from '@mantine/core'
import { Download, FileText, FolderOpen, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useToolsInUse } from '../lib/config'
import type { ToolId } from '../../../shared/api'
import { ConfirmModal } from '../components/ConfirmModal'
import { FormFooter } from '../components/FormFooter'
import { DetailSheet, MetaItem } from '../components/DetailSheet'
import { EmptyLibrary, EmptyState } from '../components/EmptyState'
import { ImportModal } from '../components/ImportModal'
import { CardGrid, ItemCard } from '../components/ItemCard'
import { ErrorAlert, Loading } from '../components/Layout'
import { Initial, ListCard, ListRow } from '../components/ListRow'
import { Markdown } from '../components/Markdown'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { PageHeader, ShownCount, Toolbar } from '../components/PageHeader'
import { ReloadButton } from '../components/ReloadButton'
import { useReload } from '../lib/reload'
import { SearchInput } from '../components/SearchInput'
import { ToolPills } from '../components/ToolPills'
import { ToolToggleRow } from '../components/ToolToggleRow'
import { ViewToggle } from '../components/ViewToggle'
import { includesCI } from '../lib/format'
import { isRefused, runWrite } from '../lib/mutate'
import { useNav, useNavSelect } from '../lib/nav'
import { useSyncFailures } from '../lib/sync'
import { pillFromCellState, TOOLS, type PillMap } from '../lib/tools'
import { lastSyncFailedText } from '../lib/problemReason'
import { useToggleBusy } from '../lib/toggleBusy'
import { useApi } from '../lib/useApi'
import { useViewMode } from '../lib/viewMode'

/** First heading (# …) or first non-empty line */
function firstHeading(text: string): string {
  const m = /^#{1,3}\s+(.+)$/m.exec(text)
  if (m) return m[1].trim()
  return (
    text
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? ''
  )
}

/** Card description: first heading. Empty if it equals the file name (ignoring case and .md) */
function cardTitle(name: string, text: string): string {
  const h = firstHeading(text)
  const base = (v: string): string => v.trim().replace(/\.md$/i, '').toLowerCase()
  return base(h) === base(name) ? '' : h
}

function Rules(): React.JSX.Element {
  const { t } = useTranslation()
  // Card switch and all-on/off cover the tools in use only (others are off by design and never written)
  const inUse = useToolsInUse()
  const cardTools = TOOLS.filter((tool) => inUse.includes(tool))
  const { request } = useNav()
  const reload = useReload()
  const rules = useApi('rules', () => window.api.rules())
  const status = useApi('status', () => window.api.status())
  const failedIn = useSyncFailures()
  const [query, setQuery] = useState('')
  const [view, setView] = useViewMode('rules')
  const [selected, setSelected] = useState<string | null>(request.select ?? null)
  const pending = useToggleBusy()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [renameErr, setRenameErr] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  /** Keep the detail open right after a rename until the list is reloaded */
  const [renamed, setRenamed] = useState<{ from: string; to: string } | null>(null)
  useNavSelect(setSelected)
  // Reset the rename field when another rule is opened (state from the previous render)
  const [draftFor, setDraftFor] = useState<string | null | undefined>(undefined)
  if (selected !== draftFor) {
    setDraftFor(selected)
    setNameDraft(selected ?? '')
    setRenameErr(null)
  }

  /** Per-tool sync state (status cells) */
  const injection = useMemo<PillMap>(() => {
    const cells = status.data?.cells.filter((c) => c.resource === 'rules') ?? []
    return Object.fromEntries(
      cells.map((c) => [
        c.tool,
        {
          ...pillFromCellState(c.state),
          ...(c.state === 'error' && c.detail ? { hint: c.detail } : {})
        }
      ])
    ) as PillMap
  }, [status.data])

  const error = rules.error ?? status.error ?? rules.data?.error
  if (error) return <ErrorAlert message={error} />
  if (!rules.data || !status.data) return <Loading />
  const data = rules.data

  const enabled = (name: string, tool: ToolId): boolean => data.toggles[name]?.[tool] !== false
  /** Pills for one rule: on = manifest on, error/needs sync = tool status */
  const pillsOf = (name: string): PillMap =>
    Object.fromEntries(
      TOOLS.map((tool) => {
        const on = enabled(name, tool)
        const inj = injection[tool]
        const failure =
          on && (tool === 'claude' || tool === 'copilot' || tool === 'grok')
            ? failedIn('rule', name, tool)
            : null
        if (failure)
          return [tool, { on: true, problem: true, hint: lastSyncFailedText(t, failure) }]
        return [tool, on ? { ...inj, on: true } : { on: false }]
      })
    ) as PillMap

  const toggle = async (name: string, tool: ToolId, on: boolean): Promise<void> => {
    await pending.run(name, tool, () =>
      runWrite(window.api.toggle('rules', name, tool, on), { success: t('toggles.saved') })
    )
    reload()
  }
  const toggleAll = async (name: string, on: boolean): Promise<void> => {
    for (const tool of cardTools)
      if (enabled(name, tool) !== on)
        await runWrite(window.api.toggle('rules', name, tool, on), { invalidate: true })
    reload()
  }
  const save = async (name: string, text: string): Promise<boolean> => {
    const r = await runWrite(window.api.ruleSave(name, text), { success: t('editor.saved') })
    reload()
    return r !== null
  }
  const create = async (): Promise<void> => {
    const name = newName.trim().endsWith('.md') ? newName.trim() : `${newName.trim()}.md`
    const r = await runWrite(window.api.ruleCreate(name, `# ${name.replace(/\.md$/, '')}\n\n`), {
      success: t('rules.created')
    })
    if (r !== null) {
      setCreating(false)
      setNewName('')
      setSelected(name)
      reload()
    }
  }
  const remove = async (): Promise<void> => {
    if (!current) return
    const r = await runWrite(window.api.ruleDelete(current.name), { success: t('rules.deleted') })
    setConfirmDelete(false)
    if (r) {
      setSelected(null)
      reload()
    }
  }

  const q = query.trim().toLowerCase()
  const files = data.files.filter((f) => !q || includesCI(f.name, q) || includesCI(f.text, q))
  const prev =
    renamed && renamed.to === selected ? data.files.find((f) => f.name === renamed.from) : undefined
  const current =
    data.files.find((f) => f.name === selected) ?? (prev && { ...prev, name: renamed!.to })
  const nextName =
    nameDraft.trim() && !nameDraft.trim().endsWith('.md')
      ? `${nameDraft.trim()}.md`
      : nameDraft.trim()
  const rename = async (): Promise<void> => {
    if (!current) return
    const from = current.name
    setRenaming(true)
    setRenameErr(null)
    const res = await window.api.ruleRename(from, nextName)
    setRenaming(false)
    if (isRefused(res)) return setRenameErr(res.message || t(`refused.${res.refused}`))
    if (!res.ok) return setRenameErr(res.message)
    const v = await runWrite(Promise.resolve(res), { success: t('rules.renamed') })
    if (v) {
      setRenamed({ from, to: v.name })
      setSelected(v.name)
      reload()
    }
  }

  return (
    <Stack gap={0} style={{ flex: 1 }}>
      <PageHeader
        title={t('nav.rules')}
        count={data.files.length}
        actions={
          <>
            <Button
              size="xs"
              leftSection={<Plus size={13} />}
              onClick={() => {
                setSelected(null)
                setCreating(true)
              }}
              data-testid="rule-new"
            >
              {t('rules.new')}
            </Button>
            <Button
              size="xs"
              variant="default"
              leftSection={<Download size={13} />}
              onClick={() => setImportOpen(true)}
              data-testid="rule-import"
            >
              {t('common.import')}
            </Button>
            <ReloadButton />
          </>
        }
      />
      <Toolbar
        left={<SearchInput value={query} onChange={setQuery} placeholder={t('rules.search')} />}
        right={
          <>
            <ShownCount shown={files.length} total={data.files.length} />
            <ViewToggle value={view} onChange={setView} />
          </>
        }
      />
      {data.files.length === 0 ? (
        <EmptyLibrary onImport={() => setImportOpen(true)} />
      ) : files.length === 0 ? (
        <EmptyState title={t('common.noResults')} />
      ) : view === 'grid' ? (
        <CardGrid>
          {files.map((f) => (
            <ItemCard
              key={f.name}
              name={f.name}
              description={cardTitle(f.name, f.text)}
              switchChecked={
                cardTools.length > 0 && cardTools.every((tool) => enabled(f.name, tool))
              }
              switchIndeterminate={cardTools.some((tool) => enabled(f.name, tool))}
              onSwitch={(v) => void toggleAll(f.name, v)}
              footerLeft={
                <Badge variant="default" size="xs" fw={500} c="dimmed">
                  {t('rules.lines', { n: f.text.split('\n').length })}
                </Badge>
              }
              footerRight={
                <ToolPills
                  pills={pillsOf(f.name)}
                  size={18}
                  onToggle={(tool) => void toggle(f.name, tool, !enabled(f.name, tool))}
                  busy={pending.of(f.name)}
                />
              }
              selected={f.name === selected}
              onClick={() => setSelected(f.name)}
            />
          ))}
        </CardGrid>
      ) : (
        <ListCard>
          {files.map((f) => (
            <ListRow
              key={f.name}
              avatar={<Initial text={f.name.replace(/^\d+-/, '')} />}
              title={f.name}
              subtitle={cardTitle(f.name, f.text)}
              right={
                <ToolPills
                  pills={pillsOf(f.name)}
                  size={18}
                  onToggle={(tool) => void toggle(f.name, tool, !enabled(f.name, tool))}
                  busy={pending.of(f.name)}
                />
              }
              active={f.name === selected}
              onClick={() => setSelected(f.name)}
            />
          ))}
        </ListCard>
      )}

      <DetailSheet
        opened={!!current}
        onClose={() => setSelected(null)}
        title={current?.name ?? ''}
        description={current ? firstHeading(current.text) : undefined}
        meta={
          current && (
            <>
              <MetaItem icon={<FolderOpen size={14} />}>{data.dir}</MetaItem>
              <MetaItem icon={<FileText size={14} />}>{current.name}</MetaItem>
            </>
          )
        }
        copyPath={current ? `${data.dir}/${current.name}` : undefined}
        onDelete={() => setConfirmDelete(true)}
        deleteTestId="rule-delete"
      >
        {current && (
          <Stack gap="lg">
            <ToolToggleRow
              pills={pillsOf(current.name)}
              onToggle={(tool) => void toggle(current.name, tool, !enabled(current.name, tool))}
              busy={pending.of(current.name)}
              testId="rule-detail-tools"
            />
            <Tabs key={current.name} defaultValue="source" keepMounted={false}>
              <Tabs.List>
                <Tabs.Tab value="source">{t('detail.source')}</Tabs.Tab>
                <Tabs.Tab value="edit" data-testid="tab-edit">
                  {t('detail.edit')}
                </Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="source" pt="md">
                <Box className="ac-card" p="lg">
                  <Markdown text={current.text} />
                </Box>
              </Tabs.Panel>
              <Tabs.Panel value="edit" pt="md">
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
                      data-testid="rule-name"
                    />
                    <Button
                      variant="default"
                      disabled={!nextName || nextName === current.name}
                      loading={renaming}
                      onClick={() => void rename()}
                      mb={renameErr ? 22 : 0}
                      data-testid="rule-rename"
                    >
                      {t('rules.rename')}
                    </Button>
                  </Group>
                  <MarkdownEditor
                    value={current.text}
                    onSave={(text) => save(current.name, text)}
                  />
                </Stack>
              </Tabs.Panel>
            </Tabs>
          </Stack>
        )}
      </DetailSheet>

      <ImportModal
        opened={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={reload}
        kind="rule"
      />
      <DetailSheet opened={creating} onClose={() => setCreating(false)} title={t('rules.new')}>
        <Stack gap="md" maw={640}>
          <TextInput
            label={t('common.name')}
            description={t('rules.nameHint')}
            placeholder="95-my-rule.md"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            data-autofocus
            data-testid="rule-new-name"
          />
          <FormFooter>
            <Button size="xs" variant="default" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              size="xs"
              disabled={!newName.trim()}
              onClick={() => void create()}
              data-testid="rule-new-ok"
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
        title={t('rules.deleteTitle')}
        confirmLabel={t('common.delete')}
        message={t('rules.deleteBody', { name: current?.name ?? '' })}
      />
    </Stack>
  )
}

export default Rules
