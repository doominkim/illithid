import { useContext, useEffect, useMemo, useState } from 'react'
import { Box, Button, Checkbox, Group, SegmentedControl, SimpleGrid, Stack, Switch, Table, Tabs, Text, Tooltip, UnstyledButton } from '@mantine/core'
import { BarChart, LineChart } from '@mantine/charts'
import { ChevronDown, ChevronRight, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Dist, ModelDetail, ModelKey, ModelSummary, ToolId } from '../../../shared/api'
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

/** Same thresholds as the engine (modelStats.ts): below them, counts only */
const MIN_REQUESTS = 30
const MIN_TOOL_CALLS = 100

type Days = 7 | 30 | 90 | 0
type Range = { days?: number; from?: string; to?: string }
type Tr = (k: string, o?: Record<string, unknown>) => string

const rangeOf = (days: Days): Range => (days ? { days } : {})
const sameKey = (a: ModelKey, b: ModelKey): boolean => a.tool === b.tool && a.model === b.model && a.effort === b.effort
const label = modelLabel
const toolName = (tool: string): string => TOOL_NAME[tool as ToolId] ?? tool

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
  const tok = (n: number): string => {
    const a = Math.abs(n)
    if (a < 1000) return int(n)
    if (a < 1e6) return `${(n / 1e3).toFixed(a < 1e4 ? 1 : 0)}K`
    if (a < 1e9) return `${(n / 1e6).toFixed(a < 1e7 ? 2 : 1)}M`
    return `${(n / 1e9).toFixed(2)}B`
  }
  const dur = (sec: number): string => {
    const s = Math.round(sec)
    if (s < 60) return t('models.dur.s', { s })
    if (s < 3600) return t('models.dur.ms', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') })
    return t('models.dur.hm', { h: Math.floor(s / 3600), m: String(Math.floor((s % 3600) / 60)).padStart(2, '0') })
  }
  const pct = (n: number, digits = 1): string => `${(n * 100).toFixed(digits)}%`
  return { int, tok, dur, pct, t }
}

