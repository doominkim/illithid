import { useRef, useState } from 'react'
import { Badge, Box, Button, Group, Textarea, Text } from '@mantine/core'
import { Save, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDirtyDraft } from '../lib/dirtyDraft'

interface Props {
  /** Current file content. Clean drafts follow changes without overwriting newer typing */
  value: string
  onSave: (text: string) => Promise<boolean>
  /** Reason saving is unavailable (disables the button if set) */
  disabledHint?: string
  minRows?: number
  placeholder?: string
  /** Header line label */
  title?: string
  /** Whether values saved alongside from outside this editor changed (enables save/revert) */
  extraDirty?: boolean
  /** Also reverts outside values on revert */
  onRevert?: () => void
}

/** Lightweight raw editor: monospace Textarea + save/revert. Clears dirty on successful save */
export function MarkdownEditor({
  value,
  onSave,
  disabledHint,
  minRows = 16,
  placeholder,
  title,
  extraDirty = false,
  onRevert
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState(value)
  const [saved, setSaved] = useState(value)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  // Take a new outside value (state from the previous render)
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    setSaved(value)
    if (text === saved) setText(value)
  }
  const dirty = text !== saved || extraDirty
  useDirtyDraft(dirty)
  const save = async (): Promise<void> => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    const submitted = text
    try {
      if (await onSave(submitted)) setSaved(submitted)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  return (
    <Box className="ac-card" p="md">
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          {title && (
            <Text size="sm" fw={600}>
              {title}
            </Text>
          )}
          <Text size="sm" c="dimmed">
            {t('editor.lines', { n: text.split('\n').length })}
          </Text>
          {dirty && (
            <Badge size="xs" variant="light" color="yellow" fw={500}>
              {t('editor.unsaved')}
            </Badge>
          )}
        </Group>
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            leftSection={<Undo2 size={12} />}
            disabled={!dirty}
            onClick={() => {
              setText(saved)
              onRevert?.()
            }}
          >
            {t('editor.revert')}
          </Button>
          <Button
            size="xs"
            leftSection={<Save size={12} />}
            disabled={!dirty || !!disabledHint}
            loading={saving}
            onClick={() => void save()}
            data-testid="editor-save"
            title={disabledHint}
          >
            {t('common.save')}
          </Button>
        </Group>
      </Group>
      <Textarea
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        autosize
        minRows={minRows}
        maxRows={40}
        placeholder={placeholder}
        spellCheck={false}
        styles={{
          input: {
            fontFamily: 'var(--mantine-font-family-monospace)',
            fontSize: 12.5,
            lineHeight: 1.55
          }
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault()
            if (dirty && !disabledHint) void save()
          }
        }}
      />
      {disabledHint && (
        <Text size="xs" c="dimmed" mt={6}>
          {disabledHint}
        </Text>
      )}
    </Box>
  )
}
