import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Initial, ListRow } from './ListRow'

export interface VirtualItem {
  id: string
  label: string
  description: string
  tag?: React.ReactNode
  avatar?: React.ReactNode
}

/** Virtual scroll for long lists (1500+ sessions). Renders only visible rows */
export function VirtualList({
  items,
  selected,
  onSelect
}: {
  items: VirtualItem[]
  selected: string | null
  onSelect: (id: string) => void
}): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 58,
    overscan: 10
  })
  return (
    <div ref={parentRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((row) => {
          const it = items[row.index]
          return (
            <div
              key={it.id}
              className="mantine-NavLink-root"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: row.size,
                transform: `translateY(${row.start}px)`
              }}
            >
              <ListRow
                avatar={it.avatar ?? <Initial text={it.label} />}
                title={it.label}
                tags={it.tag}
                subtitle={it.description}
                active={it.id === selected}
                onClick={() => onSelect(it.id)}
                style={{ height: '100%' }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
