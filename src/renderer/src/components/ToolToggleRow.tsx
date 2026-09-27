import { Group, Text } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import type { ToolId } from '../../../shared/api'
import type { PillMap } from '../lib/tools'
import { ToolPills } from './ToolPills'

interface Props {
  pills: PillMap
  /** Tools that can be toggled here (default: every tool with a pill). Others are not shown */
  tools?: readonly ToolId[]
  onToggle: (tool: ToolId) => void
  /** Tools whose toggle is being saved — all toggles are disabled meanwhile */
  busy: readonly ToolId[]
  testId: string
}

/** "Tools" line of a detail sheet (rules, skills, MCP): one toggle pill per tool in use, same save flow as the list cards */
export function ToolToggleRow({ pills, tools, onToggle, busy, testId }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const shown: PillMap = tools ? Object.fromEntries(tools.map((x) => [x, pills[x]])) : pills
  return (
    <Group gap="sm" data-testid={testId} data-busy={busy.length ? true : undefined}>
      <Text size="sm" c="dimmed">
        {t('detail.tools')}
      </Text>
      <ToolPills pills={shown} size={22} onToggle={onToggle} busy={busy} />
    </Group>
  )
}
