import { Group, Loader, UnstyledButton } from '@mantine/core'
import type { ToolId } from '../../../shared/api'
import { useToolsInUse } from '../lib/config'
import { TOOL_NAME, type PillMap } from '../lib/tools'
import { ToolIcon } from './ToolIcon'

interface Props {
  pills: PillMap
  /** Toggle callback. Display-only if omitted (always display-only until M7c) */
  onToggle?: (tool: ToolId) => void
  busy?: ToolId | null
  size?: number
  /** Whether to show not-applicable (na) tools dimmed */
  showNa?: boolean
}

/** Tool pill row: on opaque / off 40% / problem amber ring / pending dot. Tools not in use on this device are not shown */
export function ToolPills({ pills, onToggle, busy, size = 20, showNa = false }: Props): React.JSX.Element {
  const tools = useToolsInUse()
  return (
    <Group gap={6} wrap="nowrap">
      {tools.map((tool) => {
        const p = pills[tool]
        if (!p || (p.na && !showNa)) return null
        const icon =
          busy === tool ? (
            <Loader size={size - 4} color="accent" />
          ) : (
            <ToolIcon tool={tool} size={size} />
          )
        const body = (
          <span
            className="ac-pill"
            style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
            data-off={!p.on || undefined}
            data-problem={p.problem || undefined}
            data-pending={p.pending || undefined}
            data-tool={tool}
          >
            {icon}
          </span>
        )
        return onToggle ? (
          <UnstyledButton
            key={tool}
            onClick={(e) => {
              e.stopPropagation()
              onToggle(tool)
            }}
            aria-label={TOOL_NAME[tool]}
            display="inline-flex"
          >
            {body}
          </UnstyledButton>
        ) : (
          <span key={tool} style={{ display: 'inline-flex' }}>
            {body}
          </span>
        )
      })}
    </Group>
  )
}
