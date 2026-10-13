import { useEffect, useState } from 'react'
import { Group, Select, Stack } from '@mantine/core'
import { FolderOpen } from 'lucide-react'
import { ErrorAlert, Loading } from './Layout'
import { MarkdownEditor } from './MarkdownEditor'
import { useConfig } from '../lib/config'
import type { WriteResult } from '../../../shared/api'
import { useDraftGuard } from '../lib/dirtyDraft'

/** A folder's files: pick one, edit it raw. The pick can be held by the caller (e.g. to open a file it just added) */
export function FileEditor({
  id,
  files,
  value,
  onChange,
  read,
  save,
  testId,
  actions
}: {
  /** Folder identity: a change reloads the file */
  id: string
  files: string[]
  value?: string
  onChange?: (rel: string) => void
  read: (rel: string) => Promise<WriteResult<string>>
  /** true when saved */
  save: (rel: string, text: string) => Promise<boolean>
  testId?: string
  /** Buttons next to the file picker (e.g. add or delete a file) */
  actions?: React.ReactNode
}): React.JSX.Element {
  const { config } = useConfig()
  const guardDraft = useDraftGuard()
  const workspaceRoot = config?.libraryRoot
  const [own, setOwn] = useState<string>(files[0])
  const rel = value ?? own
  const pick = (v: string): void => {
    if (v !== rel) guardDraft(() => (onChange ? onChange(v) : setOwn(v)))
  }
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let alive = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the previous file before loading another
    setText(null)
    setErr(null)
    read(rel).then(
      (r) => {
        if (!alive) return
        if (r.ok) setText(r.value)
        else setErr(r.message)
      },
      (error) => {
        if (alive) setErr(error instanceof Error ? error.message : String(error))
      }
    )
    return () => {
      alive = false
    }
    // read is a new function each render; the folder and file decide what to load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, rel, workspaceRoot, retry])

  return (
    <Stack gap="sm">
      <Group gap={6} wrap="nowrap">
        <Select
          data={files}
          value={rel}
          onChange={(v) => v && pick(v)}
          allowDeselect={false}
          w={320}
          leftSection={<FolderOpen size={14} />}
          data-testid={testId}
        />
        {actions}
      </Group>
      {err ? (
        <ErrorAlert message={err} onRetry={() => setRetry((n) => n + 1)} />
      ) : text === null ? (
        <Loading />
      ) : (
        <MarkdownEditor
          key={`${workspaceRoot}/${id}/${rel}`}
          value={text}
          onSave={async (next) => {
            const ok = await save(rel, next)
            if (ok) setText(next)
            return ok
          }}
        />
      )}
    </Stack>
  )
}
