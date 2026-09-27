import { Group, Loader, Tooltip, UnstyledButton } from '@mantine/core'
import type { ToolId } from '../../../shared/api'
import { useToolsInUse } from '../lib/config'
import { TOOL_NAME, type PillMap } from '../lib/tools'
import { ToolIcon } from './ToolIcon'

interface Props {
  pills: PillMap
  /** Toggle callback. Display-only if omitted (always display-only until M7c) */
  onToggle?: (tool: ToolId) => void
  /** Tools with a save in flight (spinner). While any is saving, all pills of the row are disabled */
  busy?: ToolId | readonly ToolId[] | null
  size?: number
  /** Whether to show not-applicable (na) tools dimmed */
  showNa?: boolean
}

/** Tool pill row: on opaque / off 40% / problem amber ring / pending dot. Tools not in use on this device are not shown */
export function ToolPills({ pills, onToggle, busy, size = 20, showNa = false }: Props): React.JSX.Element {
  const tools = useToolsInUse()
  const saving: readonly ToolId[] = busy == null ? [] : typeof busy === 'string' ? [busy] : busy
  const toggle = saving.length ? undefined : onToggle
  return (
    <Group gap={6} wrap="nowrap">
      {tools.map((tool) => {
        const p = pills[tool]
        if (!p || (p.na && !showNa)) return null
        const icon =
          saving.includes(tool) ? (
            <Loader size={size - 4} color="accent" />
          ) : (
            <ToolIcon tool={tool} size={size} />
          )
        const pill = (
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
        const body = p.hint ? (
          <Tooltip label={p.hint} withArrow>
            {pill}
          </Tooltip>
        ) : (
          pill
        )
        return onToggle ? (
          <UnstyledButton
            key={tool}
            disabled={!toggle}
            onClick={(e) => {
              e.stopPropagation()
              toggle?.(tool)
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
