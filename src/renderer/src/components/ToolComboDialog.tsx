import { useRef } from 'react'
import { Button, Group, Modal, Stack, Text } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import type { ToolId } from '../../../shared/api'
import { TOOL_NAME } from '../lib/tools'

/** Tools that also read Claude Code's files when both are used */
export const CLAUDE_READERS: readonly ToolId[] = ['grok', 'copilot']

/** Readers of Claude's files that `next` turns on together with Claude while `prev` did not have that pair */
export function claudeCombos(prev: readonly ToolId[], next: readonly ToolId[]): ToolId[] {
  if (!next.includes('claude')) return []
  return CLAUDE_READERS.filter((t) => next.includes(t) && !(prev.includes(t) && prev.includes('claude')))
}

/** Asked when Claude Code and a tool that reads Claude's files (Grok CLI, GitHub Copilot) would both be in use */
export function ToolComboDialog({
  tools,
  onBoth,
  onDropClaude,
  onCancel
}: {
  tools: ToolId[]
  onBoth: () => void
  onDropClaude: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // Keep the last text while the modal fades out after a button empties `tools`
  const last = useRef<ToolId[]>([])
  if (tools.length) last.current = tools
  return (
    <Modal opened={tools.length > 0} onClose={onCancel} title={t('combo.title')} centered radius="lg" data-testid="tool-combo-dialog">
      <Stack gap="md">
        {last.current.map((tool) => (
          <Text key={tool} size="sm">
            {t(`combo.${tool}`, { tool: TOOL_NAME[tool] })}
          </Text>
        ))}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onCancel} data-testid="combo-cancel">
            {t('common.cancel')}
          </Button>
          <Button variant="default" onClick={onDropClaude} data-testid="combo-drop-claude">
            {t('combo.dropClaude')}
          </Button>
          <Button onClick={onBoth} data-testid="combo-both">
            {t('combo.both')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
