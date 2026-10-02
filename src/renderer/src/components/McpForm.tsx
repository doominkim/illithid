import { useState } from 'react'
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Group,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput
} from '@mantine/core'
import { Plus, Save, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { FormFooter } from './FormFooter'
import type { McpServer } from '../../../shared/api'

interface KV {
  k: string
  v: string
}

interface Props {
  /** undefined for a new server */
  name?: string
  def?: McpServer
  masked?: string[]
  onSave: (name: string, def: McpServer) => Promise<{ warnings: string[] } | null>
  onCancel?: () => void
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/** Monospace for the value only, not the label */
const MONO = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } }

/** Bearer value in the edit form: ${VAR} for env vars, MASK for keychain tokens */
function initialBearer(def?: McpServer): string {
  if (def?.bearerEnv) return '${' + def.bearerEnv + '}'
  return typeof def?.bearerToken === 'string' ? def.bearerToken : ''
}

function toKV(o?: Record<string, string>): KV[] {
  return Object.entries(o ?? {}).map(([k, v]) => ({ k, v }))
}
function fromKV(rows: KV[]): Record<string, string> | undefined {
  const o: Record<string, string> = {}
  for (const r of rows) if (r.k.trim()) o[r.k.trim()] = r.v
  return Object.keys(o).length ? o : undefined
}

