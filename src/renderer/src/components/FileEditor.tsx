import { useEffect, useState } from 'react'
import { Select, Stack } from '@mantine/core'
import { FolderOpen } from 'lucide-react'
import { ErrorAlert, Loading } from './Layout'
import { MarkdownEditor } from './MarkdownEditor'
import type { WriteResult } from '../../../shared/api'

/** A folder's files: pick one, edit it raw. The pick can be held by the caller (e.g. to open a file it just added) */
export function FileEditor({
  id,
  files,
  value,
  onChange,
  read,
  save,
  testId
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
}): React.JSX.Element {
  const [own, setOwn] = useState<string>(files[0])
  const rel = value ?? own
  const pick = (v: string): void => (onChange ? onChange(v) : setOwn(v))
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the previous file before loading another
    setText(null)
    setErr(null)
    read(rel).then((r) => {
      if (!alive) return
      if (r.ok) setText(r.value)
      else setErr(r.message)
    })
    return () => {
      alive = false
    }
    // read is a new function each render; the folder and file decide what to load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, rel])

  return (
    <Stack gap="sm">
      <Select
        data={files}
        value={rel}
        onChange={(v) => v && pick(v)}
        allowDeselect={false}
        w={320}
        leftSection={<FolderOpen size={14} />}
        data-testid={testId}
      />
      {err ? (
        <ErrorAlert message={err} />
      ) : text === null ? (
        <Loading />
      ) : (
        <MarkdownEditor
          key={`${id}/${rel}`}
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
