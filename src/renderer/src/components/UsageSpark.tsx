import { Group, SegmentedControl, Text } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import type { UsageSummary } from '../../../shared/api'
import type { ListSort } from '../lib/listSort'

const W = 60
const H = 16

/** Calls in the last 30 days: one bar per day (scaled to this item's busiest day) and the total */
export function UsageSpark({ summary }: { summary: UsageSummary | undefined }): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  if (!summary) return null
  const max = Math.max(0, ...summary.daily)
  const bw = W / summary.daily.length
  const count = summary.recent.toLocaleString(i18n.language)
  return (
    <Group gap={6} wrap="nowrap" data-testid="usage-spark" data-recent={summary.recent} title={t('usage.recentTitle', { n: count })}>
      <svg width={W} height={H} aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
        <line x1={0} y1={H - 0.5} x2={W} y2={H - 0.5} stroke="var(--ac-border)" />
        {summary.daily.map((n, i) => {
          if (!n || !max) return null
          const h = Math.max(1.5, (n / max) * (H - 2))
          return <rect key={i} x={i * bw + 0.25} y={H - h} width={Math.max(0.5, bw - 0.5)} height={h} rx={0.5} fill="var(--ac-accent)" />
        })}
      </svg>
      <Text size="xs" c={summary.recent ? undefined : 'dimmed'} style={{ minWidth: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {t('usage.count', { n: count })}
      </Text>
    </Group>
  )
}

/** Name / most-used order for skill and MCP lists */
export function SortToggle({ value, onChange }: { value: ListSort; onChange: (v: ListSort) => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SegmentedControl
      size="xs"
      value={value}
      onChange={(v) => onChange(v as ListSort)}
      aria-label={t('usage.sort')}
      data={[
        { value: 'name', label: t('usage.sortName') },
        { value: 'usage', label: t('usage.sortUsage') }
      ]}
      data-testid="list-sort"
    />
  )
}
