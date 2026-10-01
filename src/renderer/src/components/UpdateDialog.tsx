import { Button, Code, CopyButton, Group, Modal, ScrollArea, Stack, Text } from '@mantine/core'
import type { UpdateView } from '../../../shared/api'
import { Markdown } from './Markdown'

/** A newer release (always English): notes plus how to update (the brew command for Homebrew installs, the release page otherwise) */
export function UpdateDialog({
  update,
  opened,
  onLater,
  onSkip
}: {
  update: UpdateView | null
  opened: boolean
  onLater: () => void
  onSkip: (version: string) => void
}): React.JSX.Element {
  const u = update
  return (
    <Modal
      opened={opened && !!u}
      onClose={onLater}
      title={u ? `Illithid ${u.version} is available` : ''}
      centered
      radius="lg"
      size="lg"
      data-testid="update-dialog"
    >
      {u && (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            You have {u.current}.
          </Text>
          {u.notes.trim() && (
            <ScrollArea.Autosize mah={320} type="auto">
              <Markdown text={u.notes} />
            </ScrollArea.Autosize>
          )}
          {u.command ? (
            <Stack gap={6}>
              <Text size="sm">Installed with Homebrew. Update opens Terminal and runs:</Text>
              <Group gap="xs" wrap="nowrap">
                <Code block style={{ flex: 1 }}>
                  {u.command}
                </Code>
                <CopyButton value={u.command}>
                  {({ copied, copy }) => (
                    <Button variant="default" size="xs" onClick={copy} data-testid="update-copy">
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  )}
                </CopyButton>
              </Group>
            </Stack>
          ) : (
            <Text size="sm">Download the new version and replace the app in Applications.</Text>
          )}
          <Group justify="space-between">
            <Button
              variant="subtle"
              color="gray"
              onClick={() => onSkip(u.version)}
              data-testid="update-skip"
            >
              Skip this version
            </Button>
            <Group gap="xs">
              <Button variant="default" onClick={onLater} data-testid="update-later">
                Later
              </Button>
              {u.command && (
                <Button
                  onClick={() => {
                    void window.api.updateOpenTerminal()
                    onLater()
                  }}
                  data-testid="update-terminal"
                >
                  Update
                </Button>
              )}
              {!u.command && (
                <Button
                  component="a"
                  href={u.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={onLater}
                  data-testid="update-download"
                >
                  Download
                </Button>
              )}
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  )
}
