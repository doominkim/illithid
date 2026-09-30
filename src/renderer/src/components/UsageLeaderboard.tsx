import { Fragment, useId, useRef, useState } from 'react'
import {
  Box,
  Button,
  Group,
  SegmentedControl,
  Stack,
  Table,
  Text,
  UnstyledButton
} from '@mantine/core'
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
import { ToolIcon } from './ToolIcon'
import { axisTicks, tickStep, placeLabels } from '../lib/scatterLayout'
import { formatTokens } from '../lib/tokenFormat'
import { modelGroups, tokenTotal } from '../lib/modelGroups'

const toolName = (tool: string): string => TOOL_NAME[tool as ToolId] ?? tool
type Metric =
  | 'tokens'
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
  onOpen
}: {
  models: ModelSummary[]
  showSmall: boolean
  onOpen: (key: ModelKey) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [zoom, setZoom] = useState(1)
  const [domain, setDomain] = useState<{
    minX: number
    maxX: number
    minY: number
    maxY: number
  } | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number; endX: number; endY: number } | null>(
    null
  )
  const clipId = useId()
  const viewport = useRef<HTMLDivElement>(null)
  const [sort, setSort] = useState<{ key: Metric; dir: number }>({ key: 'perCost', dir: 1 })
  const [groupBy, setGroupBy] = useState<'none' | 'model' | 'tool'>('none')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [hover, setHover] = useState<{ series: string; point?: string } | null>(null)
  const [focus, setFocus] = useState<{ series: string; point?: string } | null>(null)
  const eligible = chartRows(models)
  const dataSignature = eligible.map((m) => `${modelKeyStr(m)}:${m.x}:${m.y}`).join('|')
  const [previousData, setPreviousData] = useState(dataSignature)
  if (previousData !== dataSignature) {
    setPreviousData(dataSignature)
    setDomain(null)
    setZoom(1)
    setDrag(null)
    setHover(null)
    setFocus(null)
  }
  const visible = eligible.filter((m) => !hidden.has(seriesKey(m)))
  const series = [...new Set(eligible.map(seriesKey))]
  const activeCandidate = hover ?? focus
  const active =
    activeCandidate && visible.some((m) => seriesKey(m) === activeCandidate.series)
      ? activeCandidate
      : null
  const point = active?.point ? visible.find((m) => modelKeyStr(m) === active.point) : undefined
  const fullX = Math.max(1e-6, ...eligible.map((m) => m.x))
  const fullY = Math.max(1, ...eligible.map((m) => m.y))
  const full = {
    minX: 0,
    maxX: Math.ceil((fullX * 1.08) / tickStep(fullX)) * tickStep(fullX),
    minY: 0,
    maxY: Math.ceil((fullY * 1.08) / tickStep(fullY)) * tickStep(fullY)
  }
  const bounds = domain ?? full
  const maxX = bounds.maxX,
    maxY = bounds.maxY
  const x = (n: number): number => 70 + ((n - bounds.minX) / (maxX - bounds.minX)) * 900
  const y = (n: number): number => 380 - ((n - bounds.minY) / (maxY - bounds.minY)) * 340
  const inView = visible.filter(
    (m) => m.x >= bounds.minX && m.x <= maxX && m.y >= bounds.minY && m.y <= maxY
  )
  const changeZoom = (next: number): void => {
    if (next === 1) {
      setDomain(null)
      setZoom(1)
      setHover(null)
      return
    }
    const factor = zoom / next
    setDomain({
      minX: bounds.minX,
      maxX: Math.min(full.maxX, bounds.minX + (maxX - bounds.minX) * factor),
      minY: bounds.minY,
      maxY: Math.min(full.maxY, bounds.minY + (maxY - bounds.minY) * factor)
    })
    setZoom(next)
    setHover(null)
  }
  const position = (e: React.PointerEvent<SVGSVGElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(70, Math.min(970, ((e.clientX - rect.left) * 1000) / rect.width)),
      y: Math.max(40, Math.min(380, ((e.clientY - rect.top) * 440) / rect.height))
    }
  }
  const muted = (m: ModelKey): boolean => !!active && active.series !== seriesKey(m)
  const color = (m: ModelKey): string =>
    muted(m) ? 'var(--ac-text-muted)' : providerColor(m.model)
  const textColor = (m: ModelKey): string =>
    muted(m) ? 'var(--ac-text-muted)' : providerText(m.model)
  const integer = (n: number): string => Math.round(n).toLocaleString(i18n.language)
  const setPointHover = (m: ModelKey): void =>
    setHover({ series: seriesKey(m), point: modelKeyStr(m) })
  const moveFocus = (m: ModelKey): void => setFocus({ series: seriesKey(m), point: modelKeyStr(m) })
  const canvas = document.createElement('canvas').getContext('2d')
  if (canvas)
    canvas.font = `10px ${getComputedStyle(document.documentElement).getPropertyValue('--mantine-font-family-monospace') || 'monospace'}`
  const labels = placeLabels(
    inView.map((m) => ({
      m,
      px: x(m.x),
      py: y(m.y),
      w: (canvas?.measureText(modelLabel(m)).width ?? modelLabel(m).length * 6.1) + 8
    }))
  )
  const costs = new Map(models.map((m) => [modelKeyStr(m), m.pricing]))
  const value = (m: ModelSummary, metric: Metric): number | null =>
    metric === 'tokens'
      ? tokenTotal(m)
      : metric === 'cost'
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
  if (
    sort.key === 'tokens' ||
    sort.key === 'requests' ||
    sort.key === 'cost' ||
    sort.key === 'activeDays'
  )
    groups.sort((a, b) => {
      if (sort.key === 'activeDays') return a.last.localeCompare(b.last) * sort.dir
      const av = sort.key === 'tokens' ? a.tokens : sort.key === 'cost' ? a.cost : a.requests,
        bv = sort.key === 'tokens' ? b.tokens : sort.key === 'cost' ? b.cost : b.requests
      return av === null ? (bv === null ? 0 : 1) : bv === null ? -1 : (av - bv) * sort.dir
    })
  const displayGroups =
    groupBy === 'model'
      ? groups
      : groupBy === 'none'
        ? groups.length
          ? [{ ...groups[0], model: 'all', children: rows }]
          : []
        : [...new Set(rows.map((m) => m.tool))]
            .map((tool) => ({
              ...modelGroups(rows.filter((m) => m.tool === tool))[0],
              model: tool,
              children: rows.filter((m) => m.tool === tool)
            }))
            .filter((g) => showSmall || g.children.some((m) => m.requests >= 30))
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
    { key: 'tokens', label: t('efficiency.tokens') },
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
            onClick={() =>
              changeZoom(zoom > 3 ? Math.max(1, zoom / 1.25) : Math.max(1, zoom - 0.25))
            }
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
            onClick={() => changeZoom(Math.min(3, zoom + 0.25))}
          >
            +
          </Button>
          <Button
            variant="subtle"
            size="compact-xs"
            onClick={() => {
              setDomain(null)
              setZoom(1)
              viewport.current?.scrollTo({ top: 0, left: 0 })
            }}
          >
            {t('leaderboard.zoomReset')}
          </Button>
        </Group>
        <div className="lb-viewport" ref={viewport} data-testid="stats-chart-viewport">
          <svg
            style={{ width: '100%', touchAction: 'none' }}
            data-domain={JSON.stringify(bounds)}
            data-zoom={zoom}
            viewBox="0 0 1000 440"
            role="group"
            aria-label={`${t('leaderboard.chart')}. ${t('leaderboard.dragZoom')}`}
            onMouseLeave={() => setHover(null)}
            onPointerDown={(e) => {
              if (e.button !== 0 || (e.target as Element).closest('.lb-point, .lb-labels')) return
              const p = position(e)
              e.currentTarget.setPointerCapture(e.pointerId)
              setDrag({ ...p, endX: p.x, endY: p.y })
              setHover(null)
            }}
            onPointerMove={(e) => {
              if (drag) {
                const p = position(e)
                setDrag({ ...drag, endX: p.x, endY: p.y })
              } else if (!(e.target as Element).closest('.lb-point, .lb-labels')) setHover(null)
            }}
            onPointerCancel={() => setDrag(null)}
            onPointerUp={(e) => {
              if (!drag) return
              const p = position(e)
              if (Math.abs(p.x - drag.x) > 12 && Math.abs(p.y - drag.y) > 12) {
                const lowX = Math.min(p.x, drag.x),
                  highX = Math.max(p.x, drag.x)
                const lowY = Math.min(p.y, drag.y),
                  highY = Math.max(p.y, drag.y)
                setDomain({
                  minX: bounds.minX + ((lowX - 70) / 900) * (maxX - bounds.minX),
                  maxX: bounds.minX + ((highX - 70) / 900) * (maxX - bounds.minX),
                  minY: bounds.minY + ((380 - highY) / 340) * (maxY - bounds.minY),
                  maxY: bounds.minY + ((380 - lowY) / 340) * (maxY - bounds.minY)
                })
                setZoom(zoom * Math.max(900 / (highX - lowX), 340 / (highY - lowY)))
              }
              setDrag(null)
              e.currentTarget.releasePointerCapture(e.pointerId)
            }}
          >
            <title>{t('leaderboard.dragZoom')}</title>
            <defs>
              <clipPath id={clipId}>
                <rect x={70} y={40} width={900} height={340} />
              </clipPath>
            </defs>
            <text x={70} y={17} className="lb-axis-label">
              {t('leaderboard.yAxis')}
            </text>
            {axisTicks(bounds.minY, maxY).map((n) => (
              <g key={n} className="lb-grid">
                <line x1={70} y1={y(n)} x2={970} y2={y(n)} />
                <text x={60} y={y(n) + 3} textAnchor="end">
                  {integer(n)}
                </text>
              </g>
            ))}
            {axisTicks(bounds.minX, maxX).map((n) => (
              <g key={n} className="lb-grid">
                <line x1={x(n)} y1={40} x2={x(n)} y2={380} />
                <text x={x(n)} y={402} textAnchor="middle">
                  {usd(n)}
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
                    clipPath={`url(#${clipId})`}
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
            {!inView.length && (
              <text x={520} y={155} textAnchor="middle" className="lb-axis-label">
                {t('leaderboard.noPoints')}
              </text>
            )}
            <text x={520} y={433} textAnchor="middle" className="lb-axis-label">
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
                        clipPath={`url(#${clipId})`}
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
                {point && inView.includes(point) && (
                  <g
                    className="lb-guides"
                    data-testid="stats-guides"
                    style={{ '--guide-color': providerColor(point.model) } as React.CSSProperties}
                    pointerEvents="none"
                  >
                    <line x1={70} y1={y(point.y)} x2={x(point.x)} y2={y(point.y)} />
                    <line x1={x(point.x)} y1={y(point.y)} x2={x(point.x)} y2={380} />
                    <rect x={5} y={y(point.y) - 10} width={55} height={20} rx={3} />
                    <text x={32} y={y(point.y) + 3} textAnchor="middle">
                      {t('models.dur.s', { s: Math.round(point.y) })}
                    </text>
                    <rect x={x(point.x) - 34} y={391} width={68} height={20} rx={3} />
                    <text x={x(point.x)} y={404} textAnchor="middle">
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
            {drag && (
              <rect
                data-testid="stats-zoom-selection"
                x={Math.min(drag.x, drag.endX)}
                y={Math.min(drag.y, drag.endY)}
                width={Math.abs(drag.endX - drag.x)}
                height={Math.abs(drag.endY - drag.y)}
                fill="var(--ac-accent)"
                fillOpacity={0.1}
                stroke="var(--ac-accent)"
                pointerEvents="none"
              />
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
                <span><span style={{ color: color(m) }}>●</span> {m.model}</span>
                <span className="lb-legend-tool lb-tool-label">
                  <ToolIcon tool={m.tool as ToolId} size={12} />
                  {toolName(m.tool)}
                </span>
              </UnstyledButton>
            )
          })}
        </Group>
      </Box>
      <Box className="ac-card lb-table-card" data-testid="stats-table">
        <Group className="lb-table-toolbar" gap="sm">
          <Text size="xs" c="dimmed">
            {t('efficiency.groupBy')}
          </Text>
          <SegmentedControl
            data-testid="stats-group-by"
            size="xs"
            value={groupBy}
            onChange={(v) => setGroupBy(v as 'none' | 'model' | 'tool')}
            data={[
              { value: 'none', label: t('efficiency.allCombinations') },
              { value: 'model', label: t('efficiency.byModel') },
              { value: 'tool', label: t('efficiency.byTool') }
            ]}
          />
        </Group>
        <Box className="lb-table-scroll">
          <Table
            className={groupBy === 'model' ? 'lb-table lb-table-expand' : 'lb-table'}
            highlightOnHover
            verticalSpacing={10}
            horizontalSpacing={12}
            style={{ minWidth: 1180, fontSize: 12 }}
          >
            <Table.Thead>
              <Table.Tr>
                {groupBy === 'model' && <Table.Th w={64} />}
                <Table.Th>{t('models.col.model')}</Table.Th>
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
              {displayGroups.map((g) => (
                <Fragment key={g.model}>
                  {groupBy === 'tool' && (
                    <Table.Tr data-testid="stats-tool-header">
                      <Table.Td colSpan={columns.length + 1}>
                        <Group gap={6}>
                          <ToolIcon tool={g.model as ToolId} size={16} />
                          <Text fw={600}>{toolName(g.model)}</Text>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  )}
                  {groupBy === 'model' && (
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
                            style={{
                              transform: collapsed.has(g.model) ? undefined : 'rotate(90deg)'
                            }}
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
                        <Text size="xs" c="dimmed" className="lb-tools">
                          {g.tools.map((tool) => (
                            <span key={tool} className="lb-tool-label">
                              <ToolIcon tool={tool as ToolId} size={14} />
                              {toolName(tool)}
                            </span>
                          ))}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right" title={integer(g.tokens)}>
                        {formatTokens(g.tokens, i18n.language)}
                      </Table.Td>
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
                  )}
                  {(groupBy !== 'model' || !collapsed.has(g.model)) &&
                    g.children
                      .filter((m) => showSmall || m.requests >= 30)
                      .map((m) => {
                        const cost = costs.get(modelKeyStr(m))
                        return (
                          <Table.Tr
                            key={modelKeyStr(m)}
                            data-testid="stats-row"
                            data-model={m.model}
                            onMouseEnter={() => setHover({ series: seriesKey(m) })}
                            onMouseLeave={() => setHover(null)}
                          >
                            {groupBy === 'model' && <Table.Td />}
                            <Table.Td>
                              <UnstyledButton
                                onClick={() => onOpen(m)}
                                onFocus={() => setFocus({ series: seriesKey(m) })}
                                onBlur={() => setFocus(null)}
                              >
                                {groupBy !== 'model' && (
                                  <Text
                                    size="sm"
                                    ff="monospace"
                                    fw={600}
                                    style={{ color: providerText(m.model) }}
                                    data-testid="stats-row-model"
                                  >
                                    {m.model}
                                  </Text>
                                )}
                                <Text
                                  size="xs"
                                  c="dimmed"
                                  fw={400}
                                  className="lb-tool-label"
                                  data-testid={groupBy === 'model' ? 'stats-row-model' : undefined}
                                >
                                  <ToolIcon tool={m.tool as ToolId} size={14} />
                                  {toolName(m.tool)}
                                  {m.effort ? ` · ${m.effort}` : ''}
                                </Text>
                              </UnstyledButton>
                            </Table.Td>
                            <Table.Td ta="right">
                              <Text size="xs" ff="monospace" title={integer(tokenTotal(m))}>
                                {formatTokens(tokenTotal(m), i18n.language)}
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
                                : formatTokens(m.median.outputPerRequest, i18n.language)}
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
                            <Table.Td
                              ta="right"
                              title={
                                m.median.contextPerTurn === null
                                  ? undefined
                                  : integer(m.median.contextPerTurn)
                              }
                            >
                              {m.median.contextPerTurn === null
                                ? '—'
                                : formatTokens(m.median.contextPerTurn, i18n.language)}
                            </Table.Td>
                            <Table.Td ta="right">
                              {value(m, 'mistakes') === null
                                ? '—'
                                : value(m, 'mistakes')!.toFixed(1)}
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
      </Box>
    </Stack>
  )
}
