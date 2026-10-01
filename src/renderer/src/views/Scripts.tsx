import { useState } from 'react'
import { Badge, Box, Button, Group, Stack, Text, TextInput } from '@mantine/core'
import { FileCode, FolderOpen, Plus, Webhook } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LIBRARY_SCRIPT_RE, SCRIPT_TEMPLATE } from '../../../engine/scriptNames'
import { ConfirmModal } from '../components/ConfirmModal'
import { DetailSheet, MetaItem } from '../components/DetailSheet'
import { EmptyState } from '../components/EmptyState'
import { ErrorAlert, Loading } from '../components/Layout'
import { ListCard, ListRow } from '../components/ListRow'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { PageHeader, Toolbar } from '../components/PageHeader'
import { ReloadButton } from '../components/ReloadButton'
import { SearchInput } from '../components/SearchInput'
import { includesCI } from '../lib/format'
import { runWrite } from '../lib/mutate'
import { useNav, useNavSelect } from '../lib/nav'
import { useReload } from '../lib/reload'
import { useApi } from '../lib/useApi'

const NEW = '__new__'

function Scripts(): React.JSX.Element {
  const { t } = useTranslation()
  const reload = useReload()
  const { request, navigate } = useNav()
  const { data, error } = useApi('scripts', () => window.api.scripts())
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(request.select ?? null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  useNavSelect(setSelected)

  if (error) return <ErrorAlert message={error} />
  if (!data) return <Loading />

  const current = data.scripts.find((s) => s.name === selected)
  const q = query.trim().toLowerCase()
  const list = data.scripts.filter(
    (s) => !q || includesCI(s.name, q) || includesCI(s.description, q)
  )
  const save = async (text: string): Promise<boolean> => {
    if (!current) return false
    const r = await runWrite(window.api.scriptSave(current.name, text), {
      success: t('scripts.saved')
    })
    if (r) reload()
    return r !== null
  }
  const remove = async (): Promise<void> => {
    if (!current) return
    const r = await runWrite(window.api.scriptDelete(current.name), {
      success: t('scripts.deleted')
    })
    setConfirmDelete(false)
    if (r) {
      setSelected(null)
      reload()
    }
  }

  return (
    <Stack gap={0} style={{ flex: 1 }}>
      <PageHeader
        title={t('nav.scripts')}
        count={data.scripts.length}
        actions={
          <>
            <Button
              size="xs"
              leftSection={<Plus size={13} />}
              onClick={() => setSelected(NEW)}
              data-testid="script-new"
            >
              {t('scripts.new')}
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
        left={<SearchInput value={query} onChange={setQuery} placeholder={t('scripts.search')} />}
      />
      {data.scripts.length === 0 ? (
        <EmptyState title={t('scripts.empty')} hint={t('scripts.emptyHint')} />
      ) : list.length === 0 ? (
        <EmptyState title={t('common.noResults')} />
      ) : (
        <ListCard>
          {list.map((s) => (
            <ListRow
              key={s.name}
              avatar={<FileCode size={18} />}
              title={s.name}
              subtitle={s.description || undefined}
              right={
                <Badge variant="default" size="sm" fw={500} c="dimmed">
                  {t('scripts.usedBy', { count: s.users.length })}
                </Badge>
              }
              active={s.name === selected}
              onClick={() => setSelected(s.name)}
            />
          ))}
        </ListCard>
      )}

      <DetailSheet
        opened={selected === NEW}
        onClose={() => setSelected(null)}
        title={t('scripts.new')}
      >
        {selected === NEW && (
          <NewScriptForm
            taken={data.scripts.map((s) => s.name)}
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
        meta={
          current && (
            <MetaItem icon={<FolderOpen size={14} />}>{`${data.dir}/${current.name}.sh`}</MetaItem>
          )
        }
        copyPath={current ? `${data.dir}/${current.name}.sh` : undefined}
        onDelete={() => setConfirmDelete(true)}
        deleteTestId="script-delete"
      >
        {current && (
          <Stack gap="lg">
            <Stack gap={8} data-testid="script-users">
              <Text size="sm" fw={600} c="dimmed">
                {t('scripts.users')}
              </Text>
              {current.users.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('scripts.noUsers')}
                </Text>
              ) : (
                <ListCard>
                  {current.users.map((h) => (
                    <ListRow
                      key={h}
                      avatar={<Webhook size={18} />}
                      title={h}
                      onClick={() => navigate('hooks', { select: h })}
                    />
                  ))}
                </ListCard>
              )}
            </Stack>
            <Text size="xs" c="dimmed">
              {t('scripts.argHint')}
            </Text>
            <MarkdownEditor key={current.name} value={current.content} minRows={16} onSave={save} />
          </Stack>
        )}
      </DetailSheet>

      <ConfirmModal
        opened={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        danger
        title={t('scripts.deleteTitle')}
        confirmLabel={t('common.delete')}
        message={
          current?.users.length
            ? t('scripts.deleteUsed', { name: current.name, count: current.users.length })
            : t('scripts.deleteBody', { name: current?.name ?? '' })
        }
      />
    </Stack>
  )
}

function NewScriptForm({
  taken,
  onCreated,
  onCancel
}: {
  taken: string[]
  onCreated: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const nameOk = LIBRARY_SCRIPT_RE.test(name) && !taken.includes(name)
  const create = async (): Promise<void> => {
    setBusy(true)
    const content = SCRIPT_TEMPLATE.replace(
      '# description: \n',
      `# description: ${description.trim()}\n`
    )
    const r = await runWrite(window.api.scriptCreate(name, content), {
      success: t('scripts.created')
    })
    setBusy(false)
    if (r) onCreated(name)
  }
  return (
    <Stack gap="md" maw={560}>
      <TextInput
        label={t('common.name')}
        description={t('scripts.nameHint')}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        error={
          name && !LIBRARY_SCRIPT_RE.test(name)
            ? t('mcp.nameInvalid')
            : taken.includes(name)
              ? t('scripts.nameTaken')
              : undefined
        }
        data-testid="script-new-name"
      />
      <TextInput
        label={t('scripts.description')}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        data-testid="script-new-description"
      />
      <Group justify="flex-end" gap="xs">
        <Button size="xs" variant="default" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          size="xs"
          loading={busy}
          disabled={!nameOk}
          onClick={() => void create()}
          data-testid="script-create"
        >
          {t('common.create')}
        </Button>
      </Group>
    </Stack>
  )
}

export default Scripts
