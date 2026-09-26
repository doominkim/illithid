import { useState } from 'react'
import { Alert, Badge, Box, Button, Group, MantineColorScheme, NumberInput, SegmentedControl, Select, Stack, Switch, Text, useMantineColorScheme } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { Command, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ConfirmModal } from '../components/ConfirmModal'
import { PageHeader, SectionTitle } from '../components/PageHeader'
import { useReload } from '../components/ReloadButton'
import { LANGUAGES, Language, setLanguage } from '../i18n'
import { useConfig } from '../lib/config'
import { fmtSize } from '../lib/format'
import { runWrite } from '../lib/mutate'

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }): React.JSX.Element {
  return (
    <Box>
      <SectionTitle right={right}>{title}</SectionTitle>
      <Box className="ac-card" p="lg">
        {children}
      </Box>
    </Box>
  )
}

function Row({ label, hint, control }: { label: string; hint?: React.ReactNode; control: React.ReactNode }): React.JSX.Element {
  return (
    <Group justify="space-between" wrap="nowrap" gap="lg" py={6} align="flex-start">
      <Box style={{ minWidth: 0, flex: 1 }}>
        <Text size="md" fw={500}>
          {label}
        </Text>
        {hint && (
          <Text size="sm" c="dimmed" component="div">
            {hint}
          </Text>
        )}
      </Box>
      <Box style={{ flexShrink: 0 }}>{control}</Box>
    </Group>
  )
}

const RETENTION_DEFAULT = { enabled: true, days: 30, keepRollback: 3 }

/** Backup cleanup: settings are saved immediately (numbers on blur); "clean up now" confirms with the planned count and size */
function BackupCleanup(): React.JSX.Element {
  const { t } = useTranslation()
  const { config, refresh } = useConfig()
  const saved = { ...RETENTION_DEFAULT, ...(config?.config.backupRetention ?? {}) }
  // Number drafts while typing (null = saved value)
  const [days, setDays] = useState<number | null>(null)
  const [keep, setKeep] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ count: number; bytes: number } | null>(null)

  const save = async (patch: Partial<typeof RETENTION_DEFAULT>): Promise<void> => {
    const next = { ...saved, ...patch }
    if (next.enabled === saved.enabled && next.days === saved.days && next.keepRollback === saved.keepRollback) return
    setBusy(true)
    const r = await runWrite(window.api.configSet({ backupRetention: next }), { success: t('settings.saved') })
    setBusy(false)
    if (r) refresh()
  }
  const commit = async (patch: Partial<typeof RETENTION_DEFAULT>): Promise<void> => {
    await save(patch)
    setDays(null)
    setKeep(null)
  }
  const int = (v: string | number, min: number, max: number, fallback: number): number => {
    const n = typeof v === 'number' ? v : parseInt(v, 10)
    return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback
  }
  const check = async (): Promise<void> => {
    setBusy(true)
    const r = await runWrite(window.api.backupCleanupPreview())
    setBusy(false)
    if (!r) return
    if (!r.count) notifications.show({ color: 'accent', message: t('settings.cleanupNothing'), autoClose: 2000 })
    else setPreview(r)
  }
  const run = async (): Promise<void> => {
    setBusy(true)
    const r = await runWrite(window.api.backupCleanupRun())
    setBusy(false)
    setPreview(null)
    if (!r) return
    if (r.failed.length)
      notifications.show({ color: 'red', title: t('settings.cleanupFailed', { count: r.failed.length }), message: r.failed.map((f) => `${f.path} (${f.reason})`).join(' · ') })
    if (r.moved) notifications.show({ color: 'accent', message: t('settings.cleanupDone', { count: r.moved, size: fmtSize(r.bytes) }), autoClose: 3000 })
  }

  return (
    <Section title={t('settings.cleanup')}>
      <Row
        label={t('settings.cleanupEnabled')}
        control={<Switch size="md" checked={saved.enabled} disabled={!config || busy} onChange={(e) => void save({ enabled: e.currentTarget.checked })} data-testid="cleanup-enabled" />}
      />
      <Row
        label={t('settings.cleanupDays')}
        control={
          <NumberInput w={110} min={1} max={3650} allowDecimal={false} value={days ?? saved.days} disabled={!config} onChange={(v) => setDays(int(v, 1, 3650, saved.days))} onBlur={() => void commit({ days: days ?? saved.days })} />
        }
      />
      <Row
        label={t('settings.cleanupKeepRollback')}
        control={
          <NumberInput w={110} min={1} max={100} allowDecimal={false} value={keep ?? saved.keepRollback} disabled={!config} onChange={(v) => setKeep(int(v, 1, 100, saved.keepRollback))} onBlur={() => void commit({ keepRollback: keep ?? saved.keepRollback })} />
        }
      />
      <Row
        label={t('settings.cleanupNow')}
        control={
          <Button variant="default" size="xs" loading={busy} disabled={!config} onClick={() => void check()} data-testid="cleanup-now">
            {t('settings.cleanupNow')}
          </Button>
        }
      />
      <ConfirmModal
        opened={!!preview}
        onClose={() => setPreview(null)}
        onConfirm={run}
        loading={busy}
        danger
        title={t('settings.cleanupConfirmTitle')}
        confirmLabel={t('settings.cleanupConfirm')}
        message={preview ? t('settings.cleanupConfirmBody', { count: preview.count, size: fmtSize(preview.bytes) }) : ''}
      />
    </Section>
  )
}