/** MCP server edit form. Masked (MASK) values left untouched keep the existing value. main stores plaintext values in the keychain */
export function McpForm({ name: initialName, def, onSave, onCancel }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const isNew = initialName === undefined
  const [name, setName] = useState(initialName ?? '')
  const [transport, setTransport] = useState<string>(def?.transport ?? 'http')
  const [url, setUrl] = useState(def?.url ?? '')
  const [command, setCommand] = useState(def?.command ?? '')
  const [args, setArgs] = useState((def?.args ?? []).join('\n'))
  const [bearer, setBearer] = useState(initialBearer(def))
  const [timeoutMs, setTimeoutMs] = useState<number | string>(def?.timeoutMs ?? '')
  const [headers, setHeaders] = useState<KV[]>(toKV(def?.headers))
  const [env, setEnv] = useState<KV[]>(toKV(def?.env))
  const meta = def?._
  const [description, setDescription] = useState(
    meta &&
      typeof meta === 'object' &&
      typeof (meta as { description?: unknown }).description === 'string'
      ? ((meta as { description: string }).description ?? '')
      : ''
  )
  const [warnings, setWarnings] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const nameOk = NAME_RE.test(name)
  const valid = nameOk && (transport === 'stdio' ? !!command.trim() : !!url.trim())

  const build = (): McpServer => {
    const rest: Record<string, unknown> = { ...(def ?? {}) }
    for (const k of [
      'transport',
      'url',
      'command',
      'args',
      'env',
      'headers',
      'bearerEnv',
      'bearerToken',
      'timeoutMs'
    ])
      delete rest[k]
    const out: McpServer = { ...(rest as object), transport }
    if (transport === 'stdio') {
      out.command = command.trim()
      const a = args
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      if (a.length) out.args = a
      const e = fromKV(env)
      if (e) out.env = e
    } else {
      out.url = url.trim()
      const h = fromKV(headers)
      if (h) out.headers = h
      const b = bearer.trim()
      const envRef = ENV_REF_RE.exec(b)
      if (envRef) out.bearerEnv = envRef[1]
      else if (b) out.bearerToken = b
    }
    if (typeof timeoutMs === 'number' && timeoutMs > 0) out.timeoutMs = timeoutMs
    // The description goes in the meta key `_`, which never reaches a tool. A text `_` (an old note) is kept as `note`
    const nextMeta: Record<string, unknown> =
      meta && typeof meta === 'object'
        ? { ...(meta as Record<string, unknown>) }
        : typeof meta === 'string'
          ? { note: meta }
          : {}
    if (description.trim()) nextMeta.description = description.trim()
    else delete nextMeta.description
    if (Object.keys(nextMeta).length || meta !== undefined) out._ = nextMeta
    else delete out._
    return out
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    const r = await onSave(name, build())
    setSaving(false)
    if (r) setWarnings(r.warnings)
  }

  const kvEditor = (
    label: string,
    rows: KV[],
    set: (r: KV[]) => void,
    hint?: string
  ): React.JSX.Element => (
    <Box>
      <Group justify="space-between" mb={4}>
        <Stack gap={0}>
          <Text size="sm" fw={500}>
            {label}
          </Text>
          {hint && (
            <Text size="xs" c="dimmed">
              {hint}
            </Text>
          )}
        </Stack>
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<Plus size={11} />}
          onClick={() => set([...rows, { k: '', v: '' }])}
        >
          {t('common.add')}
        </Button>
      </Group>
      <Stack gap={6}>
        {rows.map((r, i) => (
          <Box key={i} className="ac-kv">
            <TextInput
              size="xs"
              placeholder={t('mcp.key')}
              value={r.k}
              onChange={(e) =>
                set(rows.map((x, j) => (j === i ? { ...x, k: e.currentTarget.value } : x)))
              }
            />
            <PasswordInput
              size="xs"
              value={r.v}
              onChange={(e) =>
                set(rows.map((x, j) => (j === i ? { ...x, v: e.currentTarget.value } : x)))
              }
              styles={MONO}
              autoComplete="off"
            />
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              onClick={() => set(rows.filter((_, j) => j !== i))}
              aria-label={t('common.remove')}
            >
              <X size={13} />
            </ActionIcon>
          </Box>
        ))}
      </Stack>
    </Box>
  )

  return (
    <Box
      className={isNew ? undefined : 'ac-card'}
      p={isNew ? 0 : 'lg'}
      maw={isNew ? 640 : undefined}
    >
      <Stack gap="md">
        <TextInput
          label={t('common.name')}
          value={name}
          disabled={!isNew}
          onChange={(e) => setName(e.currentTarget.value)}
          error={name && !nameOk ? t('mcp.nameInvalid') : undefined}
          data-testid="mcp-name"
        />
        <TextInput
          label={t('mcp.description')}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          data-testid="mcp-description"
        />
        <Box>
          <Text size="sm" fw={500} mb={4}>
            {t('mcp.transport')}
          </Text>
          <SegmentedControl
            fullWidth
            value={transport}
            onChange={setTransport}
            data={[
              { value: 'http', label: 'http' },
              { value: 'stdio', label: 'stdio' }
            ]}
          />
        </Box>
        {transport === 'stdio' ? (
          <>
            <TextInput
              label={t('mcp.command')}
              value={command}
              onChange={(e) => setCommand(e.currentTarget.value)}
              styles={MONO}
              data-testid="mcp-command"
            />
            <Textarea
              label={t('mcp.args')}
              description={t('mcp.argsHint')}
              value={args}
              onChange={(e) => setArgs(e.currentTarget.value)}
              autosize
              minRows={2}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            />
            {kvEditor(t('mcp.env'), env, setEnv)}
          </>
        ) : (
          <>
            <TextInput
              label={t('mcp.url')}
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
              styles={MONO}
              data-testid="mcp-url"
            />
            <PasswordInput
              label={t('mcp.bearer')}
              value={bearer}
              onChange={(e) => setBearer(e.currentTarget.value)}
              styles={MONO}
              autoComplete="off"
            />
            {kvEditor(t('mcp.headers'), headers, setHeaders, t('mcp.headersHint'))}
          </>
        )}
        <NumberInput
          label={t('mcp.timeout')}
          description={t('mcp.timeoutHint')}
          value={timeoutMs}
          onChange={setTimeoutMs}
          min={0}
          step={1000}
          w={200}
        />
        {warnings.length > 0 && (
          <Alert color="yellow" variant="light" radius="md" title={t('mcp.warnings')}>
            <Stack gap={2}>
              {warnings.map((w) => (
                <Text key={w} size="sm">
                  {w}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}
        <FormFooter>
          {onCancel && (
            <Button size="xs" variant="default" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          )}
          <Button
            size="xs"
            leftSection={isNew ? undefined : <Save size={13} />}
            disabled={!valid}
            loading={saving}
            onClick={() => void save()}
            data-testid="mcp-save"
          >
            {isNew ? t('common.create') : t('common.save')}
          </Button>
        </FormFooter>
      </Stack>
    </Box>
  )
}
