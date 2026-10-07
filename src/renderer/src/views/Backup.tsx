import { GithubBackupConnection } from '../components/GithubBackupConnection'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Badge,
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
  CloudDownload,
  CloudUpload,
  History,
  Pencil,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Unplug
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { notifications } from '@mantine/notifications'
import type { BackupStatusView, Snapshot } from '../../../shared/api'
import { ConfirmModal } from '../components/ConfirmModal'
import { EmptyState } from '../components/EmptyState'
import { Loading } from '../components/Layout'
import { ListCard, ListRow } from '../components/ListRow'
import { PageHeader } from '../components/PageHeader'
import { useReload } from '../lib/reload'
import { RefreshContext } from '../lib/useApi'
import { useConfig } from '../lib/config'
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

/** Local snapshot durability and remote upload are shown separately. */
function Backup(): React.JSX.Element {
  const { t } = useTranslation()
  const reload = useReload()
  const tick = useContext(RefreshContext)
  const { config } = useConfig()
  const loadRevision = useRef(0)
  const { openPreview } = useSync()
  const [st, setSt] = useState<BackupStatusView | null>(null)
  const [history, setHistory] = useState<Snapshot[]>([])
  const [snapshotFirst, setSnapshotFirst] = useState(true)
  const [device, setDevice] = useState('')
  const [editingDevice, setEditingDevice] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [restore, setRestore] = useState<Snapshot | null>(null)
  const [disconnect, setDisconnect] = useState(false)
  const [pullConfirm, setPullConfirm] = useState(false)

  const load = useCallback((): void => {
    const revision = ++loadRevision.current
    window.api.backupStatus().then((s) => {
      if (revision !== loadRevision.current) return
      setSt(s)
      setDevice(s.deviceName)
    })
    window.api.backupHistory().then((r) => {
      if (revision === loadRevision.current) setHistory('ok' in r && r.ok ? r.value : [])
    })
  }, [])
  const cancelLoad = useCallback((): void => {
    loadRevision.current++
  }, [])
  useEffect(() => {
    load()
    return cancelLoad
  }, [tick, config?.libraryRoot, load, cancelLoad])

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

  /** Take the remote backup. Without confirmation only an empty library or a fast-forward is accepted */
  const pull = async (replaceLocal: boolean): Promise<void> => {
    const r = await run('pull', window.api.backupPull(replaceLocal))
    if (!r) return
    if (r.outcome === 'confirmRequired') {
      setPullConfirm(true)
      return
    }
    setPullConfirm(false)
    notifications.show({
      color: 'accent',
      message: r.backupPath
        ? `${t('backup.pulled')} · ${t('backup.pulledBackupAt', { path: r.backupPath })}`
        : t('backup.pulled')
    })
    if (r.merged !== 'upToDate') {
      reload()
      openPreview()
    }
  }

  if (!st) return <Loading />
  const na = !st.libraryExists
  const connected = st.initialized && !!st.remoteUrl
  const needsPullConfirm = st.remoteError === 'localUnsaved' || st.remoteError === 'diverged'
  const replacedDir = '~/.config/illithid/backups/replaced'
  const remoteComplete =
    connected &&
    !!st.lastSnapshot &&
    !st.dirty &&
    st.ahead === 0 &&
    st.behind === 0 &&
    !st.remoteError
  const repositoryPage = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\.git$/.test(
    st.remoteUrl ?? ''
  )
    ? st.remoteUrl!.slice(0, -4)
    : null
  const connectionControls = (
    <GithubBackupConnection
      key={`${st.root}:${st.remoteUrl ?? ''}`}
      disabled={na || busy === 'connect' || busy === 'disconnect'}
      onConnected={load}
      onConnectUrl={async (url) =>
        !!(await run('connect', window.api.backupConnect(url), t('backup.connected')))
      }
    />
  )

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
        {st.remoteError && needsPullConfirm && (
          <Alert
            color="yellow"
            variant="light"
            radius="lg"
            title={t('backup.pullTitle')}
            data-testid="backup-pull-needed"
          >
            <Stack gap="xs" align="flex-start">
              <Text size="sm">{t('backup.pullBody', { dir: replacedDir })}</Text>
              <Button
                size="xs"
                leftSection={<CloudDownload size={13} />}
                disabled={na || !!busy}
                loading={busy === 'pull'}
                onClick={() => setPullConfirm(true)}
                data-testid="backup-pull-replace"
              >
                {t('backup.pullReplace')}
              </Button>
            </Stack>
          </Alert>
        )}
        {st.remoteError && !needsPullConfirm && (
          <Alert
            color="yellow"
            variant="light"
            radius="lg"
            title={t('backup.remoteFailed')}
            data-testid="backup-remote-error"
          >
            {st.remoteError}
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
              remoteComplete
                ? t('backup.backedUp')
                : st.dirty && st.initialized
                  ? t('backup.dirty')
                  : st.lastSnapshot
                    ? t(connected ? 'backup.remotePending' : 'backup.localSaved')
                    : t('backup.notBackedUp')
            }
            icon={remoteComplete ? <ShieldCheck size={18} /> : <CircleOff size={18} />}
            tone={remoteComplete ? 'ok' : undefined}
            right={
              <Group gap={6} wrap="nowrap">
                {connected && st.behind > 0 && !needsPullConfirm && (
                  <Button
                    variant="default"
                    leftSection={<CloudDownload size={14} />}
                    disabled={na || !!busy}
                    loading={busy === 'pull'}
                    onClick={() => void pull(false)}
                    data-testid="backup-pull"
                  >
                    {t('backup.pull')}
                  </Button>
                )}
                <Button
                  leftSection={<CloudUpload size={14} />}
                  disabled={na || !st.initialized}
                  loading={busy === 'snap'}
                  onClick={() =>
                    void run('snap', window.api.backupSnapshot()).then((saved) => {
                      if (saved)
                        notifications.show({
                          color: saved.remoteError ? 'yellow' : 'accent',
                          message: t(saved.pushed ? 'backup.snapshotDone' : 'backup.localSaved')
                        })
                    })
                  }
                  data-testid="backup-now"
                >
                  {t('backup.now')}
                </Button>
              </Group>
            }
          >
            <Stack gap={8}>
              {connected && (st.ahead > 0 || st.behind > 0) ? (
                <Text size="sm" c="dimmed" data-testid="backup-ahead-behind">
                  {st.lastSnapshot
                    ? t('backup.aheadBehind', { ahead: st.ahead, behind: st.behind })
                    : t('backup.behindHint', { n: st.behind })}
                </Text>
              ) : null}
              <Group gap="xl" wrap="wrap">
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
            {connected ? (
              <Stack gap="md">
                <Group justify="space-between" data-testid="backup-connected-summary">
                  <Text fw={500} size="sm" style={{ overflowWrap: 'anywhere' }}>
                    {repositoryPage
                      ? repositoryPage.replace('https://github.com/', '')
                      : st.remoteUrl}
                  </Text>
                  <Badge color="accent" variant="light">
                    {t('backup.connected')}
                  </Badge>
                </Group>
                <Button
                  variant="subtle"
                  color="gray"
                  leftSection={<Unplug size={13} />}
                  disabled={na || !!busy}
                  loading={busy === 'disconnect'}
                  onClick={() => setDisconnect(true)}
                  style={{ alignSelf: 'flex-start' }}
                >
                  {t('backup.disconnect')}
                </Button>
              </Stack>
            ) : (
              connectionControls
            )}
          </Card>

          <Card title={t('backup.history')} icon={<History size={18} />}>
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
          opened={pullConfirm}
          onClose={() => setPullConfirm(false)}
          onConfirm={() => pull(true)}
          danger
          loading={busy === 'pull'}
          title={t('backup.pullTitle')}
          confirmLabel={t('backup.pullReplace')}
          message={t('backup.pullBody', { dir: replacedDir })}
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
