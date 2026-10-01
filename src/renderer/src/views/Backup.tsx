import { useEffect, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Group,
  Stack,
  Switch,
  Text,
  TextInput
} from '@mantine/core'
import {
  Check,
  CircleOff,
  Cloud,
  CloudUpload,
  History,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Unplug
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BackupStatusView, Snapshot } from '../../../shared/api'
import { ConfirmModal } from '../components/ConfirmModal'
import { EmptyState } from '../components/EmptyState'
import { Loading } from '../components/Layout'
import { ListCard, ListRow } from '../components/ListRow'
import { PageHeader } from '../components/PageHeader'
import { useReload } from '../lib/reload'
import { fmtTime } from '../lib/format'
import { runWrite } from '../lib/mutate'
import { useSync } from '../lib/sync'

function Card({
  title,
  icon,
  children,
  right,
  tone
}: {
  title: string
  icon: React.ReactNode
  children?: React.ReactNode
  right?: React.ReactNode
  tone?: 'ok'
}): React.JSX.Element {
  return (
    <Box
      className="ac-card"
      p="lg"
      style={
        tone === 'ok'
          ? { background: 'var(--ac-accent-bg)', borderColor: 'var(--ac-accent)' }
          : undefined
      }
    >
      <Group justify="space-between" mb="sm" wrap="nowrap">
        <Group gap={8} wrap="nowrap">
          <span
            style={{
              color: tone === 'ok' ? 'var(--ac-accent)' : 'var(--ac-text-muted)',
              display: 'inline-flex'
            }}
          >
            {icon}
          </span>
          <Text fw={600} size="lg">
            {title}
          </Text>
        </Group>
        {right}
      </Group>
      {children}
    </Box>
  )
}

