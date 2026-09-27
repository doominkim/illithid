import { useEffect, useState } from 'react'
import { Badge, Box, Button, Code, Stack, Tabs } from '@mantine/core'
import { Download, Globe, Plus, Terminal, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { MASK, type McpEditView, type McpServer, type McpServerView, type ToolId } from '../../../shared/api'
import { ConfirmModal } from '../components/ConfirmModal'
import { DetailSheet, MetaItem } from '../components/DetailSheet'
import { EmptyLibrary, EmptyState } from '../components/EmptyState'
import { ImportModal } from '../components/ImportModal'
import { CardGrid, ItemCard } from '../components/ItemCard'
import { ErrorAlert, Fields, Loading } from '../components/Layout'
import { Initial, ListCard, ListRow } from '../components/ListRow'
import { McpForm } from '../components/McpForm'
import { PageHeader, Toolbar } from '../components/PageHeader'
import { ReloadButton, useReload } from '../components/ReloadButton'
import { SearchInput } from '../components/SearchInput'
import { ToolPills } from '../components/ToolPills'
import { ToolToggleRow } from '../components/ToolToggleRow'
import { ViewToggle, type ViewMode } from '../components/ViewToggle'
import { includesCI } from '../lib/format'
import { runWrite } from '../lib/mutate'
import { useNav, useNavSelect } from '../lib/nav'
import { dotOfPills, pillFromCellState, TOOLS, type PillMap } from '../lib/tools'
import { useToggleBusy } from '../lib/toggleBusy'
import { useApi } from '../lib/useApi'

const NEW = '__new__'

function Mcp(): React.JSX.Element {
  const { t } = useTranslation()
  const { request } = useNav()
  const reload = useReload()
  const { data, error } = useApi('mcp', () => window.api.mcp())
  const [query, setQuery] = useState('')
  const [view, setView] = useState<ViewMode>('grid')
  const [selected, setSelected] = useState<string | null>(request.select ?? null)
  const pending = useToggleBusy()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  useNavSelect(setSelected)

  if (error) return <ErrorAlert message={error} />
  if (!data) return <Loading />

  const enabled = (name: string, tool: ToolId): boolean => data.toggles[name]?.[tool] !== false
  const pillsOf = (s: McpServerView): PillMap =>
    Object.fromEntries(
      TOOLS.map((tool) => {
        const st = s.tools[tool] ?? 'notApplicable'
        // Off but still present in the tool config: needs sync
        if (!enabled(s.name, tool)) return [tool, { on: false, pending: st === 'needsSync' }]
        return [tool, { ...pillFromCellState(st), on: true, na: false }]
      })
    ) as PillMap

  const toggle = async (s: McpServerView, tool: ToolId): Promise<void> => {
    await pending.run(s.name, tool, () => runWrite(window.api.toggle('mcp', s.name, tool, !enabled(s.name, tool)), { success: t('toggles.saved') }))
    reload()
  }
  const toggleAll = async (s: McpServerView, on: boolean): Promise<void> => {
    for (const tool of TOOLS) if (enabled(s.name, tool) !== on) await runWrite(window.api.toggle('mcp', s.name, tool, on))
    reload()
  }
  const save = async (name: string, def: McpServer): Promise<{ warnings: string[] } | null> => {
    const r = await runWrite(window.api.mcpSave(name, def), { success: t('mcp.saved') })
    if (r) {
      reload()
      if (selected === NEW) setSelected(name)
    }
    return r
  }
  const remove = async (): Promise<void> => {
    if (!current) return
    const r = await runWrite(window.api.mcpDelete(current.name), { success: t('mcp.deleted') })
    setConfirmDelete(false)
    if (r) {
      setSelected(null)
      reload()
    }
  }

  const q = query.trim().toLowerCase()
  const servers = data.servers.filter((s) => !q || includesCI(s.name, q) || includesCI(s.url, q) || includesCI(s.command, q))
  const current = data.servers.find((s) => s.name === selected)
  const endpoint = (s: McpServerView): string => s.url ?? [s.command, ...(s.args ?? [])].filter(Boolean).join(' ')
  const none = t('common.none')
  const transportTag = (s: McpServerView): React.ReactNode => (
    <Badge variant="default" size="xs" fw={500} c="dimmed" leftSection={s.transport === 'stdio' ? <Terminal size={10} /> : <Globe size={10} />}>
      {s.transport ?? '-'}
    </Badge>
  )

  return (
    <Stack gap={0} style={{ flex: 1 }}>
      <PageHeader
        title={t('nav.mcp')}
        count={data.servers.length}
        actions={
          <>
            <Button size="xs" leftSection={<Plus size={13} />} onClick={() => setSelected(NEW)} data-testid="mcp-new">
              {t('mcp.new')}
            </Button>
            <Button size="xs" variant="default" leftSection={<Download size={13} />} onClick={() => setImportOpen(true)} data-testid="mcp-import">
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
      <Toolbar left={<SearchInput value={query} onChange={setQuery} placeholder={t('mcp.search')} />} right={<ViewToggle value={view} onChange={setView} />} />
      {data.servers.length === 0 ? (
        <EmptyLibrary onImport={() => setImportOpen(true)} />
      ) : servers.length === 0 ? (
        <EmptyState title={t('common.noResults')} />
      ) : view === 'grid' ? (
        <CardGrid>
          {servers.map((s) => {
            const p = pillsOf(s)
            return (
              <ItemCard
                key={s.name}
                name={s.name}
                badges={transportTag(s)}
                description={endpoint(s) || none}
                dot={dotOfPills(p)}
                switchChecked={TOOLS.every((tool) => enabled(s.name, tool))}
                switchIndeterminate={TOOLS.some((tool) => enabled(s.name, tool))}
                onSwitch={(v) => void toggleAll(s, v)}
                footerRight={<ToolPills pills={p} size={18} onToggle={(tool) => void toggle(s, tool)} busy={pending.of(s.name)} />}
                selected={s.name === selected}
                onClick={() => setSelected(s.name)}
              />
            )
          })}
        </CardGrid>
      ) : (
        <ListCard>
          {servers.map((s) => (
            <ListRow
              key={s.name}
              avatar={<Initial text={s.name} />}
              title={s.name}
              tags={transportTag(s)}
              subtitle={endpoint(s) || none}
              right={<ToolPills pills={pillsOf(s)} size={18} onToggle={(tool) => void toggle(s, tool)} busy={pending.of(s.name)} />}
              active={s.name === selected}
              onClick={() => setSelected(s.name)}
            />
          ))}
        </ListCard>
      )}

      <ImportModal opened={importOpen} onClose={() => setImportOpen(false)} onImported={reload} kind="mcp" />
      {/* New server */}
      <DetailSheet opened={selected === NEW} onClose={() => setSelected(null)} title={t('mcp.new')}>
        <McpForm onSave={save} onCancel={() => setSelected(null)} />
      </DetailSheet>

      <DetailSheet
        opened={!!current}
        onClose={() => setSelected(null)}
        title={current?.name ?? ''}
        tags={current && transportTag(current)}
        meta={
          current && (
            <>
              <MetaItem icon={current.url ? <Globe size={14} /> : <Terminal size={14} />}>{endpoint(current) || none}</MetaItem>
              <Button size="compact-xs" variant="subtle" color="red" leftSection={<Trash2 size={12} />} onClick={() => setConfirmDelete(true)} data-testid="mcp-delete">
                {t('common.delete')}
              </Button>
            </>
          )
        }
      >
        {current && (
          <Stack gap="lg">
            <ToolToggleRow
              pills={pillsOf(current)}
              onToggle={(tool) => void toggle(current, tool)}
              busy={pending.of(current.name)}
              testId="mcp-detail-tools"
            />
            <Tabs defaultValue="fields" variant="pills" keepMounted={false}>
              <Tabs.List>
                <Tabs.Tab value="fields">{t('detail.fields')}</Tabs.Tab>
                <Tabs.Tab value="edit" data-testid="tab-edit">
                  {t('detail.edit')}
                </Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="fields" pt="md">
                <Box className="ac-card" p="lg">
                  <Fields
                    rows={[
                      [t('mcp.transport'), current.transport ?? '-'],
                      [t('mcp.url'), current.url ?? '-'],
                      [t('mcp.command'), current.command ?? '-'],
                      [t('mcp.args'), current.args?.length ? <Code>{current.args.join(' ')}</Code> : none],
                      [t('mcp.headers'), current.headerKeys.join(', ') || none],
                      [t('mcp.env'), current.envKeys.join(', ') || none],
                      [t('mcp.bearer'), current.bearerEnv ? '${' + current.bearerEnv + '}' : current.bearerToken ? MASK : none]
                    ]}
                  />
                </Box>
              </Tabs.Panel>
              <Tabs.Panel value="edit" pt="md">
                <McpEdit name={current.name} onSave={save} />
              </Tabs.Panel>
            </Tabs>
          </Stack>
        )}
      </DetailSheet>

      <ConfirmModal
        opened={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        danger
        title={t('mcp.deleteTitle')}
        confirmLabel={t('common.delete')}
        message={t('mcp.deleteBody', { name: current?.name ?? '' })}
      />
    </Stack>
  )
}

/** Edit form: filled with the masked definition from main */
function McpEdit({ name, onSave }: { name: string; onSave: (name: string, def: McpServer) => Promise<{ warnings: string[] } | null> }): React.JSX.Element {
  const [view, setView] = useState<McpEditView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    window.api.mcpRead(name).then((r) => {
      if (!alive) return
      if (r.ok) setView(r.value)
      else setErr(r.message)
    })
    return () => {
      alive = false
    }
  }, [name])
  if (err) return <ErrorAlert message={err} />
  if (!view) return <Loading />
  return <McpForm key={name} name={view.name} def={view.def} masked={view.masked} onSave={onSave} />
}

export default Mcp
