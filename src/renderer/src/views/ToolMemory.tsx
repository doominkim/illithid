import { useEffect, useRef, useState } from 'react'
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  UnstyledButton
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { ArrowLeft, ArrowRightLeft, FileText, Trash2, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  ClaudeMemoryProject,
  CodexMemoryEntry,
  CodexRolloutSummary,
  IndexStat,
  MemoryType,
  Refused,
  ToolMemoryMoveResult,
  ToolMemoryView,
  WriteResult
} from '../../../shared/api'
import { ConfirmModal } from '../components/ConfirmModal'
import { EmptyState } from '../components/EmptyState'
import { ErrorAlert, Loading } from '../components/Layout'
import { Markdown } from '../components/Markdown'
import { useReload } from '../components/ReloadButton'
import { fmtSize, fmtTime, relTime } from '../lib/format'
import { isRefused } from '../lib/mutate'
import { clearApiCache } from '../lib/useApi'

const TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference']
const INDEX = 'MEMORY.md'
const ROLLOUT_DIR = 'rollout_summaries'

const folderName = (p: ClaudeMemoryProject): string =>
  p.cwd ? (p.cwd.split('/').filter(Boolean).pop() ?? p.cwd) : p.slug
const overLimit = (s: IndexStat, l: IndexStat): boolean => s.lines > l.lines || s.bytes > l.bytes

/** Index size badge (lines/200, KB/25) */
export function IndexBadges({
  stat,
  limits
}: {
  stat: IndexStat
  limits: IndexStat
}): React.JSX.Element {
  const { t } = useTranslation()
  const lineOver = stat.lines > limits.lines
  const byteOver = stat.bytes > limits.bytes
  return (
    <Group gap={4} wrap="nowrap" data-testid="index-badges">
      <Badge variant="light" size="sm" color={lineOver ? 'red' : 'gray'} fw={500}>
        {t('memory.indexLines', { n: stat.lines, max: limits.lines })}
      </Badge>
      <Badge variant="light" size="sm" color={byteOver ? 'red' : 'gray'} fw={500}>
        {t('memory.indexKb', {
          n: (stat.bytes / 1024).toFixed(1),
          max: Math.round(limits.bytes / 1024)
        })}
      </Badge>
    </Group>
  )
}

type Action = 'promote' | 'move' | 'trash'
interface Pending {
  action: Action
  items: { file: string; title: string; target: string; type?: MemoryType }[]
  toSlug?: string
}

