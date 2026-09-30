import { Box, Group, Table, Text, Stack } from '@mantine/core'
import { LineChart } from '@mantine/charts'
import { useTranslation } from 'react-i18next'
import type { ModelDetail, ModelSummary } from '../../../shared/api'
import { usd } from '../lib/leaderboard'
import { BoxPlot } from './BoxPlot'

export function ModelCost({
  model,
  detail
}: {
  model: ModelSummary
  detail?: ModelDetail
}): React.JSX.Element {
  const { t } = useTranslation()
  const cost = model.pricing
  const d = detail?.costDist
  return (
    <Stack gap="md" data-testid="stats-cost-detail">
      <Box className="ac-card" p="md">
        <Group justify="space-between">
          <Box>
            <Text size="sm" fw={600}>
              {t(
                cost?.source === 'recorded'
                  ? 'efficiency.recorded'
                  : cost?.source === 'mixed'
                    ? 'efficiency.mixedCost'
                    : 'efficiency.converted'
              )}
            </Text>
            <Text size="xl" fw={600}>
              {cost?.total == null ? t('efficiency.unpriced') : usd(cost.total)}
            </Text>
          </Box>
          <Text size="sm">
            {usd(cost?.perRequest)} / {t('models.col.requests')}
          </Text>
        </Group>
        {(cost?.source === 'recorded' || cost?.source === 'mixed') && (
          <Text size="xs" c="dimmed">
            {t('efficiency.converted')}: {usd(cost.converted)}
          </Text>
        )}
        <Table mt="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th />
              <Table.Th ta="right">{t('efficiency.converted')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((k) => (
              <Table.Tr key={k}>
                <Table.Td>{t(`models.detail.tk.${k}`)}</Table.Td>
                <Table.Td ta="right">{usd(cost?.parts?.[k])}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Text size="xs" c="dimmed" mt="sm">
          {t('efficiency.priceNote', {
            date: cost?.date ?? '—',
            source: t(cost?.priceSource === 'cache' ? 'efficiency.cache' : 'efficiency.snapshot')
          })}
        </Text>
      </Box>
      <Box className="ac-card" p="md" data-testid="stats-cost-distribution">
        <Text size="sm" fw={600} mb="sm">
          {t('efficiency.costDistribution')}
        </Text>
        {d ? (
          <>
            <BoxPlot d={d} domain={[d.min, d.max]} scale="linear" />
            <Group justify="space-between" mt="sm">
              {(['min', 'p25', 'median', 'p75', 'p90', 'max'] as const).map((k) => (
                <Text key={k} size="xs">
                  {t(`models.detail.${k}`)} {usd(d[k])}
                </Text>
              ))}
            </Group>
          </>
        ) : (
          <Text size="xs" c="dimmed">
            {t(cost?.needsReindex ? 'efficiency.reindexCosts' : 'models.small')}
          </Text>
        )}
      </Box>
      <Box className="ac-card" p="md" data-testid="stats-cost-daily">
        <Text size="sm" fw={600} mb="sm">
          {t('efficiency.dailyCost')}
        </Text>
        {detail?.costDaily?.length ? (
          <LineChart
            h={180}
            data={detail.costDaily}
            dataKey="day"
            series={[{ name: 'cost', label: t('efficiency.cost'), color: 'accent.6' }]}
            valueFormatter={usd}
            curveType="linear"
            withDots={false}
            connectNulls={false}
          />
        ) : (
          <Text size="xs" c="dimmed">
            {t('efficiency.reindexCosts')}
          </Text>
        )}
      </Box>
    </Stack>
  )
}
