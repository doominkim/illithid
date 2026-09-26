import { SegmentedControl } from '@mantine/core'
import { LayoutGrid, List } from 'lucide-react'

export type ViewMode = 'grid' | 'list'

/** Grid/list toggle */
export function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }): React.JSX.Element {
  return (
    <SegmentedControl
      size="xs"
      value={value}
      onChange={(v) => onChange(v as ViewMode)}
      data={[
        { value: 'grid', label: <LayoutGrid size={14} style={{ display: 'block' }} /> },
        { value: 'list', label: <List size={14} style={{ display: 'block' }} /> }
      ]}
      styles={{ label: { padding: '4px 8px' } }}
    />
  )
}
