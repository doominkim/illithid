import { useEffect, useState } from 'react'
import { Box, Group, Loader, SimpleGrid, Text } from '@mantine/core'
import { BarChart, ChartTooltip, LineChart } from '@mantine/charts'
import { useTranslation } from 'react-i18next'
import type { ToolId, UsageKind, UsageStats } from '../../../shared/api'
import { TOOL_NAME } from '../lib/tools'
import { SectionTitle } from './PageHeader'

const TOP_MODELS = 8
/** Line colors by rank (the folded "others" line is gray) */
const LINE_COLORS = ['blue.6', 'orange.6', 'teal.6', 'grape.6', 'red.6', 'yellow.7']

/** Call counts for one skill or MCP server from local session logs: last 30 days by day, all time by model and tool */
export function UsagePanel({ kind, name }: { kind: UsageKind; name: string }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [stats, setStats] = useState<UsageStats | null | undefined>(undefined)
  const [indexing, setIndexing] = useState(false)

  useEffect(() => {
    let alive = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- show loading while another item loads
    setStats(undefined)
    window.api.sessionIndexStatus().then((v) => alive && setIndexing(v.running), () => {})
    const load = (): void => {
      window.api.usage(kind, name).then(
        (s) => alive && setStats(s),
        () => alive && setStats(null)
      )
    }
    load()
    // The session index fills usage; reload when a run finishes
    const off = window.api.onSearchIndexEvent((v) => {
      if (!alive) return
      setIndexing(v.running)
      if (!v.running) load()
    })
    return () => {
      alive = false
      off()
    }
  }, [kind, name])

  const fmt = (n: number): string => n.toLocaleString(i18n.language)
  const title = (
    <SectionTitle
      right={
        stats && stats.total > 0 ? (
          <Text size="sm" c="dimmed">
            {t('usage.summary', { recent: fmt(stats.recent), days: stats.days, total: fmt(stats.total) })}
          </Text>
        ) : undefined
      }
    >
      {t('usage.title')}
    </SectionTitle>
  )

  if (stats === undefined)
    return (
      <Box data-testid="usage-panel">
        {title}
        <Loader size="xs" />
      </Box>
    )
  if (!stats || stats.total === 0)
    return (
      <Box data-testid="usage-panel">
        {title}
        <Text size="sm" c="dimmed">
          {indexing || stats === null ? t('usage.indexing') : t('usage.none')}
        </Text>
      </Box>
    )

  // Keys m0…: model ids contain dots, which recharts would read as nested paths
  const dm = stats.dailyByModel
  const lineNames = [...dm.models, ...(dm.others ? [t('usage.others')] : [])]
  const lineSeries = lineNames.map((label, i) => ({
    name: `m${i}`,
    label,
    color: i < dm.models.length ? LINE_COLORS[i % LINE_COLORS.length] : 'gray.5'
  }))
  const daily = dm.days.map((d) => ({ day: d.day.slice(5), ...Object.fromEntries(d.n.map((n, i) => [`m${i}`, n])) }))
  const models = stats.byModel.slice(0, TOP_MODELS)
  const rest = stats.byModel.slice(TOP_MODELS).reduce((a, m) => a + m.n, 0)
  if (rest) models.push({ model: t('usage.others'), n: rest })
  const series = [{ name: 'n', label: t('usage.calls'), color: 'accent.6' }]

  return (
    <Box data-testid="usage-panel">
      {title}
      <Box className="ac-card" p="md">
        <Text size="sm" fw={600} mb={6}>
          {t('usage.daily', { days: stats.days })}
        </Text>
        <LineChart
          h={180}
          data={daily}
          dataKey="day"
          series={lineSeries}
          curveType="linear"
          withDots={false}
          yAxisProps={{ allowDecimals: false }}
          // Hover shows only the models that were called that day
          tooltipProps={{
            content: ({ label, payload }) => {
              const hits = (payload ?? []).filter((p) => Number(p.value) > 0)
              return hits.length ? <ChartTooltip label={label} payload={hits} series={lineSeries} /> : null
            }
          }}
          strokeWidth={2}
          withLegend
          legendProps={{ verticalAlign: 'bottom', height: 40 }}
          gridAxis="y"
          tickLine="none"
        />
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg" mt="md">
          <Box>
            <Text size="sm" fw={600} mb={6}>
              {t('usage.byModel')}
            </Text>
            <BarChart
              h={Math.max(80, models.length * 26 + 20)}
              data={models}
              dataKey="model"
              orientation="vertical"
              series={series}
              withLegend={false}
              gridAxis="none"
              tickLine="none"
              yAxisProps={{ width: 170, interval: 0 }}
              withBarValueLabel
              barProps={{ radius: 2 }}
            />
          </Box>
          <Box>
            <Text size="sm" fw={600} mb={6}>
              {t('usage.byTool')}
            </Text>
            <Group gap="lg">
              {stats.byTool.map((x) => (
                <Box key={x.tool}>
                  <Text size="xs" c="dimmed">
                    {TOOL_NAME[x.tool as ToolId] ?? x.tool}
                  </Text>
                  <Text fw={600}>{fmt(x.n)}</Text>
                </Box>
              ))}
            </Group>
            {stats.since && (
              <Text size="xs" c="dimmed" mt="sm">
                {t('usage.since', { day: stats.since })}
              </Text>
            )}
          </Box>
        </SimpleGrid>
      </Box>
    </Box>
  )
}
