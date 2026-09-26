import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionIcon, Alert, Badge, Box, Code, Group, Image, SegmentedControl, Select, Stack, Text, Title, UnstyledButton } from '@mantine/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ExternalLink, FolderOpen, HelpCircle, Layers } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Artifact, ArtifactTool, DocSearchResponse, DocSearchResult } from '../../../shared/api'
import { Initial } from '../components/ListRow'
import { ErrorAlert, FillStack, Loading, NoSelection, SplitPane } from '../components/Layout'
import { Markdown } from '../components/Markdown'
import { PageHeader, Toolbar } from '../components/PageHeader'
import { ReloadButton } from '../components/ReloadButton'
import { SearchInput } from '../components/SearchInput'
import { Snippet } from '../components/Snippet'
import { ToolIcon } from '../components/ToolIcon'
import { VirtualList } from '../components/VirtualList'
import { fmtSize, fmtTime, includesCI } from '../lib/format'
import { useTextHighlight } from '../lib/highlight'
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

/** Content search results (title + snippet, virtual scroll) */
function ResultList({ rows, selected, onSelect }: { rows: { a: Artifact; hit: DocSearchResult }[]; selected: string | null; onSelect: (id: string) => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => ref.current, estimateSize: () => 72, overscan: 8 })
  return (
    <div ref={ref} style={{ flex: 1, minHeight: 0, overflow: 'auto' }} data-testid="artifact-content-results">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((vr) => {
          const { a, hit } = rows[vr.index]
          return (
            <div key={a.id} data-index={vr.index} ref={v.measureElement} className="mantine-NavLink-root" style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vr.start}px)` }}>
              <UnstyledButton className="ac-row" data-active={a.id === selected || undefined} onClick={() => onSelect(a.id)} style={{ alignItems: 'flex-start' }} data-testid="artifact-content-hit">
                {a.tool === 'unknown' ? <Initial text={a.title} /> : <ToolIcon tool={a.tool} size={22} />}
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" fw={600} lineClamp={1}>
                    {a.title}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={2} style={{ lineHeight: 1.45, wordBreak: 'break-all' }}>
                    <Snippet text={hit.snippet} marks={hit.marks} />
                  </Text>
                </Box>
              </UnstyledButton>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Preview({ a, highlight }: { a: Artifact; highlight: string }): React.JSX.Element {
  const { t } = useTranslation()
  const { data, error } = useApi(`preview:${a.id}`, () => window.api.artifactPreview(a.id))
  const bodyRef = useRef<HTMLDivElement>(null)
  useTextHighlight(bodyRef, highlight, [data])
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
      <div ref={bodyRef}>{body}</div>
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
  const [mode, setMode] = useState<'title' | 'content'>('title')
  /** Content search response tagged with its query (results for an older query are not shown) */
  const [found, setFound] = useState<{ q: string; tool: string; r: DocSearchResponse } | null>(null)
  const [indexRunning, setIndexRunning] = useState(false)
  const contentQ = mode === 'content' ? query.trim() : ''
  useEffect(() => window.api.onSearchIndexEvent((x) => setIndexRunning(x.running)), [])
  // Content search: 300ms after input, and again when indexing finishes
  useEffect(() => {
    if (!contentQ) return
    let alive = true
    const done = (r: DocSearchResponse): void => {
      if (alive) setFound({ q: contentQ, tool, r })
    }
    const timer = setTimeout(() => {
      void window.api.docSearch(contentQ, { kind: 'artifact', ...(tool === ALL ? {} : { tool: tool as ArtifactTool }) }).then(done, () =>
        done({ results: [], mode: 'fts', limited: false, ms: 0 })
      )
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [contentQ, tool, indexRunning])

  const sources = useMemo(() => [...new Set((data ?? []).map((a) => a.source))], [data])
  const filtered = useMemo(() => {
    const q = mode === 'title' ? query.trim().toLowerCase() : ''
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
  }, [data, query, source, tool, mode])
  /** Content hits mapped to the latest scan (hits no longer in the scan are dropped) */
  const resultRows = useMemo(() => {
    if (!found || found.q !== contentQ || found.tool !== tool) return null
    const byId = new Map((data ?? []).map((a) => [a.id, a]))
    return found.r.results.flatMap((hit) => {
      const a = byId.get(hit.key)
      return a && (source === ALL || a.source === source) ? [{ a, hit }] : []
    })
  }, [found, contentQ, tool, data, source])
  const showResults = mode === 'content' && !!contentQ

  if (error) return <ErrorAlert message={error} />
  if (!data) return <Loading />
  const current = data.find((a) => a.id === selected)

  return (
    <FillStack>
      <PageHeader title={t('nav.artifacts')} count={data.length} actions={<ReloadButton />} />
      <Toolbar
        left={
          <>
            <SearchInput value={query} onChange={setQuery} placeholder={mode === 'content' ? t('artifacts.searchContent') : t('artifacts.search')} />
            <SegmentedControl
              size="xs"
              value={mode}
              onChange={(v) => setMode(v as 'title' | 'content')}
              data={[
                { value: 'title', label: t('artifacts.modeTitle') },
                { value: 'content', label: t('artifacts.modeContent') }
              ]}
              data-testid="artifact-search-mode"
            />
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
            {t('common.shown', { shown: showResults ? (resultRows?.length ?? 0) : filtered.length, total: data.length })}
          </Text>
        }
      />
      <SplitPane
        listScroll={false}
        detailWidth="55%"
        list={
          showResults ? (
            !resultRows ? (
              <Loading />
            ) : resultRows.length ? (
              <ResultList rows={resultRows} selected={selected} onSelect={setSelected} />
            ) : (
              <Text size="xs" c="dimmed" p="md">
                {t('common.noResults')}
              </Text>
            )
          ) : (
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
          )
        }
        detail={current ? <Preview key={current.id} a={current} highlight={showResults ? contentQ : ''} /> : <NoSelection />}
      />
    </FillStack>
  )
}

export default Artifacts
