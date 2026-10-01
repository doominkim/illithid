import { useState } from 'react'
import { Button, Checkbox, Group, Modal, Stack, Text } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import type { ToolId } from '../../../shared/api'
import { TOOL_NAME } from '../lib/tools'

/**
 * Asked when Claude Code and a tool that reads Claude's files (Grok CLI, GitHub Copilot) would both be in use.
 * For Grok, "both" can also switch off Grok's reading of Claude's skills and MCP servers (config.grokReadsClaude = false)
 */
export function ToolComboDialog({
  tools,
  onBoth,
  onDropClaude,
  onCancel
}: {
  tools: ToolId[]
  onBoth: (opts: { grokSkipsClaude: boolean }) => void
  onDropClaude: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // Keep the last text while the modal fades out after a button empties `tools` (state from the previous render)
  const [last, setLast] = useState<ToolId[]>(tools)
  if (tools.length && tools !== last) setLast(tools)
  const [grokSkipsClaude, setGrokSkipsClaude] = useState(false)
  return (
    <Modal
      opened={tools.length > 0}
      onClose={() => {
        setGrokSkipsClaude(false)
        onCancel()
      }}
      title={t('combo.title')}
      centered
      radius="lg"
      data-testid="tool-combo-dialog"
    >
      <Stack gap="md">
        {last.map((tool) => (
          <Text key={tool} size="sm">
            {t(`combo.${tool}`, { tool: TOOL_NAME[tool] })}
          </Text>
        ))}
        {tools.includes('grok') && (
          <Checkbox
            checked={grokSkipsClaude}
            onChange={(e) => setGrokSkipsClaude(e.currentTarget.checked)}
            label={t('combo.grokSkipClaude')}
            description={t('combo.grokSkipClaudeNote')}
            data-testid="combo-grok-skip-claude"
          />
        )}
        <Group justify="flex-end" gap="xs">
          <Button
            variant="default"
            onClick={() => {
              setGrokSkipsClaude(false)
              onCancel()
            }}
            data-testid="combo-cancel"
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="default"
            onClick={() => {
              setGrokSkipsClaude(false)
              onDropClaude()
            }}
            data-testid="combo-drop-claude"
          >
            {t('combo.dropClaude')}
          </Button>
          <Button
            onClick={() => {
              const skip = tools.includes('grok') && grokSkipsClaude
              setGrokSkipsClaude(false)
              onBoth({ grokSkipsClaude: skip })
            }}
            data-testid="combo-both"
          >
            {t('combo.both')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
