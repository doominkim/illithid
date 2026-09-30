import { SegmentedControl, VisuallyHidden } from '@mantine/core'
import { LayoutGrid, List } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export type ViewMode = 'grid' | 'list'

/** Grid/list toggle */
export function ViewToggle({
  value,
  onChange
}: {
  value: ViewMode
  onChange: (v: ViewMode) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SegmentedControl
      size="xs"
      value={value}
      onChange={(v) => onChange(v as ViewMode)}
      data={[
        {
          value: 'grid',
          label: (
            <>
              <LayoutGrid size={14} aria-hidden style={{ display: 'block' }} />
              <VisuallyHidden>{t('common.gridView')}</VisuallyHidden>
            </>
          )
        },
        {
          value: 'list',
          label: (
            <>
              <List size={14} aria-hidden style={{ display: 'block' }} />
              <VisuallyHidden>{t('common.listView')}</VisuallyHidden>
            </>
          )
        }
      ]}
      styles={{ label: { padding: '4px 8px' } }}
      data-testid="view-toggle"
    />
  )
}
