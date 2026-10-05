import { useCallback, useEffect, useState } from 'react'
import {
  ActionIcon,
  Button,
  Group,
  Modal,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { Download, Pencil, Trash2, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SwitchLossItem, WorkspaceView } from '../../../shared/api'
import { TOOL_NAME } from '../lib/tools'
import { WORKSPACE_SWITCH_REQUEST } from '../lib/mutate'
import { ConfirmModal } from './ConfirmModal'
import { hasDirtyDrafts } from '../lib/dirtyDraft'

const NEW = '__new__'

/** Top of the nav: workspace picker + import/export */
export function WorkspaceBar({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [list, setList] = useState<WorkspaceView[]>([])
  const [switchTo, setSwitchTo] = useState<WorkspaceView | null>(null)
  const [losses, setLosses] = useState<SwitchLossItem[] | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [unsaved, setUnsaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [from, setFrom] = useState<'empty' | 'current'>('current')
  const [dropdown, setDropdown] = useState(false)
  const [renaming, setRenaming] = useState<WorkspaceView | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [deleting, setDeleting] = useState<WorkspaceView | null>(null)

  const load = useCallback(() => {
    window.api.workspaces().then(setList, () => {})
  }, [])
  useEffect(load, [load])

  // Switch confirmation: items that will be removed from tools on switch (read-only preview)
  useEffect(() => {
    if (!switchTo) return
    let live = true
    window.api.workspaceSwitchPreview(switchTo.id).then(
      (r) => {
        if (!live) return
        if (r.ok) setLosses(r.value)
        else setPreviewError(r.message)
      },
      (e) => {
        if (live) setPreviewError(String((e as Error).message ?? e))
      }
    )
    return () => {
      live = false
    }
  }, [switchTo])

  const active = list.find((w) => w.active)
  const fail = (message: string): void => {
    notifications.show({ color: 'red', title: t('common.error'), message })
  }

  const openSwitch = (w: WorkspaceView): void => {
    setLosses(null)
    setPreviewError(null)
    setUnsaved(hasDirtyDrafts())
    setSwitchTo(w)
  }

  // From the menu bar item: same confirmation as picking it here
  useEffect(() => {
    const on = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail
      window.api.workspaces().then(
        (ws) => {
          setList(ws)
          const w = ws.find((x) => x.id === id)
          if (w && !w.active) openSwitch(w)
        },
        () => {}
      )
    }
    window.addEventListener(WORKSPACE_SWITCH_REQUEST, on)
    return () => window.removeEventListener(WORKSPACE_SWITCH_REQUEST, on)
  }, [])

  const onSelect = (v: string | null): void => {
    if (!v) return
    if (v === NEW) {
      setNewName('')
      setFrom('current')
      setCreating(true)
      return
    }
    const w = list.find((x) => x.id === v)
    if (w && !w.active) openSwitch(w)
  }

  const doSwitch = async (): Promise<void> => {
    if (!switchTo || losses === null || previewError) return
    setBusy(true)
    try {
      const r = await window.api.workspaceSwitch(switchTo.id)
      if (!r.ok) return fail(r.message)
      setSwitchTo(null)
      load()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.workspaceCreate(newName.trim(), from)
      if (!r.ok) return fail(r.message)
      setCreating(false)
      load()
      openSwitch(r.value)
    } finally {
      setBusy(false)
    }
  }

  const doRename = async (): Promise<void> => {
    if (!renaming) return
    setBusy(true)
    try {
      const r = await window.api.workspaceRename(renaming.id, renameTo.trim())
      if (!r.ok) return fail(r.message)
      setRenaming(null)
      load()
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async (): Promise<void> => {
    if (!deleting) return
    setBusy(true)
    try {
      const r = await window.api.workspaceDelete(deleting.id)
      if (!r.ok) return fail(r.message)
      setDeleting(null)
      load()
    } finally {
      setBusy(false)
    }
  }

  /** Icons on the right of an item: stop clicks from propagating to item selection (switch) */
  const optionAction = (
    label: string,
    icon: React.ReactNode,
    disabled: boolean,
    run: () => void,
    testId: string
  ): React.JSX.Element => (
    <span
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (disabled) return
        setDropdown(false)
        run()
      }}
    >
      <ActionIcon
        component="span"
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={label}
        disabled={disabled}
        data-testid={testId}
      >
        {icon}
      </ActionIcon>
    </span>
  )

  const renderOption = ({
    option
  }: {
    option: { value: string; label: string }
  }): React.JSX.Element => {
    const w = list.find((x) => x.id === option.value)
    if (!w) return <span>{option.label}</span>
    return (
      <Group gap={2} wrap="nowrap" style={{ width: '100%' }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {w.name}
        </span>
        {optionAction(
          t('workspace.rename'),
          <Pencil size={13} />,
          false,
          () => {
            setRenameTo(w.name)
            setRenaming(w)
          },
          `workspace-rename-${w.id}`
        )}
        {w.id !== 'default' &&
          optionAction(
            t('workspace.delete'),
            <Trash2 size={13} />,
            w.active || list.length <= 1,
            () => setDeleting(w),
            `workspace-delete-${w.id}`
          )}
      </Group>
    )
  }

  const doExport = async (): Promise<void> => {
    const r = await window.api.workspaceExport()
    if (!r.ok) return fail(r.message)
    if (r.value)
      notifications.show({
        color: 'accent',
        message: t('workspace.exported', { path: r.value.path }),
        autoClose: 3000
      })
  }

  const doImport = async (): Promise<void> => {
    const r = await window.api.workspaceImport()
    if (!r.ok) return fail(r.message)
    if (!r.value) return
    // Import creates an inactive workspace; keep the current editor and its draft intact.
    load()
    const miss = r.value.missingSecrets
    notifications.show({
      color: miss.length ? 'yellow' : 'accent',
      title: t('workspace.imported', { name: r.value.name }),
      message: miss.length ? `${t('workspace.missingSecrets')}: ${miss.join(', ')}` : undefined,
      autoClose: miss.length ? false : 3000
    })
  }

  return (
    <>
      <Group gap={4} wrap="nowrap" mb={10} px={2}>
        <Select
          size="xs"
          style={{ flex: 1, minWidth: 0 }}
          aria-label={t('workspace.label')}
          allowDeselect={false}
          value={active?.id ?? null}
          onChange={onSelect}
          data={[
            ...list.map((w) => ({ value: w.id, label: w.name })),
            { value: NEW, label: t('workspace.new') }
          ]}
          renderOption={renderOption}
          dropdownOpened={dropdown}
          onDropdownOpen={() => setDropdown(true)}
          onDropdownClose={() => setDropdown(false)}
          data-testid="workspace-select"
        />
        <ActionIcon
          variant="subtle"
          color="gray"
          size="md"
          aria-label={t('workspace.import')}
          onClick={() => void doImport()}
          data-testid="workspace-import"
        >
          <Download size={15} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="md"
          aria-label={t('workspace.export')}
          onClick={() => void doExport()}
          data-testid="workspace-export"
        >
          <Upload size={15} />
        </ActionIcon>
      </Group>

      <Modal
        opened={creating}
        onClose={() => setCreating(false)}
        title={t('workspace.new')}
        centered
        radius="lg"
      >
        <Stack gap="md">
          <TextInput
            label={t('common.name')}
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            data-autofocus
            data-testid="workspace-new-name"
          />
          <SegmentedControl
            value={from}
            onChange={(v) => setFrom(v === 'current' ? 'current' : 'empty')}
            data={[
              { value: 'empty', label: t('workspace.fromEmpty') },
              { value: 'current', label: t('workspace.fromCurrent') }
            ]}
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={!newName.trim()}
              loading={busy}
              onClick={() => void create()}
              data-testid="workspace-new-ok"
            >
              {t('common.create')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={!!renaming}
        onClose={() => setRenaming(null)}
        title={t('workspace.rename')}
        centered
        radius="lg"
      >
        <Stack gap="md">
          <TextInput
            label={t('common.name')}
            value={renameTo}
            onChange={(e) => setRenameTo(e.currentTarget.value)}
            data-autofocus
            data-testid="workspace-rename-name"
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setRenaming(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={!renameTo.trim() || renameTo.trim() === renaming?.name}
              loading={busy}
              onClick={() => void doRename()}
              data-testid="workspace-rename-ok"
            >
              {t('common.save')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <ConfirmModal
        opened={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={doDelete}
        loading={busy}
        danger
        title={t('workspace.deleteTitle')}
        confirmLabel={t('common.delete')}
        message={deleting?.name ?? ''}
      />

      <ConfirmModal
        opened={!!switchTo}
        onClose={() => setSwitchTo(null)}
        onConfirm={doSwitch}
        loading={busy}
        title={t('workspace.switchTitle')}
        disabled={losses === null || !!previewError}
        confirmLabel={t('workspace.switch')}
        message={
          <Stack gap={6}>
            <Text size="md">{switchTo?.name ?? ''}</Text>
            {unsaved && (
              <Text size="sm" c="yellow" data-testid="workspace-switch-unsaved">
                {t('workspace.switchUnsaved')}
              </Text>
            )}
            {previewError ? (
              <Text size="sm" c="red" data-testid="workspace-switch-preview-error">
                {t('workspace.switchPreviewFailed')} · {previewError}
              </Text>
            ) : losses === null ? (
              <Text size="sm" c="dimmed" data-testid="workspace-switch-preview-loading">
                {t('workspace.switchPreviewLoading')}
              </Text>
            ) : null}
            {losses && losses.length > 0 && (
              <>
                <Text size="sm" fw={600} data-testid="workspace-switch-losses">
                  {t('workspace.switchRemoves', { n: losses.length })}
                </Text>
                <ScrollArea.Autosize mah={220}>
                  <Stack gap={2}>
                    {losses.map((x) => (
                      <Text key={`${x.kind}:${x.tool}:${x.name}`} size="xs" c="dimmed">
                        {t(`import.kind.${x.kind}`)} · {TOOL_NAME[x.tool]} · {x.name}
                      </Text>
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
              </>
            )}
          </Stack>
        }
      />
    </>
  )
}
