import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Box, Button, Code, Group, Image, SegmentedControl, Select, Stack, Tabs, Text, Title, UnstyledButton } from '@mantine/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ExternalLink, File, FileText, FolderOpen, HelpCircle, Layers, MessagesSquare } from 'lucide-react'
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
import { ViewToggle, type ViewMode } from '../components/ViewToggle'
import { useNav } from '../lib/nav'
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

/** Prepended to rendered HTML: nothing may load from outside the document itself */
const HTML_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:">`

type KindFilter = 'all' | 'image' | 'doc' | 'other'
const kindMatches = (k: KindFilter, a: Artifact): boolean =>
  k === 'all' || (k === 'image' ? a.kind === 'image' : k === 'doc' ? a.kind === 'md' || a.kind === 'html' : a.kind === 'other')

/** Short name for a source location (the full path stays in the tooltip) */
function sourceName(source: string, t: (k: string) => string): string {
  if (/\/workspaces\/[^/]+\/artifacts$/.test(source)) return 'Illithid'
  if (source.endsWith('/.codex/generated_images')) return t('artifacts.srcCodexImages')
  if (source.endsWith('/.claude/plans')) return t('artifacts.srcClaudePlans')
  if (source.endsWith('/.cursor/plans')) return t('artifacts.srcCursorPlans')
  return source.split('/').filter(Boolean).pop() ?? source
}

/** Image thumbnail (loaded once the card scrolls into view) or a file-type icon */
function Thumb({ a }: { a: Artifact }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if ((a.kind !== 'image' && a.kind !== 'html') || !ref.current) return
    let alive = true
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      window.api.artifactThumb(a.id).then((u) => alive && setUrl(u), () => {})
    })
    io.observe(ref.current)
    return () => {
      alive = false
      io.disconnect()
    }
  }, [a.id, a.kind])
  return (
    <div ref={ref} className="ac-thumb">
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : a.kind === 'md' || a.kind === 'html' ? (
        <FileText size={28} strokeWidth={1.5} />
      ) : (
        <File size={28} strokeWidth={1.5} />
      )}
    </div>
  )
}

