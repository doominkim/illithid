import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  PasswordInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  MarketDetailView,
  MarketInstallChoice,
  MarketKind,
  MarketMcpItem,
  MarketRuleItem,
  MarketSearchView,
  MarketSkillItem,
  MarketUpdate
} from '../../../shared/api'
import { DetailSheet } from '../components/DetailSheet'
import { EmptyState } from '../components/EmptyState'
import { ErrorAlert, Loading } from '../components/Layout'
import { Initial, ListCard, ListRow } from '../components/ListRow'
import { Markdown } from '../components/Markdown'
import { PageHeader, SectionTitle, Toolbar } from '../components/PageHeader'
import { SearchInput } from '../components/SearchInput'
import { includesCI } from '../lib/format'
import { runWrite } from '../lib/mutate'
import type { Menu } from '../lib/nav'
import { useNav } from '../lib/nav'

const MENU: Record<MarketKind, Menu> = { skill: 'skills', mcp: 'mcp', rule: 'rules' }
const RISK_COLOR: Record<string, string> = { safe: 'green', low: 'green', medium: 'yellow', high: 'red', critical: 'red' }

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

function Market(): React.JSX.Element {
  const { t } = useTranslation()
  const { navigate } = useNav()
  const [kind, setKind] = useState<MarketKind>('skill')
  const [query, setQuery] = useState('')
  const q = useDebounced(query.trim(), 300)
  const [result, setResult] = useState<MarketSearchView | null>(null)
  const [mcpMore, setMcpMore] = useState<MarketMcpItem[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [updates, setUpdates] = useState<{ updates: MarketUpdate[]; failed: string[] } | null>(null)
  const [checking, setChecking] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const seq = useRef(0)

  const search = async (): Promise<void> => {
    const my = ++seq.current
    setError(null)
    setPicked(new Set())
    setMcpMore([])
    setCursor(undefined)
    setLoading(true)
    const r = await window.api.marketSearch(kind, kind === 'rule' ? '' : q)
    if (my !== seq.current) return
    setLoading(false)
    if (r.ok) {
      setResult(r.value)
      setCursor(r.value.nextCursor)
    } else {
      setResult(null)
      setError(`${t(`libError.${r.code}`, { defaultValue: r.code })}: ${r.message}`)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- search again when the tab or query changes
    void search()
    // Rules load once per tab switch; skills and MCP follow the query
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, kind === 'rule' ? '' : q])

  const loadMore = async (): Promise<void> => {
    if (!cursor) return
    const my = seq.current
    setLoading(true)
    const r = await window.api.marketSearch('mcp', q, cursor)
    // A newer search replaced the list meanwhile
    if (my !== seq.current) return
    setLoading(false)
    if (r.ok) {
      setMcpMore((prev) => [...prev, ...(r.value.mcp ?? [])])
      setCursor(r.value.nextCursor)
    } else setError(`${t(`libError.${r.code}`, { defaultValue: r.code })}: ${r.message}`)
  }

  const checkUpdates = async (): Promise<void> => {
    setChecking(true)
    const r = await runWrite(window.api.marketUpdates(), { invalidate: false })
    setChecking(false)
    if (r) setUpdates(r)
  }

  const runUpdate = async (u: MarketUpdate): Promise<void> => {
    const r = await runWrite(window.api.marketUpdate(u.kind, u.name), { success: t('market.updated', { name: u.name }) })
    if (r && updates) setUpdates({ ...updates, updates: updates.updates.filter((x) => x !== u) })
  }

  const installed = result?.installed ?? {}
  const rules = useMemo(
    () => (result?.rules ?? []).filter((r) => !query.trim() || includesCI(r.title, query.trim()) || includesCI(r.id, query.trim()) || includesCI(r.description, query.trim())),
    [result, query]
  )
  const servers = [...(result?.mcp ?? []), ...mcpMore]

  // Selectable = shown and not installed yet (MCP: installable here)
  const selectable: string[] =
    kind === 'skill'
      ? (result?.skills ?? []).filter((x) => !installed[`skill:${x.id}`]).map((x) => x.id)
      : kind === 'mcp'
        ? servers.filter((x) => x.installable && !installed[`mcp:${x.name}`]).map((x) => x.name)
        : rules.filter((x) => !installed[`rule:${x.id}`]).map((x) => x.id)
  const pickedVisible = selectable.filter((id) => picked.has(id))
  const allPicked = selectable.length > 0 && pickedVisible.length === selectable.length
  const togglePick = (id: string): void =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const pickBox = (id: string, key: string, enabled = true): React.ReactNode => (
    <Checkbox
      size="sm"
      checked={!!installed[key] || picked.has(id)}
      disabled={!!installed[key] || !enabled}
      onChange={() => togglePick(id)}
      aria-label={id}
      data-testid="market-pick"
    />
  )

  const installPicked = async (): Promise<void> => {
    if (!pickedVisible.length) return
    setBulkBusy(true)
    const r = await runWrite(window.api.marketInstallMany(kind, pickedVisible))
    setBulkBusy(false)
    if (!r) return
    setPicked(new Set())
    notifications.show({
      color: r.skipped.length ? 'yellow' : 'accent',
      title: t('market.bulkDone', { n: r.installed.length }),
      message: r.skipped.length
        ? r.skipped.map((x) => `${x.id}: ${t(`market.skip.${x.reason}`, { defaultValue: x.reason })}`).join(' · ')
        : undefined,
      autoClose: r.skipped.length ? false : 3000
    })
    void search()
  }

  const badgeInstalled = (key: string): React.ReactNode =>
    installed[key] ? (
      <Badge variant="light" size="xs" fw={500}>
        {t('market.installed')}
      </Badge>
    ) : null

  const list = (): React.ReactNode => {
    if (error) return <ErrorAlert message={error} />
    if (loading && !result) return <Loading />
    if (kind === 'skill') {
      const items = result?.skills ?? []
      if (!items.length) return <EmptyState title={t('common.noResults')} />
      return (
        <ListCard>
          {items.map((s: MarketSkillItem) => (
            <ListRow
              key={s.id}
              leading={pickBox(s.id, `skill:${s.id}`)}
              avatar={<Initial text={s.name} />}
              title={s.name}
              tags={badgeInstalled(`skill:${s.id}`)}
              subtitle={s.source}
              right={
                <Text size="sm" c="dimmed">
                  {t('market.installs', { n: s.installs.toLocaleString() })}
                </Text>
              }
              active={selected === s.id}
              onClick={() => setSelected(s.id)}
            />
          ))}
        </ListCard>
      )
    }
    if (kind === 'mcp') {
      if (!servers.length) return <EmptyState title={t('common.noResults')} />
      return (
        <Stack gap="sm">
          <ListCard>
            {servers.map((s) => (
              <ListRow
                key={s.name}
                leading={pickBox(s.name, `mcp:${s.name}`, s.installable)}
                avatar={<Initial text={s.title ?? s.name.split('/').pop() ?? s.name} />}
                title={s.title ?? s.name}
                tags={
                  <>
                    {s.kinds
                      .filter((k) => k !== 'other')
                      .map((k) => (
                        <Badge key={k} variant="default" size="xs" fw={500} c="dimmed">
                          {k}
                        </Badge>
                      ))}
                    {badgeInstalled(`mcp:${s.name}`)}
                  </>
                }
                subtitle={s.description || s.name}
                right={
                  <Text size="sm" c="dimmed">
                    {s.downloads !== undefined ? t('market.weekly', { n: s.downloads.toLocaleString() }) : s.version}
                  </Text>
                }
                active={selected === s.name}
                onClick={() => setSelected(s.name)}
                style={s.installable ? undefined : { opacity: 0.6 }}
              />
            ))}
          </ListCard>
          {cursor && (
            <Group justify="center">
              <Button size="xs" variant="default" loading={loading} onClick={() => void loadMore()} data-testid="market-more">
                {t('market.more')}
              </Button>
            </Group>
          )}
        </Stack>
      )
    }
    if (!rules.length) return <EmptyState title={t('common.noResults')} />
    return (
      <ListCard>
        {rules.map((r: MarketRuleItem) => (
          <ListRow
            key={r.id}
            leading={pickBox(r.id, `rule:${r.id}`)}
            avatar={<Initial text={r.title} />}
            title={r.title}
            tags={badgeInstalled(`rule:${r.id}`)}
            subtitle={r.description}
            right={
              r.applyTo && r.applyTo !== '**' ? (
                <Text size="xs" c="dimmed" ff="monospace" maw={220} truncate="end">
                  {r.applyTo}
                </Text>
              ) : undefined
            }
            active={selected === r.id}
            onClick={() => setSelected(r.id)}
          />
        ))}
      </ListCard>
    )
  }

  return (
    <Stack gap={0} style={{ flex: 1 }}>
      <PageHeader
        title={t('nav.market')}
        count={kind === 'rule' ? rules.length : undefined}
        actions={
          <Button size="xs" variant="default" leftSection={<RefreshCw size={13} />} loading={checking} onClick={() => void checkUpdates()} data-testid="market-updates">
            {t('market.checkUpdates')}
          </Button>
        }
      />
      {updates && (
        <Box mb="md">
          {updates.updates.length ? (
            <ListCard>
              {updates.updates.map((u) => (
                <ListRow
                  key={`${u.kind}:${u.name}`}
                  title={u.name}
                  tags={
                    <Badge variant="default" size="xs" fw={500} c="dimmed">
                      {t(`market.tab.${u.kind}`)}
                    </Badge>
                  }
                  subtitle={u.id}
                  right={
                    <Button size="compact-xs" onClick={() => void runUpdate(u)}>
                      {t('market.update')}
                    </Button>
                  }
                />
              ))}
            </ListCard>
          ) : (
            <Alert variant="light" radius="lg" withCloseButton onClose={() => setUpdates(null)}>
              {t('market.noUpdates')}
            </Alert>
          )}
          {updates.failed.length > 0 && (
            <Text size="sm" c="dimmed" mt={6}>
              {t('market.updateFailed', { n: updates.failed.length })}
            </Text>
          )}
        </Box>
      )}
      <Toolbar
        left={
          <>
            <SegmentedControl
              size="xs"
              value={kind}
              onChange={(v) => {
                setKind(v as MarketKind)
                setSelected(null)
                setResult(null)
              }}
              data={(['skill', 'mcp', 'rule'] as const).map((k) => ({ value: k, label: t(`market.tab.${k}`) }))}
              data-testid="market-tabs"
            />
            <SearchInput value={query} onChange={setQuery} placeholder={t('market.search')} />
          </>
        }
        right={
          <>
            <Checkbox
              size="sm"
              label={t('market.selectAll')}
              checked={allPicked}
              indeterminate={pickedVisible.length > 0 && !allPicked}
              disabled={!selectable.length}
              onChange={() => setPicked(allPicked ? new Set() : new Set(selectable))}
              data-testid="market-pick-all"
            />
            <Button size="xs" disabled={!pickedVisible.length} loading={bulkBusy} onClick={() => void installPicked()} data-testid="market-install-picked">
              {t('market.installPicked', { n: pickedVisible.length })}
            </Button>
          </>
        }
      />
      {list()}

      <DetailSheet opened={!!selected} onClose={() => setSelected(null)} title={selected ?? ''} maw={1200}>
        {selected && (
          <MarketDetail
            key={`${kind}:${selected}`}
            kind={kind}
            id={selected}
            onInstalled={(name) => {
              setSelected(null)
              navigate(MENU[kind], { select: name, tool: null })
            }}
          />
        )}
      </DetailSheet>
    </Stack>
  )
}

function MarketDetail({ kind, id, onInstalled }: { kind: MarketKind; id: string; onInstalled: (name: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { navigate } = useNav()
  const [view, setView] = useState<MarketDetailView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [choice, setChoice] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    window.api.marketDetail(kind, id).then((r) => {
      if (!alive) return
      if (!r.ok) return setErr(`${t(`libError.${r.code}`, { defaultValue: r.code })}: ${r.message}`)
      setView(r.value)
      setName(r.value.name)
      if (r.value.kind === 'mcp') {
        const first = r.value.choices.find((c) => c.supported)
        setChoice(first?.id ?? null)
      }
    })
    return () => {
      alive = false
    }
  }, [kind, id, t])

  if (err) return <ErrorAlert message={err} />
  if (!view) return <Loading />

  const current: MarketInstallChoice | undefined = view.kind === 'mcp' ? view.choices.find((c) => c.id === choice) : undefined
  const missing = !!current && current.inputs.some((i) => i.required && !(values[i.key] ?? '').trim() && !i.default)
  const canInstall = !!name.trim() && (view.kind !== 'mcp' || (!!current?.supported && !missing))

  const install = async (): Promise<void> => {
    setBusy(true)
    const r = await runWrite(
      window.api.marketInstall(kind, id, { name: name.trim(), choice: choice ?? undefined, values, ref: view.ref }),
      { success: t('market.installedToast', { name: name.trim() }) }
    )
    setBusy(false)
    if (!r) return
    if (r.warnings?.length) notifications.show({ color: 'yellow', message: r.warnings.join(' · ') })
    onInstalled(r.name)
  }

  const installBox = view.installedAs ? (
    <Group gap="sm">
      <Badge variant="light" fw={500}>
        {t('market.installedAs', { name: view.installedAs })}
      </Badge>
      <Button size="xs" variant="default" onClick={() => navigate(MENU[kind], { select: view.installedAs, tool: null })}>
        {t('market.open')}
      </Button>
    </Group>
  ) : (
    <Group gap="sm" align="flex-end">
      <TextInput label={t('market.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} w={280} data-testid="market-name" />
      <Button onClick={() => void install()} loading={busy} disabled={!canInstall} data-testid="market-install">
        {t('market.install')}
      </Button>
    </Group>
  )

  const link = (href: string, label: string): React.ReactNode => (
    <Anchor href={href} target="_blank" rel="noreferrer" size="sm">
      <Group gap={4} wrap="nowrap" component="span">
        {label}
        <ExternalLink size={12} />
      </Group>
    </Anchor>
  )

  if (view.kind === 'skill')
    return (
      <Stack gap="lg">
        {view.description && <Text c="var(--ac-text-2)">{view.description}</Text>}
        <Group gap="lg">{link(`https://github.com/${view.source}`, view.source)}</Group>
        {view.audit && (
          <Group gap="xs">
            {Object.entries(view.audit).map(([p, a]) => (
              <Badge key={p} variant="light" color={RISK_COLOR[a.risk ?? ''] ?? 'gray'} fw={500}>
                {p}: {a.risk ?? '-'}
                {a.score !== undefined ? ` · ${a.score}` : ''}
              </Badge>
            ))}
          </Group>
        )}
        {installBox}
        <Box>
          <SectionTitle>{t('market.files', { n: view.files.length })}</SectionTitle>
          <Text size="sm" ff="monospace" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
            {view.files.map((f) => f.rel).join('\n')}
          </Text>
          {view.skipped.length > 0 && (
            <Text size="sm" c="dimmed" mt={6}>
              {t('market.skipped', { list: view.skipped.join(', ') })}
            </Text>
          )}
        </Box>
        <Box className="ac-card" p="lg">
          <Markdown text={stripFrontmatter(view.skillMd)} />
        </Box>
      </Stack>
    )

  if (view.kind === 'rule')
    return (
      <Stack gap="lg">
        {view.description && <Text c="var(--ac-text-2)">{view.description}</Text>}
        <Group gap="lg">
          {link(view.url, 'github/awesome-copilot')}
          {view.applyTo && (
            <Text size="sm" ff="monospace" c="dimmed">
              {view.applyTo}
            </Text>
          )}
        </Group>
        {installBox}
        <Box className="ac-card" p="lg">
          <Markdown text={view.body} />
        </Box>
      </Stack>
    )

  return (
    <Stack gap="lg">
      {view.description && <Text c="var(--ac-text-2)">{view.description}</Text>}
      <Group gap="lg">
        <Text size="sm" c="dimmed">
          {view.id} · {view.version}
        </Text>
        {view.repo && link(view.repo, t('market.repo'))}
        {view.website && link(view.website, t('market.website'))}
      </Group>
      {view.choices.some((c) => c.supported) ? (
        !view.installedAs && (
          <Stack gap="sm" maw={560}>
            <Select
              label={t('market.option')}
              value={choice}
              onChange={(v) => {
                setChoice(v)
                setValues({})
              }}
              allowDeselect={false}
              data={view.choices.map((c) => ({
                value: c.id,
                label: `${c.kind} · ${c.label}${c.reason ? ` (${t(`market.reason.${c.reason}`)})` : ''}`,
                disabled: !c.supported
              }))}
              data-testid="market-option"
            />
            {current?.inputs.map((i) => {
              const common = {
                label: i.label,
                description: i.description,
                required: i.required && !i.default,
                placeholder: i.default,
                value: values[i.key] ?? '',
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                  const v = e.currentTarget.value
                  setValues((prev) => ({ ...prev, [i.key]: v }))
                }
              }
              return i.secret ? <PasswordInput key={i.key} {...common} /> : <TextInput key={i.key} {...common} />
            })}
          </Stack>
        )
      ) : (
        <Alert variant="light" color="gray" radius="lg">
          {t('market.noOptions')}
        </Alert>
      )}
      {view.choices.some((c) => c.supported) && installBox}
    </Stack>
  )
}

export default Market
