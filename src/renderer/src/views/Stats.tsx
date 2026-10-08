import { formatTokens } from '../lib/tokenFormat'
import { useContext, useEffect, useState } from 'react'
import {
  Box,
  Alert,
  Group,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton
} from '@mantine/core'
import { LineChart } from '@mantine/charts'
import { Info, Layers } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  Dist,
  ModelDetail,
  ModelKey,
  ModelSummary,
  SearchIndexView,
  ToolId
} from '../../../shared/api'
import { modelMetricSupport } from '../../../shared/modelMetrics'
import { UsageLeaderboard } from '../components/UsageLeaderboard'
import { ModelCost } from '../components/ModelCost'

import { BoxPlot } from '../components/BoxPlot'
import { DetailSheet } from '../components/DetailSheet'
import { Loading } from '../components/Layout'
import { PageHeader, SectionTitle } from '../components/PageHeader'
import { ReloadButton } from '../components/ReloadButton'
import { ToolIcon } from '../components/ToolIcon'
import { modelKeyStr, modelLabel, parseModelKey } from '../lib/modelKey'
import { useNav, useNavSelect } from '../lib/nav'
import { TOOL_NAME } from '../lib/tools'
import { RefreshContext } from '../lib/useApi'
import { resolveMcpUsageServer } from '../lib/usageNavigation'

/** Same thresholds as the engine (modelStats.ts): below them, counts only */
const MIN_REQUESTS = 30
const MIN_TOOL_CALLS = 100

type Period = '7' | '30' | '90' | '0' | 'custom'
type Range = { days?: number; from?: string; to?: string }
type Tr = (k: string, o?: Record<string, unknown>) => string

/** Presets map to last N days; a custom range is sorted so a swapped start/end still reads as one span */
const rangeOf = (period: Period, from: string, to: string): Range => {
  if (period !== 'custom') return Number(period) ? { days: Number(period) } : {}
  const [a, b] = from && to && from > to ? [to, from] : [from, to]
  return { ...(a ? { from: a } : {}), ...(b ? { to: b } : {}) }
}
const label = modelLabel
const toolName = (tool: string): string => TOOL_NAME[tool as ToolId] ?? tool
const toolFilterIcon = (v: string): React.JSX.Element =>
  v === 'all' ? <Layers size={13} /> : <ToolIcon tool={v as ToolId} size={13} />

// ---------------------------------------------------------------- formatting

