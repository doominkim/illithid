import { Group, Loader, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import type { ToolId } from '../../../shared/api'
import { useToolsInUse } from '../lib/config'
import { TOOL_NAME, type PillMap } from '../lib/tools'
import { ToolIcon } from './ToolIcon'

interface Props {
  pills: PillMap
  /** Tools that can be toggled here (default: every tool with a pill). Others are not shown */
  tools?: readonly ToolId[]
  onToggle: (tool: ToolId) => void
  /** Tools whose toggle is being saved — all toggles are disabled meanwhile */
  busy: readonly ToolId[]
  testId: string
}

/**
 * "Enabled in" block of a detail sheet (rules, skills, MCP): one labeled toggle per tool in use — logo, tool name and On/Off text —
 * with the same save flow as the list pills
 */
export function ToolToggleRow({ pills, tools, onToggle, busy, testId }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const inUse = useToolsInUse()
  const shown = inUse.filter((tool) => (!tools || tools.includes(tool)) && pills[tool] && !pills[tool]!.na)
  return (
    <Stack gap={8} data-testid={testId} data-busy={busy.length ? true : undefined}>
      <Text size="sm" fw={600} c="dimmed">
        {t('detail.enabledIn')}
      </Text>
      <Group gap={8} wrap="wrap">
        {shown.map((tool) => {
          const p = pills[tool]!
          const name = TOOL_NAME[tool]
          const button = (
            <UnstyledButton
              key={tool}
              className="ac-tool-btn"
              aria-pressed={p.on}
              data-problem={p.problem || undefined}
              data-pending={p.pending || undefined}
              data-via={p.via || undefined}
              data-tool={tool}
              disabled={busy.length > 0}
              onClick={() => onToggle(tool)}
            >
              {busy.includes(tool) ? <Loader size={14} color="accent" /> : <ToolIcon tool={tool} size={16} />}
              <span className="ac-tool-btn-name">{name}</span>
              <span className="ac-tool-btn-state">{t(p.on ? 'detail.on' : 'detail.off')}</span>
            </UnstyledButton>
          )
          return p.hint ? (
            <Tooltip key={tool} label={p.hint} withArrow>
              {button}
            </Tooltip>
          ) : (
            button
          )
        })}
      </Group>
      {/* Reasons shown in a tooltip on the list pills are spelled out here (e.g. Grok still reading it through Claude Code) */}
      {shown
        .filter((tool) => pills[tool]!.via && pills[tool]!.hint)
        .map((tool) => (
          <Text key={tool} size="xs" c="dimmed" data-testid={`${testId}-via-${tool}`}>
            {TOOL_NAME[tool]}: {pills[tool]!.hint}
          </Text>
        ))}
      <Text size="xs" c="dimmed">
        {t('detail.applyOnSync')}
      </Text>
    </Stack>
  )
}
