import { Group, Loader, Tooltip, UnstyledButton } from '@mantine/core'
import { useTranslation } from 'react-i18next'
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

/**
 * Tool pill row: on opaque / off dimmed with a slash / problem amber ring / pending dot. Tools not in use on this device are not shown.
 * Every pill has a tooltip with the tool name and state, so off is never told by color alone
 */
export function ToolPills({ pills, onToggle, busy, size = 20, showNa = false }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const tools = useToolsInUse()
  const saving: readonly ToolId[] = busy == null ? [] : typeof busy === 'string' ? [busy] : busy
  const toggle = saving.length ? undefined : onToggle
  return (
    <Group gap={6} wrap="nowrap">
      {tools.map((tool) => {
        const p = pills[tool]
        if (!p || (p.na && !showNa)) return null
        const name = TOOL_NAME[tool]
        const icon = saving.includes(tool) ? <Loader size={size - 4} color="accent" /> : <ToolIcon tool={tool} size={size} />
        const pill = (
          <span
            className="ac-pill"
            style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
            data-off={!p.on || undefined}
            data-problem={p.problem || undefined}
            data-pending={p.pending || undefined}
            data-via={p.via || undefined}
            data-tool={tool}
          >
            {icon}
          </span>
        )
        const state = onToggle
          ? t(p.on ? 'detail.turnOff' : 'detail.turnOn', { tool: name })
          : `${name}: ${t(p.on ? 'detail.on' : 'detail.off')}`
        const label = p.hint ? `${state}\n${p.hint}` : state
        return (
          <Tooltip key={tool} label={label} withArrow openDelay={300} style={{ whiteSpace: 'pre-line' }}>
            {onToggle ? (
              <UnstyledButton
                disabled={!toggle}
                onClick={(e) => {
                  e.stopPropagation()
                  toggle?.(tool)
                }}
                aria-label={name}
                aria-pressed={p.on}
                display="inline-flex"
              >
                {pill}
              </UnstyledButton>
            ) : (
              <span style={{ display: 'inline-flex' }} role="img" aria-label={`${name}: ${t(p.on ? 'detail.on' : 'detail.off')}`}>
                {pill}
              </span>
            )}
          </Tooltip>
        )
      })}
    </Group>
  )
}
