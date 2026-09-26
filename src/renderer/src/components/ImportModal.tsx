import { useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Box, Button, Checkbox, Group, Modal, Select, Stack, Stepper, Text, UnstyledButton } from '@mantine/core'
import { Download, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ImportCandidate, ImportKind, ImportPlanView, ImportResult, ImportSelection, ImportSource } from '../../../shared/api'
import { runWrite } from '../lib/mutate'
import { TOOL_NAME } from '../lib/tools'
import { EmptyState } from './EmptyState'
import { Loading } from './Layout'
import { ListCard, ListRow } from './ListRow'
import { ToolIcon } from './ToolIcon'

interface Props {
  opened: boolean
  onClose: () => void
  onImported: () => void
  /** Skip the source step and go straight to this source */
  initialSource?: string
  /** Import only this kind, and only from agent (tool) sources (per-menu import). All if omitted */
  kind?: ImportKind
}

/** Import: pick source → check candidates (confirm variants and replacements) → apply. Writes to the library only */
export function ImportModal({ opened, onClose, onImported, initialSource, kind }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [plan, setPlan] = useState<ImportPlanView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [variant, setVariant] = useState<Record<string, string>>({})
  const [replace, setReplace] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ImportResult[] | null>(null)

  useEffect(() => {
    if (!opened) return
    setSources(null)
    setPlan(null)
    setErr(null)
    setResults(null)
    setPicked({})
    setReplace({})
    setSourceId(initialSource ?? null)
    window.api
      .importSources()
      .then((xs) => setSources(kind ? xs.filter((x) => x.kind === 'tool' && x.kinds.includes(kind)) : xs), (e) => setErr(String(e)))
  }, [opened, initialSource, kind])

  useEffect(() => {
    if (!opened || !sourceId) return
    setPlan(null)
    setErr(null)
    let alive = true
    window.api.importPlan(sourceId).then((r) => {
      if (!alive) return
      if (r.ok) setPlan(r.value)
      else setErr(r.message)
    })
    return () => {
      alive = false
    }
  }, [opened, sourceId])

  const cands: ImportCandidate[] = useMemo(() => {
    if (!plan) return []
    const all = [...plan.rules, ...plan.memory, ...plan.permissions, ...plan.skills, ...plan.mcp, ...(plan.agents ?? [])]
    return kind ? all.filter((c) => c.kind === kind) : all
  }, [plan, kind])
  const key = (c: ImportCandidate): string => `${c.kind}:${c.name}`
  const variantOf = (c: ImportCandidate): string => variant[key(c)] ?? (c.variants.find((x) => x.portability !== 'toolOnly') ?? c.variants[0])?.id ?? ''
  const blocked = (c: ImportCandidate): boolean => c.conflicts.includes('invalidName') || c.portability === 'toolOnly' || c.variants.find((x) => x.id === variantOf(c))?.portability === 'toolOnly'
  const selected = cands.filter((c) => picked[key(c)] && !blocked(c))

  /** Replaceable entries of the selected MCP candidates (secret literal → ${KEY}). Each must be confirmed before applying */
  const replaceables = selected.flatMap((c) => {
    if (c.kind !== 'mcp') return []
    const v = c.variants.find((x) => x.id === variantOf(c))
    return (v?.replaceable ?? []).map((r) => ({ id: `${c.name}:${r.key}`, name: c.name, key: r.key, at: r.at, looksSecret: r.looksSecret }))
  })
  const allAcked = replaceables.every((r) => replace[r.id] !== undefined)

  const apply = async (): Promise<void> => {
    if (!sourceId) return
    setBusy(true)
    const sel: ImportSelection[] = selected.map((c) => ({
      kind: c.kind,
      name: c.name,
      variant: variantOf(c),
      overwrite: c.conflicts.includes('existsInLibrary'),
      ...(c.kind === 'mcp' ? { replace: replaceables.filter((r) => r.name === c.name && replace[r.id]).map((r) => r.key) } : {})
    }))
    const r = await runWrite(window.api.importApply(sourceId, sel), { success: t('import.done') })
    setBusy(false)
    if (r) {
      setResults(r)
      onImported()
    }
  }

  const variantLabel = (c: ImportCandidate, id: string): string => {
    const v = c.variants.find((x) => x.id === id)
    if (!v) return id
    // Agents have several locations even within one tool (OpenCode agent/, agents/, opencode.json); distinguish by location
    if (c.kind === 'agent') return v.sources.map((s) => s.path.split('/').slice(-2).join('/')).join(', ')
    if ('tools' in v && Array.isArray(v.tools) && v.tools.length) return v.tools.map((x) => TOOL_NAME[x]).join(', ')
    return v.sources.map((s) => s.label).join(', ')
  }

  const row = (c: ImportCandidate): React.JSX.Element => {
    const k = key(c)
    const v = c.variants.find((x) => x.id === variantOf(c))
    const invalid = blocked(c)
    const pv = v ?? c
    const tool = v && 'tools' in v ? v.tools[0] : undefined
    return (
      <ListRow
        key={k}
        avatar={
          <Group gap={8} wrap="nowrap">
            <Checkbox size="xs" checked={!!picked[k]} disabled={invalid} onChange={({ currentTarget: { checked } }) => setPicked((m) => ({ ...m, [k]: checked }))} aria-label={c.name} data-testid={`import-${c.kind}-${c.name}`} />
            {tool ? <ToolIcon tool={tool} size={24} /> : <Download size={16} style={{ color: 'var(--ac-text-muted)' }} />}
          </Group>
        }
        title={c.name}
        tags={
          <>
            <Badge variant="default" size="xs" fw={500} c="dimmed">
              {t(`import.kind.${c.kind}`)}
            </Badge>
            {c.conflicts.map((x) => (
              <Badge key={x} variant="light" color={x === 'invalidName' ? 'red' : 'yellow'} size="xs" fw={500}>
                {t(`import.conflict.${x}`)}
              </Badge>
            ))}
            {pv.portability === 'toolOnly' ? (
              <Badge variant="light" color="gray" size="xs" fw={500} data-testid={`import-portability-${c.kind}-${c.name}`}>
                {t('import.portability.toolOnly')}
              </Badge>
            ) : (
              pv.reasons.map((x) => (
                <Badge key={x} variant="light" color="orange" size="xs" fw={500} data-testid={`import-portability-${c.kind}-${c.name}-${x}`}>
                  {t(`import.portability.${x}`)}
                </Badge>
              ))
            )}
            {pv.portability !== 'toolOnly' && v && 'warnings' in v && v.warnings.length > 0 && (
              <Badge variant="light" color="yellow" size="xs" fw={500}>
                {t('mcp.warnings')} {v.warnings.length}
              </Badge>
            )}
          </>
        }
        subtitle={v ? variantLabel(c, v.id) : undefined}
        right={
          c.variants.length > 1 ? (
            <Select size="xs" w={220} value={variantOf(c)} onChange={(val) => val && setVariant((m) => ({ ...m, [k]: val }))} allowDeselect={false} data={c.variants.map((x) => ({ value: x.id, label: variantLabel(c, x.id) }))} />
          ) : undefined
        }
      />
    )
  }

  const step = results ? 2 : sourceId ? 1 : 0
  const src = sources?.find((s) => s.id === sourceId)

  return (
    <Modal opened={opened} onClose={onClose} title={kind ? t('import.titleKind', { kind: t(`import.kind.${kind}`) }) : t('common.import')} size="xl" centered radius="lg">
      <Stack gap="md" pt="xs">
        {!kind && (
          <Stepper active={step} size="xs">
            <Stepper.Step label={t('import.stepSource')} />
            <Stepper.Step label={t('import.stepPick')} />
            <Stepper.Step label={t('import.stepDone')} />
          </Stepper>
        )}
        {err && (
          <Alert color="red" variant="light">
            {err}
          </Alert>
        )}

        {step === 0 &&
          (!sources ? (
            <Loading />
          ) : (
            <Stack gap="xs">
              <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
                {sources.map((s) => (
                  <UnstyledButton
                    key={s.id}
                    className="ac-card"
                    data-clickable={s.available || undefined}
                    disabled={!s.available}
                    onClick={() => s.available && setSourceId(s.id)}
                    p="md"
                    style={{ opacity: s.available ? 1 : 0.55 }}
                    data-testid={`import-source-${s.id}`}
                  >
                    <Group gap={8} wrap="nowrap">
                      {s.kind === 'tool' && s.id.startsWith('tool:') ? <ToolIcon tool={s.id.slice(5) as 'claude'} size={20} /> : <FolderOpen size={16} style={{ color: 'var(--ac-text-muted)' }} />}
                      <Text fw={600} size="md">
                        {kind && s.id.startsWith('tool:') ? TOOL_NAME[s.id.slice(5) as 'claude'] : s.label}
                      </Text>
                      {!kind && (
                        <Badge variant="default" size="xs" fw={500} c="dimmed" ml="auto" style={{ flexShrink: 0 }} styles={{ label: { overflow: 'visible' } }}>
                          {t(`import.sourceKind.${s.kind}`)}
                        </Badge>
                      )}
                    </Group>
                    {!kind && (
                      <>
                        <Text size="xs" c="dimmed" ff="monospace" mt={4} truncate="end">
                          {s.path}
                        </Text>
                        <Text size="xs" c="dimmed" mt={2}>
                          {s.available ? s.kinds.map((k) => t(`import.kind.${k}`)).join(' · ') : (s.note ?? t('import.sourceMissing'))}
                        </Text>
                      </>
                    )}
                    {kind && !s.available && (
                      <Text size="xs" c="dimmed" mt={4}>
                        {t('import.sourceMissing')}
                      </Text>
                    )}
                  </UnstyledButton>
                ))}
              </Box>
            </Stack>
          ))}

        {step === 1 &&
          (!plan ? (
            <Loading />
          ) : (
            <Stack gap="md">
              <Group justify="space-between">
                <Text size="sm" fw={600}>
                  {kind && sourceId?.startsWith('tool:') ? TOOL_NAME[sourceId.slice(5) as 'claude'] : (src?.label ?? sourceId)}
                </Text>
                {!initialSource && (
                  <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setSourceId(null)}>
                    {t('import.changeSource')}
                  </Button>
                )}
              </Group>
              {cands.length === 0 ? <EmptyState title={t('import.none')} /> : <ListCard style={{ maxHeight: 340, overflow: 'auto' }}>{cands.map(row)}</ListCard>}
              {replaceables.length > 0 && (
                <Box>
                  <Text size="sm" fw={600} mb={4}>
                    {t('import.replacements')}
                  </Text>
                  <Stack gap={4}>
                    {replaceables.map((r) => (
                      <Group key={r.id} gap="sm" wrap="nowrap">
                        <Checkbox size="xs" checked={replace[r.id] === true} indeterminate={replace[r.id] === undefined} onChange={({ currentTarget: { checked } }) => setReplace((m) => ({ ...m, [r.id]: checked }))} data-testid={`import-replace-${r.id}`} />
                        <Text size="sm" ff="monospace" style={{ flex: 1 }}>
                          {r.name} · {r.at} → {'${' + r.key + '}'}
                        </Text>
                        {r.looksSecret && (
                          <Badge variant="light" color="red" size="xs" fw={500}>
                            {t('import.looksSecret')}
                          </Badge>
                        )}
                      </Group>
                    ))}
                  </Stack>
                </Box>
              )}
              <Group justify="flex-end" gap="xs">
                <Button variant="default" onClick={onClose}>
                  {t('common.cancel')}
                </Button>
                <Button leftSection={<Download size={14} />} disabled={selected.length === 0 || !allAcked} loading={busy} onClick={() => void apply()} data-testid="import-apply">
                  {t('import.apply', { n: selected.length })}
                </Button>
              </Group>
            </Stack>
          ))}

        {step === 2 && results && (
          <Stack gap="md">
            {results.some((r) => r.kind === 'mcp' && r.status === 'imported') && (
              <Text size="sm" c="dimmed" data-testid="import-mcp-all-tools">
                {t('import.mcpAllTools')}
              </Text>
            )}
            <ListCard>
              {results.map((r) => (
                <ListRow
                  key={`${r.kind}:${r.name}`}
                  title={r.name}
                  tags={
                    <>
                      <Badge variant="default" size="xs" fw={500} c="dimmed">
                        {t(`import.kind.${r.kind}`)}
                      </Badge>
                      <Badge variant="light" color={r.status === 'imported' ? 'accent' : 'red'} size="xs" fw={500}>
                        {t(`import.status.${r.status}`)}
                        {r.reason ? ` · ${r.reason}` : ''}
                      </Badge>
                    </>
                  }
                  subtitle={[
                    r.trashPath ? `${t('import.trashed')}: ${r.trashPath}` : '',
                    ...(r.warnings ?? []).map((w) => t(`import.warn.${w}`, { defaultValue: w })),
                    r.converted?.length ? `${t('import.converted')}: ${r.converted.map((x) => TOOL_NAME[x]).join(', ')}` : '',
                    r.inlineRemains ? t('import.inlineRemains') : '',
                    r.adopted?.length ? `${t('import.adopted')}: ${r.adopted.map((x) => TOOL_NAME[x]).join(', ')}` : '',
                    r.userOwned?.length ? `${t('import.userOwnedKept')}: ${r.userOwned.map((x) => TOOL_NAME[x]).join(', ')}` : ''
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
              ))}
            </ListCard>
            <Group justify="flex-end">
              <Button onClick={onClose} data-testid="import-close">
                {t('common.close')}
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Modal>
  )
}
