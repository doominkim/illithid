import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Box, Button, Group, Modal, Stack, Text } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import type { ApplyPreviewAction, ApplyPreviewItem, ApplyPreviewView, EditedRuleItem, ImportedChangedItem, ToolId } from '../../../shared/api'
import { LIBRARY_CHANGED, runWrite } from '../lib/mutate'
import { useSync } from '../lib/sync'
import { TOOL_NAME, TOOLS } from '../lib/tools'
import { Loading } from './Layout'
import { ListCard, ListRow } from './ListRow'
import { ToolIcon } from './ToolIcon'

const ACTION_COLOR: Record<ApplyPreviewAction, string> = {
  add: 'accent',
  update: 'blue',
  replace: 'orange',
  retire: 'orange',
  remove: 'red'
}

const ACTION_ORDER: ApplyPreviewAction[] = ['add', 'update', 'replace', 'retire', 'remove']

interface BodyProps {
  /** Secondary button (Cancel in the dialog, Later during first run) */
  cancelLabel: string
  onCancel: () => void
  /** After a successful apply, or when there is nothing to apply */
  onDone: () => void
  doneLabel?: string
}

/** Sync plan grouped by tool → Apply (one approved sync) */
export function ApplyPreviewBody({ cancelLabel, onCancel, onDone, doneLabel }: BodyProps): React.JSX.Element {
  const { t } = useTranslation()
  const { applyOnce } = useSync()
  const [view, setView] = useState<ApplyPreviewView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [keeping, setKeeping] = useState<string | null>(null)
  /** The plan changed between preview and Apply — nothing was written, the refreshed plan is shown */
  const [changed, setChanged] = useState(false)

  const load = useCallback(() => {
    window.api.syncPreview().then(
      (v) => {
        setErr(null)
        setView(v)
      },
      (e) => setErr(String((e as Error).message ?? e))
    )
  }, [])
  useEffect(load, [load])

  const keep = async (x: ImportedChangedItem): Promise<void> => {
    setKeeping(x.path)
    const r = await runWrite(window.api.importedKeep({ kind: x.kind, tool: x.tool, path: x.path }), { success: t('preview.kept') })
    setKeeping(null)
    if (r !== null) load()
  }

  // A rule an agent edited in a tool: save that version to the library (it then reaches every tool) instead of restoring
  const keepEdited = async (x: EditedRuleItem): Promise<void> => {
    setKeeping(`edited:${x.tool}:${x.name}`)
    const r = await runWrite(window.api.editedRuleKeep(x.tool, x.name), { success: t('preview.keptEdited') })
    setKeeping(null)
    if (r !== null) {
      window.dispatchEvent(new Event(LIBRARY_CHANGED))
      load()
    }
  }

  const apply = async (): Promise<void> => {
    if (!view?.fingerprint) return
    setBusy(true)
    const s = await applyOnce(view.fingerprint)
    setBusy(false)
    if (s && s.wrote) onDone()
    else {
      setChanged(s?.refused === 'planChanged')
      load()
    }
  }

  if (err)
    return (
      <Alert color="red" variant="light">
        {err}
      </Alert>
    )
  if (!view) return <Loading />

  const byOrder = (a: ApplyPreviewItem, b: ApplyPreviewItem): number =>
    ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action) || a.name.localeCompare(b.name)
  // Top-level rows only; detail rows (parent) are listed under their config file row
  const byTool = (tool: ToolId): ApplyPreviewItem[] => view.items.filter((x) => x.tool === tool && !x.parent).sort(byOrder)
  const childrenOf = (x: ApplyPreviewItem): ApplyPreviewItem[] =>
    view.items.filter((c) => c.tool === x.tool && c.parent === x.path).sort(byOrder)
  const tools = TOOLS.filter(
    (tool) =>
      byTool(tool).length ||
      view.importedChanged.some((x) => x.tool === tool) ||
      view.edited.some((x) => x.tool === tool) ||
      view.notInitialized.some((x) => x.tool === tool) ||
      view.libraryDirect.some((x) => x.tool === tool)
  )
  const n = view.items.filter((x) => !x.parent).length
  const itemRow = (x: ApplyPreviewItem, child = false): React.JSX.Element => (
    <ListRow
      key={`${x.parent ?? ''}:${x.action}:${x.kind}:${x.path}:${x.name}`}
      style={child ? { paddingLeft: 36 } : undefined}
      title={x.name}
      tags={
        <>
          <Badge variant="default" size="xs" fw={500} c="dimmed">
            {t(`preview.kind.${x.kind}`)}
          </Badge>
          <Badge
            variant="light"
            color={ACTION_COLOR[x.action]}
            size="xs"
            fw={500}
            data-testid={x.kind === 'mcp' ? `apply-preview-mcp-${x.tool}-${x.name}-${x.action}` : `apply-preview-action-${x.action}`}
          >
            {t(`preview.action.${x.action}`)}
          </Badge>
        </>
      }
      subtitle={x.kind === 'config' || x.kind === 'mcp' ? undefined : x.path}
    />
  )

  return (
    <Stack gap="md" data-testid="apply-preview">
      {view.libraryMissing && (
        <Alert color="yellow" variant="light">
          {t('sync.libraryMissing')}
        </Alert>
      )}
      {changed && (
        <Alert color="yellow" variant="light" data-testid="apply-preview-changed">
          {t('preview.planChanged')}
        </Alert>
      )}
      {view.errors.length > 0 && (
        <Alert color="red" variant="light">
          <Stack gap={2}>
            {view.errors.map((e) => (
              <Text key={e} size="sm">
                {e}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
      {!view.libraryMissing && tools.length === 0 && (
        <Text size="md" c="dimmed" data-testid="apply-preview-empty">
          {t('preview.nothing')}
        </Text>
      )}
      <Box style={{ maxHeight: 420, overflow: 'auto' }}>
        <Stack gap="md">
          {tools.map((tool) => (
            <Box key={tool} data-testid={`apply-preview-${tool}`}>
              <Group gap={8} mb={6}>
                <ToolIcon tool={tool} size={18} />
                <Text fw={600} size="md">
                  {TOOL_NAME[tool]}
                </Text>
                {byTool(tool).length > 0 && (
                  <Text size="sm" c="dimmed">
                    {byTool(tool).length}
                  </Text>
                )}
              </Group>
              <ListCard>
                {view.notInitialized
                  .filter((x) => x.tool === tool)
                  .map((x) => (
                    <ListRow
                      key={`notInitialized:${x.label}`}
                      title={x.label}
                      tags={
                        <Badge variant="light" color="yellow" size="xs" fw={500} data-testid="apply-preview-not-initialized">
                          {t(`sync.${x.reason ?? 'notInitialized'}`, { tool: TOOL_NAME[tool] })}
                        </Badge>
                      }
                    />
                  ))}
                {view.edited
                  .filter((x) => x.tool === tool)
                  .map((x) => (
                    <ListRow
                      key={`edited:${x.name}`}
                      title={x.name}
                      tags={
                        <>
                          <Badge variant="default" size="xs" fw={500} c="dimmed">
                            {t('preview.kind.rule')}
                          </Badge>
                          <Badge variant="light" color="yellow" size="xs" fw={500} data-testid="apply-preview-edited">
                            {t('preview.editedIn', { tool: TOOL_NAME[tool] })}
                          </Badge>
                        </>
                      }
                      subtitle={x.path}
                      right={
                        <Button
                          size="compact-xs"
                          variant="default"
                          loading={keeping === `edited:${x.tool}:${x.name}`}
                          onClick={() => void keepEdited(x)}
                          data-testid={`apply-preview-keep-edited-${x.tool}-${x.name}`}
                        >
                          {t('preview.keepEdited')}
                        </Button>
                      }
                    />
                  ))}
                {view.importedChanged
                  .filter((x) => x.tool === tool)
                  .map((x) => (
                    <ListRow
                      key={`changed:${x.kind}:${x.path}`}
                      title={x.name}
                      tags={
                        <>
                          <Badge variant="default" size="xs" fw={500} c="dimmed">
                            {t(`preview.kind.${x.kind}`)}
                          </Badge>
                          <Badge variant="light" color="yellow" size="xs" fw={500}>
                            {t('sync.reason.importedChanged')}
                          </Badge>
                        </>
                      }
                      subtitle={x.path}
                      right={
                        <Button size="compact-xs" variant="default" loading={keeping === x.path} onClick={() => void keep(x)} data-testid="apply-preview-keep">
                          {t('preview.keepOriginal')}
                        </Button>
                      }
                    />
                  ))}
                {byTool(tool).flatMap((x) => [itemRow(x), ...childrenOf(x).map((c) => itemRow(c, true))])}
                {view.libraryDirect
                  .filter((x) => x.tool === tool)
                  .map((x) => (
                    <ListRow
                      key={`direct:${x.kind}:${x.name}`}
                      title={x.name}
                      tags={
                        <>
                          <Badge variant="default" size="xs" fw={500} c="dimmed">
                            {t(`preview.kind.${x.kind}`)}
                          </Badge>
                          <Badge variant="light" color="gray" size="xs" fw={500} data-testid="apply-preview-library-direct">
                            {t('preview.libraryDirect')}
                          </Badge>
                        </>
                      }
                    />
                  ))}
              </ListCard>
            </Box>
          ))}
        </Stack>
      </Box>
      <Group justify="flex-end" gap="xs">
        {n > 0 ? (
          <>
            <Button variant="default" onClick={onCancel} disabled={busy} data-testid="apply-preview-cancel">
              {cancelLabel}
            </Button>
            <Button onClick={() => void apply()} loading={busy} data-testid="apply-preview-apply">
              {t('preview.apply', { n })}
            </Button>
          </>
        ) : (
          <Button onClick={onDone} data-testid="apply-preview-done">
            {doneLabel ?? t('common.close')}
          </Button>
        )}
      </Group>
    </Stack>
  )
}

/** Apply preview dialog (sidebar sync button, backup restore, tool turned on in settings) */
export function ApplyPreviewModal({
  opened,
  onCancel,
  onDone
}: {
  opened: boolean
  /** Dismissed without applying: cancel button, close button, Esc, overlay */
  onCancel: () => void
  /** Applied, or nothing left to apply */
  onDone: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // Keep the body until the close transition ends, so the dialog never shrinks to an empty frame while closing
  const [mounted, setMounted] = useState(false)
  // Each opening gets a fresh body (fresh plan), even when reopened before the previous close finished
  const [session, setSession] = useState({ n: 0, opened: false })
  if (opened !== session.opened) setSession({ n: session.n + (opened ? 1 : 0), opened })
  if (opened && !mounted) setMounted(true)
  return (
    // Above drawers and modals (default 200) so it works from an open item detail; below notifications (400)
    <Modal
      opened={opened}
      onClose={onCancel}
      onExitTransitionEnd={() => setMounted(false)}
      title={t('preview.title')}
      size="lg"
      centered
      radius="lg"
      zIndex={300}
    >
      {mounted && <ApplyPreviewBody key={session.n} cancelLabel={t('common.cancel')} onCancel={onCancel} onDone={onDone} />}
    </Modal>
  )
}