function Settings(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { colorScheme, setColorScheme } = useMantineColorScheme()
  const { config, allowRealApply, refresh } = useConfig()
  const reload = useReload()
  const [confirmApply, setConfirmApply] = useState(false)
  const [saving, setSaving] = useState<'apply' | null>(null)

  const save = async (patch: Parameters<typeof window.api.configSet>[0], what: 'apply'): Promise<void> => {
    setSaving(what)
    const r = await runWrite(window.api.configSet(patch), { success: t('settings.saved') })
    setSaving(null)
    if (r) {
      refresh()
      reload()
    }
  }

  return (
    <Stack gap="lg" maw={820}>
      <PageHeader title={t('nav.settings')} />
      {config?.fixture && (
        <Alert color="yellow" variant="light" radius="lg" title={t('settings.fixtureTitle')}>
          {t('settings.fixtureBody', { home: config.home })}
        </Alert>
      )}
      {config?.error && (
        <Alert color="red" variant="light" radius="lg">
          {t('settings.configError', { error: config.error })}
        </Alert>
      )}

      <Section title={t('settings.appearance')}>
        <Row
          label={t('settings.language')}
          control={<Select w={180} data={LANGUAGES.map((l) => ({ value: l.value, label: l.label }))} value={i18n.resolvedLanguage} onChange={(value) => value && setLanguage(value as Language)} allowDeselect={false} />}
        />
        <Row
          label={t('settings.theme')}
          control={
            <SegmentedControl
              value={colorScheme}
              onChange={(value) => setColorScheme(value as MantineColorScheme)}
              data={[
                { value: 'light', label: t('settings.themeLight') },
                { value: 'dark', label: t('settings.themeDark') },
                { value: 'auto', label: t('settings.themeAuto') }
              ]}
            />
          }
        />
        <Row
          label={t('settings.shortcuts')}
          control={
            <Group gap={4}>
              <Badge variant="default" size="sm" fw={500} leftSection={<Command size={10} />}>
                K
              </Badge>
              <Text size="sm" c="dimmed">
                {t('settings.shortcutSearch')}
              </Text>
            </Group>
          }
        />
      </Section>


      <Section
        title={t('settings.apply')}
        right={
          allowRealApply ? (
            <Badge variant="light" color="red" size="xs" fw={500} leftSection={<ShieldAlert size={10} />}>
              {t('settings.applyOn')}
            </Badge>
          ) : undefined
        }
      >
        <Row
          label={t('settings.allowApply')}
          control={
            <Switch
              size="md"
              checked={allowRealApply}
              disabled={!config || saving === 'apply'}
              onChange={(e) => {
                if (e.currentTarget.checked) setConfirmApply(true)
                else void save({ allowRealApply: false }, 'apply')
              }}
              data-testid="allow-apply"
            />
          }
        />
      </Section>

      <BackupCleanup />

      <ConfirmModal
        opened={confirmApply}
        onClose={() => setConfirmApply(false)}
        onConfirm={async () => {
          setConfirmApply(false)
          await save({ allowRealApply: true }, 'apply')
        }}
        danger
        title={t('settings.allowApply')}
        confirmLabel={t('settings.allowApplyConfirm')}
        message={t('settings.allowApplyBody')}
      />
    </Stack>
  )
}

export default Settings
