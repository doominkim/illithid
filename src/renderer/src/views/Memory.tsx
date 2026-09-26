import { useEffect, useState } from 'react'
import { Box, Button, Group, Modal, Stack, Tabs, Text, TextInput } from '@mantine/core'
import { Brain, FileText, FolderOpen, Layers, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ConfirmModal } from '../components/ConfirmModal'
import { DetailSheet, MetaItem } from '../components/DetailSheet'
import { EmptyState } from '../components/EmptyState'
import { CardGrid, ItemCard } from '../components/ItemCard'
import { ErrorAlert, Loading } from '../components/Layout'
import { Initial, ListCard, ListRow } from '../components/ListRow'
import { Markdown } from '../components/Markdown'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { PageHeader, Toolbar } from '../components/PageHeader'
import { ReloadButton, useReload } from '../components/ReloadButton'
import { SearchInput } from '../components/SearchInput'
import { ToolIcon } from '../components/ToolIcon'
import { ViewToggle, type ViewMode } from '../components/ViewToggle'
import { includesCI } from '../lib/format'
import { useConfig } from '../lib/config'
import { runWrite } from '../lib/mutate'
import { useNav, useNavSelect } from '../lib/nav'
import { useApi } from '../lib/useApi'
import type { IndexStat } from '../../../shared/api'
import { ClaudeMemory, CodexMemory, IndexBadges } from './ToolMemory'

function firstHeading(text: string): string {
  const m = /^#{1,3}\s+(.+)$/m.exec(text)
  if (m) return m[1].trim()
  return text.split('\n').find((l) => l.trim())?.trim() ?? ''
}

async function loadFiles(): Promise<string[]> {
  const r = await window.api.memoryFiles()
  if (!r.ok) throw new Error(r.message)
  return r.value
}

