import { Fragment, useRef, useState } from 'react'
import { Box, Button, Checkbox, Group, Stack, Table, Text, UnstyledButton } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import type { ModelKey, ModelSummary, ToolId } from '../../../shared/api'
import {
  chartRows,
  effortOrder,
  providerColor,
  providerText,
  seriesKey,
  usd
} from '../lib/leaderboard'
import { modelKeyStr, modelLabel } from '../lib/modelKey'
import { TOOL_NAME } from '../lib/tools'
import './UsageLeaderboard.css'
import { modelGroups, tokenTotal } from '../lib/modelGroups'

const toolName = (tool: string): string => TOOL_NAME[tool as ToolId] ?? tool
const upper = (n: number): number => {
  const step = 10 ** Math.floor(Math.log10(n || 1)) / 2
  return Math.ceil(((n || 1) * 1.12) / step) * step
}
type Metric =
  | 'requests'
  | 'activeDays'
  | 'response'
  | 'output'
  | 'tools'
  | 'cost'
  | 'perCost'
  | 'turns'
  | 'context'
  | 'mistakes'

export function UsageLeaderboard({
  models,
  showSmall,
  onOpen,
  checked,
  onCheck
}: {
  models: ModelSummary[]
  showSmall: boolean
  onOpen: (key: ModelKey) => void
  checked: ModelKey[]
  onCheck: (key: ModelKey, checked: boolean) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [zoom, setZoom] = useState(1)
  const viewport = useRef<HTMLDivElement>(null)
  const [sort, setSort] = useState<{ key: Metric; dir: number }>({ key: 'perCost', dir: 1 })
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [hover, setHover] = useState<{ series: string; point?: string } | null>(null)
  const [focus, setFocus] = useState<{ series: string; point?: string } | null>(null)
  const eligible = chartRows(models)
  const visible = eligible.filter((m) => !hidden.has(seriesKey(m)))
  const series = [...new Set(eligible.map(seriesKey))]
  const activeCandidate = hover ?? focus
  const active =
    activeCandidate && visible.some((m) => seriesKey(m) === activeCandidate.series)
      ? activeCandidate
      : null
  const point = active?.point ? visible.find((m) => modelKeyStr(m) === active.point) : undefined
  const maxX = upper(Math.max(0, ...eligible.map((m) => m.x)))
  const maxY = upper(Math.max(0, ...eligible.map((m) => m.y)))
  const x = (n: number): number => 70 + (n / maxX) * 900
  const y = (n: number): number => 285 - (n / maxY) * 245
  const muted = (m: ModelKey): boolean => !!active && active.series !== seriesKey(m)
  const color = (m: ModelKey): string =>
    muted(m) ? 'var(--ac-text-muted)' : providerColor(m.model)
  const textColor = (m: ModelKey): string =>
    muted(m) ? 'var(--ac-text-muted)' : providerText(m.model)
  const integer = (n: number): string => Math.round(n).toLocaleString(i18n.language)
  const setPointHover = (m: ModelKey): void =>
    setHover({ series: seriesKey(m), point: modelKeyStr(m) })
  const moveFocus = (m: ModelKey): void => setFocus({ series: seriesKey(m), point: modelKeyStr(m) })
  const boxes: { x: number; y: number; w: number; h: number }[] = []
  const labels = visible.map((m) => {
    const px = x(m.x),
      py = y(m.y),
      w = modelLabel(m).length * 6.1 + 6,
      h = 15
    const candidates = [
      [px - w / 2, py - 23],
      [px - w / 2, py + 10],
      [px - w / 2, py - 42],
      [px + 12, py - 23],
      [px - w - 12, py - 23],
      [px + 12, py + 6],
      [px - w - 12, py + 6],
      [px + 12, py - 60],
      [px - w - 12, py - 60],
      [px + 12, py + 40],
      [px - w - 12, py + 40]
    ]
    const candidate = candidates.find(
      ([lx, ly]) =>
        lx >= 70 &&
        lx + w <= 970 &&
        ly >= 24 &&
        ly + h <= 277 &&
        !boxes.some(
          (b) => lx < b.x + b.w + 5 && lx + w + 5 > b.x && ly < b.y + b.h + 4 && ly + h + 4 > b.y
        ) &&
        !visible.some(
          (n) =>
            n !== m &&
            Math.abs(x(n.x) - (lx + w / 2)) < w / 2 + 9 &&
            Math.abs(y(n.y) - (ly + h / 2)) < h / 2 + 9
        )
    )
    const [lx, ly] = candidate ?? [
      Math.min(970 - w, Math.max(70, px - w / 2)),
      Math.max(24, py - 23)
    ]
    boxes.push({ x: lx, y: ly, w, h })
    return { m, px, py, lx: lx + w / 2, ly }
  })
  const costs = new Map(models.map((m) => [modelKeyStr(m), m.pricing]))
  const value = (m: ModelSummary, metric: Metric): number | null =>
    metric === 'cost'
      ? (costs.get(modelKeyStr(m))?.total ?? null)
      : metric === 'perCost'
        ? (costs.get(modelKeyStr(m))?.perRequest ?? null)
        : metric === 'response'
          ? m.median.responseSec
          : metric === 'tools'
            ? m.median.toolsPerRequest
            : metric === 'turns'
              ? m.median.turnsPerRequest
              : metric === 'context'
                ? m.median.contextPerTurn
                : metric === 'mistakes'
                  ? m.tool === 'claude' && m.toolCalls >= 100
                    ? (m.errors.mistake * 100) / m.toolCalls
                    : null
                  : metric === 'output'
                    ? m.median.outputPerRequest
                    : m[metric]
  const rows = [...models].sort((a, b) => {
    const av = value(a, sort.key),
      bv = value(b, sort.key)
    return av === null
      ? bv === null
        ? 0
        : 1
      : bv === null
        ? -1
        : (av - bv) * sort.dir || modelKeyStr(a).localeCompare(modelKeyStr(b))
  })
  const groups = modelGroups(rows).filter(
    (g) => showSmall || g.children.some((m) => m.requests >= 30)
  )
  if (sort.key === 'requests' || sort.key === 'cost' || sort.key === 'activeDays')
    groups.sort((a, b) => {
      if (sort.key === 'activeDays') return a.last.localeCompare(b.last) * sort.dir
      const av = sort.key === 'cost' ? a.cost : a.requests,
        bv = sort.key === 'cost' ? b.cost : b.requests
      return av === null ? (bv === null ? 0 : 1) : bv === null ? -1 : (av - bv) * sort.dir
    })
  const barMax = Object.fromEntries(
    (['response', 'output', 'perCost'] as const).map((key) => [
      key,
      Math.max(
        0,
        ...models.filter((m) => showSmall || m.requests >= 30).map((m) => value(m, key) ?? 0)
      )
    ])
  )
  const bar = (
    m: ModelSummary,
    key: 'response' | 'output' | 'perCost'
  ): React.JSX.Element | null => {
    const n = value(m, key)
    if (n === null || !Number.isFinite(n)) return null
    return (
      <div className="lb-metric-bar" data-metric-bar={key} aria-hidden="true">
        <span
          style={{
            width: `${barMax[key] > 0 ? Math.max(0, Math.min(100, (n / barMax[key]) * 100)) : 0}%`
          }}
        />
      </div>
    )
  }
  const columns: { key: Metric; label: string }[] = [
    { key: 'requests', label: t('models.col.requests') },
    { key: 'activeDays', label: t('efficiency.periodDays') },
    { key: 'response', label: t('models.col.response') },
    { key: 'output', label: t('models.col.outPerReq') },
    { key: 'tools', label: t('models.col.toolsPerReq') },
    { key: 'turns', label: t('models.col.turnsPerReq') },
    { key: 'context', label: t('models.col.context') },
    { key: 'mistakes', label: t('models.col.mistakes') },
    { key: 'cost', label: t('leaderboard.totalCost') },
    { key: 'perCost', label: t('leaderboard.perCost') }
  ]

  return (
    <Stack gap="md" data-testid="usage-leaderboard">
      <Box className="ac-card usage-scatter" p="md" data-testid="stats-scatter">
        <Group justify="flex-end" gap="xs" mb="xs">
          <Button
            variant="subtle"
            size="compact-xs"
            aria-label={t('leaderboard.zoomOut')}
            disabled={zoom <= 1}
            onClick={() => setZoom((n) => Math.max(1, n - 0.25))}
          >
            −
          </Button>
          <Text component="span" size="xs" c="dimmed">
            {Math.round(zoom * 100)}%
          </Text>
          <Button
            variant="subtle"
            size="compact-xs"
            aria-label={t('leaderboard.zoomIn')}
            disabled={zoom >= 3}
            onClick={() => setZoom((n) => Math.min(3, n + 0.25))}
          >
            +
          </Button>
          <Button
            variant="subtle"
            size="compact-xs"
            onClick={() => {
              setZoom(1)
              viewport.current?.scrollTo({ top: 0, left: 0 })
            }}
          >
            {t('leaderboard.zoomReset')}
          </Button>
        </Group>
        <div className="lb-viewport" ref={viewport} data-testid="stats-chart-viewport">
          <svg
            style={{ width: `${zoom * 100}%` }}
            data-zoom={zoom}
            viewBox="0 0 1000 340"
            role="group"
            aria-label={t('leaderboard.chart')}
            onMouseLeave={() => setHover(null)}
          >
            <text x={70} y={17} className="lb-axis-label">
              {t('leaderboard.yAxis')}
            </text>
            {[0, 1, 2, 3, 4].map((i) => (
              <g key={i} className="lb-grid">
                <line x1={70} y1={y((i * maxY) / 4)} x2={970} y2={y((i * maxY) / 4)} />
                <line x1={x((i * maxX) / 4)} y1={40} x2={x((i * maxX) / 4)} y2={285} />
                <text x={60} y={y((i * maxY) / 4) + 3} textAnchor="end">
                  {integer((i * maxY) / 4)}
                </text>
                <text x={x((i * maxX) / 4)} y={302} textAnchor="middle">
                  {usd((i * maxX) / 4)}
                </text>
              </g>
            ))}
            {series
              .filter((k) => k !== active?.series)
              .map((k) => {
                const points = visible
                  .filter(
                    (m) => seriesKey(m) === k && m.effort && effortOrder(m.effort) < effortOrder('')
                  )
                  .sort((a, b) => effortOrder(a.effort) - effortOrder(b.effort))
                return points.length > 1 ? (
                  <polyline
                    key={k}
                    data-series-line={k}
                    points={points.map((m) => `${x(m.x)},${y(m.y)}`).join(' ')}
                    fill="none"
                    stroke={color(points[0])}
                    strokeWidth={1.5}
                    opacity={muted(points[0]) ? 1 : 0.7}
                    pointerEvents="none"
                  />
                ) : null
              })}
            {labels.map(({ m, px, py, lx, ly }) => (
              <g
                key={modelKeyStr(m)}
                role="button"
                tabIndex={0}
                className="lb-point"
                data-testid="stats-point"
                data-model={m.model}
                data-series={seriesKey(m)}
                data-active={active?.series === seriesKey(m)}
                aria-label={`${modelLabel(m)}, ${toolName(m.tool)}, ${usd(m.x)}, ${Math.round(m.y)}s`}
                onMouseEnter={() => setPointHover(m)}
                onFocus={() => moveFocus(m)}
                onBlur={() => setFocus(null)}
                onClick={() => onOpen(m)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen(m)
                  }
                }}
              >
                <line
                  x1={px}
                  y1={py}
                  x2={lx}
                  y2={ly + 7}
                  stroke="var(--ac-border)"
                  pointerEvents="none"
                />
                <circle cx={px} cy={py} r={15} fill="transparent" />
                <circle
                  className="lb-dot"
                  cx={px}
                  cy={py}
                  r={3.5}
                  fill={color(m)}
                  stroke="var(--ac-surface)"
                  strokeWidth={1}
                />
              </g>
            ))}
            {!visible.length && (
              <text x={520} y={155} textAnchor="middle" className="lb-axis-label">
                {t('leaderboard.noPoints')}
              </text>
            )}
            <text x={520} y={333} textAnchor="middle" className="lb-axis-label">
              {t('leaderboard.xAxis')}
            </text>
            <g className="lb-labels">
              {[...labels]
                .sort((a, b) => {
                  const priority = (m: ModelKey): number =>
                    modelKeyStr(m) === active?.point ? 2 : seriesKey(m) === active?.series ? 1 : 0
                  return priority(a.m) - priority(b.m)
                })
                .map(({ m, lx, ly }) => (
                  <text
                    key={modelKeyStr(m)}
                    data-model={m.model}
                    x={lx}
                    y={ly + 8}
                    textAnchor="middle"
                    className="lb-model"
                    fill={textColor(m)}
                    onMouseEnter={() => setPointHover(m)}
                    onClick={() => onOpen(m)}
                  >
                    {modelLabel(m)}
                  </text>
                ))}
            </g>
            {active && (
              <g data-testid="stats-active-layer" pointerEvents="none">
                {series
                  .filter((k) => k === active.series)
                  .map((k) => {
                    const points = visible
                      .filter(
                        (m) =>
                          seriesKey(m) === k && m.effort && effortOrder(m.effort) < effortOrder('')
                      )
                      .sort((a, b) => effortOrder(a.effort) - effortOrder(b.effort))
                    return points.length > 1 ? (
                      <polyline
                        key={k}
                        data-series-line={k}
                        points={points.map((m) => `${x(m.x)},${y(m.y)}`).join(' ')}
                        fill="none"
                        stroke={color(points[0])}
                        strokeWidth={1.5}
                        opacity={muted(points[0]) ? 1 : 0.7}
                        pointerEvents="none"
                      />
                    ) : null
                  })}
                {labels
                  .filter(({ m }) => seriesKey(m) === active.series)
                  .map(({ m, px, py, lx, ly }) => (
                    <g key={modelKeyStr(m)}>
                      <line x1={px} y1={py} x2={lx} y2={ly + 7} stroke={color(m)} opacity={0.35} />
                      <circle
                        cx={px}
                        cy={py}
                        r={3.5}
                        fill={color(m)}
                        data-testid="stats-active-dot"
                        stroke={
                          focus?.point === modelKeyStr(m) ? 'var(--ac-text)' : 'var(--ac-surface)'
                        }
                        strokeWidth={focus?.point === modelKeyStr(m) ? 1.5 : 1}
                        strokeDasharray={focus?.point === modelKeyStr(m) ? '3 2' : undefined}
                      />
                    </g>
                  ))}
                {point && (
                  <g
                    className="lb-guides"
                    data-testid="stats-guides"
                    style={{ '--guide-color': providerColor(point.model) } as React.CSSProperties}
                    pointerEvents="none"
                  >
                    <line x1={70} y1={y(point.y)} x2={x(point.x)} y2={y(point.y)} />
                    <line x1={x(point.x)} y1={y(point.y)} x2={x(point.x)} y2={285} />
                    <rect x={5} y={y(point.y) - 10} width={55} height={20} rx={3} />
                    <text x={32} y={y(point.y) + 3} textAnchor="middle">
                      {t('models.dur.s', { s: Math.round(point.y) })}
                    </text>
                    <rect x={x(point.x) - 34} y={291} width={68} height={20} rx={3} />
                    <text x={x(point.x)} y={304} textAnchor="middle">
                      {usd(point.x)}
                    </text>
                  </g>
                )}
                {labels
                  .filter(({ m }) => seriesKey(m) === active.series)
                  .sort(
                    (a, b) =>
                      Number(modelKeyStr(a.m) === active.point) -
                      Number(modelKeyStr(b.m) === active.point)
                  )
                  .map(({ m, lx, ly }) => (
                    <text
                      key={modelKeyStr(m)}
                      x={lx}
                      y={ly + 8}
                      textAnchor="middle"
                      className="lb-model"
                      fill={textColor(m)}
                    >
                      {modelLabel(m)}
                    </text>
                  ))}
              </g>
            )}
          </svg>
        </div>
        <Group gap={8} className="lb-legend">
          {series.map((k) => {
            const m = eligible.find((m) => seriesKey(m) === k)!
            return (
              <UnstyledButton
                key={k}
                data-testid="stats-legend"
                aria-pressed={!hidden.has(k)}
                onMouseEnter={() => setHover({ series: k })}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setFocus({ series: k })}
                onBlur={() => setFocus(null)}
                onClick={() => {
                  setHover(null)
                  setHidden((s) => {
                    const next = new Set(s)
                    if (next.has(k)) next.delete(k)
                    else next.add(k)
                    return next
                  })
                }}
                style={{
                  color: textColor(m),
                  textDecoration: hidden.has(k) ? 'line-through' : undefined
                }}
              >
                <span style={{ color: color(m) }}>●</span> {m.model}{' '}
                <span className="lb-legend-tool">{toolName(m.tool)}</span>
              </UnstyledButton>
            )
          })}
        </Group>
      </Box>
      <Box className="ac-card" style={{ overflowX: 'auto' }} data-testid="stats-table">
        <Table
          highlightOnHover
          verticalSpacing={7}
          horizontalSpacing={10}
          style={{ minWidth: 1180, fontSize: 12 }}
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={28} />
              <Table.Th>{t('models.col.model')}</Table.Th>
              <Table.Th>{t('efficiency.tokens')}</Table.Th>
              {columns.map((c) => (
                <Table.Th
                  key={c.key}
                  ta="right"
                  aria-sort={
                    sort.key === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'
                  }
                >
                  <UnstyledButton
                    onClick={() =>
                      setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : 1 }))
                    }
                  >
                    <Text size="xs" fw={600}>
                      {c.label}
                      {sort.key === c.key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}
                    </Text>
                  </UnstyledButton>
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {groups.map((g) => (
              <Fragment key={g.model}>
                <Table.Tr
                  data-testid="stats-model-parent"
                  data-model={g.model}
                  className="lb-parent"
                >
                  <Table.Td>
                    <UnstyledButton
                      className="lb-expand"
                      aria-label={t('efficiency.expand', { model: g.model })}
                      aria-expanded={!collapsed.has(g.model)}
                      onClick={() =>
                        setCollapsed((old) => {
                          const next = new Set(old)
                          if (next.has(g.model)) next.delete(g.model)
                          else next.add(g.model)
                          return next
                        })
                      }
                    >
                      <svg
                        width={20}
                        height={20}
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        style={{ transform: collapsed.has(g.model) ? undefined : 'rotate(90deg)' }}
                      >
                        <path
                          d="m9 5 7 7-7 7"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2.5}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </UnstyledButton>
                  </Table.Td>
                  <Table.Td>
                    <Text
                      size="sm"
                      ff="monospace"
                      fw={600}
                      style={{ color: providerText(g.model) }}
                    >
                      {g.model}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {g.tools.map(toolName).join(' · ')}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">{integer(g.tokens)}</Table.Td>
                  <Table.Td ta="right">{integer(g.requests)}</Table.Td>
                  <Table.Td ta="right">
                    <Text size="xs" style={{ whiteSpace: 'nowrap' }}>
                      {g.first}
                      <br />
                      {g.last}
                    </Text>
                  </Table.Td>
                  <Table.Td />
                  <Table.Td />
                  <Table.Td />
                  <Table.Td />
                  <Table.Td />
                  <Table.Td />
                  <Table.Td ta="right">
                    {g.cost === null ? t('efficiency.unpriced') : usd(g.cost)}
                  </Table.Td>
                  <Table.Td />
                </Table.Tr>
                {!collapsed.has(g.model) &&
                  g.children
                    .filter((m) => showSmall || m.requests >= 30)
                    .map((m) => {
                      const cost = costs.get(modelKeyStr(m)),
                        selected = checked.some((k) => modelKeyStr(k) === modelKeyStr(m))
                      return (
                        <Table.Tr
                          key={modelKeyStr(m)}
                          data-testid="stats-row"
                          data-model={m.model}
                          onMouseEnter={() => setHover({ series: seriesKey(m) })}
                          onMouseLeave={() => setHover(null)}
                        >
                          <Table.Td>
                            <Checkbox
                              size="xs"
                              aria-label={modelLabel(m)}
                              checked={selected}
                              disabled={!selected && checked.length >= 2}
                              onChange={(e) => onCheck(m, e.currentTarget.checked)}
                            />
                          </Table.Td>
                          <Table.Td>
                            <UnstyledButton
                              onClick={() => onOpen(m)}
                              onFocus={() => setFocus({ series: seriesKey(m) })}
                              onBlur={() => setFocus(null)}
                            >
                              <Text
                                size="sm"
                                ff="monospace"
                                fw={600}
                                style={{ color: providerText(m.model) }}
                                data-testid="stats-row-model"
                              >
                                {toolName(m.tool)}
                                {m.effort ? ` · ${m.effort}` : ''}
                              </Text>
                            </UnstyledButton>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" ff="monospace">
                              {integer(tokenTotal(m))}
                            </Text>
                            {m.requests < 30 && (
                              <Text size="xs" c="dimmed">
                                {t('models.small')}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td ta="right">{integer(m.requests)}</Table.Td>
                          <Table.Td ta="right">{integer(m.activeDays)}</Table.Td>
                          <Table.Td ta="right">
                            {m.median.responseSec === null
                              ? '—'
                              : t('models.dur.s', { s: Math.round(m.median.responseSec) })}
                            {bar(m, 'response')}
                          </Table.Td>
                          <Table.Td ta="right">
                            {m.median.outputPerRequest === null
                              ? '—'
                              : integer(m.median.outputPerRequest)}
                            {bar(m, 'output')}
                          </Table.Td>
                          <Table.Td ta="right">
                            {m.median.toolsPerRequest === null
                              ? '—'
                              : m.median.toolsPerRequest.toFixed(1)}
                          </Table.Td>
                          <Table.Td ta="right">
                            {m.median.turnsPerRequest === null
                              ? '—'
                              : m.median.turnsPerRequest.toFixed(1)}
                          </Table.Td>
                          <Table.Td ta="right">
                            {m.median.contextPerTurn === null
                              ? '—'
                              : integer(m.median.contextPerTurn)}
                          </Table.Td>
                          <Table.Td ta="right">
                            {value(m, 'mistakes') === null ? '—' : value(m, 'mistakes')!.toFixed(1)}
                          </Table.Td>
                          <Table.Td ta="right">
                            {cost?.total == null ? t('efficiency.unpriced') : usd(cost.total)}
                            <Text size="xs" c="dimmed">
                              {t(
                                cost?.source === 'recorded'
                                  ? 'efficiency.recorded'
                                  : cost?.source === 'mixed'
                                    ? 'efficiency.mixedCost'
                                    : 'efficiency.converted'
                              )}
                            </Text>
                          </Table.Td>
                          <Table.Td ta="right">
                            <Text size="sm" fw={600}>
                              {usd(cost?.perRequest)}
                            </Text>
                            {bar(m, 'perCost')}
                          </Table.Td>
                        </Table.Tr>
                      )
                    })}
              </Fragment>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
    </Stack>
  )
}