/** Backup screen (modeled on Skills Manager Backup). Placeholder only until engine backup.ts exists */
function Backup(): React.JSX.Element {
  const { t } = useTranslation()
  const reload = useReload()
  const { openPreview } = useSync()
  const [st, setSt] = useState<BackupStatusView | null>(null)
  const [history, setHistory] = useState<Snapshot[]>([])
  const [snapshotFirst, setSnapshotFirst] = useState(true)
  const [url, setUrl] = useState('')
  const [device, setDevice] = useState('')
  const [editingDevice, setEditingDevice] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [restore, setRestore] = useState<Snapshot | null>(null)
  const [disconnect, setDisconnect] = useState(false)

  const load = (): void => {
    window.api.backupStatus().then((s) => {
      setSt(s)
      setUrl(s.remoteUrl ?? '')
      setDevice(s.deviceName)
    })
    window.api.backupHistory().then((r) => setHistory('ok' in r && r.ok ? r.value : []))
  }
  useEffect(load, [])

  const run = async <T,>(
    key: string,
    p: Promise<
      import('../../../shared/api').WriteResult<T> | import('../../../shared/api').Refused
    >,
    success?: string
  ): Promise<T | null> => {
    setBusy(key)
    const r = await runWrite(p, { success, invalidate: false })
    setBusy(null)
    load()
    return r
  }

  if (!st) return <Loading />
  const na = !st.libraryExists
  const connected = st.initialized && !!st.remoteUrl

  return (
    <Stack gap={0}>
      <PageHeader
        title={t('nav.backup')}
        actions={
          <Button variant="default" size="xs" leftSection={<RefreshCw size={13} />} onClick={load}>
            {t('common.reload')}
          </Button>
        }
      />
      <Stack gap="lg">
        {st.error && (
          <Alert color="yellow" variant="light" radius="lg">
            {st.error}
          </Alert>
        )}
        {na && (
          <Alert color="gray" variant="light" radius="lg" title={t('sync.libraryMissing')}>
            {t('backup.needLibrary')}
          </Alert>
        )}
        <Stack gap="md" maw={760}>
          <Card
            title={
              connected && !st.dirty
                ? t('backup.backedUp')
                : connected
                  ? t('backup.dirty')
                  : t('backup.notBackedUp')
            }
            icon={connected && !st.dirty ? <ShieldCheck size={18} /> : <CircleOff size={18} />}
            tone={connected && !st.dirty ? 'ok' : undefined}
            right={
              <Button
                leftSection={<CloudUpload size={14} />}
                disabled={na || !st.initialized}
                loading={busy === 'snap'}
                onClick={() =>
                  void run('snap', window.api.backupSnapshot(), t('backup.snapshotDone'))
                }
                data-testid="backup-now"
              >
                {t('backup.now')}
              </Button>
            }
          >
            <Stack gap={8}>
              <Text size="sm" c="dimmed">
                {st.lastSnapshot
                  ? t('backup.latest', {
                      title: st.lastSnapshot.message,
                      at: fmtTime(st.lastSnapshot.at)
                    })
                  : t('backup.noSnapshot')}
                {connected && (st.ahead || st.behind)
                  ? ` · ${t('backup.aheadBehind', { ahead: st.ahead, behind: st.behind })}`
                  : ''}
              </Text>
              <Group gap="xl" wrap="wrap">
                <Box>
                  <Text size="xs" c="dimmed">
                    {t('backup.repo')}
                  </Text>
                  <Text size="sm" ff="monospace" truncate="end" maw={420}>
                    {st.remoteUrl ?? '—'}
                  </Text>
                </Box>
                <Box>
                  <Text size="xs" c="dimmed">
                    {t('backup.branch')}
                  </Text>
                  <Text size="sm" ff="monospace">
                    {st.branch ?? '—'}
                  </Text>
                </Box>
                <Box>
                  <Text size="xs" c="dimmed">
                    {t('backup.device')}
                  </Text>
                  {editingDevice ? (
                    <Group gap={4} wrap="nowrap">
                      <TextInput
                        size="xs"
                        value={device}
                        onChange={(e) => setDevice(e.currentTarget.value)}
                        w={180}
                      />
                      <ActionIcon
                        size="sm"
                        variant="filled"
                        onClick={() =>
                          void run(
                            'device',
                            window.api.backupSetDevice(device.trim()),
                            t('settings.saved')
                          ).then(() => setEditingDevice(false))
                        }
                        disabled={na}
                        aria-label={t('common.save')}
                      >
                        <Check size={12} />
                      </ActionIcon>
                    </Group>
                  ) : (
                    <Group gap={4} wrap="nowrap">
                      <Text size="sm">{st.deviceName}</Text>
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        color="gray"
                        onClick={() => setEditingDevice(true)}
                        disabled={na}
                        aria-label={t('common.edit')}
                      >
                        <Pencil size={11} />
                      </ActionIcon>
                    </Group>
                  )}
                </Box>
              </Group>
            </Stack>
          </Card>

          <Card title={t('backup.connection')} icon={<Cloud size={18} />}>
            <Group gap={6} wrap="nowrap">
              <TextInput
                style={{ flex: 1 }}
                value={url}
                onChange={(e) => setUrl(e.currentTarget.value)}
                placeholder="https://github.com/<user>/<repo>.git"
                ff="monospace"
                disabled={na}
                data-testid="backup-url"
              />
              <Button
                leftSection={<Save size={13} />}
                disabled={na || !url.trim()}
                loading={busy === 'connect'}
                onClick={() =>
                  void run('connect', window.api.backupConnect(url.trim()), t('backup.connected'))
                }
                data-testid="backup-connect"
              >
                {t('common.save')}
              </Button>
            </Group>
          </Card>

          <Card
            title={t('backup.history')}
            icon={<History size={18} />}
            right={
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<RefreshCw size={11} />}
                onClick={load}
              >
                {t('common.reload')}
              </Button>
            }
          >
            <ListCard>
              {history.length === 0 ? (
                <EmptyState title={t('backup.noSnapshot')} />
              ) : (
                history.map((h) => (
                  <ListRow
                    key={h.hash}
                    title={h.message}
                    subtitle={`${h.device} · ${h.hash.slice(0, 7)} · ${fmtTime(h.at)}`}
                    right={
                      <Button
                        size="compact-xs"
                        variant="default"
                        leftSection={<RotateCcw size={11} />}
                        onClick={() => setRestore(h)}
                        disabled={na}
                        data-testid={`backup-restore-${h.hash.slice(0, 7)}`}
                      >
                        {t('backup.restore')}
                      </Button>
                    }
                  />
                ))
              )}
            </ListCard>
          </Card>

          <Card title={t('backup.scope')} icon={<ShieldCheck size={18} />}>
            <Stack gap={6}>
              {(['rules', 'skills', 'mcp', 'memory', 'permissions', 'toggles'] as const).map(
                (k) => (
                  <Group key={k} gap={8} wrap="nowrap">
                    <Check size={14} style={{ color: 'var(--ac-accent)', flexShrink: 0 }} />
                    <Text size="sm">{t(`backup.scopeIn.${k}`)}</Text>
                  </Group>
                )
              )}
              {(['secrets', 'machine'] as const).map((k) => (
                <Group key={k} gap={8} wrap="nowrap">
                  <CircleOff size={14} style={{ color: 'var(--ac-text-muted)', flexShrink: 0 }} />
                  <Text size="sm" c="dimmed">
                    {t(`backup.scopeOut.${k}`)}
                  </Text>
                </Group>
              ))}
            </Stack>
          </Card>
          <Card
            title={t('backup.auto')}
            icon={<RefreshCw size={18} />}
            right={
              <Switch
                size="md"
                checked={st.autoBackup}
                disabled={na || !st.initialized}
                onChange={(e) =>
                  void run('auto', window.api.backupSetAuto(e.currentTarget.checked))
                }
                data-testid="backup-auto"
              />
            }
          >
            <Text size="sm" c="dimmed">
              {t('backup.autoHint')}
            </Text>
          </Card>
          <Card title={t('backup.disconnectTitle')} icon={<Unplug size={18} />}>
            <Text size="sm" c="dimmed" mb="sm">
              {t('backup.disconnectBody')}
            </Text>
            <Button
              variant="default"
              leftSection={<Unplug size={13} />}
              disabled={na || !st.initialized}
              onClick={() => setDisconnect(true)}
            >
              {t('backup.disconnect')}
            </Button>
          </Card>
        </Stack>

        <ConfirmModal
          opened={!!restore}
          onClose={() => setRestore(null)}
          onConfirm={async () => {
            if (!restore) return
            const r = await run(
              'restore',
              window.api.backupRestore(restore.hash, st.dirty && snapshotFirst),
              t('backup.restored')
            )
            setRestore(null)
            if (r) {
              reload()
              openPreview()
            }
          }}
          danger
          loading={busy === 'restore'}
          title={t('backup.restore')}
          confirmLabel={t('backup.restore')}
          message={
            <Stack gap="xs">
              <Text size="md">
                {t('backup.restoreBody', {
                  id: `${restore?.message ?? ''} (${restore?.hash.slice(0, 7) ?? ''})`
                })}
              </Text>
              {st.dirty && (
                <Switch
                  size="sm"
                  checked={snapshotFirst}
                  onChange={(e) => setSnapshotFirst(e.currentTarget.checked)}
                  label={t('backup.snapshotFirst')}
                  description={t('backup.snapshotFirstHint')}
                />
              )}
            </Stack>
          }
        />
        <ConfirmModal
          opened={disconnect}
          onClose={() => setDisconnect(false)}
          onConfirm={async () => {
            await run('disconnect', window.api.backupDisconnect(), t('backup.disconnected'))
            setDisconnect(false)
          }}
          danger
          loading={busy === 'disconnect'}
          title={t('backup.disconnectTitle')}
          confirmLabel={t('backup.disconnect')}
          message={t('backup.disconnectBody')}
        />
      </Stack>
    </Stack>
  )
}

export default Backup