function useFmt(): {
  int: (n: number) => string
  tok: (n: number) => string
  dur: (sec: number) => string
  pct: (n: number, digits?: number) => string
  t: Tr
} {
  const { t, i18n } = useTranslation()
  const int = (n: number): string => Math.round(n).toLocaleString(i18n.language)
  const tok = (n: number): string => formatTokens(n, i18n.language)
  const dur = (sec: number): string => {
    const s = Math.round(sec)
    if (s < 60) return t('models.dur.s', { s })
    if (s < 3600)
      return t('models.dur.ms', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') })
    return t('models.dur.hm', {
      h: Math.floor(s / 3600),
      m: String(Math.floor((s % 3600) / 60)).padStart(2, '0')
    })
  }
  const pct = (n: number, digits = 1): string => `${(n * 100).toFixed(digits)}%`
  return { int, tok, dur, pct, t }
}

const NUM: React.CSSProperties = { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

/** Loads on mount, on Reload, on range change and whenever a session index run finishes */
function useStatsLoad<T>(
  deps: unknown[],
  load: () => Promise<T | null>
): { data: T | null | undefined; indexing: boolean; error?: string; lastIndexedAt?: string } {
  const tick = useContext(RefreshContext)
  // Results are tagged with the deps they were loaded for: a stale result reads as "loading" without resetting state in the effect
  const depKey = JSON.stringify([tick, ...deps])
  const [result, setResult] = useState<
    { key: string; value: T | null; error?: string } | undefined
  >(undefined)
  const [index, setIndex] = useState<SearchIndexView | undefined>()
  useEffect(() => {
    let alive = true
    const run = (): void => {
      load().then(
        (value) => alive && setResult({ key: depKey, value }),
        (e) =>
          alive &&
          setResult({ key: depKey, value: null, error: String(e instanceof Error ? e.message : e) })
      )
    }
    run()
    window.api.sessionIndexStatus().then(
      (v) => alive && setIndex(v),
      () => {}
    )
    const off = window.api.onSearchIndexEvent((v) => {
      if (!alive) return
      setIndex(v)
      if (!v.running) run()
    })
    return () => {
      alive = false
      off()
    }
    // load is identified by deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey])
  const current = result?.key === depKey ? result : undefined
  return {
    data: current?.value,
    indexing: index?.running ?? false,
    error: current?.error ?? index?.error,
    lastIndexedAt: index?.lastIndexedAt
  }
}

function Tip({ label: text }: { label: string }): React.JSX.Element {
  return (
    <Tooltip label={text} multiline w={280} withArrow>
      <Info
        size={12}
        style={{
          color: 'var(--ac-text-muted)',
          verticalAlign: '-1px',
          marginLeft: 3,
          flexShrink: 0
        }}
      />
    </Tooltip>
  )
}

function ToolTag({ tool }: { tool: string }): React.JSX.Element {
  return (
    <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
      <ToolIcon tool={tool as ToolId} size={14} />
      <Text size="xs" c="dimmed">
        {toolName(tool)}
      </Text>
    </Group>
  )
}

// ---------------------------------------------------------------- detail pieces

function Tile({
  label: name,
  value,
  sub,
  tip
}: {
  label: string
  value: string
  sub?: string
  tip?: string
}): React.JSX.Element {
  return (
    <Box
      p="md"
      style={{
        borderRight: '1px solid var(--ac-border-subtle)',
        borderBottom: '1px solid var(--ac-border-subtle)'
      }}
    >
      <Text size="xs" c="dimmed">
        {name}
        {tip && <Tip label={tip} />}
      </Text>
      <Text fw={700} style={{ fontSize: 22, ...NUM }}>
        {value}
      </Text>
      {sub && (
        <Text size="xs" c="dimmed" style={NUM}>
          {sub}
        </Text>
      )}
    </Box>
  )
}

function ShareBar({ v }: { v: number }): React.JSX.Element {
  return (
    <Box
      style={{
        width: 90,
        height: 6,
        borderRadius: 3,
        background: 'var(--ac-surface-active)',
        overflow: 'hidden'
      }}
    >
      <Box
        style={{
          width: `${Math.min(100, v * 100)}%`,
          height: '100%',
          background: 'var(--ac-text-muted)'
        }}
      />
    </Box>
  )
}

/** Continuous day axis (days without use stay empty) */
function dayAxis(daily: { day: string }[], range: Range): string[] {
  if (!daily.length) return []
  const start = range.from ?? (range.days ? shiftDay(today(), -(range.days - 1)) : daily[0].day)
  const end = range.to ?? (range.days ? today() : daily[daily.length - 1].day)
  const out: string[] = []
  for (let d = start; d <= end && out.length < 400; d = shiftDay(d, 1)) out.push(d)
  return out
}
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const x = new Date(y, m - 1, d + n, 12)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

type DistKey = 'responseSec' | 'toolsPerRequest' | 'turnsPerRequest' | 'outputPerRequest'
const DIST_KEYS: DistKey[] = [
  'responseSec',
  'toolsPerRequest',
  'turnsPerRequest',
  'outputPerRequest'
]

function DistTable({
  rows,
  fmt
}: {
  rows: {
    key: DistKey | 'contextPerTurn'
    d: Dist | null
    max?: React.ReactNode
    requests?: number
  }[]
  fmt: (k: string) => (n: number) => string
}): React.JSX.Element {
  const { t } = useTranslation()
  // Rows of the same metric share one axis
  const domain = (key: string): [number, number] => {
    const ds = rows.filter((r) => r.key === key && r.d).map((r) => r.d!)
    return [Math.min(...ds.map((d) => d.min)), Math.max(...ds.map((d) => d.max))]
  }
  const cols = ['min', 'p25', 'median', 'mean', 'p75', 'p90', 'max'] as const
  return (
    <Box className="ac-card" style={{ overflowX: 'auto' }}>
      <Table verticalSpacing={6} horizontalSpacing="sm" style={{ minWidth: 760 }}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th />
            {cols.map((c) => (
              <Table.Th key={c} ta="right">
                <Text size="xs" c="dimmed" fw={600}>
                  {t(`models.detail.${c}`)}
                </Text>
              </Table.Th>
            ))}
            <Table.Th w="30%">
              <Text size="xs" c="dimmed" fw={600}>
                {t('models.detail.range')}
              </Text>
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r, i) => (
            <Table.Tr key={`${r.key}-${i}`}>
              <Table.Td>
                <Text size="sm" style={{ whiteSpace: 'nowrap' }}>
                  {t(`models.detail.metric.${r.key}`)}
                </Text>
              </Table.Td>
              {r.d ? (
                <>
                  {cols.map((c) => (
                    <Table.Td key={c} ta="right" style={NUM} fw={c === 'median' ? 700 : undefined}>
                      {fmt(r.key)(r.d![c])}
                      {c === 'max' && r.max}
                    </Table.Td>
                  ))}
                  <Table.Td>
                    <BoxPlot d={r.d} domain={domain(r.key)} />
                  </Table.Td>
                </>
              ) : (
                <Table.Td colSpan={8}>
                  <Text size="xs" c="dimmed">
                    {r.requests !== undefined
                      ? t('models.detail.fewRequests', { n: r.requests })
                      : '—'}
                  </Text>
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text size="xs" c="dimmed" px="sm" pb="xs">
        {t('models.detail.legend')}
      </Text>
    </Box>
  )
}

function ModelDetailView({
  k,
  range,
  onSession,
  onItem
}: {
  k: ModelKey
  range: Range
  onSession: (tool: string, id: string) => void
  onItem: (kind: 'skill' | 'mcp', name: string) => void
}): React.JSX.Element {
  const f = useFmt()
  const { t } = f
  const [tab, setTab] = useState<string | null>('turns')
  const [listTab, setListTab] = useState<string | null>('tools')
  const [sessionSort, setSessionSort] = useState<'turns' | 'output' | 'toolCalls'>('turns')
  const { data, error } = useStatsLoad<ModelDetail>([modelKeyStr(k), JSON.stringify(range)], () =>
    window.api.modelDetail(k, range)
  )
  if (error)
    return (
      <Alert color="red">
        {t('models.readFailed')}: {error}
      </Alert>
    )
  if (data === undefined) return <Loading />
  if (!data) return <Text c="dimmed">{t('models.indexing')}</Text>
  const s = data.summary
  const metrics = s.metrics ?? modelMetricSupport(s.tool)
  const med = s.median
  const fmtOf = (key: string): ((n: number) => string) =>
    key === 'responseSec'
      ? f.dur
      : key === 'outputPerRequest' || key === 'contextPerTurn'
        ? f.tok
        : f.int
  const axis = dayAxis(data.daily, range)
  const byDay = new Map(data.daily.map((d) => [d.day, d]))
  const chartKey = tab === 'output' ? 'output' : tab === 'context' ? 'context' : 'turns'
  const chart = axis.map((day) => ({ day: day.slice(5), v: byDay.get(day)?.[chartKey] ?? 0 }))
  const turnsTotal = Math.max(1, s.turns)
  const weekly = data.limits.filter((l) => l.windowMinutes === 10080)
  const limits = weekly.length ? weekly : data.limits
  const plan = limits.find((l) => l.plan)?.plan ?? '—'
  const errTotal =
    s.errors.mistake + s.errors.command + s.errors.policy + s.errors.userReject + s.errors.other
  const kinds = ['mistake', 'command', 'policy', 'userReject', 'other'] as const
  const kindAvailable = (kind: (typeof kinds)[number]): boolean =>
    metrics.errors &&
    (s.tool === 'claude' || (s.tool === 'codex' ? kind === 'command' : kind === 'other'))
  const sessions = [...data.sessions].sort((a, b) => b[sessionSort] - a[sessionSort]).slice(0, 10)
  const listRows = listTab === 'skills' ? data.skills : listTab === 'mcp' ? data.mcp : data.tools
  const listMax = Math.max(1, ...listRows.map((x) => x.calls))
  const projMax = Math.max(1, ...data.projects.map((p) => p.turns))

  return (
    <Stack gap="xl" data-testid="stats-detail">
      {(!metrics.tokens || !metrics.turns) && (
        <Alert color="yellow" data-testid="stats-metrics-unavailable">
          {t('models.metricsUnavailable')}
        </Alert>
      )}
      <Text size="sm" c="dimmed" style={NUM}>
        {t('models.detail.sub', {
          from: s.first,
          to: s.last,
          days: s.activeDays,
          n: metrics.requests ? f.int(s.requests) : '—'
        })}
      </Text>

      <Box>
        <SectionTitle>{t('models.detail.summary')}</SectionTitle>
        <Box className="ac-card" style={{ overflow: 'hidden' }}>
          <SimpleGrid cols={3} spacing={0}>
            <Tile
              label={t('models.detail.sessions')}
              value={f.int(s.sessions)}
              sub={
                metrics.requests && s.sessions
                  ? t('models.detail.sessionsSub', { n: (s.requests / s.sessions).toFixed(1) })
                  : undefined
              }
            />
            <Tile
              label={t('models.detail.subagents')}
              value={f.int(s.subagentSessions)}
              sub={t('models.detail.subagentsSub')}
            />
            <Tile
              label={t('models.detail.turns')}
              value={metrics.turns ? f.int(s.turns) : '—'}
              sub={
                med.turnsPerRequest !== null
                  ? t('models.detail.turnsSub', { n: med.turnsPerRequest })
                  : undefined
              }
              tip={t('models.tip.turns')}
            />
            <Tile
              label={t('models.detail.toolCalls')}
              value={f.int(s.toolCalls)}
              sub={
                med.toolsPerRequest !== null
                  ? t('models.detail.toolCallsSub', { n: med.toolsPerRequest })
                  : undefined
              }
            />
            <Tile
              label={t('models.detail.mistakes')}
              value={s.tool === 'claude' ? f.int(s.errors.mistake) : '—'}
              sub={
                s.tool !== 'claude'
                  ? t('models.detail.mistakesNA')
                  : s.toolCalls >= MIN_TOOL_CALLS
                    ? t('models.detail.mistakesSub', {
                        n: (s.errors.mistake / (s.toolCalls / 100)).toFixed(2)
                      })
                    : undefined
              }
              tip={t('models.tip.mistakes')}
            />
            <Tile
              label={t('models.detail.interrupts')}
              value={metrics.interrupts ? f.int(s.interrupts) : '—'}
              sub={
                metrics.interrupts
                  ? t('models.detail.interruptsSub', {
                      n: ((s.interrupts / turnsTotal) * 100).toFixed(2)
                    })
                  : undefined
              }
              tip={
                metrics.interrupts
                  ? t(
                      `models.detail.interruptTip.${s.tool === 'codex' ? 'codex' : s.tool === 'opencode' ? 'opencode' : 'claude'}`
                    )
                  : t('models.metricsUnavailable')
              }
            />
          </SimpleGrid>
        </Box>
      </Box>

      <ModelCost model={s} detail={data} />

      <Box>
        <SectionTitle>{t('models.detail.daily')}</SectionTitle>
        <Box className="ac-card" p="md">
          <Tabs value={tab} onChange={setTab} mb="sm">
            <Tabs.List>
              <Tabs.Tab value="turns">{t('models.detail.tabTurns')}</Tabs.Tab>
              <Tabs.Tab value="output">{t('models.detail.tabOutput')}</Tabs.Tab>
              <Tabs.Tab value="context">{t('models.detail.tabContext')}</Tabs.Tab>
            </Tabs.List>
          </Tabs>
          {!metrics.turns || !metrics.tokens ? (
            <Text size="sm" c="dimmed">
              {t('models.metricsUnavailable')}
            </Text>
          ) : (
            <LineChart
              h={200}
              data={chart}
              dataKey="day"
              series={[
                {
                  name: 'v',
                  label: t(
                    `models.detail.tab${chartKey === 'turns' ? 'Turns' : chartKey === 'output' ? 'Output' : 'Context'}`
                  ),
                  color: 'accent.6'
                }
              ]}
              withLegend={false}
              gridAxis="y"
              tickLine="none"
              valueFormatter={(v) => (chartKey === 'turns' ? f.int(v) : f.tok(v))}
              curveType="linear"
              withDots={false}
            />
          )}
        </Box>
      </Box>

      <Box>
        <SectionTitle>{t('models.detail.tokens')}</SectionTitle>
        <Stack gap="md">
          <Box className="ac-card">
            <Text size="xs" c="dimmed" px="md" pt="sm">
              {t('models.detail.tokensNote')}
            </Text>
            <Table verticalSpacing={6} horizontalSpacing="md">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th />
                  <Table.Th ta="right">
                    <Text size="xs" c="dimmed" fw={600}>
                      {t('models.detail.total')}
                    </Text>
                  </Table.Th>
                  <Table.Th ta="right">
                    <Text size="xs" c="dimmed" fw={600}>
                      {t('models.detail.perTurn')}
                    </Text>
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(['input', 'cacheWrite', 'cacheRead', 'output', 'reasoning'] as const).map(
                  (key) => {
                    const v = s.tokens[key]
                    // Codex logs have no cache writes
                    const missing =
                      !metrics.tokens || (v === 0 && key === 'cacheWrite' && s.tool === 'codex')
                    return (
                      <Table.Tr key={key}>
                        <Table.Td>
                          <Text size="sm">{t(`models.detail.tk.${key}`)}</Text>
                        </Table.Td>
                        <Table.Td ta="right" style={NUM}>
                          {missing ? '—' : f.tok(v)}
                        </Table.Td>
                        <Table.Td ta="right" style={NUM}>
                          {missing ? '—' : f.tok(v / turnsTotal)}
                        </Table.Td>
                      </Table.Tr>
                    )
                  }
                )}
              </Table.Tbody>
            </Table>
            {s.cost !== null && (
              <Text size="sm" px="md" pb="sm" style={NUM}>
                {t('models.detail.cost')}: ${s.cost.toFixed(2)}
              </Text>
            )}
          </Box>
          <DistTable rows={[{ key: 'contextPerTurn', d: data.dist.contextPerTurn }]} fmt={fmtOf} />
          {s.tool === 'codex' && limits.length > 0 && (
            <Box className="ac-card" p="md">
              <Text size="sm" fw={600}>
                {t('models.detail.limits')}
              </Text>
              <Text size="xs" c="dimmed" mb="sm">
                {t('models.detail.limitsNote', { plan })}
              </Text>
              <LineChart
                h={180}
                data={limits.map((l) => ({ day: l.day.slice(5), v: l.usedPercent }))}
                dataKey="day"
                series={[{ name: 'v', label: '%', color: 'accent.6' }]}
                yAxisProps={{ domain: [0, 100] }}
                valueFormatter={(v) => `${v}%`}
                curveType="linear"
                withDots={false}
                withLegend={false}
                gridAxis="y"
                tickLine="none"
              />
            </Box>
          )}
        </Stack>
      </Box>

      <Box>
        <SectionTitle
          right={
            <Text size="xs" c="dimmed">
              {metrics.requests ? f.int(s.requests) : '—'}
            </Text>
          }
        >
          {t('models.detail.dist')}
        </SectionTitle>
        {!metrics.requests ? (
          <Text size="sm" c="dimmed">
            {t('models.metricsUnavailable')}
          </Text>
        ) : s.requests < MIN_REQUESTS ? (
          <Text size="sm" c="dimmed">
            {t('models.detail.distTooFew', { min: MIN_REQUESTS, n: s.requests })}
          </Text>
        ) : (
          <DistTable
            fmt={fmtOf}
            rows={DIST_KEYS.map((key) => {
              const ref = key === 'turnsPerRequest' ? undefined : data.maxSessions[key]
              return {
                key,
                d: data.dist[key],
                max: ref ? (
                  <Tooltip
                    label={t('models.detail.maxSession', {
                      title: ref.title || t('models.detail.untitled')
                    })}
                    withArrow
                  >
                    <UnstyledButton
                      ml={4}
                      onClick={() => onSession(ref.tool, ref.id)}
                      aria-label={t('models.detail.maxSession', { title: ref.title })}
                    >
                      <Text span size="xs" c="dimmed">
                        ↗
                      </Text>
                    </UnstyledButton>
                  </Tooltip>
                ) : undefined
              }
            })}
          />
        )}
      </Box>

      <Box>
        <SectionTitle
          right={
            <Text size="xs" c="dimmed">
              {metrics.errors ? f.int(errTotal) : '—'}
            </Text>
          }
        >
          {t('models.detail.errors')}
        </SectionTitle>
        <Box className="ac-card" p="md">
          {s.tool !== 'claude' && (
            <Text size="xs" c="dimmed" mb="sm">
              {t(
                !metrics.errors
                  ? 'models.metricsUnavailable'
                  : s.tool === 'codex'
                    ? 'models.detail.errorsCodex'
                    : 'models.detail.errorsOpencode'
              )}
            </Text>
          )}
          {errTotal > 0 && (
            <Group
              gap={0}
              wrap="nowrap"
              mb="md"
              style={{ height: 10, borderRadius: 5, overflow: 'hidden' }}
            >
              {kinds.map((kind, i) =>
                s.errors[kind] ? (
                  <Box
                    key={kind}
                    style={{
                      width: `${(s.errors[kind] / errTotal) * 100}%`,
                      height: '100%',
                      background:
                        kind === 'mistake'
                          ? 'var(--ac-accent)'
                          : `color-mix(in srgb, var(--ac-text-muted) ${90 - i * 15}%, transparent)`
                    }}
                  />
                ) : null
              )}
            </Group>
          )}
          <Table verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th />
                <Table.Th ta="right">
                  <Text size="xs" c="dimmed" fw={600}>
                    {t('models.detail.count')}
                  </Text>
                </Table.Th>
                <Table.Th ta="right">
                  <Text size="xs" c="dimmed" fw={600}>
                    {t('models.detail.per100')}
                  </Text>
                </Table.Th>
                <Table.Th ta="right">
                  <Text size="xs" c="dimmed" fw={600}>
                    {t('models.detail.share')}
                  </Text>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {kinds.map((kind) => {
                const ok = kindAvailable(kind)
                const n = s.errors[kind]
                return (
                  <Table.Tr key={kind}>
                    <Table.Td>
                      <Text size="sm" fw={kind === 'mistake' ? 600 : undefined}>
                        {t(`models.detail.kind.${kind}`)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {t(`models.detail.kindDesc.${kind}`)}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right" style={NUM}>
                      {ok ? f.int(n) : '—'}
                    </Table.Td>
                    <Table.Td ta="right" style={NUM}>
                      {ok && s.toolCalls >= MIN_TOOL_CALLS
                        ? (n / (s.toolCalls / 100)).toFixed(2)
                        : '—'}
                    </Table.Td>
                    <Table.Td ta="right" style={NUM}>
                      {ok && errTotal ? f.pct(n / errTotal) : '—'}
                    </Table.Td>
                  </Table.Tr>
                )
              })}
            </Table.Tbody>
          </Table>
        </Box>
      </Box>

      <Box>
        <Box className="ac-card">
          <Tabs value={listTab} onChange={setListTab} px="md" pt="xs">
            <Tabs.List>
              <Tabs.Tab value="tools">{`${t('models.detail.tabTools')} ${data.tools.length}`}</Tabs.Tab>
              <Tabs.Tab value="skills">{`${t('models.detail.tabSkills')} ${data.skills.length}`}</Tabs.Tab>
              <Tabs.Tab value="mcp">{`${t('models.detail.tabMcp')} ${data.mcp.length}`}</Tabs.Tab>
            </Tabs.List>
          </Tabs>
          {listRows.length === 0 ? (
            <Text size="sm" c="dimmed" p="md">
              {t('models.detail.none')}
            </Text>
          ) : (
            <Table verticalSpacing={5} horizontalSpacing="md">
              <Table.Tbody>
                {listRows.slice(0, 15).map((x) => {
                  const errors = 'errors' in x ? (x as { errors: number }).errors : undefined
                  return (
                    <Table.Tr key={x.name}>
                      <Table.Td>
                        {listTab === 'skills' || listTab === 'mcp' ? (
                          <UnstyledButton
                            data-testid={`stats-item-${listTab === 'skills' ? 'skill' : 'mcp'}-${x.name}`}
                            onClick={() => onItem(listTab === 'skills' ? 'skill' : 'mcp', x.name)}
                          >
                            <Text size="sm" ff="monospace" c="accent">
                              {x.name} ↗
                            </Text>
                          </UnstyledButton>
                        ) : (
                          <Text size="sm" ff="monospace">
                            {x.name}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td ta="right" style={NUM}>
                        {f.int(x.calls)}
                      </Table.Td>
                      <Table.Td w={110}>
                        <ShareBar v={x.calls / listMax} />
                      </Table.Td>
                      {listTab === 'tools' && (
                        <Table.Td ta="right" style={NUM} c="dimmed">
                          {errors ? `${f.int(errors)} · ${f.pct(errors / x.calls)}` : '—'}
                        </Table.Td>
                      )}
                    </Table.Tr>
                  )
                })}
              </Table.Tbody>
            </Table>
          )}
        </Box>
      </Box>

      <Box>
        <SectionTitle
          right={
            <SegmentedControl
              size="xs"
              value={sessionSort}
              onChange={(v) => setSessionSort(v as typeof sessionSort)}
              data={[
                { value: 'turns', label: t('models.detail.sortTurns') },
                { value: 'output', label: t('models.detail.sortOutput') },
                { value: 'toolCalls', label: t('models.detail.sortTools') }
              ]}
            />
          }
        >
          {t('models.detail.sessions10')}
        </SectionTitle>
        <Box className="ac-card" style={{ overflowX: 'auto' }}>
          <Table
            highlightOnHover
            verticalSpacing={6}
            horizontalSpacing="sm"
            style={{ minWidth: 720 }}
          >
            <Table.Thead>
              <Table.Tr>
                {['colSession', 'colProject', 'colPeriod'].map((c) => (
                  <Table.Th key={c}>
                    <Text size="xs" c="dimmed" fw={600}>
                      {t(`models.detail.${c}`)}
                    </Text>
                  </Table.Th>
                ))}
                {['sortTurns', 'sortTools', 'colMistakes', 'sortOutput'].map((c) => (
                  <Table.Th key={c} ta="right">
                    <Text size="xs" c="dimmed" fw={600}>
                      {t(`models.detail.${c}`)}
                    </Text>
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {sessions.map((x) => (
                <Table.Tr
                  key={`${x.tool}:${x.id}`}
                  onClick={() => onSession(x.tool, x.id)}
                  style={{ cursor: 'pointer' }}
                  data-testid="stats-session"
                >
                  <Table.Td maw={260}>
                    <Text size="sm" truncate="end">
                      {x.title || t('models.detail.untitled')}
                    </Text>
                  </Table.Td>
                  <Table.Td maw={160}>
                    <Text
                      size="xs"
                      c="dimmed"
                      ff={x.project ? 'monospace' : undefined}
                      truncate="end"
                    >
                      {x.project || t('models.detail.noProject')}
                    </Text>
                  </Table.Td>
                  <Table.Td style={NUM}>
                    <Text size="xs" c="dimmed">
                      {x.first === x.last
                        ? x.first.slice(5)
                        : `${x.first.slice(5)} ~ ${x.last.slice(5)}`}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right" style={NUM}>
                    {metrics.turns ? f.int(x.turns) : '—'}
                  </Table.Td>
                  <Table.Td ta="right" style={NUM}>
                    {f.int(x.toolCalls)}
                  </Table.Td>
                  <Table.Td ta="right" style={NUM}>
                    {s.tool === 'claude' ? f.int(x.mistakes) : '—'}
                  </Table.Td>
                  <Table.Td ta="right" style={NUM}>
                    {metrics.tokens ? f.tok(x.output) : '—'}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      </Box>

      <Box>
        <SectionTitle>{t('models.detail.projects')}</SectionTitle>
        <Box className="ac-card">
          <Table verticalSpacing={5} horizontalSpacing="md">
            <Table.Tbody>
              {data.projects.slice(0, 10).map((p) => (
                <Table.Tr key={p.project}>
                  <Table.Td>
                    <Text
                      size="sm"
                      ff={p.project ? 'monospace' : undefined}
                      c={p.project ? undefined : 'dimmed'}
                    >
                      {p.project || t('models.detail.noProject')}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right" style={NUM}>
                    {metrics.turns ? f.int(p.turns) : '—'}
                  </Table.Td>
                  <Table.Td w={110}>{metrics.turns && <ShareBar v={p.turns / projMax} />}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      </Box>
    </Stack>
  )
}

// ---------------------------------------------------------------- screen

function Stats(): React.JSX.Element {
  const { t } = useTranslation()
  const { navigate } = useNav()
  const [period, setPeriod] = useState<Period>('30')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [showSmall, setShowSmall] = useState(false)
  const [tool, setTool] = useState<string>('all')
  const [selected, setSelected] = useState<ModelKey | null>(null)
  const range = rangeOf(period, from, to)
  const { data, indexing, error, lastIndexedAt } = useStatsLoad<ModelSummary[]>([range], () =>
    window.api.models(range)
  )
  useNavSelect((s) => {
    const k = parseModelKey(s)
    if (k) setSelected(k)
  })

  const tools = [...new Set((data ?? []).map((m) => m.tool))]
  const models = (data ?? []).filter((m) => tool === 'all' || m.tool === tool)
  const openSession = (sessionTool: string, id: string): void =>
    navigate('sessions', { select: `${sessionTool}:${id}` })
  const openItem = (kind: 'skill' | 'mcp', name: string): void => {
    if (kind === 'skill') {
      navigate('skills', { select: name })
      return
    }
    // Log names normalize punctuation; select only an unambiguous library server.
    void window.api.mcp().then(
      (data) => {
        const server = resolveMcpUsageServer(
          selected?.tool ?? '',
          name,
          data.servers.map((s) => s.name)
        )
        navigate('mcp', server ? { select: server } : undefined)
      },
      () => navigate('mcp')
    )
  }

  return (
    <Stack gap={0} style={{ flex: 1 }}>
      <PageHeader
        title={t('nav.stats')}
        count={
          data
            ? new Set(
                models.filter((m) => showSmall || m.requests >= MIN_REQUESTS).map((m) => m.model)
              ).size
            : undefined
        }
        actions={<ReloadButton />}
      />
      <Group gap="sm" mb="sm" wrap="wrap" className="ac-stats-filters">
        <Select
          w={120}
          allowDeselect={false}
          value={period}
          onChange={(v) => {
            if (!v) return
            if (v === 'custom' && !from && !to) {
              setFrom(shiftDay(today(), -29))
              setTo(today())
            }
            setPeriod(v as Period)
          }}
          aria-label={t('models.detail.colPeriod')}
          data={[
            { value: '7', label: t('models.days7') },
            { value: '30', label: t('models.days30') },
            { value: '90', label: t('models.days90') },
            { value: '0', label: t('models.all') },
            { value: 'custom', label: t('models.custom') }
          ]}
          data-testid="stats-days"
        />
        {period === 'custom' && (
          <Group gap={6} wrap="nowrap">
            <TextInput
              type="date"
              w={150}
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.currentTarget.value)}
              aria-label={t('models.from')}
              data-testid="stats-from"
            />
            <Text size="xs" c="dimmed">
              ~
            </Text>
            <TextInput
              type="date"
              w={150}
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.currentTarget.value)}
              aria-label={t('models.to')}
              data-testid="stats-to"
            />
          </Group>
        )}
        <Group gap="xs" wrap="nowrap">
          <Text size="xs" c="dimmed">
            {t('efficiency.referenceTool')}
          </Text>
          <Select
            w={170}
            allowDeselect={false}
            value={tool}
            onChange={(v) => setTool(v ?? 'all')}
            aria-label={t('efficiency.referenceTool')}
            data={[
              { value: 'all', label: t('models.allTools') },
              ...tools.map((x) => ({ value: x, label: toolName(x) }))
            ]}
            leftSection={toolFilterIcon(tool)}
            renderOption={({ option }) => (
              <Group gap={6} wrap="nowrap">
                {toolFilterIcon(option.value)}
                <span>{option.label}</span>
              </Group>
            )}
            data-testid="stats-tool"
          />
        </Group>
        <Switch
          size="xs"
          label={t('models.showSmall')}
          checked={showSmall}
          onChange={(e) => setShowSmall(e.currentTarget.checked)}
          data-testid="stats-show-small"
        />
      </Group>

      {lastIndexedAt && (
        <Text size="xs" c="dimmed" mb="sm" data-testid="stats-indexed-at">
          {t('models.lastIndexed', { at: new Date(lastIndexedAt).toLocaleString() })}
        </Text>
      )}
      {error ? (
        <Alert color="red" data-testid="stats-read-error">
          {t('models.readFailed')}: {error}
        </Alert>
      ) : data === undefined ? (
        <Loading />
      ) : data === null ? (
        <Text size="sm" c="dimmed">
          {t('models.indexing')}
        </Text>
      ) : data.length === 0 ? (
        <Text size="sm" c="dimmed">
          {indexing ? t('models.indexing') : t('models.none')}
        </Text>
      ) : (
        <UsageLeaderboard models={models} showSmall={showSmall} onOpen={setSelected} />
      )}

      <DetailSheet
        opened={!!selected}
        onClose={() => setSelected(null)}
        title={
          selected ? (
            <Group gap="sm" wrap="nowrap">
              <span style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}>
                {label(selected)}
              </span>
              <ToolTag tool={selected.tool} />
            </Group>
          ) : (
            ''
          )
        }
      >
        {selected && (
          <ModelDetailView k={selected} range={range} onSession={openSession} onItem={openItem} />
        )}
      </DetailSheet>
    </Stack>
  )
}

export default Stats
