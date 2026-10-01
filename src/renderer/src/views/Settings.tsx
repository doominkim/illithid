import { useEffect, useState } from 'react'
import { Alert, Badge, Box, Button, Group, MantineColorScheme, NumberInput, SegmentedControl, Select, Stack, Switch, Text, useMantineColorScheme } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { Command, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ConfirmModal } from '../components/ConfirmModal'
import { PageHeader, SectionTitle } from '../components/PageHeader'
import { useReload } from '../lib/reload'
import { LANGUAGES, Language, setLanguage } from '../i18n'
import { useConfig } from '../lib/config'
import { fmtSize } from '../lib/format'
import { LIBRARY_CHANGED, runWrite, UPDATE_NOTICE_REQUEST } from '../lib/mutate'
import { useSync } from '../lib/sync'
import { TOOL_NAME, TOOLS } from '../lib/tools'
import { ToolIcon } from '../components/ToolIcon'
import { ToolComboDialog } from '../components/ToolComboDialog'
import { claudeCombos } from '../lib/toolCombos'
import type { ToolId, ToolsInUseView, UpdateView } from '../../../shared/api'
import { DEFAULT_TOOLS_IN_USE } from '../../../engine/toolIds'

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

/** Tools in use: on or off → save → apply preview (on adds the library there, off removes the app's copies); cancel restores */
function ToolsInUse(): React.JSX.Element {
  const { t } = useTranslation()
  const { config, refresh } = useConfig()
  const { openPreview } = useSync()
  const reload = useReload()
  const [view, setView] = useState<ToolsInUseView | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    window.api.toolsInUseGet().then(setView, () => {})
  }, [])

  // Never chosen yet: inUse is already the default tools that look installed (engine toolsInUse) — the first change saves that list
  const detected = (tool: ToolId): boolean => !!view?.detected.find((d) => d.tool === tool)?.detected
  const shown: ToolId[] = view?.inUse ?? []
  // Claude + a tool that also reads Claude's files: the user picks (both, Claude off, cancel) before anything is saved
  const [combo, setCombo] = useState<{ next: ToolId[]; tools: ToolId[] } | null>(null)
  const set = async (tool: ToolId, on: boolean): Promise<void> => {
    if (!view) return
    const next = on ? TOOLS.filter((x) => x === tool || shown.includes(x)) : shown.filter((x) => x !== tool)
    const tools = on ? claudeCombos(shown, next) : []
    if (tools.length) {
      setCombo({ next, tools })
      return
    }
    await save(next)
  }
  /** `undo` also runs when the apply preview is cancelled (e.g. the combo dialog's Grok option) */
  const save = async (next: ToolId[], undo?: () => Promise<unknown>): Promise<void> => {
    if (!view) return
    if (view.configured && next.length === shown.length && next.every((x) => shown.includes(x))) return
    // Restored if the apply preview is dismissed: a never-saved list goes back to unset
    const previous = view.configured ? view.inUse : null
    const retiring = view.retiring
    setBusy(true)
    const r = await runWrite(window.api.toolsInUseSet(next), { success: t('settings.saved') })
    setBusy(false)
    if (!r) return
    setView(r)
    refresh()
    reload()
    window.dispatchEvent(new Event(LIBRARY_CHANGED))
    // Off works like on: the preview lists what leaves that tool (the app's copies); cancelling restores the list and what was retiring
    openPreview({
      onCancel: () =>
        void (async () => {
          await undo?.()
          await restore(previous, retiring)
        })()
    })
  }
  const restore = async (previous: ToolId[] | null, retiring: ToolId[]): Promise<void> => {
    setBusy(true)
    const r = await runWrite(window.api.toolsInUseSet(previous, retiring))
    setBusy(false)
    if (!r) return
    setView(r)
    refresh()
    reload()
    window.dispatchEvent(new Event(LIBRARY_CHANGED))
  }

  return (
    <Section title={t('settings.tools')}>
      {TOOLS.map((tool) => (
        <Group key={tool} justify="space-between" wrap="nowrap" gap="lg" py={6}>
          <Group gap={8} wrap="nowrap">
            <ToolIcon tool={tool} size={18} />
            <Box>
              <Text size="md" fw={500}>
                {TOOL_NAME[tool]}
              </Text>
              {view && !view.configured && DEFAULT_TOOLS_IN_USE.includes(tool) && !detected(tool) && (
                <Text size="xs" c="dimmed" data-testid={`tool-not-found-${tool}`}>
                  {t('onboarding.notDetected')}
                </Text>
              )}
              {tool === 'copilot' && (
                <Text size="xs" c="dimmed">
                  {t('settings.copilotDoubleLoad')}
                </Text>
              )}
              {tool === 'grok' && shown.includes('grok') && (shown.includes('claude') || !!view?.detected.find((d) => d.tool === 'claude')?.configFound) && (
                <>
                  <Text size="xs" c="dimmed" data-testid="grok-reads-claude">
                    {t(shown.includes('claude') ? 'settings.grokWithClaude' : 'settings.grokReadsClaude')}
                  </Text>
                  <GrokReadsClaude disabled={!view || busy} />
                </>
              )}
            </Box>
          </Group>
          <Switch size="md" checked={shown.includes(tool)} disabled={!view || busy} onChange={(e) => void set(tool, e.currentTarget.checked)} data-testid={`tool-in-use-${tool}`} />
        </Group>
      ))}
      <ToolComboDialog
        tools={combo?.tools ?? []}
        onCancel={() => setCombo(null)}
        onBoth={({ grokSkipsClaude }) => {
          const c = combo
          setCombo(null)
          if (!c) return
          void (async () => {
            if (!grokSkipsClaude) return save(c.next)
            const before = config?.config.grokReadsClaude
            if (!(await runWrite(window.api.configSet({ grokReadsClaude: false })))) return
            await save(c.next, () => runWrite(window.api.configSet({ grokReadsClaude: before })))
          })()
        }}
        onDropClaude={() => {
          const c = combo
          setCombo(null)
          if (c) void save(c.next.filter((x) => x !== 'claude'))
        }}
      />
    </Section>
  )
}

