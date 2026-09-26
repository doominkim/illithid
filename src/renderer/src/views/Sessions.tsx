import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionIcon, Alert, Badge, Box, Button, Code, Collapse, Group, Loader, SegmentedControl, Select, Stack, Switch, Text, UnstyledButton } from '@mantine/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, Clock, Copy, FileText, FolderOpen, Hash, Layers, ListOrdered, MessageSquare, Play, RefreshCw, Wrench } from 'lucide-react'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import type { SearchIndexView, Session, SessionSearchHit, SessionSearchResponse, TranscriptMessage, TranscriptView } from '../../../shared/api'
import { EmptyState } from '../components/EmptyState'
import { ErrorAlert, Loading } from '../components/Layout'
import { Markdown } from '../components/Markdown'
import { PageHeader } from '../components/PageHeader'
import { ReloadButton } from '../components/ReloadButton'
import { SearchInput } from '../components/SearchInput'
import { Snippet } from '../components/Snippet'
import { ToolIcon } from '../components/ToolIcon'
import { cleanTitle, fmtTime, includesCI, relTime } from '../lib/format'
import { TOOL_NAME, TOOLS } from '../lib/tools'
import { useApi } from '../lib/useApi'

const ALL = '__all__'
const LONG = 1200

function copy(text: string, ok: string, fail: string): void {
  navigator.clipboard.writeText(text).then(
    () => notifications.show({ message: ok, color: 'accent', autoClose: 1500 }),
    () => notifications.show({ message: fail, color: 'red' })
  )
}

/** Left session list (virtual scroll) */
function SessionList({ items, selected, onSelect }: { items: Session[]; selected: string | null; onSelect: (s: Session) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({ count: items.length, getScrollElement: () => ref.current, estimateSize: () => 72, overscan: 8 })
  return (
    <div ref={ref} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((row) => {
          const s = items[row.index]
          const key = `${s.tool}:${s.id}`
          return (
            <div key={key} className="mantine-NavLink-root" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: row.size, transform: `translateY(${row.start}px)` }}>
              <UnstyledButton className="ac-row" data-active={key === selected || undefined} onClick={() => onSelect(s)} style={{ height: '100%', alignItems: 'flex-start' }}>
                <ToolIcon tool={s.tool} size={22} />
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" fw={600} lineClamp={2} style={{ lineHeight: 1.35 }}>
                    {cleanTitle(s.title) || t('sessions.untitled')}
                  </Text>
                  <Group gap={6} mt={3} wrap="nowrap">
                    <Clock size={11} style={{ color: 'var(--ac-text-muted)', flexShrink: 0 }} />
                    <Text size="xs" c="dimmed" truncate="end">
                      {relTime(s.updatedAt, t)}
                      {s.project ? ` · ${s.project}` : ''}
                    </Text>
                  </Group>
                </Box>
                <ChevronRight size={14} style={{ color: 'var(--ac-text-muted)', flexShrink: 0, marginTop: 4 }} />
              </UnstyledButton>
            </div>
          )
        })}
      </div>
    </div>
  )
}


type ResultRow = { kind: 'session'; s: Session; count: number } | { kind: 'hit'; s: Session; hit: SessionSearchHit }

