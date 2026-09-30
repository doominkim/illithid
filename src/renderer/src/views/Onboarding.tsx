import { useEffect, useState } from 'react'
import { Box, Button, Checkbox, Group, Stack, Stepper, Text, Title, UnstyledButton } from '@mantine/core'
import { ArchiveRestore, Download, FileArchive, GitBranch, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ImportSource, ToolDetection, ToolId } from '../../../shared/api'
import { ApplyPreviewBody } from '../components/ApplyPreviewModal'
import { ImportModal } from '../components/ImportModal'
import { Loading } from '../components/Layout'
import { ListCard, ListRow } from '../components/ListRow'
import { ToolIcon } from '../components/ToolIcon'
import { claudeCombos, ToolComboDialog } from '../components/ToolComboDialog'
import { runWrite } from '../lib/mutate'
import type { Menu } from '../lib/nav'
import { TOOL_NAME, TOOLS } from '../lib/tools'
import { clearApiCache } from '../lib/useApi'

type Mode = 'import' | 'fresh' | 'restore'

function Choice({ icon, label, onClick, testId }: { icon: React.ReactNode; label: string; onClick: () => void; testId: string }): React.JSX.Element {
  return (
    <UnstyledButton className="ac-card" data-clickable onClick={onClick} p="lg" data-testid={testId}>
      <Group gap={12} wrap="nowrap">
        <Box style={{ color: 'var(--ac-text-muted)', display: 'flex' }}>{icon}</Box>
        <Text fw={600} size="md">
          {label}
        </Text>
      </Group>
    </UnstyledButton>
  )
}

/**
 * First run (tools in use never chosen, library empty): start mode → tools in use → import or restore → apply preview.
 * Nothing is written to tools until Apply; Later keeps the library and the tool choice only.
 */
