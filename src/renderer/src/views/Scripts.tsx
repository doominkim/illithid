import { useState } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput
} from '@mantine/core'
import {
  Copy,
  FileCode,
  Folder,
  FolderInput,
  FolderOpen,
  FolderTree,
  Plus,
  Sparkles,
  Trash2,
  Webhook
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LIBRARY_SCRIPT_RE, SCRIPT_TEMPLATE } from '../../../engine/scriptNames'
import { ConfirmModal } from '../components/ConfirmModal'
import { DetailSheet, MetaItem } from '../components/DetailSheet'
import { FileEditor } from '../components/FileEditor'
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
import { TOOL_NAME } from '../lib/tools'
import type { ScriptBuiltinView, ScriptView } from '../../../shared/api'

const NEW = '__new__'
/** Selection key prefix of Illithid's recipe scripts */
const BUILTIN = 'builtin:'

function Scripts(): React.JSX.Element {
  const { t } = useTranslation()
  const reload = useReload()
  const { request, navigate } = useNav()
  const { data, error } = useApi('scripts', () => window.api.scripts())
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(request.select ?? null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [importFrom, setImportFrom] = useState<string | null>(null)
  useNavSelect(setSelected)

  if (error) return <ErrorAlert message={error} />
  if (!data) return <Loading />

  const current = data.scripts.find((s) => s.name === selected)
  const q = query.trim().toLowerCase()
  const list = data.scripts.filter(
    (s) => !q || includesCI(s.name, q) || includesCI(s.description, q)
  )
  const builtins = (data.builtins ?? []).filter(
    (b) =>
      !q ||
      includesCI(t(`hooks.actions.${b.action}.title`), q) ||
      includesCI(t(`hooks.actions.${b.action}.desc`), q)
  )
  const builtin = selected?.startsWith(BUILTIN)
    ? data.builtins?.find((b) => `${BUILTIN}${b.action}` === selected)
    : undefined
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
              variant="default"
              leftSection={<FolderInput size={13} />}
              onClick={() =>
                void window.api.pickDirectory().then((dir) => dir && setImportFrom(dir))
              }
              data-testid="script-import"
            >
              {t('scripts.importFolder')}
            </Button>
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
      <Stack gap="lg">
        <Stack gap={8}>
          <Text size="sm" fw={600} c="dimmed">
            {t('scripts.mine')}
          </Text>
          {data.scripts.length === 0 ? (
            <Text size="sm" c="dimmed" data-testid="scripts-empty">
              {t('scripts.emptyHint')}
            </Text>
          ) : list.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('common.noResults')}
            </Text>
          ) : (
            <ListCard>
              {list.map((s) => (
                <ListRow
                  key={s.name}
                  avatar={s.kind === 'folder' ? <Folder size={18} /> : <FileCode size={18} />}
                  title={s.kind === 'folder' ? `${s.name}/` : s.name}
                  subtitle={s.description || undefined}
                  right={
                    <Group gap={6} wrap="nowrap">
                      {s.problem && (
                        <Badge color="yellow" variant="light" size="sm" fw={500}>
                          {t('scripts.problemShort')}
                        </Badge>
                      )}
                      <Badge variant="default" size="sm" fw={500} c="dimmed">
                        {t('scripts.usedBy', { count: s.users.length })}
                      </Badge>
                    </Group>
                  }
                  active={s.name === selected}
                  onClick={() => setSelected(s.name)}
                />
              ))}
            </ListCard>
          )}
        </Stack>
        {builtins.length > 0 && (
          <Stack gap={8} data-testid="script-builtins">
            <Text size="sm" fw={600} c="dimmed">
              {t('scripts.builtins')}
            </Text>
            <Text size="xs" c="dimmed">
              {t('scripts.builtinsHint')}
            </Text>
            <ListCard>
              {builtins.map((b) => (
                <ListRow
                  key={b.action}
                  avatar={<Sparkles size={18} />}
                  title={t(`hooks.actions.${b.action}.title`)}
                  subtitle={t(`hooks.actions.${b.action}.desc`)}
                  right={
                    <Badge variant="default" size="sm" fw={500} c="dimmed">
                      {t('scripts.usedBy', { count: b.users.length })}
                    </Badge>
                  }
                  active={selected === `${BUILTIN}${b.action}`}
                  onClick={() => setSelected(`${BUILTIN}${b.action}`)}
                />
              ))}
            </ListCard>
          </Stack>
        )}
      </Stack>

      <DetailSheet
        opened={!!builtin}
        onClose={() => setSelected(null)}
        title={builtin ? t(`hooks.actions.${builtin.action}.title`) : ''}
        description={builtin ? t(`hooks.actions.${builtin.action}.desc`) : undefined}
        tags={
          <Badge variant="default" size="xs" fw={500} c="dimmed">
            {t('scripts.readOnly')}
          </Badge>
        }
      >
        {builtin && (
          <BuiltinDetail
            key={builtin.action}
            builtin={builtin}
            taken={data.scripts.map((x) => x.name)}
            onCopied={(name) => {
              reload()
              setSelected(name)
            }}
          />
        )}
      </DetailSheet>

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
            <MetaItem icon={<FolderOpen size={14} />}>{scriptPathOf(data.dir, current)}</MetaItem>
          )
        }
        copyPath={current ? scriptPathOf(data.dir, current) : undefined}
        onDelete={() => setConfirmDelete(true)}
        deleteTestId="script-delete"
      >
        {current && (
          <Stack gap="lg">
            <Group gap="xs">
              <Button
                size="xs"
                variant="default"
                leftSection={<FolderOpen size={13} />}
                onClick={() => void runWrite(window.api.scriptReveal(current.name))}
                data-testid="script-reveal"
              >
                {t('scripts.reveal')}
              </Button>
            </Group>
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
            {current.kind === 'folder' ? (
              <FolderScript key={current.name} script={current} onChanged={reload} />
            ) : (
              <FileScript key={current.name} script={current} onSave={save} onChanged={reload} />
            )}
          </Stack>
        )}
      </DetailSheet>

      <ImportFolderModal
        from={importFrom}
        taken={data.scripts.map((s) => s.name)}
        onClose={() => setImportFrom(null)}
        onImported={(name) => {
          setImportFrom(null)
          reload()
          setSelected(name)
        }}
      />

      <ConfirmModal
        opened={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        danger
        title={t('scripts.deleteTitle')}
        confirmLabel={t('common.delete')}
        message={
          current?.users.length
            ? current.kind === 'folder'
              ? t('scripts.deleteFolderUsed', { name: current.name, count: current.users.length })
              : t('scripts.deleteUsed', { name: current.name, count: current.users.length })
            : t('scripts.deleteBody', { name: current?.name ?? '' })
        }
      />
    </Stack>
  )
}

