import { useEffect, useState } from 'react'
import { Alert, Box, Button, Group, Menu, Stack, Text, TextInput } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import type { GitHubLoginView } from '../../../engine/githubBackup'
import { ConfirmModal } from './ConfirmModal'

/** Login is separate from installation and from the explicit creation of a private repository. */
export function GithubBackupConnection({
  disabled,
  onConnectUrl,
  onConnected
}: {
  disabled: boolean
  onConnectUrl: (url: string) => Promise<boolean>
  onConnected: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [view, setView] = useState<GitHubLoginView | null>(null)
  const [name, setName] = useState('illithid-backup')
  const [existingUrl, setExistingUrl] = useState('')
  const [busyAction, setBusyAction] = useState<'create' | 'connect' | 'finish' | 'other' | null>(
    null
  )
  const busy = busyAction !== null
  const [error, setError] = useState('')
  const [created, setCreated] = useState(false)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    let alive = true
    void window.api
      .githubLoginStatus()
      .then((r) => {
        if (!alive) return
        if (r.ok) setView(r.value)
        else {
          setView({ configured: true, phase: 'signedOut' })
          setError(r.code)
        }
      })
      .catch(() => {
        if (!alive) return
        setView({ configured: true, phase: 'signedOut' })
        setError('githubUnavailable')
      })
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    if (view?.phase !== 'pending') return
    let alive = true
    const timer = setInterval(() => {
      void window.api
        .githubLoginPoll()
        .then((r) => {
          if (!alive) return
          if (r.ok) setView(r.value)
          else setError(r.code)
        })
        .catch(() => {
          if (alive) setError('githubUnavailable')
        })
    }, 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [view?.phase])
  const run = async (
    action: () => Promise<void>,
    operation: 'create' | 'connect' | 'finish' | 'other' = 'other'
  ): Promise<void> => {
    setBusyAction(operation)
    setError('')
    try {
      await action()
    } catch {
      setError('githubUnavailable')
    } finally {
      setBusyAction(null)
    }
  }
  const login = async (): Promise<void> => {
    const r = await window.api.githubLoginStart()
    if (r.ok) setView(r.value)
    else setError(r.code)
  }
  const connect = async (repository = name): Promise<void> => {
    const r = await window.api.githubRepositoryConnect(repository)
    if ('ok' in r && r.ok) onConnected()
    else setError('code' in r ? r.code : 'connectionFailed')
  }
  const openAccess = async (): Promise<void> => {
    const r = await window.api.githubInstallationOpen()
    if (!r.ok) setError(r.code)
  }
  if (!view) return <></>
  const needsAccess = error === 'permissionDenied' || error === 'installationRequired'
  return (
    <Stack gap="sm" data-testid="github-backup-connection">
      <Text size="sm" c="dimmed">
        {t('backup.github.setupHint')}
      </Text>
      {!view.configured && (
        <Text size="sm" c="dimmed">
          {t('backup.github.notConfigured')}
        </Text>
      )}
      {(error || view.error) && (
        <Alert color="yellow">
          <Stack gap="sm">
            <Text size="sm">
              {t(`backup.github.errors.${error || view.error}`, {
                defaultValue: t('backup.github.errors.githubUnavailable')
              })}
            </Text>
            {needsAccess && (
              <Button
                variant="light"
                disabled={busy || disabled}
                style={{ alignSelf: 'flex-start' }}
                onClick={() => void run(openAccess)}
                data-testid="github-allow-access"
              >
                {t('backup.github.allowAccess')}
              </Button>
            )}
          </Stack>
        </Alert>
      )}
      {view.phase === 'signedOut' && (
        <Button
          disabled={disabled || !view.configured}
          loading={busy}
          style={{ alignSelf: 'flex-start' }}
          onClick={() => void run(login)}
          data-testid="github-sign-in"
        >
          {t('backup.github.signIn')}
        </Button>
      )}
      {view.phase === 'pending' && (
        <>
          <Text size="sm">{t('backup.github.enterCode')}</Text>
          <Text fw={700} ff="monospace" size="xl" data-testid="github-user-code">
            {view.userCode}
          </Text>
          <Button
            variant="default"
            style={{ alignSelf: 'flex-start' }}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await window.api.githubLoginCancel()
                if (r.ok) setView(r.value)
                else setError(r.code)
              })
            }
          >
            {t('common.cancel')}
          </Button>
        </>
      )}
      {view.phase === 'signedIn' && (
        <>
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {t('backup.github.signedIn', { login: view.login })}
            </Text>
            <Menu position="bottom-end">
              <Menu.Target>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  disabled={busy}
                  data-testid="github-account-menu"
                >
                  {t('backup.github.accountSettings')}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => void run(openAccess)}>
                  {t('backup.github.install')}
                </Menu.Item>
                <Menu.Item
                  onClick={() =>
                    void run(async () => {
                      const r = await window.api.githubLogout()
                      if (r.ok) {
                        setView(r.value)
                        setCreated(false)
                      } else setError(r.code)
                    })
                  }
                >
                  {t('backup.github.signOut')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
          <>
            {created ? (
              <>
                <Text size="sm">{t('backup.github.created')}</Text>
                <Text ff="monospace" size="sm">
                  {view.login}/{name}
                </Text>
                <Button
                  disabled={busy || disabled}
                  loading={busyAction === 'create' || busyAction === 'finish'}
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => void run(() => connect(), 'finish')}
                  data-testid="github-finish-setup"
                >
                  {t('backup.github.finishSetup')}
                </Button>
              </>
            ) : (
              <>
                <TextInput
                  label={t('backup.github.repositoryName')}
                  value={name}
                  onChange={(e) => setName(e.currentTarget.value)}
                  disabled={busy || disabled}
                  data-testid="github-repository-name"
                />
                <Button
                  disabled={busy || disabled || !name.trim()}
                  loading={busyAction === 'create'}
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => setConfirm(true)}
                  data-testid="github-create-repository"
                >
                  {t('backup.github.create')}
                </Button>
              </>
            )}
          </>
        </>
      )}
      <Box component="details" data-testid="backup-existing-url">
        <Text component="summary" size="sm" c="dimmed" style={{ cursor: 'pointer' }}>
          {t('backup.github.existingRepository')}
        </Text>
        <Stack gap="sm" mt="sm">
          <TextInput
            label={t('backup.github.existingUrl')}
            value={existingUrl}
            onChange={(e) => setExistingUrl(e.currentTarget.value)}
            disabled={busy || disabled}
            placeholder="https://github.com/<user>/<repo>.git"
            ff="monospace"
            data-testid="backup-url"
          />
          <Button
            variant="light"
            disabled={busy || disabled || !existingUrl.trim()}
            loading={busyAction === 'connect'}
            style={{ alignSelf: 'flex-start' }}
            onClick={() =>
              void run(async () => {
                const url = existingUrl.trim()
                const github = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(
                  url
                )
                if (
                  view.phase === 'signedIn' &&
                  github &&
                  github[1].toLowerCase() === view.login?.toLowerCase()
                ) {
                  await connect(github[2].replace(/\.git$/, ''))
                } else if (!(await onConnectUrl(url))) setError('connectionFailed')
              }, 'connect')
            }
            data-testid="backup-connect"
          >
            {t('backup.github.connect')}
          </Button>
        </Stack>
      </Box>
      <ConfirmModal
        opened={confirm}
        onClose={() => setConfirm(false)}
        title={t('backup.github.create')}
        message={t('backup.github.confirmCreate', { repository: `${view.login}/${name}` })}
        confirmLabel={t('backup.github.create')}
        onConfirm={async () => {
          setConfirm(false)
          await run(async () => {
            const r = await window.api.githubRepositoryCreate(name)
            if ('ok' in r && r.ok) {
              setCreated(true)
              await connect()
            } else setError('code' in r ? r.code : 'connectionFailed')
          }, 'create')
        }}
      />
    </Stack>
  )
}