/** Claude auto memory: projects │ files (multi-select) │ preview */
export function ClaudeMemory({ view }: { view: ToolMemoryView }): React.JSX.Element {
  const { t } = useTranslation()
  const reload = useReload()
  const { projects, limits } = view.claude
  const [slug, setSlug] = useState<string | null>(projects[0]?.slug ?? null)
  const [checked, setChecked] = useState<string[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [promoteOpen, setPromoteOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const project = projects.find((p) => p.slug === slug) ?? projects[0] ?? null
  const selectProject = (s: string): void => {
    setSlug(s)
    setChecked([])
    setPreview(null)
  }

  if (projects.length === 0) return <EmptyState title={t('common.noResults')} />
  const files = project?.files ?? []
  const picked = files.filter((f) => checked.includes(f.file))
  const allChecked = files.length > 0 && picked.length === files.length

  const run = async (): Promise<void> => {
    if (!pending || !project) return
    setBusy(true)
    let ok = 0
    const fails: string[] = []
    for (const it of pending.items) {
      let r: WriteResult<ToolMemoryMoveResult> | Refused
      try {
        r =
          pending.action === 'promote'
            ? await window.api.toolMemoryPromote(project.slug, it.file, it.type!)
            : pending.action === 'move'
              ? await window.api.toolMemoryMove(project.slug, it.file, pending.toSlug!)
              : await window.api.toolMemoryTrash(project.slug, it.file)
      } catch (e) {
        fails.push(`${it.file}: ${(e as Error).message}`)
        continue
      }
      if (isRefused(r)) {
        notifications.show({
          color: 'yellow',
          title: t(`refused.${r.refused}`),
          message: r.refused === 'allowRealApplyOff' ? t('refused.allowRealApplyHint') : r.message
        })
        break
      }
      if (r.ok) ok++
      else fails.push(`${it.file}: ${t(`libError.${r.code}`, { defaultValue: r.code })}`)
    }
    setBusy(false)
    setPending(null)
    setChecked([])
    setPreview(null)
    if (ok || fails.length) {
      notifications.show({
        color: fails.length ? (ok ? 'yellow' : 'red') : 'accent',
        title: [
          ok ? t('memory.resultOk', { n: ok }) : '',
          fails.length ? t('memory.resultFail', { n: fails.length }) : ''
        ]
          .filter(Boolean)
          .join(' · '),
        message: fails.join('\n') || undefined,
        autoClose: fails.length ? false : 2500
      })
    }
    if (ok) {
      clearApiCache()
      reload()
    }
  }

  const confirmTitle = pending ? t(`memory.${pending.action}`) : ''

  return (
    <Box style={{ flex: 1, minHeight: 0, display: 'flex', gap: 14 }}>
      {/* Projects */}
      <Box
        className="ac-card"
        style={{
          width: 280,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
      >
        <Group gap={6} p="sm" style={{ borderBottom: '1px solid var(--ac-border-subtle)' }}>
          <Text size="sm" fw={600}>
            {t('memory.projects')}
          </Text>
          <Badge variant="default" size="sm" fw={600} c="dimmed">
            {projects.length}
          </Badge>
        </Group>
        <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {projects.map((p) => (
            <UnstyledButton
              key={p.slug}
              className="ac-row"
              data-active={p.slug === project?.slug || undefined}
              onClick={() => selectProject(p.slug)}
              style={{ alignItems: 'flex-start' }}
              data-testid="tm-project"
            >
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" fw={600} truncate="end">
                  {folderName(p)}
                </Text>
                <Text size="xs" c="dimmed" truncate="end">
                  {t('memory.fileCount', { n: p.files.length })} · {relTime(p.updatedAt, t)}
                </Text>
                {(p.missing ||
                  p.temp ||
                  overLimit(p.index, limits) ||
                  p.index.broken.length > 0) && (
                  <Group gap={4} mt={4}>
                    {p.missing && (
                      <Badge size="xs" variant="light" color="red">
                        {t('memory.badgeMissing')}
                      </Badge>
                    )}
                    {p.temp && (
                      <Badge size="xs" variant="light" color="gray">
                        {t('memory.badgeTemp')}
                      </Badge>
                    )}
                    {overLimit(p.index, limits) && (
                      <Badge size="xs" variant="light" color="red">
                        {t('memory.badgeOver')}
                      </Badge>
                    )}
                    {p.index.broken.length > 0 && (
                      <Badge size="xs" variant="light" color="yellow">
                        {t('memory.badgeBroken', { n: p.index.broken.length })}
                      </Badge>
                    )}
                  </Group>
                )}
              </Box>
            </UnstyledButton>
          ))}
        </Box>
      </Box>

      {/* Files */}
      <Box
        className="ac-card"
        style={{
          width: 380,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
      >
        {project && (
          <Stack gap={6} p="sm" style={{ borderBottom: '1px solid var(--ac-border-subtle)' }}>
            <Group gap={6} wrap="nowrap">
              <Checkbox
                size="xs"
                checked={allChecked}
                indeterminate={picked.length > 0 && !allChecked}
                onChange={() => setChecked(allChecked ? [] : files.map((f) => f.file))}
                aria-label={t('memory.selectAll')}
                data-testid="tm-check-all"
              />
              <Text size="sm" fw={600} truncate="end" style={{ flex: 1, minWidth: 0 }}>
                {project.cwd ?? project.slug}
              </Text>
            </Group>
            {picked.length > 0 && (
              <Group gap={6}>
                <Badge variant="default" size="sm" fw={600} c="dimmed">
                  {picked.length}
                </Badge>
                <Button
                  size="compact-xs"
                  leftSection={<Upload size={12} />}
                  onClick={() => setPromoteOpen(true)}
                  data-testid="tm-promote"
                >
                  {t('memory.promote')}
                </Button>
                <Button
                  size="compact-xs"
                  variant="default"
                  leftSection={<ArrowRightLeft size={12} />}
                  onClick={() => setMoveOpen(true)}
                  data-testid="tm-move"
                >
                  {t('memory.move')}
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  leftSection={<Trash2 size={12} />}
                  onClick={() =>
                    setPending({
                      action: 'trash',
                      items: picked.map((f) => ({
                        file: f.file,
                        title: f.title,
                        target: `.trash/…/${project.slug}/${f.file}`
                      }))
                    })
                  }
                  data-testid="tm-trash"
                >
                  {t('memory.trash')}
                </Button>
              </Group>
            )}
          </Stack>
        )}
        <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {project && (
            <UnstyledButton
              className="ac-row"
              data-active={preview === INDEX || undefined}
              onClick={() => setPreview(INDEX)}
              data-testid="tm-index"
            >
              <FileText size={14} style={{ color: 'var(--ac-text-muted)', flexShrink: 0 }} />
              <Text size="sm" fw={600} style={{ flex: 1 }}>
                {INDEX}
              </Text>
              {project.index.exists ? (
                <IndexBadges stat={project.index} limits={limits} />
              ) : (
                <Badge size="xs" variant="light" color="gray">
                  {t('common.none')}
                </Badge>
              )}
            </UnstyledButton>
          )}
          {files.map((f) => (
            <UnstyledButton
              component="div"
              key={f.file}
              className="ac-row"
              data-active={preview === f.file || undefined}
              onClick={() => setPreview(f.file)}
              style={{ alignItems: 'flex-start' }}
              data-testid="tm-file"
            >
              <Checkbox
                size="xs"
                mt={2}
                checked={checked.includes(f.file)}
                onClick={(e) => e.stopPropagation()}
                onChange={() =>
                  setChecked((c) =>
                    c.includes(f.file) ? c.filter((x) => x !== f.file) : [...c, f.file]
                  )
                }
                aria-label={f.file}
              />
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" fw={600} lineClamp={2} style={{ lineHeight: 1.35 }}>
                  {f.title}
                </Text>
                <Group gap={4} mt={3}>
                  {f.type && (
                    <Badge size="xs" variant="default" fw={500}>
                      {f.type}
                    </Badge>
                  )}
                  <Text size="xs" c="dimmed">
                    {relTime(f.mtime, t)}
                  </Text>
                  {!f.inIndex && (
                    <Badge size="xs" variant="light" color="yellow">
                      {t('memory.badgeNotInIndex')}
                    </Badge>
                  )}
                  {f.inShared && (
                    <Badge size="xs" variant="light" color="blue">
                      {t('memory.badgeInShared')}
                    </Badge>
                  )}
                </Group>
              </Box>
            </UnstyledButton>
          ))}
        </Box>
      </Box>

      {/* Preview */}
      {project && preview ? (
        <ToolMemoryPreview
          key={`${project.slug}/${preview}`}
          slug={project.slug}
          file={preview}
          onClose={() => setPreview(null)}
        />
      ) : (
        <Box className="ac-card" style={{ flex: 1 }}>
          <EmptyState title={t('common.noSelection')} />
        </Box>
      )}

      {project && promoteOpen && (
        <PromoteModal
          files={picked.map((f) => ({ file: f.file, title: f.title, type: f.type }))}
          onClose={() => setPromoteOpen(false)}
          onNext={(types) => {
            setPromoteOpen(false)
            setPending({
              action: 'promote',
              items: picked.map((f) => ({
                file: f.file,
                title: f.title,
                type: types[f.file],
                target: `memory/${types[f.file]}/${f.file}`
              }))
            })
          }}
        />
      )}
      {project && moveOpen && (
        <MoveModal
          from={project}
          projects={projects}
          onClose={() => setMoveOpen(false)}
          onNext={(toSlug, label) => {
            setMoveOpen(false)
            setPending({
              action: 'move',
              toSlug,
              items: picked.map((f) => ({
                file: f.file,
                title: f.title,
                target: `${label}/${f.file}`
              }))
            })
          }}
        />
      )}
      <ConfirmModal
        opened={!!pending}
        onClose={() => setPending(null)}
        onConfirm={run}
        loading={busy}
        danger={pending?.action === 'trash'}
        title={confirmTitle}
        confirmLabel={confirmTitle}
        message={
          <Stack gap={4} data-testid="tm-confirm-list">
            {pending?.items.map((it) => (
              <Text key={it.file} size="sm" ff="monospace" style={{ wordBreak: 'break-all' }}>
                {it.file} → {it.target}
              </Text>
            ))}
          </Stack>
        }
      />
    </Box>
  )
}

/** Preview card: ← + title │ read-only Markdown (shared by Claude and Codex) */
function PreviewCard({
  title,
  onClose,
  err,
  text,
  footer
}: {
  title: string
  onClose: () => void
  err: string | null
  text: string | null
  footer?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Box
      className="ac-card"
      style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <Group
        gap="xs"
        px="md"
        py={10}
        wrap="nowrap"
        style={{ borderBottom: '1px solid var(--ac-border-subtle)' }}
      >
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={onClose}
          aria-label={t('common.back')}
        >
          <ArrowLeft size={16} />
        </ActionIcon>
        <Text size="sm" fw={600} ff="monospace" truncate="end">
          {title}
        </Text>
      </Group>
      <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }} p="md" data-testid="tm-preview">
        {err ? (
          <ErrorAlert message={err} />
        ) : text === null ? (
          <Loading />
        ) : (
          <Stack gap="md">
            <Markdown text={text} />
            {footer}
          </Stack>
        )}
      </Box>
    </Box>
  )
}

function ToolMemoryPreview({
  slug,
  file,
  onClose
}: {
  slug: string
  file: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    window.api.toolMemoryRead(slug, file).then((r) => {
      if (!alive) return
      if (r.ok) setText(r.value)
      else setErr(t(`libError.${r.code}`, { defaultValue: r.code }))
    })
    return () => {
      alive = false
    }
  }, [slug, file, t])
  return <PreviewCard title={file} onClose={onClose} err={err} text={text} />
}

/** Mounted only while open (resets state) */
function PromoteModal({
  files,
  onClose,
  onNext
}: {
  files: { file: string; title: string; type?: string }[]
  onClose: () => void
  onNext: (types: Record<string, MemoryType>) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [types, setTypes] = useState<Record<string, MemoryType | null>>(() =>
    Object.fromEntries(
      files.map((f) => [
        f.file,
        (TYPES as string[]).includes(f.type ?? '') ? (f.type as MemoryType) : null
      ])
    )
  )
  const ready = files.length > 0 && files.every((f) => types[f.file])
  return (
    <Modal opened onClose={onClose} title={t('memory.promote')} centered radius="lg" size="lg">
      <Stack gap="sm">
        {files.map((f) => (
          <Group key={f.file} gap="sm" wrap="nowrap">
            <Text size="sm" style={{ flex: 1, minWidth: 0 }} truncate="end">
              {f.title}
            </Text>
            <Select
              size="xs"
              w={140}
              placeholder={t('memory.type')}
              data={TYPES}
              value={types[f.file] ?? null}
              onChange={(v) => setTypes((s) => ({ ...s, [f.file]: (v as MemoryType) ?? null }))}
              allowDeselect={false}
              aria-label={t('memory.type')}
              data-testid="tm-promote-type"
            />
          </Group>
        ))}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!ready}
            onClick={() => onNext(types as Record<string, MemoryType>)}
            data-testid="tm-promote-next"
          >
            {t('memory.promote')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

/** Mounted only while open (resets state) */
function MoveModal({
  from,
  projects,
  onClose,
  onNext
}: {
  from: ClaudeMemoryProject
  projects: ClaudeMemoryProject[]
  onClose: () => void
  onNext: (toSlug: string, label: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [picked, setPicked] = useState<string | null>(null)
  const [path, setPath] = useState('')
  const [pathSlug, setPathSlug] = useState('')
  const latest = useRef('')
  const onPath = (v: string): void => {
    setPath(v)
    latest.current = v
    if (!v.trim()) {
      setPathSlug('')
      return
    }
    void window.api.toolMemorySlug(v).then((s) => {
      if (latest.current === v) setPathSlug(s)
    })
  }
  const options = projects
    .filter((p) => p.slug !== from.slug)
    .map((p) => ({ value: p.slug, label: p.cwd ?? p.slug }))
  const toSlug = path.trim() ? pathSlug : (picked ?? '')
  const label = path.trim() ? path.trim() : (options.find((o) => o.value === picked)?.label ?? '')
  const ready = !!toSlug && toSlug !== from.slug
  return (
    <Modal opened onClose={onClose} title={t('memory.move')} centered radius="lg" size="lg">
      <Stack gap="sm">
        <Select
          label={t('memory.moveTarget')}
          data={options}
          value={picked}
          onChange={setPicked}
          searchable
          disabled={!!path.trim()}
          data-testid="tm-move-select"
        />
        <TextInput
          label={t('memory.movePath')}
          value={path}
          onChange={(e) => onPath(e.currentTarget.value)}
          data-testid="tm-move-path"
        />
        {path.trim() && (
          <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-all' }}>
            {pathSlug || '—'}
          </Text>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!ready}
            onClick={() => onNext(toSlug, label)}
            data-testid="tm-move-next"
          >
            {t('memory.move')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

/** Codex memory file preview: reads on in 64KB chunks */
function CodexPreview({ rel, onClose }: { rel: string; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [next, setNext] = useState<number | null>(null)
  const [size, setSize] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    window.api.codexMemoryRead(rel).then((r) => {
      if (!alive) return
      if (!r.ok) return setErr(t(`libError.${r.code}`, { defaultValue: r.code }))
      setText(r.value.text)
      setSize(r.value.size)
      setNext(r.value.nextOffset ?? null)
    })
    return () => {
      alive = false
    }
  }, [rel, t])
  const more = async (): Promise<void> => {
    if (next === null) return
    setBusy(true)
    const r = await window.api.codexMemoryRead(rel, next)
    setBusy(false)
    if (!r.ok) return setErr(t(`libError.${r.code}`, { defaultValue: r.code }))
    setText((x) => (x ?? '') + r.value.text)
    setNext(r.value.nextOffset ?? null)
  }
  return (
    <PreviewCard
      title={rel}
      onClose={onClose}
      err={err}
      text={text}
      footer={
        next !== null && (
          <Button
            variant="default"
            size="xs"
            loading={busy}
            onClick={() => void more()}
            data-testid="codex-more"
          >
            {t('memory.more', { done: fmtSize(next), total: fmtSize(size) })}
          </Button>
        )
      }
    />
  )
}

function CodexRow({
  name,
  value,
  active,
  onClick,
  testId
}: {
  name: string
  value: string
  active: boolean
  onClick: () => void
  testId: string
}): React.JSX.Element {
  return (
    <UnstyledButton
      className="ac-row"
      data-active={active || undefined}
      onClick={onClick}
      style={{ alignItems: 'flex-start' }}
      data-testid={testId}
    >
      <FileText size={14} style={{ color: 'var(--ac-text-muted)', flexShrink: 0, marginTop: 3 }} />
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" fw={600} ff="monospace" truncate="end">
          {name}
        </Text>
        <Text size="xs" c="dimmed" truncate="end">
          {value}
        </Text>
      </Box>
    </UnstyledButton>
  )
}

/** Codex memory (read-only): list │ preview. rollout_summaries/ opens into its file list */
export function CodexMemory({ entries }: { entries: CodexMemoryEntry[] }): React.JSX.Element {
  const { t } = useTranslation()
  const [rel, setRel] = useState<string | null>(
    entries.find((e) => e.kind === 'file')?.name ?? null
  )
  const [inRollouts, setInRollouts] = useState(false)
  const [rollouts, setRollouts] = useState<CodexRolloutSummary[] | null>(null)
  const [rolloutErr, setRolloutErr] = useState<string | null>(null)
  const openRollouts = (): void => {
    setInRollouts(true)
    setRel(null)
    setRolloutErr(null)
    void window.api.codexRollouts().then((r) => {
      if (r.ok) setRollouts(r.value)
      else setRolloutErr(t(`libError.${r.code}`, { defaultValue: r.code }))
    })
  }
  if (entries.length === 0) return <EmptyState title={t('common.noResults')} />
  const dirName = `${ROLLOUT_DIR}/`
  return (
    <Box style={{ flex: 1, minHeight: 0, display: 'flex', gap: 14 }}>
      <Box
        className="ac-card"
        style={{
          width: 340,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
        data-testid="codex-memory"
      >
        {inRollouts ? (
          <>
            <Group
              gap="xs"
              p="sm"
              wrap="nowrap"
              style={{ borderBottom: '1px solid var(--ac-border-subtle)' }}
            >
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                onClick={() => {
                  setInRollouts(false)
                  setRel(null)
                }}
                aria-label={t('common.back')}
                data-testid="codex-rollouts-back"
              >
                <ArrowLeft size={16} />
              </ActionIcon>
              <Text size="sm" fw={600} ff="monospace">
                {dirName}
              </Text>
              {rollouts && (
                <Badge variant="default" size="sm" fw={600} c="dimmed">
                  {rollouts.length}
                </Badge>
              )}
            </Group>
            <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {rolloutErr ? (
                <ErrorAlert message={rolloutErr} />
              ) : !rollouts ? (
                <Loading />
              ) : (
                rollouts.map((f) => (
                  <CodexRow
                    key={f.name}
                    name={f.name}
                    value={`${fmtSize(f.bytes)} · ${fmtTime(f.updatedAt)}`}
                    active={rel === `${ROLLOUT_DIR}/${f.name}`}
                    onClick={() => setRel(`${ROLLOUT_DIR}/${f.name}`)}
                    testId="codex-rollout"
                  />
                ))
              )}
            </Box>
          </>
        ) : (
          <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {entries.map((e) =>
              e.kind === 'dir' ? (
                <CodexRow
                  key={e.name}
                  name={dirName}
                  value={`${t('memory.fileCount', { n: e.files ?? 0 })} · ${fmtSize(e.bytes)} · ${fmtTime(e.updatedAt)}`}
                  active={false}
                  onClick={openRollouts}
                  testId="codex-entry"
                />
              ) : (
                <CodexRow
                  key={e.name}
                  name={e.name}
                  value={`${t('memory.lineCount', { n: (e.lines ?? 0).toLocaleString() })} · ${fmtSize(e.bytes)} · ${fmtTime(e.updatedAt)}`}
                  active={rel === e.name}
                  onClick={() => setRel(e.name)}
                  testId="codex-entry"
                />
              )
            )}
          </Box>
        )}
      </Box>
      {rel ? (
        <CodexPreview key={rel} rel={rel} onClose={() => setRel(null)} />
      ) : (
        <Box className="ac-card" style={{ flex: 1 }}>
          <EmptyState title={t('common.noSelection')} />
        </Box>
      )}
    </Box>
  )
}
