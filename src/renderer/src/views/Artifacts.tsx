import { useMemo, useState } from 'react'
import { ActionIcon, Alert, Badge, Code, Group, Image, Select, Stack, Text, Title } from '@mantine/core'
import { ExternalLink, FolderOpen, HelpCircle, Layers } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Artifact, ArtifactTool } from '../../../shared/api'
import { Initial } from '../components/ListRow'
import { ErrorAlert, FillStack, Loading, NoSelection, SplitPane } from '../components/Layout'
import { Markdown } from '../components/Markdown'
import { PageHeader, Toolbar } from '../components/PageHeader'
import { ReloadButton } from '../components/ReloadButton'
import { SearchInput } from '../components/SearchInput'
import { ToolIcon } from '../components/ToolIcon'
import { VirtualList } from '../components/VirtualList'
import { fmtSize, fmtTime, includesCI } from '../lib/format'
import { runWrite } from '../lib/mutate'
import { useApi } from '../lib/useApi'

const ALL = '__all__'

const TOOL_ORDER: ArtifactTool[] = ['claude', 'codex', 'opencode', 'cursor', 'unknown']
const ARTIFACT_TOOL_NAME: Record<Exclude<ArtifactTool, 'unknown'>, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor'
}

/** Tool filter icons (all = Layers, unknown = HelpCircle) */
function toolFilterIcon(v: string): React.JSX.Element {
  if (v === ALL) return <Layers size={13} />
  if (v === 'unknown') return <HelpCircle size={13} />
  return <ToolIcon tool={v as Exclude<ArtifactTool, 'unknown'>} size={13} />
}

function Preview({ a }: { a: Artifact }): React.JSX.Element {
  const { t } = useTranslation()
  const { data, error } = useApi(`preview:${a.id}`, () => window.api.artifactPreview(a.id))
  const head = (
    <Group justify="space-between" wrap="nowrap" align="flex-start">
      <Title order={3} style={{ minWidth: 0, wordBreak: 'break-word' }}>
        {a.title}
      </Title>
      <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
        <ActionIcon variant="subtle" color="gray" aria-label={t('artifacts.open')} onClick={() => void runWrite(window.api.artifactOpen(a.id))} data-testid="artifact-open">
          <ExternalLink size={16} />
        </ActionIcon>
        <ActionIcon variant="subtle" color="gray" aria-label={t('artifacts.reveal')} onClick={() => void runWrite(window.api.artifactReveal(a.id))} data-testid="artifact-reveal">
          <FolderOpen size={16} />
        </ActionIcon>
      </Group>
    </Group>
  )
  let body: React.ReactNode
  if (error) body = <ErrorAlert message={error} />
  else if (!data) body = <Loading />
  else if (data.error === 'tooLarge')
    body = (
      <Text size="sm" c="dimmed">
        {t('artifacts.tooLarge')}
      </Text>
    )
  else if (data.error === 'unknownId')
    body = (
      <Text size="sm" c="dimmed">
        {t('artifacts.unknownId')}
      </Text>
    )
  else if (data.error?.startsWith('readFailed:'))
    body = <ErrorAlert message={t('artifacts.readFailed', { code: data.error.slice('readFailed:'.length) })} />
  else if (data.kind === 'image' && data.dataUrl) body = <Image src={data.dataUrl} alt={a.title} fit="contain" maw="100%" radius="md" />
  else if (data.kind === 'md') body = <Markdown text={data.text ?? ''} />
  else if (data.kind === 'html' || data.kind === 'text')
    body = (
      <Stack gap="xs">
        {data.kind === 'html' && (
          <Text size="xs" c="dimmed">
            {t('artifacts.htmlSource')}
          </Text>
        )}
        <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {data.text ?? ''}
        </Code>
      </Stack>
    )
  else
    body = (
      <Text size="sm" c="dimmed">
        {t('artifacts.binary')}
      </Text>
    )

  return (
    <Stack gap="md">
      {head}
      {data?.truncated && (
        <Alert color="yellow" variant="light" radius="md">
          {t('artifacts.truncated')}
        </Alert>
      )}
      {body}
    </Stack>
  )
}

function Artifacts(): React.JSX.Element {
  const { t } = useTranslation()
  const { data, error } = useApi('artifacts', () => window.api.artifacts())
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<string>(ALL)
  const [tool, setTool] = useState<string>(ALL)
  const [selected, setSelected] = useState<string | null>(null)

  const sources = useMemo(() => [...new Set((data ?? []).map((a) => a.source))], [data])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data ?? []).filter(
      (a) =>
        (source === ALL || a.source === source) &&
        (tool === ALL || a.tool === tool) &&
        (!q ||
          includesCI(a.title, q) ||
          includesCI(a.path, q) ||
          includesCI(a.project, q) ||
          (a.tool !== 'unknown' && (includesCI(a.tool, q) || includesCI(ARTIFACT_TOOL_NAME[a.tool], q))))
    )
  }, [data, query, source, tool])

  if (error) return <ErrorAlert message={error} />
  if (!data) return <Loading />
  const current = data.find((a) => a.id === selected)

  return (
    <FillStack>
      <PageHeader title={t('nav.artifacts')} count={data.length} actions={<ReloadButton />} />
      <Toolbar
        left={
          <>
            <SearchInput value={query} onChange={setQuery} placeholder={t('artifacts.search')} />
            <Select
              w={260}
              allowDeselect={false}
              value={source}
              onChange={(v) => setSource(v ?? ALL)}
              data={[{ value: ALL, label: t('artifacts.allSources') }, ...sources.map((s) => ({ value: s, label: s }))]}
            />
            <Select
              w={170}
              allowDeselect={false}
              value={tool}
              onChange={(v) => setTool(v ?? ALL)}
              aria-label={t('artifacts.allTools')}
              data-testid="artifact-tool-filter"
              data={[
                { value: ALL, label: t('artifacts.allTools') },
                ...TOOL_ORDER.map((x) => ({ value: x, label: x === 'unknown' ? t('artifacts.unknownTool') : ARTIFACT_TOOL_NAME[x] }))
              ]}
              leftSection={toolFilterIcon(tool)}
              renderOption={({ option }) => (
                <Group gap={6} wrap="nowrap">
                  {toolFilterIcon(option.value)}
                  <span>{option.label}</span>
                </Group>
              )}
            />
          </>
        }
        right={
          <Text size="sm" c="dimmed" data-testid="artifact-count">
            {t('common.shown', { shown: filtered.length, total: data.length })}
          </Text>
        }
      />
      <SplitPane
        listScroll={false}
        detailWidth="55%"
        list={
          <VirtualList
            items={filtered.map((a) => ({
              id: a.id,
              label: a.title,
              avatar: a.tool === 'unknown' ? <Initial text={a.title} /> : <ToolIcon tool={a.tool} size={22} />,
              description: [a.project, fmtTime(a.mtime), fmtSize(a.size)].filter(Boolean).join(' · '),
              tag: (
                <Badge variant="default" size="xs" fw={500} c="dimmed">
                  {a.source}
                </Badge>
              )
            }))}
            selected={selected}
            onSelect={setSelected}
          />
        }
        detail={current ? <Preview key={current.id} a={current} /> : <NoSelection />}
      />
    </FillStack>
  )
}

export default Artifacts