/** Shared memory (memory/*.md): file list + markdown editor. MEMORY.md is the index */
function SharedMemory({ shared, limits }: { shared: IndexStat | null; limits: IndexStat }): React.JSX.Element {
  const { t } = useTranslation()
  const { request } = useNav()
  const { config } = useConfig()
  const reload = useReload()
  const files = useApi('memoryFiles', loadFiles)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<ViewMode>('grid')
  const [selected, setSelected] = useState<string | null>(request.select ?? null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  useNavSelect(setSelected)

  if (files.error) return <ErrorAlert message={files.error} />
  if (!files.data) return <Loading />

  const q = query.trim().toLowerCase()
  const visible = files.data.filter((f) => !q || includesCI(f, q))
  const current = selected && files.data.includes(selected) ? selected : null
  const dir = `${config?.libraryRoot ?? ''}/memory`

  const create = async (): Promise<void> => {
    let rel = newName.trim().replace(/^\/+/, '')
    if (!rel.endsWith('.md')) rel += '.md'
    const title = rel.split('/').pop()!.replace(/\.md$/, '')
    const r = await runWrite(window.api.memorySave(rel, `# ${title}\n\n`), { success: t('memory.created') })
    if (r !== null) {
      setCreating(false)
      setNewName('')
      setSelected(rel)
      reload()
    }
  }
  const remove = async (): Promise<void> => {
    if (!current) return
    const r = await runWrite(window.api.memoryDelete(current), { success: t('memory.deleted') })
    setConfirmDelete(false)
    if (r) {
      setSelected(null)
      reload()
    }
  }

  return (
    <Stack gap={0} style={{ flex: 1 }}>
      <Toolbar
        left={
          <>
            <SearchInput value={query} onChange={setQuery} placeholder={t('memory.search')} />
            {shared && <IndexBadges stat={shared} limits={limits} />}
          </>
        }
        right={
          <>
            <Button size="xs" leftSection={<Plus size={13} />} onClick={() => setCreating(true)} data-testid="memory-new">
              {t('memory.new')}
            </Button>
            <ViewToggle value={view} onChange={setView} />
          </>
        }
      />
      {visible.length === 0 ? (
        <EmptyState title={t('common.noResults')} icon={<Brain size={18} />} />
      ) : view === 'grid' ? (
        <CardGrid>
          {visible.map((f) => (
            <ItemCard
              key={f}
              name={f}
              description={f.split('/').slice(0, -1).join('/')}
              dot="on"
              selected={f === selected}
              onClick={() => setSelected(f)}
            />
          ))}
        </CardGrid>
      ) : (
        <ListCard>
          {visible.map((f) => (
            <ListRow key={f} avatar={<Initial text={f.split('/').pop() ?? f} />} title={f} active={f === selected} onClick={() => setSelected(f)} />
          ))}
        </ListCard>
      )}

      <DetailSheet
        opened={!!current}
        onClose={() => setSelected(null)}
        title={current ?? ''}
        meta={
          current && (
            <>
              <MetaItem icon={<FolderOpen size={14} />}>{dir}</MetaItem>
              <MetaItem icon={<FileText size={14} />}>{current}</MetaItem>
              {current !== 'MEMORY.md' && (
                <Button size="compact-xs" variant="subtle" color="red" leftSection={<Trash2 size={12} />} onClick={() => setConfirmDelete(true)} data-testid="memory-delete">
                  {t('common.delete')}
                </Button>
              )}
            </>
          )
        }
      >
        {current && <MemoryFile key={current} rel={current} onSaved={reload} />}
      </DetailSheet>

      <Modal opened={creating} onClose={() => setCreating(false)} title={t('memory.new')} centered radius="lg">
        <Stack gap="md">
          <TextInput label={t('common.name')} description={t('memory.nameHint')} placeholder="feedback/my-note.md" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} data-autofocus data-testid="memory-new-name" />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={!newName.trim()} onClick={() => void create()} data-testid="memory-new-ok">
              {t('common.create')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <ConfirmModal opened={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={remove} danger title={t('memory.deleteTitle')} confirmLabel={t('common.delete')} message={t('memory.deleteBody', { name: current ?? '' })} />
    </Stack>
  )
}

function MemoryFile({ rel, onSaved }: { rel: string; onSaved: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    window.api.memoryRead(rel).then((r) => {
      if (!alive) return
      if (r.ok) setText(r.value)
      else setErr(r.message)
    })
    return () => {
      alive = false
    }
  }, [rel])
  if (err) return <ErrorAlert message={err} />
  if (text === null) return <Loading />
  return (
    <Stack gap="lg">
      <Text size="md" c="dimmed">
        {firstHeading(text)}
      </Text>
      <Tabs defaultValue="source" variant="pills" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="source">{t('detail.source')}</Tabs.Tab>
          <Tabs.Tab value="edit" data-testid="tab-edit">
            {t('detail.edit')}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="source" pt="md">
          <Box className="ac-card" p="lg">
            <Markdown text={text} />
          </Box>
        </Tabs.Panel>
        <Tabs.Panel value="edit" pt="md">
          <MarkdownEditor
            value={text}
            onSave={async (next) => {
              const r = await runWrite(window.api.memorySave(rel, next), { success: t('editor.saved') })
              if (r !== null) {
                setText(next)
                onSaved()
              }
              return r !== null
            }}
          />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  )
}

/** Memory: Shared · Claude · Codex tabs */
function Memory(): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<string | null>('shared')
  const tm = useApi('toolMemory', () => window.api.toolMemoryScan())
  const limits = tm.data?.claude.limits ?? { lines: 200, bytes: 25 * 1024 }
  return (
    <Stack gap={0} h="100%" style={{ minHeight: 0 }}>
      <PageHeader title={t('nav.memory')} actions={<ReloadButton />} />
      <Tabs value={tab} onChange={setTab} mb="md" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="shared" data-testid="memory-tab-shared" leftSection={<Layers size={14} />}>
            {t('memory.tabShared')}
          </Tabs.Tab>
          <Tabs.Tab value="claude" data-testid="memory-tab-claude" leftSection={<ToolIcon tool="claude" size={14} />}>
            {t('memory.tabClaude')}
          </Tabs.Tab>
          <Tabs.Tab value="codex" data-testid="memory-tab-codex" leftSection={<ToolIcon tool="codex" size={14} />}>
            {t('memory.tabCodex')}
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {tab === 'shared' && <SharedMemory shared={tm.data?.claude.shared ?? null} limits={limits} />}
      {tab !== 'shared' && (tm.error ? <ErrorAlert message={tm.error} /> : !tm.data ? <Loading /> : tab === 'claude' ? <ClaudeMemory view={tm.data} /> : <CodexMemory entries={tm.data.codex} />)}
    </Stack>
  )
}

export default Memory
