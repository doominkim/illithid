import { useState } from 'react'
import { Alert, Badge, Box, Group, MantineColorScheme, SegmentedControl, Select, Stack, Switch, Text, useMantineColorScheme } from '@mantine/core'
import { Command, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ConfirmModal } from '../components/ConfirmModal'
import { PageHeader, SectionTitle } from '../components/PageHeader'
import { useReload } from '../components/ReloadButton'
import { LANGUAGES, Language, setLanguage } from '../i18n'
import { useConfig } from '../lib/config'
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