/** Content search results (session rows + matching message rows, virtual scroll) */
function ResultList({ rows, selected, onSelect }: { rows: ResultRow[]; selected: string | null; onSelect: (s: Session, idx?: number) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => ref.current, estimateSize: (i) => (rows[i].kind === 'session' ? 60 : 52), overscan: 8 })
  return (
    <div ref={ref} style={{ flex: 1, minHeight: 0, overflow: 'auto' }} data-testid="content-results">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((vr) => {
          const r = rows[vr.index]
          const key = `${r.s.tool}:${r.s.id}`
          return (
            <div key={vr.key} data-index={vr.index} ref={v.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vr.start}px)` }}>
              {r.kind === 'session' ? (
                <UnstyledButton className="ac-row" data-active={key === selected || undefined} onClick={() => onSelect(r.s)} style={{ alignItems: 'flex-start', borderBottom: 0, paddingBottom: 4 }}>
                  <ToolIcon tool={r.s.tool} size={20} />
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" fw={600} lineClamp={1}>
                      {cleanTitle(r.s.title) || t('sessions.untitled')}
                    </Text>
                    <Text size="xs" c="dimmed" truncate="end">
                      {relTime(r.s.updatedAt, t)}
                      {r.s.project ? ` · ${r.s.project}` : ''}
                      {` · ${r.count}`}
                    </Text>
                  </Box>
                </UnstyledButton>
              ) : (
                <UnstyledButton className="ac-row" data-testid="content-hit" data-index={r.hit.idx} onClick={() => onSelect(r.s, r.hit.idx)} style={{ padding: '4px 14px 8px 46px', borderBottom: 0, alignItems: 'flex-start' }}>
                  <Text size="xs" c={r.hit.role === 'user' ? 'var(--ac-accent)' : 'dimmed'} fw={600} style={{ flexShrink: 0, lineHeight: 1.45 }}>
                    {r.hit.role === 'user' ? t('sessions.user') : t('sessions.ai')}
                  </Text>
                  <Text size="xs" lineClamp={2} style={{ lineHeight: 1.45, wordBreak: 'break-all' }}>
                    <Snippet text={r.hit.snippet} marks={r.hit.marks} />
                  </Text>
                </UnstyledButton>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Indexing progress (only while indexing) */
function useSearchIndex(): SearchIndexView | null {
  const [v, setV] = useState<SearchIndexView | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.sessionIndexStatus().then((x) => alive && setV(x), () => {})
    const off = window.api.onSearchIndexEvent((x) => setV(x))
    return () => {
      alive = false
      off()
    }
  }, [])
  return v
}

/** Session tool filter icons (all = Layers) */
function toolFilterIcon(v: string): React.JSX.Element {
  return v === ALL ? <Layers size={13} /> : <ToolIcon tool={v as (typeof TOOLS)[number]} size={13} />
}
/** A single chat bubble */
function Bubble({ m, highlight, refCb }: { m: TranscriptMessage; highlight: boolean; refCb: (el: HTMLDivElement | null) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const isUser = m.role === 'user'
  if (m.kind === 'tool') {
    return (
      <Box ref={refCb} px="sm" data-index={m.index}>
        <UnstyledButton onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ac-text-muted)', fontSize: 12 }}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Wrench size={12} />
          <span>{t('sessions.toolCall', { tool: '' }).replace(/[:：]\s*$/, '')}</span>
          <span style={{ opacity: 0.7 }}>{m.text.slice(0, 100).replace(/\n/g, ' ')}</span>
        </UnstyledButton>
        <Collapse expanded={open}>
          <Code block mt={4} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11.5 }}>
            {m.text}
          </Code>
        </Collapse>
      </Box>
    )
  }
  const long = m.text.length > LONG
  const shown = long && !open ? m.text.slice(0, LONG) + '…' : m.text
  return (
    <Box
      ref={refCb}
      data-index={m.index}
      p="sm"
      style={{
        marginLeft: isUser ? 40 : 0,
        marginRight: isUser ? 0 : 40,
        borderRadius: 10,
        border: `1px solid ${highlight ? 'var(--ac-accent)' : 'var(--ac-border-subtle)'}`,
        background: isUser ? 'var(--ac-accent-bg)' : 'var(--ac-surface)',
        transition: 'border-color 300ms'
      }}
    >
      <Group justify="space-between" mb={4}>
        <Text size="xs" fw={600} c={isUser ? 'var(--ac-accent)' : 'dimmed'}>
          {isUser ? t('sessions.user') : t('sessions.ai')}
        </Text>
        <Text size="xs" c="dimmed">
          {fmtTime(m.at)}
        </Text>
      </Group>
      <Markdown text={shown} />
      {long && (
        <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setOpen((o) => !o)}>
          {open ? t('sessions.collapse') : t('sessions.expand', { n: m.text.length })}
        </Button>
      )}
    </Box>
  )
}

/** Center: header + transcript, right: Contents */
const PAGE = 80

function Detail({ s, jumpTo }: { s: Session; jumpTo?: { index: number; nonce: number } }): React.JSX.Element {
  const { t } = useTranslation()
  const first = useApi<TranscriptView>(`transcript:${s.tool}:${s.id}`, () => window.api.sessionTranscript(s.tool, s.id, { limit: PAGE }))
  const [older, setOlder] = useState<TranscriptMessage[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const tr = useMemo<typeof first>(() => (first.data ? { ...first, data: { ...first.data, messages: [...older, ...first.data.messages] } } : first), [first, older])
  const loadMore = async (): Promise<void> => {
    const oldest = tr.data?.messages[0]?.index
    if (oldest === undefined || oldest <= 0) return
    setLoadingMore(true)
    const more = await window.api.sessionTranscript(s.tool, s.id, { limit: PAGE, before: oldest })
    setLoadingMore(false)
    if (more.available) setOlder((o) => [...more.messages, ...o])
  }
  const hasMore = (tr.data?.messages[0]?.index ?? 0) > 0
  const [highlight, setHighlight] = useState<number | null>(null)
  const refs = useRef(new Map<number, HTMLDivElement>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pendingJump, setPendingJump] = useState<number | null>(null)
  /** Scroll only inside the transcript pane (scrollIntoView also moves outer containers) */
  const scrollTo = (index: number): boolean => {
    const el = refs.current.get(index)
    const box = scrollRef.current
    if (!el || !box) return false
    const b = box.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const top = box.scrollTop + (r.top - b.top) - Math.max(0, (b.height - r.height) / 2)
    // Jump instantly; smooth scrolling gets interrupted by layout shifts while earlier messages are prepended
    box.scrollTop = Math.max(0, top)
    // Adjust once more in case markdown rendering changes the height late
    requestAnimationFrame(() => {
      const r2 = el.getBoundingClientRect()
      const b2 = box.getBoundingClientRect()
      box.scrollTop = Math.max(0, box.scrollTop + (r2.top - b2.top) - Math.max(0, (b2.height - r2.height) / 2))
    })
    setHighlight(index)
    setTimeout(() => setHighlight(null), 1600)
    return true
  }
  const jump = async (index: number): Promise<void> => {
    if (scrollTo(index)) return
    // If the message is earlier than what is loaded, load up to it first, then jump
    let oldest = tr.data?.messages[0]?.index
    const loaded: TranscriptMessage[] = []
    setLoadingMore(true)
    while (oldest !== undefined && oldest > index) {
      const more = await window.api.sessionTranscript(s.tool, s.id, { limit: PAGE, before: oldest })
      if (!more.available || more.messages.length === 0) break
      loaded.unshift(...more.messages)
      oldest = more.messages[0].index
    }
    setLoadingMore(false)
    if (loaded.length) setOlder((o) => [...loaded, ...o])
    setPendingJump(index)
  }
  useEffect(() => {
    if (pendingJump === null) return
    if (scrollTo(pendingJump)) setPendingJump(null)
  })
  // Search result click: load the transcript, then jump to that message
  const jumped = useRef<number | null>(null)
  // On first open, show the latest messages (bottom), unless entered at a specific message from search
  const initialScrolled = useRef(false)
  useEffect(() => {
    if (initialScrolled.current || !first.data?.available || jumpTo) return
    const box = scrollRef.current
    if (!box) return
    initialScrolled.current = true
    const toBottom = (): void => {
      box.scrollTop = box.scrollHeight
    }
    toBottom()
    // Follow for two more frames in case markdown rendering grows the height late
    requestAnimationFrame(() => {
      toBottom()
      requestAnimationFrame(toBottom)
    })
  }, [first.data, jumpTo])
  useEffect(() => {
    if (!jumpTo || !first.data?.available || jumped.current === jumpTo.nonce) return
    jumped.current = jumpTo.nonce
    void jump(jumpTo.index)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo, first.data])
  const resume = s.resumeCommand

  return (
    <Box style={{ flex: 1, minWidth: 0, display: 'flex', gap: 14 }}>
      <Box className="ac-card" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Box p="md" style={{ borderBottom: '1px solid var(--ac-border-subtle)' }}>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
              <ToolIcon tool={s.tool} size={26} />
              <Text fw={600} style={{ fontSize: 16, lineHeight: 1.3 }} lineClamp={2}>
                {cleanTitle(s.title) || t('sessions.untitled')}
              </Text>
            </Group>
            {resume && (
              <Button size="xs" leftSection={<Play size={12} />} style={{ flexShrink: 0 }} onClick={() => copy(resume, t('common.copied'), t('common.copyFailed'))} data-testid="resume-copy">
                {t('sessions.continue')}
              </Button>
            )}
          </Group>
          <Group gap="md" mt={6} wrap="wrap" c="dimmed">
            <Group gap={4} wrap="nowrap">
              <Clock size={12} />
              <Text size="xs" c="dimmed">
                {fmtTime(s.startedAt)} → {fmtTime(s.updatedAt)}
              </Text>
            </Group>
            {s.project && (
              <Group gap={4} wrap="nowrap">
                <FolderOpen size={12} />
                <Text size="xs" c="dimmed">
                  {s.project}
                </Text>
              </Group>
            )}
            <Group gap={4} wrap="nowrap">
              <Hash size={12} />
              <Text size="xs" c="dimmed" ff="monospace">
                {s.id}
              </Text>
            </Group>
            <Group gap={4} wrap="nowrap">
              <FileText size={12} />
              <Text size="xs" c="dimmed" ff="monospace" truncate="end" maw={360}>
                {s.path}
              </Text>
            </Group>
          </Group>
          <Group gap={6} mt={8} wrap="nowrap">
            <Code style={{ flex: 1, padding: '6px 10px', wordBreak: 'break-all' }}>{resume ?? t('sessions.noResume')}</Code>
            {resume && (
              <ActionIcon variant="default" onClick={() => copy(resume, t('common.copied'), t('common.copyFailed'))} aria-label={t('common.copy')}>
                <Copy size={13} />
              </ActionIcon>
            )}
          </Group>
        </Box>
        <Group gap={8} px="md" py={8} style={{ borderBottom: '1px solid var(--ac-border-subtle)' }}>
          <MessageSquare size={14} style={{ color: 'var(--ac-text-muted)' }} />
          <Text size="sm" fw={600}>
            {t('sessions.history')}
          </Text>
          <Badge variant="default" size="sm" fw={600} c="dimmed">
            {tr.data?.total ?? s.messageCount ?? '—'}
          </Badge>
          {tr.data?.truncated && (
            <Badge variant="light" color="yellow" size="xs" fw={500}>
              {t('sessions.truncated')}
            </Badge>
          )}
        </Group>
        <Box ref={scrollRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', overflowAnchor: 'none' }} p="md" data-testid="transcript-scroll">
          {tr.error ? (
            <ErrorAlert message={tr.error} />
          ) : !tr.data ? (
            <Loading />
          ) : !tr.data.available ? (
            <EmptyState title={t('sessions.transcriptUnavailable')} hint={tr.data.error} />
          ) : tr.data.messages.length === 0 ? (
            <EmptyState title={t('sessions.noMessages')} />
          ) : (
            <Stack gap="sm">
              {hasMore && (
                <Button variant="default" size="xs" loading={loadingMore} onClick={() => void loadMore()} data-testid="transcript-more">
                  {t('sessions.loadMore', { n: Math.min(PAGE, tr.data.messages[0].index) })}
                </Button>
              )}
              {tr.data.messages.map((m) => (
                <Bubble key={m.index} m={m} highlight={highlight === m.index} refCb={(el) => (el ? refs.current.set(m.index, el) : refs.current.delete(m.index))} />
              ))}
            </Stack>
          )}
        </Box>
      </Box>
      <Box className="ac-card" style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Group gap={8} px="md" py={10} style={{ borderBottom: '1px solid var(--ac-border-subtle)' }}>
          <ListOrdered size={14} style={{ color: 'var(--ac-text-muted)' }} />
          <Text size="sm" fw={600}>
            {t('sessions.contents')}
          </Text>
        </Group>
        <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {!tr.data?.available || tr.data.prompts.length === 0 ? (
            <Text size="xs" c="dimmed" p="md">
              {t('sessions.noContents')}
            </Text>
          ) : (
            tr.data.prompts.map((p, i) => (
              <UnstyledButton key={p.index} className="ac-row" data-testid="contents-item" data-index={p.index} onClick={() => void jump(p.index)} style={{ alignItems: 'flex-start', padding: '8px 12px' }}>
                <Badge size="xs" variant="light" circle fw={600} style={{ flexShrink: 0, marginTop: 2 }}>
                  {i + 1}
                </Badge>
                <Text size="xs" lineClamp={2} style={{ lineHeight: 1.4 }}>
                  {cleanTitle(p.text)}
                </Text>
              </UnstyledButton>
            ))
          )}
        </Box>
      </Box>
    </Box>
  )
}

function Sessions(): React.JSX.Element {
  const { t } = useTranslation()
  const { data, error } = useApi('sessions', () => window.api.sessions())
  const [tool, setTool] = useState<string>(ALL)
  const [query, setQuery] = useState('')
  const [hideSub, setHideSub] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [mode, setMode] = useState<'title' | 'content'>('title')
  const [jumpTo, setJumpTo] = useState<{ index: number; nonce: number } | undefined>()
  const [found, setFound] = useState<SessionSearchResponse | null>(null)
  const index = useSearchIndex()
  const contentQ = mode === 'content' ? query.trim() : ''
  // Clear previous results immediately when the query or tool changes (kept on re-search after indexing finishes)
  useEffect(() => {
    setFound(null)
  }, [contentQ, tool])
  // Content search: 300ms after input, and again when indexing finishes
  useEffect(() => {
    if (!contentQ) return
    let alive = true
    const timer = setTimeout(() => {
      void window.api.sessionSearch(contentQ, tool === ALL ? {} : { tool: tool as Session['tool'] }).then(
        (r) => alive && setFound(r),
        () => alive && setFound({ results: [], mode: 'fts', limited: false, ms: 0 })
      )
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [contentQ, tool, index?.running])

  const filtered = useMemo(() => {
    const q = mode === 'title' ? query.trim().toLowerCase() : ''
    return (data?.sessions ?? []).filter(
      (s) => (tool === ALL || s.tool === tool) && (!hideSub || !s.parentId) && (!q || includesCI(s.title, q) || includesCI(s.project, q) || includesCI(s.cwd, q))
    )
  }, [data, tool, query, hideSub, mode])
  /** Content search results to list rows (uses the latest title and parent info from the session list) */
  const resultRows = useMemo(() => {
    if (!found) return null
    const byKey = new Map((data?.sessions ?? []).map((s) => [`${s.tool}:${s.id}`, s]))
    const rows: ResultRow[] = []
    let n = 0
    for (const r of found.results) {
      const s: Session = byKey.get(`${r.tool}:${r.id}`) ?? { tool: r.tool, id: r.id, title: r.title, project: r.project, updatedAt: r.updatedAt, parentId: r.parentId, path: '' }
      if ((tool !== ALL && s.tool !== tool) || (hideSub && s.parentId)) continue
      n++
      rows.push({ kind: 'session', s, count: r.count })
      for (const hit of r.hits) rows.push({ kind: 'hit', s, hit })
    }
    return { rows, sessions: n }
  }, [found, data, tool, hideSub])
  useEffect(() => {
    if (!selected && filtered[0]) setSelected(`${filtered[0].tool}:${filtered[0].id}`)
  }, [filtered, selected])

  if (error) return <ErrorAlert message={error} />
  if (!data) return <Loading />
  const current = data.sessions.find((s) => `${s.tool}:${s.id}` === selected)
  const select = (s: Session, idx?: number): void => {
    setSelected(`${s.tool}:${s.id}`)
    setJumpTo(idx === undefined ? undefined : { index: idx, nonce: Date.now() })
  }
  const showResults = mode === 'content' && !!contentQ

  return (
    <Stack gap={0} h="100%" style={{ minHeight: 0 }}>
      <PageHeader title={t('nav.sessions')} count={data.sessions.length} actions={<ReloadButton />} />
      {data.errors.map((e) => (
        <Alert key={e.tool} color="red" variant="light" radius="md" mb="sm">
          {t('sessions.scanError', { tool: TOOL_NAME[e.tool], message: e.message })}
        </Alert>
      ))}
      <Box style={{ flex: 1, minHeight: 0, display: 'flex', gap: 14 }}>
        <Box className="ac-card" style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <Stack gap={6} p="sm" style={{ borderBottom: '1px solid var(--ac-border-subtle)' }}>
            <Group justify="space-between" wrap="nowrap">
              <Group gap={6}>
                <Text size="sm" fw={600}>
                  {t('nav.sessions')}
                </Text>
                <Badge variant="default" size="sm" fw={600} c="dimmed" data-testid="session-count">
                  {t('common.shown', { shown: showResults ? (resultRows?.sessions ?? 0) : filtered.length, total: data.sessions.length })}
                </Badge>
              </Group>
              <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => window.dispatchEvent(new Event('ac-reload'))} aria-label={t('common.reload')} style={{ display: 'none' }}>
                <RefreshCw size={12} />
              </ActionIcon>
            </Group>
            <Group gap={6} wrap="nowrap">
              <Box style={{ flex: 1, minWidth: 0 }}>
                <SearchInput value={query} onChange={setQuery} placeholder={mode === 'content' ? t('sessions.searchContent') : t('sessions.search')} w="100%" />
              </Box>
              <SegmentedControl
                size="xs"
                value={mode}
                onChange={(v) => setMode(v as 'title' | 'content')}
                data={[
                  { value: 'title', label: t('sessions.modeTitle') },
                  { value: 'content', label: t('sessions.modeContent') }
                ]}
                data-testid="search-mode"
              />
            </Group>
            <Group gap={6} wrap="nowrap">
              <Select
                size="xs"
                style={{ flex: 1 }}
                allowDeselect={false}
                value={tool}
                onChange={(v) => setTool(v ?? ALL)}
                data={[{ value: ALL, label: t('sessions.allTools') }, ...TOOLS.map((x) => ({ value: x, label: TOOL_NAME[x] }))]}
                leftSection={toolFilterIcon(tool)}
                renderOption={({ option }) => (
                  <Group gap={6} wrap="nowrap">
                    {toolFilterIcon(option.value)}
                    <span>{option.label}</span>
                  </Group>
                )}
              />
              <Switch size="xs" label={t('sessions.hideSubagents')} checked={hideSub} onChange={(e) => setHideSub(e.currentTarget.checked)} />
            </Group>
          </Stack>
          {index?.running && index.progress && index.progress.total > 0 && (
            <Group gap={6} px="sm" py={4} style={{ borderBottom: '1px solid var(--ac-border-subtle)' }} data-testid="index-progress">
              <Loader size={10} />
              <Text size="xs" c="dimmed">
                {index.progress.done} / {index.progress.total}
              </Text>
            </Group>
          )}
          {showResults ? (
            !found ? (
              <Loading />
            ) : resultRows && resultRows.rows.length ? (
              <ResultList rows={resultRows.rows} selected={selected} onSelect={select} />
            ) : (
              <Text size="xs" c="dimmed" p="md">
                {t('common.noResults')}
              </Text>
            )
          ) : (
            <SessionList items={filtered} selected={selected} onSelect={(s) => select(s)} />
          )}
        </Box>
        {current ? (
          <Detail key={`${current.tool}:${current.id}`} s={current} jumpTo={jumpTo} />
        ) : (
          <Box className="ac-card" style={{ flex: 1 }}>
            <EmptyState title={t('common.noSelection')} />
          </Box>
        )}
      </Box>
    </Stack>
  )
}

export default Sessions