/** Card grid: thumbnail, title, session or project and time */
function ArtifactGrid({ items, selected, onSelect }: { items: Artifact[]; selected: string | null; onSelect: (id: string) => void }): React.JSX.Element {
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8 }} data-testid="artifact-grid">
      <div className="ac-thumb-grid">
        {items.map((a) => (
          <UnstyledButton key={a.id} className="ac-thumb-card" data-active={a.id === selected || undefined} onClick={() => onSelect(a.id)} title={a.path}>
            <Thumb a={a} />
            <Text size="xs" fw={500} truncate="end" mt={6}>
              {a.title}
            </Text>
            <Text size="xs" c="dimmed" truncate="end">
              {[a.sessionTitle ?? a.project, fmtTime(a.mtime)].filter(Boolean).join(' · ')}
            </Text>
          </UnstyledButton>
        ))}
      </div>
    </div>
  )
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
  const { navigate } = useNav()
  const [htmlView, setHtmlView] = useState<'rendered' | 'source'>('rendered')
  const { data, error } = useApi(`preview:${a.id}`, () => window.api.artifactPreview(a.id))
  const bodyRef = useRef<HTMLDivElement>(null)
  useTextHighlight(bodyRef, highlight, [data])
  const head = (
    <Group justify="space-between" wrap="nowrap" align="flex-start">
      <Box style={{ minWidth: 0 }}>
        <Title order={3} style={{ wordBreak: 'break-word' }}>
          {a.title}
        </Title>
        {a.sessionId && (
          <UnstyledButton
            mt={4}
            onClick={() => navigate('sessions', { select: `${a.tool}:${a.sessionId}` })}
            data-testid="artifact-session"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <MessagesSquare size={14} />
            <Text size="sm" c="dimmed" td="underline">
              {a.sessionTitle}
            </Text>
          </UnstyledButton>
        )}
      </Box>
      <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
        <Button size="xs" variant="default" leftSection={<ExternalLink size={14} />} onClick={() => void runWrite(window.api.artifactOpen(a.id))} data-testid="artifact-open">
          {t('artifacts.open')}
        </Button>
        <Button size="xs" variant="subtle" color="gray" leftSection={<FolderOpen size={14} />} onClick={() => void runWrite(window.api.artifactReveal(a.id))} data-testid="artifact-reveal">
          {t('artifacts.reveal')}
        </Button>
      </Group>
    </Group>
  )
  const facts = (
    <Stack gap={4}>
      <Text size="sm" c="dimmed">
        {[a.tool === 'unknown' ? t('artifacts.unknownTool') : ARTIFACT_TOOL_NAME[a.tool], a.project, fmtTime(a.mtime), fmtSize(a.size)].filter(Boolean).join(' · ')}
      </Text>
      <Group gap={6} wrap="nowrap" c="dimmed">
        <FolderOpen size={14} style={{ flexShrink: 0 }} />
        <Text size="xs" ff="monospace" c="dimmed" truncate="start" title={a.path}>
          {a.path}
        </Text>
      </Group>
    </Stack>
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
  else if (data.kind === 'html' && htmlView === 'rendered')
    body = (
      // No scripts, forms, navigation or popups (empty sandbox), and no network (CSP): HTML and CSS only
      <iframe
        title={a.title}
        sandbox=""
        srcDoc={HTML_CSP + (data.rendered ?? data.text ?? '')}
        className="ac-html-frame"
        data-testid="artifact-html-frame"
      />
    )
  else if (data.kind === 'html' || data.kind === 'text')
    body = (
      <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {data.text ?? ''}
      </Code>
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
      {facts}
      {data?.kind === 'html' && !data.error && (
        <Tabs value={htmlView} onChange={(v) => v && setHtmlView(v as 'rendered' | 'source')} data-testid="artifact-html-view">
          <Tabs.List>
            <Tabs.Tab value="rendered">{t('artifacts.htmlRendered')}</Tabs.Tab>
            <Tabs.Tab value="source">{t('artifacts.htmlSourceView')}</Tabs.Tab>
          </Tabs.List>
        </Tabs>
      )}
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
  const [kind, setKind] = useState<KindFilter>('all')
  const [view, setView] = useState<ViewMode>('grid')
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

  const filtered = useMemo(() => {
    const q = mode === 'title' ? query.trim().toLowerCase() : ''
    return (data ?? []).filter(
      (a) =>
        kindMatches(kind, a) &&
        (tool === ALL || a.tool === tool) &&
        (!q ||
          includesCI(a.title, q) ||
          includesCI(a.path, q) ||
          includesCI(a.project, q) ||
          includesCI(a.sessionTitle, q) ||
          (a.tool !== 'unknown' && (includesCI(a.tool, q) || includesCI(ARTIFACT_TOOL_NAME[a.tool], q))))
    )
  }, [data, query, kind, tool, mode])
  /** Content hits mapped to the latest scan (hits no longer in the scan are dropped) */
  const resultRows = useMemo(() => {
    if (!found || found.q !== contentQ || found.tool !== tool) return null
    const byId = new Map((data ?? []).map((a) => [a.id, a]))
    return found.r.results.flatMap((hit) => {
      const a = byId.get(hit.key)
      return a && kindMatches(kind, a) ? [{ a, hit }] : []
    })
  }, [found, contentQ, tool, data, kind])
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
            <SegmentedControl
              size="xs"
              value={kind}
              onChange={(v) => setKind(v as KindFilter)}
              data={[
                { value: 'all', label: t('artifacts.kindAll') },
                { value: 'image', label: t('artifacts.kindImage') },
                { value: 'doc', label: t('artifacts.kindDoc') },
                { value: 'other', label: t('artifacts.kindOther') }
              ]}
              data-testid="artifact-kind"
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
          <Group gap="sm" wrap="nowrap">
            <Text size="sm" c="dimmed" data-testid="artifact-count">
              {t('common.shown', { shown: showResults ? (resultRows?.length ?? 0) : filtered.length, total: data.length })}
            </Text>
            <ViewToggle value={view} onChange={setView} />
          </Group>
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
          ) : view === 'grid' ? (
            <ArtifactGrid items={filtered} selected={selected} onSelect={setSelected} />
          ) : (
            <VirtualList
              items={filtered.map((a) => ({
                id: a.id,
                label: a.title,
                avatar: a.tool === 'unknown' ? <Initial text={a.title} /> : <ToolIcon tool={a.tool} size={22} />,
                // Location goes on the secondary line with time and size instead of a chip next to the title
                description: [sourceName(a.source, t), a.sessionTitle ?? a.project, fmtTime(a.mtime), fmtSize(a.size)].filter(Boolean).join(' · ')
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