const NUM: React.CSSProperties = { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

/** Loads on mount, on Reload, on range change and whenever a session index run finishes */
function useStatsLoad<T>(deps: unknown[], load: () => Promise<T | null>): { data: T | null | undefined; indexing: boolean } {
  const tick = useContext(RefreshContext)
  // Results are tagged with the deps they were loaded for: a stale result reads as "loading" without resetting state in the effect
  const depKey = JSON.stringify([tick, ...deps])
  const [result, setResult] = useState<{ key: string; value: T | null } | undefined>(undefined)
  const [indexing, setIndexing] = useState(false)
  useEffect(() => {
    let alive = true
    const run = (): void => {
      load().then(
        (value) => alive && setResult({ key: depKey, value }),
        () => alive && setResult({ key: depKey, value: null })
      )
    }
    run()
    window.api.sessionIndexStatus().then((v) => alive && setIndexing(v.running), () => {})
    const off = window.api.onSearchIndexEvent((v) => {
      if (!alive) return
      setIndexing(v.running)
      if (!v.running) run()
    })
    return () => {
      alive = false
      off()
    }
    // load is identified by deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey])
  return { data: result && result.key === depKey ? result.value : undefined, indexing }
}

function Tip({ label: text }: { label: string }): React.JSX.Element {
  return (
    <Tooltip label={text} multiline w={280} withArrow>
      <Info size={12} style={{ color: 'var(--ac-text-muted)', verticalAlign: '-1px', marginLeft: 3, flexShrink: 0 }} />
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

// ---------------------------------------------------------------- list

type SortKey = 'last' | 'requests' | 'tools' | 'turns' | 'response' | 'mistakes' | 'output' | 'context'

interface Row {
  key: ModelKey
  models: ModelSummary[]
  /** Model used at several efforts: expandable group */
  group: boolean
}

/** Reasoning levels from low to high; unknown ones go last in name order */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const effortRank = (e: string): number => {
  const i = EFFORT_ORDER.indexOf(e)
  return i < 0 ? EFFORT_ORDER.length : i
}
/** Efforts of a grouped model, low to high: "low · medium · high" */
const effortList = (models: ModelSummary[]): string =>
  models
    .map((m) => m.effort || '—')
    .sort((a, b) => effortRank(a) - effortRank(b) || a.localeCompare(b))
    .join(' · ')

function sortValue(m: ModelSummary, k: SortKey): number | string | null {
  switch (k) {
    case 'last':
      return m.last
    case 'requests':
      return m.requests
    case 'tools':
      return m.median.toolsPerRequest
    case 'turns':
      return m.median.turnsPerRequest
    case 'response':
      return m.median.responseSec
    case 'mistakes':
      return m.tool === 'claude' && m.toolCalls >= MIN_TOOL_CALLS ? m.errors.mistake / m.toolCalls : null
    case 'output':
      return m.median.outputPerRequest
    case 'context':
      return m.median.contextPerTurn
  }
}

function compareBy(k: SortKey, dir: 1 | -1) {
  return (a: ModelSummary, b: ModelSummary): number => {
    const x = sortValue(a, k)
    const y = sortValue(b, k)
    if (x === null && y === null) return 0
    if (x === null) return 1
    if (y === null) return -1
    return (x < y ? -1 : x > y ? 1 : 0) * dir
  }
}

function StatsList({
  models,
  onOpen,
  checked,
  onCheck,
  showSmall
}: {
  models: ModelSummary[]
  onOpen: (k: ModelKey) => void
  checked: ModelKey[]
  onCheck: (k: ModelKey, on: boolean) => void
  showSmall: boolean
}): React.JSX.Element {
  const f = useFmt()
  const { t } = f
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'last', dir: -1 })
  const [open, setOpen] = useState<Set<string>>(new Set())

  const visible = models.filter((m) => showSmall || m.requests >= MIN_REQUESTS)
  const rows = useMemo<Row[]>(() => {
    const cmp = compareBy(sort.key, sort.dir)
    const groups = new Map<string, ModelSummary[]>()
    const out: Row[] = []
    const gk = (m: ModelSummary): string => `${m.tool}|${m.model}`
    for (const m of visible) {
      const list = groups.get(gk(m))
      if (list) list.push(m)
      else groups.set(gk(m), [m])
    }
    for (const m of visible) {
      const list = groups.get(gk(m))!
      if (list.length > 1) {
        // Rows inside a group follow the effort level, like the list in the group row
        if (list[0] === m)
          out.push({ key: { tool: m.tool, model: m.model, effort: '' }, models: [...list].sort((a, b) => effortRank(a.effort) - effortRank(b.effort) || a.effort.localeCompare(b.effort)), group: true })
        continue
      }
      out.push({ key: m, models: [m], group: false })
    }
    // Groups sort by their best child for the chosen column
    return out.sort((a, b) => cmp([...a.models].sort(cmp)[0], [...b.models].sort(cmp)[0]))
  }, [visible, sort])

  const head = (key: SortKey, text: string, sub?: string, tip?: string): React.JSX.Element => (
    <Table.Th ta="right" style={{ verticalAlign: 'bottom' }}>
      <UnstyledButton
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : -1 }))}
        aria-sort={sort.key === key ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none'}
        style={{ textAlign: 'right' }}
      >
        <Text size="xs" fw={600} c={sort.key === key ? undefined : 'dimmed'} component="span">
          {text}
          {tip && <Tip label={tip} />}
          {sort.key === key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}
        </Text>
        {sub && (
          <Text size="xs" c="dimmed" display="block">
            {sub}
          </Text>
        )}
      </UnstyledButton>
    </Table.Th>
  )

  const range = (list: ModelSummary[], f2: (m: ModelSummary) => number | null, fmt: (n: number) => string): string => {
    const v = list.map(f2).filter((x): x is number => x !== null)
    if (!v.length) return '—'
    const lo = Math.min(...v)
    const hi = Math.max(...v)
    return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`
  }
  const cells = (list: ModelSummary[]): React.JSX.Element => {
    const one = list.length === 1 ? list[0] : undefined
    const first = list.reduce((a, m) => (m.first < a ? m.first : a), list[0].first)
    const last = list.reduce((a, m) => (m.last > a ? m.last : a), list[0].last)
    const days = one ? one.activeDays : Math.max(...list.map((m) => m.activeDays))
    const requests = list.reduce((a, m) => a + m.requests, 0)
    // Mistakes are only told apart in Claude Code logs; a group adds its efforts up
    const mistakeCount = list.reduce((a, m) => a + m.errors.mistake, 0)
    const calls = list.reduce((a, m) => a + m.toolCalls, 0)
    const mistakes =
      list[0].tool === 'claude' ? (
        <>
          <Text size="sm" style={NUM}>
            {f.int(mistakeCount)}
          </Text>
          {calls >= MIN_TOOL_CALLS && (
            <Text size="xs" c="dimmed" style={NUM}>
              {(mistakeCount / (calls / 100)).toFixed(2)}
            </Text>
          )}
        </>
      ) : (
        <Tooltip label={t('models.mistakesNA')} withArrow>
          <Text size="sm" c="dimmed">
            —
          </Text>
        </Tooltip>
      )
    return (
      <>
        <Table.Td>
          <Text size="sm" style={NUM}>
            {first.slice(5)} ~ {last.slice(5)}
          </Text>
          <Text size="xs" c="dimmed">
            {t('models.activeDays', { n: days })}
          </Text>
        </Table.Td>
        <Table.Td ta="right" style={NUM}>
          {f.int(requests)}
        </Table.Td>
        <Table.Td ta="right" style={NUM}>
          {range(list, (m) => m.median.toolsPerRequest, f.int)}
        </Table.Td>
        <Table.Td ta="right" style={NUM}>
          {range(list, (m) => m.median.turnsPerRequest, f.int)}
        </Table.Td>
        <Table.Td ta="right" style={NUM}>
          {range(list, (m) => m.median.responseSec, f.dur)}
        </Table.Td>
        <Table.Td ta="right">{mistakes}</Table.Td>
        <Table.Td ta="right" style={NUM}>
          {range(list, (m) => m.median.outputPerRequest, f.tok)}
        </Table.Td>
        <Table.Td ta="right" style={NUM}>
          {range(list, (m) => m.median.contextPerTurn, f.tok)}
        </Table.Td>
      </>
    )
  }

  const isChecked = (k: ModelKey): boolean => checked.some((c) => sameKey(c, k))
  const check = (m: ModelSummary): React.JSX.Element => (
    <Checkbox
      size="xs"
      aria-label={label(m)}
      checked={isChecked(m)}
      disabled={!isChecked(m) && checked.length >= 2}
      onChange={(e) => onCheck(m, e.currentTarget.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  )
  const small = (m: ModelSummary): React.JSX.Element | null =>
    m.requests < MIN_REQUESTS ? (
      <Text size="xs" c="dimmed" span ml={6} style={{ border: '1px solid var(--ac-border)', borderRadius: 4, padding: '0 4px' }}>
        {t('models.small')}
      </Text>
    ) : null

  // Model name above its tool, so long ids don't push the columns apart
  const modelCell = (k: ModelKey): React.JSX.Element => (
    <Stack gap={2}>
      <Text size="sm" fw={600} ff="monospace" style={{ whiteSpace: 'nowrap' }}>
        {k.model}
      </Text>
      <ToolTag tool={k.tool} />
    </Stack>
  )
  const effortCell = (m: ModelSummary): React.JSX.Element => (
    <Group gap={6} wrap="nowrap">
      <Text size="sm" ff="monospace" c={m.effort ? undefined : 'dimmed'}>
        {m.effort || '—'}
      </Text>
      {small(m)}
    </Group>
  )

  return (
    <Box className="ac-card" style={{ overflowX: 'auto' }} data-testid="stats-table">
      <Table highlightOnHover verticalSpacing={8} horizontalSpacing={8} style={{ minWidth: 960 }}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={28} />
            <Table.Th style={{ verticalAlign: 'bottom' }}>
              <Text size="xs" fw={600} c="dimmed">
                {t('models.col.model')}
              </Text>
            </Table.Th>
            <Table.Th w={150} style={{ verticalAlign: 'bottom' }}>
              <Text size="xs" fw={600} c="dimmed">
                {t('models.col.effort')}
              </Text>
            </Table.Th>
            <Table.Th style={{ verticalAlign: 'bottom' }}>
              <UnstyledButton onClick={() => setSort((s) => ({ key: 'last', dir: s.key === 'last' ? ((-s.dir) as 1 | -1) : -1 }))}>
                <Text size="xs" fw={600} c={sort.key === 'last' ? undefined : 'dimmed'}>
                  {t('models.col.period')}
                  {sort.key === 'last' ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}
                </Text>
              </UnstyledButton>
            </Table.Th>
            {head('requests', t('models.col.requests'))}
            {head('tools', t('models.col.toolsPerReq'), t('models.col.median'))}
            {head('turns', t('models.col.turnsPerReq'), t('models.col.median'), t('models.tip.turns'))}
            {head('response', t('models.col.response'), t('models.col.median'), t('models.tip.response'))}
            {head('mistakes', t('models.col.mistakes'), t('models.col.per100'), t('models.tip.mistakes'))}
            {head('output', t('models.col.outPerReq'), t('models.col.median'))}
            {head('context', t('models.col.context'), t('models.col.median'), t('models.tip.context'))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => {
            const id = modelKeyStr(r.key)
            if (!r.group) {
              const m = r.models[0]
              return (
                <Table.Tr key={id} onClick={() => onOpen(m)} style={{ cursor: 'pointer', opacity: m.requests < MIN_REQUESTS ? 0.7 : 1 }} data-testid="stats-row">
                  <Table.Td>{check(m)}</Table.Td>
                  <Table.Td>{modelCell(m)}</Table.Td>
                  <Table.Td>{effortCell(m)}</Table.Td>
                  {cells([m])}
                </Table.Tr>
              )
            }
            const expanded = open.has(id)
            return [
              <Table.Tr
                key={id}
                onClick={() =>
                  setOpen((s) => {
                    const n = new Set(s)
                    if (n.has(id)) n.delete(id)
                    else n.add(id)
                    return n
                  })
                }
                style={{ cursor: 'pointer' }}
                data-testid="stats-group"
              >
                <Table.Td>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</Table.Td>
                <Table.Td>{modelCell(r.key)}</Table.Td>
                {/* Long lists wrap inside a fixed width instead of pushing the number columns apart */}
                <Table.Td maw={150}>
                  <Text size="xs" ff="monospace" c="dimmed" style={{ lineHeight: 1.5 }}>
                    {effortList(r.models)}
                  </Text>
                </Table.Td>
                {cells(r.models)}
              </Table.Tr>,
              ...(expanded
                ? r.models.map((m) => (
                    <Table.Tr key={modelKeyStr(m)} onClick={() => onOpen(m)} style={{ cursor: 'pointer', opacity: m.requests < MIN_REQUESTS ? 0.7 : 1 }} data-testid="stats-row">
                      <Table.Td>{check(m)}</Table.Td>
                      <Table.Td />
                      <Table.Td>{effortCell(m)}</Table.Td>
                      {cells([m])}
                    </Table.Tr>
                  ))
                : [])
            ]
          })}
        </Table.Tbody>
      </Table>
    </Box>
  )
}

// ---------------------------------------------------------------- detail pieces

function Tile({ label: name, value, sub, tip }: { label: string; value: string; sub?: string; tip?: string }): React.JSX.Element {
  return (
    <Box p="md" style={{ borderRight: '1px solid var(--ac-border-subtle)', borderBottom: '1px solid var(--ac-border-subtle)' }}>
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
    <Box style={{ width: 90, height: 6, borderRadius: 3, background: 'var(--ac-surface-active)', overflow: 'hidden' }}>
      <Box style={{ width: `${Math.min(100, v * 100)}%`, height: '100%', background: 'var(--ac-text-muted)' }} />
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
const DIST_KEYS: DistKey[] = ['responseSec', 'toolsPerRequest', 'turnsPerRequest', 'outputPerRequest']

function DistTable({
  rows,
  fmt
}: {
  rows: { key: DistKey | 'contextPerTurn'; d: Dist | null; hatch?: boolean; tag?: React.ReactNode; max?: React.ReactNode; requests?: number }[]
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
                <Group gap={6} wrap="nowrap">
                  {r.tag}
                  <Text size="sm" style={{ whiteSpace: 'nowrap' }}>
                    {t(`models.detail.metric.${r.key}`)}
                  </Text>
                </Group>
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
                    <BoxPlot d={r.d} domain={domain(r.key)} hatch={r.hatch} />
                  </Table.Td>
                </>
              ) : (
                <Table.Td colSpan={8}>
                  <Text size="xs" c="dimmed">
                    {r.requests !== undefined ? t('models.detail.fewRequests', { n: r.requests }) : '—'}
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

function ModelDetailView({ k, range, onSession }: { k: ModelKey; range: Range; onSession: (tool: string, id: string) => void }): React.JSX.Element {
  const f = useFmt()
  const { t } = f
  const [tab, setTab] = useState<string | null>('turns')
  const [listTab, setListTab] = useState<string | null>('tools')
  const [sessionSort, setSessionSort] = useState<'turns' | 'output' | 'toolCalls'>('turns')
  const { data } = useStatsLoad<ModelDetail>([modelKeyStr(k), JSON.stringify(range)], () => window.api.modelDetail(k, range))
  if (data === undefined) return <Loading />
  if (!data) return <Text c="dimmed">{t('models.indexing')}</Text>
  const s = data.summary
  const med = s.median
  const fmtOf = (key: string): ((n: number) => string) => (key === 'responseSec' ? f.dur : key === 'outputPerRequest' || key === 'contextPerTurn' ? f.tok : f.int)
  const axis = dayAxis(data.daily, range)
  const byDay = new Map(data.daily.map((d) => [d.day, d]))
  const chartKey = tab === 'output' ? 'output' : tab === 'context' ? 'context' : 'turns'
  const chart = axis.map((day) => ({ day: day.slice(5), v: byDay.get(day)?.[chartKey] ?? 0 }))
  const turnsTotal = Math.max(1, s.turns)
  const weekly = data.limits.filter((l) => l.windowMinutes === 10080)
  const limits = weekly.length ? weekly : data.limits
  const plan = limits.find((l) => l.plan)?.plan ?? '—'
  const errTotal = s.errors.mistake + s.errors.command + s.errors.policy + s.errors.userReject + s.errors.other
  const kinds = ['mistake', 'command', 'policy', 'userReject', 'other'] as const
  const kindAvailable = (kind: (typeof kinds)[number]): boolean => s.tool === 'claude' || (s.tool === 'codex' ? kind === 'command' : kind === 'other')
  const sessions = [...data.sessions].sort((a, b) => b[sessionSort] - a[sessionSort]).slice(0, 10)
  const listRows = listTab === 'skills' ? data.skills : listTab === 'mcp' ? data.mcp : data.tools
  const listMax = Math.max(1, ...listRows.map((x) => x.calls))
  const projMax = Math.max(1, ...data.projects.map((p) => p.turns))

  return (
    <Stack gap="xl" data-testid="stats-detail">
      <Text size="sm" c="dimmed" style={NUM}>
        {t('models.detail.sub', { from: s.first, to: s.last, days: s.activeDays, n: f.int(s.requests) })}
      </Text>

      <Box>
        <SectionTitle>{t('models.detail.summary')}</SectionTitle>
        <Box className="ac-card" style={{ overflow: 'hidden' }}>
          <SimpleGrid cols={3} spacing={0}>
            <Tile label={t('models.detail.sessions')} value={f.int(s.sessions)} sub={s.sessions ? t('models.detail.sessionsSub', { n: (s.requests / s.sessions).toFixed(1) }) : undefined} />
            <Tile label={t('models.detail.subagents')} value={f.int(s.subagentSessions)} sub={t('models.detail.subagentsSub')} />
            <Tile label={t('models.detail.turns')} value={f.int(s.turns)} sub={med.turnsPerRequest !== null ? t('models.detail.turnsSub', { n: med.turnsPerRequest }) : undefined} tip={t('models.tip.turns')} />
            <Tile label={t('models.detail.toolCalls')} value={f.int(s.toolCalls)} sub={med.toolsPerRequest !== null ? t('models.detail.toolCallsSub', { n: med.toolsPerRequest }) : undefined} />
            <Tile
              label={t('models.detail.mistakes')}
              value={s.tool === 'claude' ? f.int(s.errors.mistake) : '—'}
              sub={s.tool !== 'claude' ? t('models.detail.mistakesNA') : s.toolCalls >= MIN_TOOL_CALLS ? t('models.detail.mistakesSub', { n: (s.errors.mistake / (s.toolCalls / 100)).toFixed(2) }) : undefined}
              tip={t('models.tip.mistakes')}
            />
            <Tile
              label={t('models.detail.interrupts')}
              value={s.tool === 'opencode' ? '—' : f.int(s.interrupts)}
              sub={s.tool !== 'opencode' ? t('models.detail.interruptsSub', { n: ((s.interrupts / turnsTotal) * 100).toFixed(2) }) : undefined}
              tip={t(`models.detail.interruptTip.${s.tool === 'codex' ? 'codex' : s.tool === 'opencode' ? 'opencode' : 'claude'}`)}
            />
          </SimpleGrid>
        </Box>
      </Box>

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
          <BarChart
            h={200}
            data={chart}
            dataKey="day"
            series={[{ name: 'v', label: t(`models.detail.tab${chartKey === 'turns' ? 'Turns' : chartKey === 'output' ? 'Output' : 'Context'}`), color: 'accent.6' }]}
            withLegend={false}
            gridAxis="y"
            tickLine="none"
            valueFormatter={(v) => (chartKey === 'turns' ? f.int(v) : f.tok(v))}
            barProps={{ radius: 2 }}
          />
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
                {(['input', 'cacheWrite', 'cacheRead', 'output', 'reasoning'] as const).map((key) => {
                  const v = s.tokens[key]
                  // Codex logs have no cache writes
                  const missing = v === 0 && key === 'cacheWrite' && s.tool === 'codex'
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
                })}
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
        <SectionTitle right={<Text size="xs" c="dimmed">{f.int(s.requests)}</Text>}>{t('models.detail.dist')}</SectionTitle>
        {s.requests < MIN_REQUESTS ? (
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
                  <Tooltip label={t('models.detail.maxSession', { title: ref.title || t('models.detail.untitled') })} withArrow>
                    <UnstyledButton ml={4} onClick={() => onSession(ref.tool, ref.id)} aria-label={t('models.detail.maxSession', { title: ref.title })}>
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
        <SectionTitle right={<Text size="xs" c="dimmed">{f.int(errTotal)}</Text>}>{t('models.detail.errors')}</SectionTitle>
        <Box className="ac-card" p="md">
          {s.tool !== 'claude' && (
            <Text size="xs" c="dimmed" mb="sm">
              {t(s.tool === 'codex' ? 'models.detail.errorsCodex' : 'models.detail.errorsOpencode')}
            </Text>
          )}
          {errTotal > 0 && (
            <Group gap={0} wrap="nowrap" mb="md" style={{ height: 10, borderRadius: 5, overflow: 'hidden' }}>
              {kinds.map((kind, i) =>
                s.errors[kind] ? (
                  <Box
                    key={kind}
                    style={{
                      width: `${(s.errors[kind] / errTotal) * 100}%`,
                      height: '100%',
                      background: kind === 'mistake' ? 'var(--ac-accent)' : `color-mix(in srgb, var(--ac-text-muted) ${90 - i * 15}%, transparent)`
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
                      {ok && s.toolCalls >= MIN_TOOL_CALLS ? (n / (s.toolCalls / 100)).toFixed(2) : '—'}
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
                        <Text size="sm" ff="monospace">
                          {x.name}
                        </Text>
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
          <Table highlightOnHover verticalSpacing={6} horizontalSpacing="sm" style={{ minWidth: 720 }}>
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
                <Table.Tr key={`${x.tool}:${x.id}`} onClick={() => onSession(x.tool, x.id)} style={{ cursor: 'pointer' }} data-testid="stats-session">
                  <Table.Td maw={260}>
                    <Text size="sm" truncate="end">
                      {x.title || t('models.detail.untitled')}
                    </Text>
                  </Table.Td>
                  <Table.Td maw={160}>
                    <Text size="xs" c="dimmed" ff={x.project ? 'monospace' : undefined} truncate="end">
                      {x.project || t('models.detail.noProject')}
                    </Text>
                  </Table.Td>
                  <Table.Td style={NUM}>
                    <Text size="xs" c="dimmed">
                      {x.first === x.last ? x.first.slice(5) : `${x.first.slice(5)} ~ ${x.last.slice(5)}`}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right" style={NUM}>
                    {f.int(x.turns)}
                  </Table.Td>
                  <Table.Td ta="right" style={NUM}>
                    {f.int(x.toolCalls)}
                  </Table.Td>
                  <Table.Td ta="right" style={NUM}>
                    {s.tool === 'claude' ? f.int(x.mistakes) : '—'}
                  </Table.Td>
                  <Table.Td ta="right" style={NUM}>
                    {f.tok(x.output)}
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
                    <Text size="sm" ff={p.project ? 'monospace' : undefined} c={p.project ? undefined : 'dimmed'}>
                      {p.project || t('models.detail.noProject')}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right" style={NUM}>
                    {f.int(p.turns)}
                  </Table.Td>
                  <Table.Td w={110}>
                    <ShareBar v={p.turns / projMax} />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      </Box>
    </Stack>
  )
}

// ---------------------------------------------------------------- side by side

function Swatch({ b }: { b?: boolean }): React.JSX.Element {
  return (
    <svg width="12" height="12" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="0.5" y="0.5" width="11" height="11" rx="2" fill={b ? 'url(#ac-hatch)' : 'var(--ac-accent-bg)'} stroke={b ? 'var(--ac-text)' : 'var(--ac-accent)'} />
    </svg>
  )
}

function CompareView({ a, b, range }: { a: ModelKey; b: ModelKey; range: Range }): React.JSX.Element {
  const f = useFmt()
  const { t } = f
  // First the chosen range for both, then — when their days overlap — only the overlapping days
  const first = useStatsLoad<[ModelDetail | null, ModelDetail | null]>([modelKeyStr(a), modelKeyStr(b), JSON.stringify(range)], () =>
    Promise.all([window.api.modelDetail(a, range), window.api.modelDetail(b, range)])
  )
  const overlap = useMemo(() => {
    const [x, y] = first.data ?? [null, null]
    if (!x || !y) return null
    const days = new Set(x.daily.filter((d) => d.turns > 0).map((d) => d.day))
    const both = y.daily.filter((d) => d.turns > 0 && days.has(d.day)).map((d) => d.day)
    return both.length ? { from: both[0], to: both[both.length - 1], days: both.length } : null
  }, [first.data])
  const second = useStatsLoad<[ModelDetail | null, ModelDetail | null]>([modelKeyStr(a), modelKeyStr(b), overlap?.from, overlap?.to], () =>
    overlap ? Promise.all([window.api.modelDetail(a, overlap), window.api.modelDetail(b, overlap)]) : Promise.resolve(null)
  )
  if (first.data === undefined) return <Loading />
  if (overlap && second.data === undefined) return <Loading />
  // The overlap is used only when both sides have enough requests in it; otherwise each model's whole period, without differences
  const inOverlap = second.data ?? null
  const enough = !!overlap && !!inOverlap?.[0] && !!inOverlap?.[1] && inOverlap[0].summary.requests >= MIN_REQUESTS && inOverlap[1].summary.requests >= MIN_REQUESTS
  const pair = enough ? inOverlap : first.data
  const [x, y] = pair ?? [null, null]
  if (!x || !y) return <Text c="dimmed">{t('models.indexing')}</Text>
  const A = x.summary
  const B = y.summary
  const showDiff = enough
  const ratio = (p: number, q: number): string => (q ? `×${(p / q).toFixed(2)}` : '—')
  const pp = (p: number, q: number): string => `${p - q >= 0 ? '+' : ''}${((p - q) * 100).toFixed(2)}%p`
  const rate = (m: ModelSummary): number | null => (m.tool === 'claude' && m.toolCalls >= MIN_TOOL_CALLS ? m.errors.mistake / m.toolCalls : null)
  const allErr = (m: ModelSummary): number => m.errors.mistake + m.errors.command + m.errors.policy + m.errors.userReject + m.errors.other
  const fmtOf = (key: string): ((n: number) => string) => (key === 'responseSec' ? f.dur : key === 'outputPerRequest' || key === 'contextPerTurn' ? f.tok : f.int)
  const rows: { name: string; a: string; b: string; diff?: string; muted?: boolean }[] = [
    { name: t('models.col.period'), a: `${A.first.slice(5)} ~ ${A.last.slice(5)}`, b: `${B.first.slice(5)} ~ ${B.last.slice(5)}` },
    { name: t('models.detail.sessions'), a: f.int(A.sessions), b: f.int(B.sessions), diff: ratio(A.sessions, B.sessions) },
    { name: t('models.col.requests'), a: f.int(A.requests), b: f.int(B.requests), diff: ratio(A.requests, B.requests) },
    { name: t('models.detail.turns'), a: f.int(A.turns), b: f.int(B.turns), diff: ratio(A.turns, B.turns) },
    { name: t('models.detail.toolCalls'), a: f.int(A.toolCalls), b: f.int(B.toolCalls), diff: ratio(A.toolCalls, B.toolCalls) },
    {
      name: `${t('models.detail.mistakes')} (${t('models.col.per100')})`,
      a: rate(A) === null ? '—' : (rate(A)! * 100).toFixed(2),
      b: rate(B) === null ? '—' : (rate(B)! * 100).toFixed(2),
      diff: rate(A) !== null && rate(B) !== null ? pp(rate(A)!, rate(B)!) : '—'
    },
    A.tool === B.tool && A.tool !== 'opencode'
      ? {
          name: `${t('models.detail.interrupts')} (${t('models.detail.interruptsSub', { n: '' }).trim()})`,
          a: ((A.interrupts / Math.max(1, A.turns)) * 100).toFixed(2),
          b: ((B.interrupts / Math.max(1, B.turns)) * 100).toFixed(2)
        }
      : { name: t('models.detail.interrupts'), a: t('models.cmp.interruptsNA'), b: '', muted: true },
    { name: t('models.detail.tk.output'), a: f.tok(A.tokens.output), b: f.tok(B.tokens.output), diff: ratio(A.tokens.output, B.tokens.output) },
    {
      name: t('models.col.context'),
      a: A.median.contextPerTurn === null ? '—' : f.tok(A.median.contextPerTurn),
      b: B.median.contextPerTurn === null ? '—' : f.tok(B.median.contextPerTurn),
      diff: A.median.contextPerTurn && B.median.contextPerTurn ? ratio(A.median.contextPerTurn, B.median.contextPerTurn) : '—'
    },
    {
      name: t('models.cmp.allErrors'),
      a: A.toolCalls ? f.pct(allErr(A) / A.toolCalls) : '—',
      b: B.toolCalls ? f.pct(allErr(B) / B.toolCalls) : '—',
      muted: true
    }
  ]
  const toolNames = [...new Set([...x.tools.slice(0, 10).map((q) => q.name), ...y.tools.slice(0, 10).map((q) => q.name)])]
  const toolOf = (d: ModelDetail, n: string): { calls: number; errors: number } | undefined => d.tools.find((q) => q.name === n)

  return (
    <Stack gap="xl" data-testid="stats-compare">
      <SimpleGrid cols={2}>
        {[
          { k: a, m: A, b: false },
          { k: b, m: B, b: true }
        ].map(({ k, m, b: isB }) => (
          <Box key={modelKeyStr(k)} className="ac-card" p="md">
            <Group gap={8} wrap="nowrap">
              <Swatch b={isB} />
              <Text fw={600} ff="monospace">
                {label(k)}
              </Text>
              <ToolTag tool={k.tool} />
            </Group>
            <Text size="xs" c="dimmed" mt={4} style={NUM}>
              {isB ? 'B' : 'A'} · {m.first} ~ {m.last} · {t('models.activeDays', { n: m.activeDays })}
            </Text>
          </Box>
        ))}
      </SimpleGrid>
      <Text size="sm" c="dimmed" className="ac-card" p="sm" data-testid="stats-overlap">
        {!overlap ? t('models.cmp.noOverlap') : enough ? t('models.cmp.overlap', { from: overlap.from, to: overlap.to, days: overlap.days }) : t('models.cmp.overlapSmall', { from: overlap.from, to: overlap.to, days: overlap.days })}
      </Text>

      <Box className="ac-card" style={{ overflowX: 'auto' }}>
        <Table verticalSpacing={7} horizontalSpacing="md">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>
                <Text size="xs" c="dimmed" fw={600}>
                  {t('models.cmp.metric')}
                </Text>
              </Table.Th>
              <Table.Th ta="right">
                <Group gap={4} justify="flex-end">
                  <Swatch />
                  <Text size="xs" fw={600}>
                    A
                  </Text>
                </Group>
              </Table.Th>
              <Table.Th ta="right">
                <Group gap={4} justify="flex-end">
                  <Swatch b />
                  <Text size="xs" fw={600}>
                    B
                  </Text>
                </Group>
              </Table.Th>
              {showDiff && (
                <Table.Th ta="right">
                  <Text size="xs" c="dimmed" fw={600}>
                    {t('models.cmp.diff')}
                  </Text>
                </Table.Th>
              )}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r.name}>
                <Table.Td>
                  <Text size="sm" c={r.muted ? 'dimmed' : undefined}>
                    {r.name}
                  </Text>
                </Table.Td>
                {r.b === '' ? (
                  <Table.Td colSpan={showDiff ? 3 : 2} ta="right">
                    <Text size="sm" c="dimmed">
                      {r.a}
                    </Text>
                  </Table.Td>
                ) : (
                  <>
                    <Table.Td ta="right" style={NUM} c={r.muted ? 'dimmed' : undefined}>
                      {r.a}
                    </Table.Td>
                    <Table.Td ta="right" style={NUM} c={r.muted ? 'dimmed' : undefined}>
                      {r.b}
                    </Table.Td>
                    {showDiff && (
                      <Table.Td ta="right" style={NUM} c="dimmed">
                        {r.diff ?? ''}
                      </Table.Td>
                    )}
                  </>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>

      <Box>
        <SectionTitle>{t('models.detail.dist')}</SectionTitle>
        <DistTable
          fmt={fmtOf}
          rows={DIST_KEYS.flatMap((key) => [
            { key, d: x.dist[key], tag: <Swatch />, requests: A.requests },
            { key, d: y.dist[key], hatch: true, tag: <Swatch b />, requests: B.requests }
          ])}
        />
      </Box>

      <Box>
        <SectionTitle>{t('models.detail.tabTools')}</SectionTitle>
        <Box className="ac-card">
          <Table verticalSpacing={5} horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th />
                <Table.Th ta="right">
                  <Group gap={4} justify="flex-end">
                    <Swatch />
                    <Text size="xs" fw={600}>
                      {t('models.detail.calls')}
                    </Text>
                  </Group>
                </Table.Th>
                <Table.Th ta="right">
                  <Text size="xs" c="dimmed" fw={600}>
                    {t('models.detail.errorRate')}
                  </Text>
                </Table.Th>
                <Table.Th ta="right">
                  <Group gap={4} justify="flex-end">
                    <Swatch b />
                    <Text size="xs" fw={600}>
                      {t('models.detail.calls')}
                    </Text>
                  </Group>
                </Table.Th>
                <Table.Th ta="right">
                  <Text size="xs" c="dimmed" fw={600}>
                    {t('models.detail.errorRate')}
                  </Text>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {toolNames.map((n) => {
                const p = toolOf(x, n)
                const q = toolOf(y, n)
                return (
                  <Table.Tr key={n}>
                    <Table.Td>
                      <Text size="sm" ff="monospace">
                        {n}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right" style={NUM}>
                      {p ? f.int(p.calls) : '—'}
                    </Table.Td>
                    <Table.Td ta="right" style={NUM} c="dimmed">
                      {p?.errors ? f.pct(p.errors / p.calls) : '—'}
                    </Table.Td>
                    <Table.Td ta="right" style={NUM}>
                      {q ? f.int(q.calls) : '—'}
                    </Table.Td>
                    <Table.Td ta="right" style={NUM} c="dimmed">
                      {q?.errors ? f.pct(q.errors / q.calls) : '—'}
                    </Table.Td>
                  </Table.Tr>
                )
              })}
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
  const [days, setDays] = useState<Days>(30)
  const [tool, setTool] = useState<string>('all')
  const [showSmall, setShowSmall] = useState(false)
  const [checked, setChecked] = useState<ModelKey[]>([])
  const [selected, setSelected] = useState<ModelKey | null>(null)
  const [comparing, setComparing] = useState<[ModelKey, ModelKey] | null>(null)
  const range = rangeOf(days)
  const { data, indexing } = useStatsLoad<ModelSummary[]>([days], () => window.api.models(range))
  useNavSelect((s) => {
    const k = parseModelKey(s)
    if (k) setSelected(k)
  })

  const tools = [...new Set((data ?? []).map((m) => m.tool))]
  const models = (data ?? []).filter((m) => tool === 'all' || m.tool === tool)
  const openSession = (sessionTool: string, id: string): void => navigate('sessions', { select: `${sessionTool}:${id}` })
  const hidden = models.filter((m) => m.requests < MIN_REQUESTS).length

  return (
    <Stack gap={0} style={{ flex: 1 }}>
      <PageHeader title={t('nav.stats')} count={data ? models.length : undefined} actions={<ReloadButton />} />
      <Group gap="sm" mb="xs" wrap="wrap">
        <SegmentedControl
          size="xs"
          value={String(days)}
          onChange={(v) => setDays(Number(v) as Days)}
          data={[
            { value: '7', label: t('models.days7') },
            { value: '30', label: t('models.days30') },
            { value: '90', label: t('models.days90') },
            { value: '0', label: t('models.all') }
          ]}
          data-testid="stats-days"
        />
        <SegmentedControl
          size="xs"
          value={tool}
          onChange={setTool}
          data={[{ value: 'all', label: t('models.allTools') }, ...tools.map((x) => ({ value: x, label: toolName(x) }))]}
          data-testid="stats-tool"
        />
        <Switch size="sm" checked={showSmall} onChange={(e) => setShowSmall(e.currentTarget.checked)} label={`${t('models.showSmall')}${hidden ? ` (${hidden})` : ''}`} data-testid="stats-small" />
        <Group gap="xs" ml="auto">
          <Text size="xs" c="dimmed">
            {t('models.compareHint')}
          </Text>
          <Button size="xs" variant="default" disabled={checked.length !== 2} onClick={() => checked.length === 2 && setComparing([checked[0], checked[1]])} data-testid="stats-compare-open">
            {t('models.compare')}
          </Button>
        </Group>
      </Group>
      <Text size="xs" c="dimmed" mb="sm">
        {t('models.note')}
      </Text>
      {data === undefined ? (
        <Loading />
      ) : data === null ? (
        <Text size="sm" c="dimmed">
          {t('models.indexing')}
        </Text>
      ) : data.length === 0 ? (
        <Text size="sm" c="dimmed">
          {indexing ? t('models.indexing') : t('models.none')}
        </Text>
      ) : models.filter((m) => showSmall || m.requests >= MIN_REQUESTS).length === 0 ? (
        <Group gap="sm">
          <Text size="sm" c="dimmed">
            {t('models.empty')}
          </Text>
          {days !== 0 && (
            <Button size="compact-xs" variant="subtle" onClick={() => setDays(0)}>
              {t('models.showAll')}
            </Button>
          )}
        </Group>
      ) : (
        <StatsList
          models={models}
          showSmall={showSmall}
          onOpen={setSelected}
          checked={checked}
          onCheck={(k, on) => setChecked((c) => (on ? [...c.filter((x) => !sameKey(x, k)), k].slice(-2) : c.filter((x) => !sameKey(x, k))))}
        />
      )}

      <DetailSheet
        opened={!!selected}
        onClose={() => setSelected(null)}
        title={
          selected ? (
            <Group gap="sm" wrap="nowrap">
              <span style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}>{label(selected)}</span>
              <ToolTag tool={selected.tool} />
            </Group>
          ) : (
            ''
          )
        }
      >
        {selected && <ModelDetailView k={selected} range={range} onSession={openSession} />}
      </DetailSheet>
      <DetailSheet opened={!!comparing} onClose={() => setComparing(null)} title={t('models.cmp.title')}>
        {comparing && <CompareView a={comparing[0]} b={comparing[1]} range={range} />}
      </DetailSheet>
    </Stack>
  )
}

export default Stats