/**
 * Grok also reads Claude Code's skills and MCP servers: off writes [compat.claude] skills/mcps = false to ~/.grok/config.toml
 * (applied through the preview like any other change; cancelling restores the previous value)
 */
function GrokReadsClaude({ disabled }: { disabled: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const { config, refresh } = useConfig()
  const { openPreview } = useSync()
  const reload = useReload()
  const [busy, setBusy] = useState(false)
  const reads = config?.config.grokReadsClaude !== false
  const set = async (on: boolean): Promise<void> => {
    setBusy(true)
    const r = await runWrite(window.api.configSet({ grokReadsClaude: on ? undefined : false }), { success: t('settings.saved') })
    setBusy(false)
    if (!r) return
    refresh()
    reload()
    window.dispatchEvent(new Event(LIBRARY_CHANGED))
    openPreview({
      onCancel: () =>
        void (async () => {
          await runWrite(window.api.configSet({ grokReadsClaude: reads ? undefined : false }))
          refresh()
          reload()
          window.dispatchEvent(new Event(LIBRARY_CHANGED))
        })()
    })
  }
  return (
    <Switch
      mt={6}
      size="xs"
      checked={reads}
      disabled={disabled || busy}
      onChange={(e) => void set(e.currentTarget.checked)}
      label={t('settings.grokReadsClaudeOpt')}
      description={t('settings.grokReadsClaudeOptNote')}
      data-testid="grok-reads-claude-switch"
    />
  )
}

const RETENTION_DEFAULT = { enabled: true, days: 30, keepRollback: 3 }

/** Backup cleanup: settings are saved immediately (numbers on blur); "clean up now" confirms with the planned count and size */
/** Running version, a newer one if known, and Check now (opens the update notice or says it's up to date) */
function AppVersion(): React.JSX.Element {
  const { t } = useTranslation()
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateView | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    window.api.appVersion().then(setVersion, () => {})
    window.api.updateStatus().then(setUpdate, () => {})
    return window.api.onUpdateEvent(setUpdate)
  }, [])
  const check = async (): Promise<void> => {
    setChecking(true)
    let v: UpdateView | null
    try {
      v = await window.api.updateCheckNow()
    } catch {
      setChecking(false)
      notifications.show({ color: 'red', message: t('settings.checkFailed') })
      return
    }
    setChecking(false)
    setUpdate(v)
    if (v) window.dispatchEvent(new CustomEvent(UPDATE_NOTICE_REQUEST, { detail: v }))
    else notifications.show({ color: 'accent', message: t('settings.upToDate'), autoClose: 2500 })
  }
  return (
    <Row
      label={t('settings.version', { version })}
      hint={
        update ? (
          <Badge variant="light" color="accent" size="sm" fw={500} data-testid="update-available">
            {t('settings.updateAvailable', { version: update.version })}
          </Badge>
        ) : undefined
      }
      control={
        <Button size="xs" variant="default" loading={checking} onClick={() => void check()} data-testid="update-check-now">
          {t('settings.checkNow')}
        </Button>
      }
    />
  )
}

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
        hint={t('settings.cleanupEnabledHint')}
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
        hint={t('settings.cleanupNowHint')}
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
  const [saving, setSaving] = useState<'apply' | 'market' | 'update' | null>(null)

  const save = async (patch: Parameters<typeof window.api.configSet>[0], what: 'apply' | 'market' | 'update'): Promise<void> => {
    setSaving(what)
    const r = await runWrite(window.api.configSet(patch), { success: t('settings.saved') })
    setSaving(null)
    if (r) {
      refresh()
      reload()
    }
  }

  return (
    <Stack gap={0} maw={820}>
      <PageHeader title={t('nav.settings')} />
      <Stack gap="lg">
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
          control={<Select w={180} data={LANGUAGES.map((l) => ({ value: l.value, label: l.label }))} value={i18n.resolvedLanguage} onChange={(value) => value && setLanguage(value as Language)} allowDeselect={false} data-testid="settings-language" />}
        />
        <Row
          label={t('settings.theme')}
          hint={t('settings.themeHint')}
          control={
            <SegmentedControl
              value={colorScheme}
              onChange={(value) => setColorScheme(value as MantineColorScheme)}
              data-testid="settings-theme"
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


      <ToolsInUse />

      <Section title={t('nav.market')}>
        <Row
          label={t('settings.marketEnabled')}
          control={
            <Switch
              size="md"
              checked={config?.config.marketEnabled !== false}
              disabled={!config || saving === 'market'}
              onChange={(e) => void save({ marketEnabled: e.currentTarget.checked ? undefined : false }, 'market')}
              data-testid="market-enabled"
            />
          }
        />
      </Section>

      <Section title={t('settings.updates')}>
        <Row
          label={t('settings.updateCheck')}
          control={
            <Switch
              size="md"
              checked={config?.config.updateCheck !== false}
              disabled={!config || saving === 'update'}
              onChange={(e) => {
                const on = e.currentTarget.checked
                void save({ updateCheck: on ? undefined : false }, 'update')
              }}
              data-testid="update-check"
            />
          }
        />
        <AppVersion />
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
          hint={t('settings.allowApplyBody')}
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
    </Stack>
  )
}

export default Settings