function Onboarding({ onDone }: { onDone: (menu?: Menu) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [step, setStep] = useState(0)
  const [mode, setMode] = useState<Mode | null>(null)
  const [detected, setDetected] = useState<ToolDetection[] | null>(null)
  const [sources, setSources] = useState<ImportSource[]>([])
  const [tools, setTools] = useState<ToolId[]>([])
  const [busy, setBusy] = useState(false)
  const [importFrom, setImportFrom] = useState<ToolId | null>(null)
  const [imported, setImported] = useState<Partial<Record<ToolId, number>>>({})

  useEffect(() => {
    window.api.detectTools().then(
      (d) => {
        setDetected(d)
        setTools(d.filter((x) => x.detected).map((x) => x.tool))
      },
      () => setDetected([])
    )
    window.api.importSources().then(setSources, () => {})
  }, [])

  const choose = (m: Mode): void => {
    setMode(m)
    setStep(1)
  }

  const [combo, setCombo] = useState<ToolId[]>([])
  const saveTools = async (list: ToolId[] = tools, asked = false): Promise<void> => {
    // Claude + a tool that also reads Claude's files: ask first
    if (!asked) {
      const c = claudeCombos([], list)
      if (c.length) {
        setCombo(c)
        return
      }
    }
    setTools(list)
    setBusy(true)
    const r = await runWrite(window.api.toolsInUseSet(list))
    setBusy(false)
    if (!r) return
    setStep(mode === 'fresh' ? 3 : 2)
  }

  const restoreZip = async (): Promise<void> => {
    setBusy(true)
    const w = await runWrite(window.api.workspaceImport())
    if (w) {
      // Switch only; the preview step decides whether anything reaches the tools
      const s = await runWrite(window.api.workspaceSwitch(w.id, false))
      if (s) setStep(3)
    }
    setBusy(false)
  }

  const sourceOf = (tool: ToolId): ImportSource | undefined => sources.find((s) => s.id === `tool:${tool}`)
  const detectedValue = (d: ToolDetection): string =>
    [d.configFound ? sourceOf(d.tool)?.path : undefined, d.executable].filter(Boolean).join(' · ')

  return (
    <Box style={{ height: '100dvh', overflow: 'auto' }} data-testid="onboarding">
      <Box mx="auto" maw={720} px={20} pt={64} pb={32}>
        <Stack gap="xl">
          <Title order={2}>{t('onboarding.title')}</Title>
          <Stepper active={step} size="xs">
            <Stepper.Step label={t('onboarding.stepStart')} />
            <Stepper.Step label={t('onboarding.stepTools')} />
            <Stepper.Step label={mode === 'restore' ? t('onboarding.stepRestore') : t('onboarding.stepImport')} />
            <Stepper.Step label={t('onboarding.stepApply')} />
          </Stepper>

          {step === 0 && (
            <Stack gap="sm">
              <Choice icon={<Download size={20} />} label={t('onboarding.modeImport')} onClick={() => choose('import')} testId="onboarding-mode-import" />
              <Choice icon={<Sparkles size={20} />} label={t('onboarding.modeFresh')} onClick={() => choose('fresh')} testId="onboarding-mode-fresh" />
              <Choice icon={<ArchiveRestore size={20} />} label={t('onboarding.modeRestore')} onClick={() => choose('restore')} testId="onboarding-mode-restore" />
            </Stack>
          )}

          {step === 1 &&
            (!detected ? (
              <Loading />
            ) : (
              <Stack gap="md">
                <ListCard>
                  {TOOLS.map((tool) => {
                    const d = detected.find((x) => x.tool === tool)
                    return (
                      <ListRow
                        key={tool}
                        avatar={
                          <Group gap={10} wrap="nowrap">
                            <Checkbox
                              checked={tools.includes(tool)}
                              onChange={({ currentTarget: { checked } }) => setTools((xs) => TOOLS.filter((x) => (x === tool ? checked : xs.includes(x))))}
                              aria-label={TOOL_NAME[tool]}
                              data-testid={`onboarding-tool-${tool}`}
                            />
                            <ToolIcon tool={tool} size={22} />
                          </Group>
                        }
                        title={TOOL_NAME[tool]}
                        subtitle={d?.detected ? detectedValue(d) : t('onboarding.notDetected')}
                      />
                    )
                  })}
                </ListCard>
                <Group justify="space-between">
                  <Button variant="default" onClick={() => setStep(0)}>
                    {t('common.back')}
                  </Button>
                  <Button disabled={!tools.length} loading={busy} onClick={() => void saveTools()} data-testid="onboarding-tools-next">
                    {t('onboarding.next')}
                  </Button>
                </Group>
              </Stack>
            ))}

          {step === 2 && mode === 'import' && (
            <Stack gap="md">
              <ListCard>
                {tools.map((tool) => {
                  const src = sourceOf(tool)
                  const n = imported[tool]
                  return (
                    <ListRow
                      key={tool}
                      avatar={<ToolIcon tool={tool} size={22} />}
                      title={TOOL_NAME[tool]}
                      subtitle={n !== undefined ? t('onboarding.imported', { n }) : src?.available ? src.path : t('import.sourceMissing')}
                      right={
                        <Button size="xs" variant="default" leftSection={<Download size={13} />} disabled={!src?.available} onClick={() => setImportFrom(tool)} data-testid={`onboarding-import-${tool}`}>
                          {t('common.import')}
                        </Button>
                      }
                    />
                  )
                })}
              </ListCard>
              <Group justify="space-between">
                <Button variant="default" onClick={() => setStep(1)}>
                  {t('common.back')}
                </Button>
                <Button onClick={() => setStep(3)} data-testid="onboarding-import-next">
                  {t('onboarding.next')}
                </Button>
              </Group>
              <ImportModal
                opened={!!importFrom}
                onClose={() => setImportFrom(null)}
                initialSource={importFrom ? `tool:${importFrom}` : undefined}
                tools={tools}
                onImported={(rs) => {
                  clearApiCache()
                  if (importFrom) setImported((m) => ({ ...m, [importFrom]: (m[importFrom] ?? 0) + rs.filter((r) => r.status === 'imported').length }))
                }}
              />
            </Stack>
          )}

          {step === 2 && mode === 'restore' && (
            <Stack gap="md">
              <Choice icon={<FileArchive size={20} />} label={t('onboarding.restoreZip')} onClick={() => void restoreZip()} testId="onboarding-restore-zip" />
              <Choice icon={<GitBranch size={20} />} label={t('onboarding.restoreBackup')} onClick={() => onDone('backup')} testId="onboarding-restore-backup" />
              <Group>
                <Button variant="default" onClick={() => setStep(1)} disabled={busy}>
                  {t('common.back')}
                </Button>
              </Group>
            </Stack>
          )}

          {step === 3 && (
            <ApplyPreviewBody cancelLabel={t('onboarding.later')} onCancel={() => onDone()} onDone={() => onDone()} doneLabel={t('onboarding.finish')} />
          )}
        </Stack>
      </Box>
      <ToolComboDialog
        tools={combo}
        onCancel={() => setCombo([])}
        onBoth={({ grokSkipsClaude }) => {
          setCombo([])
          void (async () => {
            if (grokSkipsClaude && !(await runWrite(window.api.configSet({ grokReadsClaude: false })))) return
            await saveTools(tools, true)
          })()
        }}
        onDropClaude={() => {
          setCombo([])
          void saveTools(tools.filter((x) => x !== 'claude'), true)
        }}
      />
    </Box>
  )
}

export default Onboarding