/** Display path of a script: its .sh file or its folder */
const scriptPathOf = (dir: string, s: ScriptView): string =>
  s.kind === 'folder' ? `${dir}/${s.name}/` : `${dir}/${s.name}.sh`

/** A file script: its editor, and turning it into a folder script */
function FileScript({
  script,
  onSave,
  onChanged
}: {
  script: ScriptView
  onSave: (text: string) => Promise<boolean>
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [confirm, setConfirm] = useState(false)
  const toFolder = async (): Promise<void> => {
    const r = await runWrite(window.api.scriptToFolder(script.name), {
      success: t('scripts.toFolderDone')
    })
    setConfirm(false)
    if (r) onChanged()
  }
  return (
    <Stack gap="sm">
      <MarkdownEditor value={script.content} minRows={16} onSave={onSave} />
      <Group gap="xs">
        <Button
          size="xs"
          variant="default"
          leftSection={<FolderTree size={13} />}
          onClick={() => setConfirm(true)}
          data-testid="script-to-folder"
        >
          {t('scripts.toFolder')}
        </Button>
        <Text size="xs" c="dimmed">
          {t('scripts.toFolderHint')}
        </Text>
      </Group>
      <ConfirmModal
        opened={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={toFolder}
        title={t('scripts.toFolder')}
        confirmLabel={t('scripts.toFolder')}
        message={t('scripts.toFolderBody', { name: script.name })}
      />
    </Stack>
  )
}

/** A folder script: why the tools don't get it, what runs, its files (edit, add, delete) */
function FolderScript({
  script,
  onChanged
}: {
  script: ScriptView
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const files = script.files ?? []
  const editable = files.filter((f) => f !== 'SCRIPT.md')
  const [rel, setRel] = useState<string>(script.entry ?? files[0])
  const [description, setDescription] = useState(script.description)
  const [entry, setEntry] = useState(script.entry ?? '')
  const [newFile, setNewFile] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const name = script.name
  const shown = files.includes(rel) ? rel : (script.entry ?? files[0])
  const infoDirty = description !== script.description || entry !== script.entry
  const saveInfo = async (): Promise<void> => {
    const r = await runWrite(window.api.scriptInfoSave(name, { description, entry }), {
      success: t('scripts.saved')
    })
    if (r) onChanged()
  }
  const add = async (): Promise<void> => {
    const path = newFile.trim()
    const r = await runWrite(window.api.scriptFileSave(name, path, ''), {
      success: t('scripts.fileAdded', { file: path })
    })
    if (r === null) return
    setNewFile('')
    setRel(path)
    onChanged()
  }
  const removeFile = async (): Promise<void> => {
    const r = await runWrite(window.api.scriptFileDelete(name, shown), {
      success: t('scripts.fileDeleted', { file: shown })
    })
    setConfirmDelete(false)
    if (r === null) return
    setRel(script.entry ?? files[0])
    onChanged()
  }
  const removable = shown !== 'SCRIPT.md' && shown !== script.entry
  return (
    <Stack gap="md" data-testid="script-files">
      {script.problem && (
        <Alert color="yellow" variant="light" title={t('scripts.problemTitle')}>
          {t(`scripts.problem.${script.problem}`)}
        </Alert>
      )}
      <Group gap="sm" align="flex-end">
        <TextInput
          label={t('scripts.description')}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          style={{ flex: 1 }}
        />
        <Select
          label={t('scripts.entry')}
          description={t('scripts.entryHint')}
          data={editable}
          value={entry}
          onChange={(v) => v && setEntry(v)}
          allowDeselect={false}
          w={220}
          data-testid="script-entry"
        />
        <Button size="sm" disabled={!infoDirty} onClick={() => void saveInfo()}>
          {t('common.save')}
        </Button>
      </Group>
      <FileEditor
        id={name}
        files={files}
        value={shown}
        onChange={setRel}
        read={(f) => window.api.scriptFileRead(name, f)}
        save={async (f, text) => {
          const r = await runWrite(window.api.scriptFileSave(name, f, text), {
            success: t('editor.saved')
          })
          if (r !== null) onChanged()
          return r !== null
        }}
        testId="script-file-select"
      />
      <Group gap="xs" align="flex-end">
        <TextInput
          label={t('scripts.fileNew')}
          placeholder="lib/util.sh"
          value={newFile}
          onChange={(e) => setNewFile(e.currentTarget.value)}
          w={260}
          data-testid="script-file-new"
        />
        <Button
          size="sm"
          variant="default"
          leftSection={<Plus size={13} />}
          disabled={!newFile.trim() || files.includes(newFile.trim())}
          onClick={() => void add()}
          data-testid="script-file-add"
        >
          {t('scripts.fileAdd')}
        </Button>
        {removable && (
          <Button
            size="sm"
            variant="subtle"
            color="red"
            leftSection={<Trash2 size={13} />}
            onClick={() => setConfirmDelete(true)}
            data-testid="script-file-delete"
          >
            {t('scripts.fileDelete', { file: shown })}
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {t('scripts.depsHint')}
      </Text>
      <ConfirmModal
        opened={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={removeFile}
        danger
        title={t('scripts.fileDelete', { file: shown })}
        confirmLabel={t('common.delete')}
        message={t('scripts.fileDeleteBody', { file: shown })}
      />
    </Stack>
  )
}

/** A picked folder comes in as a folder script: its name and the file the hooks run */
function ImportFolderModal({
  from,
  taken,
  onClose,
  onImported
}: {
  from: string | null
  taken: string[]
  onClose: () => void
  onImported: (name: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const base = (from ?? '').split('/').filter(Boolean).pop() ?? ''
  const suggested = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
  const [typed, setTyped] = useState<string | null>(null)
  const [entry, setEntry] = useState('')
  const [busy, setBusy] = useState(false)
  const name = typed ?? suggested
  const nameOk = LIBRARY_SCRIPT_RE.test(name) && !taken.includes(name)
  const close = (): void => {
    setTyped(null)
    setEntry('')
    onClose()
  }
  const go = async (): Promise<void> => {
    if (!from) return
    setBusy(true)
    const r = await runWrite(window.api.scriptImportFolder(name, from, entry.trim() || undefined), {
      success: t('scripts.imported', { name })
    })
    setBusy(false)
    if (r) {
      setTyped(null)
      setEntry('')
      onImported(name)
    }
  }
  return (
    <Modal opened={!!from} onClose={close} title={t('scripts.importFolder')} centered radius="lg">
      <Stack gap="md">
        <Code>{from}</Code>
        <TextInput
          label={t('common.name')}
          value={name}
          onChange={(e) => setTyped(e.currentTarget.value)}
          error={
            name && !LIBRARY_SCRIPT_RE.test(name)
              ? t('mcp.nameInvalid')
              : taken.includes(name)
                ? t('scripts.nameTaken')
                : undefined
          }
          data-testid="script-import-name"
        />
        <TextInput
          label={t('scripts.entry')}
          description={t('scripts.importEntryHint')}
          placeholder="run.sh"
          value={entry}
          onChange={(e) => setEntry(e.currentTarget.value)}
          data-testid="script-import-entry"
        />
        <Text size="xs" c="dimmed">
          {t('scripts.importHint')}
        </Text>
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={busy}
            disabled={!nameOk}
            onClick={() => void go()}
            data-testid="script-import-ok"
          >
            {t('scripts.importFolder')}
          </Button>
        </Group>
      </Stack>
    </Modal>
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
  const [kind, setKind] = useState<'file' | 'folder'>('file')
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
    const r = await runWrite(
      kind === 'folder'
        ? window.api.scriptCreateFolder(name, description.trim())
        : window.api.scriptCreate(name, content),
      { success: t('scripts.created') }
    )
    setBusy(false)
    if (r) onCreated(name)
  }
  return (
    <Stack gap="md" maw={560}>
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          {t('scripts.kindLabel')}
        </Text>
        <SegmentedControl
          value={kind}
          onChange={(v) => setKind(v as 'file' | 'folder')}
          data={[
            { value: 'file', label: t('scripts.kindFile') },
            { value: 'folder', label: t('scripts.kindFolder') }
          ]}
          data-testid="script-new-kind"
        />
        <Text size="xs" c="dimmed">
          {t(kind === 'folder' ? 'scripts.kindFolderHint' : 'scripts.kindFileHint')}
        </Text>
      </Stack>
      <TextInput
        label={t('common.name')}
        description={t(kind === 'folder' ? 'scripts.nameHintFolder' : 'scripts.nameHint')}
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

/** One of Illithid's recipe scripts: hooks using it, its scripts (all tools / per tool), new hook, copy to edit */
function BuiltinDetail({
  builtin,
  taken,
  onCopied
}: {
  builtin: ScriptBuiltinView
  taken: string[]
  onCopied: (name: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { navigate } = useNav()
  const [view, setView] = useState('all')
  const suggested = (() => {
    const base = `my-${builtin.action}`
    let n = base
    for (let i = 2; taken.includes(n); i++) n = `${base}-${i}`
    return n
  })()
  const [copyName, setCopyName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const tools = Object.keys(builtin.perTool) as (keyof typeof builtin.perTool)[]
  const shown =
    view === 'all' ? builtin.universal : (builtin.perTool[view as (typeof tools)[number]] ?? '')
  const nameOk = !!copyName && LIBRARY_SCRIPT_RE.test(copyName) && !taken.includes(copyName)
  const copy = async (): Promise<void> => {
    if (!copyName) return
    setBusy(true)
    const r = await runWrite(window.api.scriptFromRecipe(builtin.action, copyName), {
      success: t('scripts.copied', { name: copyName })
    })
    setBusy(false)
    if (r) onCopied(copyName)
  }
  return (
    <Stack gap="lg">
      <Group gap="sm">
        <Button
          size="xs"
          variant="default"
          leftSection={<Copy size={13} />}
          onClick={() => setCopyName(copyName === null ? suggested : null)}
          data-testid="script-builtin-copy"
        >
          {t('scripts.copy')}
        </Button>
      </Group>
      {copyName !== null && (
        <Group gap="xs" align="flex-end">
          <TextInput
            label={t('scripts.copyName')}
            description={t('scripts.copyHint')}
            value={copyName}
            onChange={(e) => setCopyName(e.currentTarget.value)}
            error={
              copyName && !LIBRARY_SCRIPT_RE.test(copyName)
                ? t('mcp.nameInvalid')
                : taken.includes(copyName)
                  ? t('scripts.nameTaken')
                  : undefined
            }
            w={320}
            data-testid="script-copy-name"
          />
          <Button
            size="xs"
            loading={busy}
            disabled={!nameOk}
            onClick={() => void copy()}
            data-testid="script-copy-confirm"
          >
            {t('common.create')}
          </Button>
        </Group>
      )}
      <Stack gap={8} data-testid="script-users">
        <Text size="sm" fw={600} c="dimmed">
          {t('scripts.users')}
        </Text>
        {builtin.users.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('scripts.noUsers')}
          </Text>
        ) : (
          <ListCard>
            {builtin.users.map((h) => (
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
      <Stack gap={8}>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={setView}
          data={[
            { value: 'all', label: t('scripts.allTools') },
            ...tools.map((tool) => ({ value: tool, label: TOOL_NAME[tool] }))
          ]}
          data-testid="script-builtin-view"
        />
        <Text size="xs" c="dimmed">
          {view === 'all'
            ? t('scripts.allToolsHint')
            : t('scripts.toolHint', { tool: TOOL_NAME[view as (typeof tools)[number]] })}
        </Text>
        <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {shown}
        </Code>
      </Stack>
    </Stack>
  )
}

export default Scripts
