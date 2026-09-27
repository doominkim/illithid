import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Box } from '@mantine/core'
import { Spotlight, type SpotlightActionData } from '@mantine/spotlight'
import { notifications } from '@mantine/notifications'
import {
  BookOpen,
  Brain,
  CloudUpload,
  FolderOpen,
  MessagesSquare,
  Plug,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Users
} from 'lucide-react'
import type { ConfigView, ToolId } from '../../shared/api'
import { clearApiCache, RefreshContext, useApi } from './lib/useApi'
import { ReloadContext } from './components/ReloadButton'
import { ConfigContext } from './lib/config'
import { type Menu, NavContext, type NavRequest, PRIMARY, SECONDARY } from './lib/nav'
import { Sidebar } from './components/Sidebar'
import Settings from './views/Settings'
import Rules from './views/Rules'
import Memory from './views/Memory'
import Skills from './views/Skills'
import Mcp from './views/Mcp'
import Agents from './views/Agents'
import Artifacts from './views/Artifacts'
import Sessions from './views/Sessions'
import Backup from './views/Backup'
import Onboarding from './views/Onboarding'
import { ApplyPreviewModal } from './components/ApplyPreviewModal'
import { SyncContext } from './lib/sync'
import { LIBRARY_CHANGED, notifySync } from './lib/mutate'
import type { SyncPendingView, SyncStatusView } from '../../shared/api'

export type { Menu }

const MENU_ICON: Record<Menu, React.ReactNode> = {
  rules: <BookOpen size={16} />,
  memory: <Brain size={16} />,
  skills: <Sparkles size={16} />,
  mcp: <Plug size={16} />,
  agents: <Users size={16} />,
  artifacts: <FolderOpen size={16} />,
  sessions: <MessagesSquare size={16} />,
  backup: <CloudUpload size={16} />,
  settings: <SettingsIcon size={16} />
}


/** Screens where list and preview scroll independently: pin page height to the window so the list does not stretch the page */
const FILL_MENUS = new Set<string>(['artifacts', 'sessions'])
function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [request, setRequest] = useState<NavRequest>({ menu: 'rules', seq: 0 })
  const [tick, setTick] = useState(0)
  const status = useApi('status', () => window.api.status())
  const mcp = useApi('mcp', () => window.api.mcp())
  const rules = useApi('rules', () => window.api.rules())
  const [cfgTick, setCfgTick] = useState(0)
  const [config, setConfig] = useState<ConfigView | undefined>()
  useEffect(() => {
    let alive = true
    window.api.configGet().then((c) => alive && setConfig(c), () => {})
    return () => {
      alive = false
    }
  }, [cfgTick, tick])
  const configCtx = useMemo(
    () => ({ config, allowRealApply: !!config?.config.allowRealApply, refresh: () => setCfgTick((n) => n + 1) }),
    [config]
  )

  // ---- Sync state (source → tools on app start, reload, window focus)
  const [syncStatus, setSyncStatus] = useState<SyncStatusView | undefined>()
  const [syncBusy, setSyncBusy] = useState(false)
  const refreshSync = useCallback(() => {
    window.api.syncStatus().then(setSyncStatus, () => {})
  }, [])
  const syncNow = useCallback(async (): Promise<SyncStatusView | null> => {
    setSyncBusy(true)
    try {
      const s = await window.api.syncNow()
      setSyncStatus(s)
      clearApiCache()
      setTick((n) => n + 1)
      return s
    } catch {
      return null
    } finally {
      setSyncBusy(false)
    }
  }, [])
  useEffect(() => {
    // When the library watcher in main runs a sync: refresh state + rescan + notify
    const off = window.api.onSyncEvent((s) => {
      setSyncStatus(s)
      clearApiCache()
      setTick((n) => n + 1)
      if (s.wrote) {
        const n = s.targets.filter((x) => x.status === 'written').length + [...s.rules, ...s.skills, ...(s.agents ?? [])].filter((x) => x.status === 'done').length
        if (s.errorCount) notifications.show({ color: 'red', title: t('sync.syncedWithErrors', { n: s.errorCount }), message: s.errors.join(' · ') })
        else notifications.show({ color: 'accent', message: t('sync.watchSynced', { n }), autoClose: 2500 })
      }
    })
    return off
  }, [t])
  useEffect(
    () =>
      // Automatic backup cleanup only reports failures
      window.api.onBackupCleanupEvent((r) =>
        notifications.show({ color: 'red', title: t('settings.cleanupFailed', { count: r.failed.length }), message: r.failed.map((f) => `${f.path} (${f.reason})`).join(' · ') })
      ),
    [t]
  )
  useEffect(() => {
    refreshSync()
    let last = 0
    const onFocus = (): void => {
      const now = Date.now()
      if (now - last < 15_000) return
      last = now
      void syncNow()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshSync, syncNow])
  useEffect(() => {
    refreshSync()
  }, [tick, refreshSync])
  // ---- Pending apply count (computed in the worker, late responses dropped). On new sync state (start, focus, switch, watch, reload) and after config or library changes
  const [pending, setPending] = useState<SyncPendingView | undefined>()
  const pendingSeq = useRef(0)
  const refreshPending = useCallback(() => {
    const seq = ++pendingSeq.current
    window.api.syncPending().then((p) => seq === pendingSeq.current && setPending(p), () => {})
  }, [])
  useEffect(() => {
    refreshPending()
  }, [cfgTick, syncStatus, refreshPending])
  useEffect(() => {
    window.addEventListener(LIBRARY_CHANGED, refreshPending)
    return () => window.removeEventListener(LIBRARY_CHANGED, refreshPending)
  }, [refreshPending])
  const applyOnce = useCallback(async (fingerprint: string): Promise<SyncStatusView | null> => {
    setSyncBusy(true)
    try {
      const s = await window.api.syncApplyOnce(fingerprint)
      setSyncStatus(s)
      notifySync(s)
      clearApiCache()
      setTick((n) => n + 1)
      return s
    } catch {
      // Recount on the next refresh without notifying
      return null
    } finally {
      setSyncBusy(false)
    }
  }, [])
  const [previewOpen, setPreviewOpen] = useState(false)
  const previewCancel = useRef<(() => void) | null>(null)
  const openPreview = useCallback((opts?: { onCancel?: () => void }) => {
    previewCancel.current = opts?.onCancel ?? null
    setPreviewOpen(true)
  }, [])
  const cancelPreview = useCallback(() => {
    const f = previewCancel.current
    previewCancel.current = null
    setPreviewOpen(false)
    f?.()
  }, [])
  const finishPreview = useCallback(() => {
    previewCancel.current = null
    setPreviewOpen(false)
  }, [])
  const syncCtx = useMemo(
    () => ({ status: syncStatus, refresh: refreshSync, syncNow, busy: syncBusy, pending, applyOnce, openPreview }),
    [syncStatus, refreshSync, syncNow, syncBusy, pending, applyOnce, openPreview]
  )

  // First run: tools in use never chosen and the library is empty. Decided once at start (the flow itself saves toolsInUse)
  const [onboarding, setOnboarding] = useState<boolean | null>(null)
  useEffect(() => {
    Promise.all([window.api.configGet(), window.api.toolsInUseGet()]).then(
      ([c, v]) => setOnboarding(!v.configured && c.libraryEmpty),
      () => setOnboarding(false)
    )
  }, [])

  const navigate = useCallback((menu: Menu, opts?: { select?: string; tool?: ToolId | null }) => {
    setRequest((r) => ({
      menu,
      select: opts?.select,
      tool: opts && 'tool' in opts ? opts.tool : null,
      seq: r.seq + 1
    }))
  }, [])

  // After workspace switch or import: reload config and data (main already synced on switch)
  const onWorkspaceChange = useCallback((): void => {
    clearApiCache()
    setCfgTick((n) => n + 1)
    setTick((n) => n + 1)
  }, [])

  const reload = (): void => {
    clearApiCache()
    setTick((n) => n + 1)
    void window.api.syncNow().then(setSyncStatus, () => {})
  }

  const actions = useMemo<SpotlightActionData[]>(() => {
    const nav: SpotlightActionData[] = [...PRIMARY, ...SECONDARY].map((m) => ({
      id: `nav:${m}`,
      group: t('spotlight.screens'),
      label: t(`nav.${m}`),
      leftSection: MENU_ICON[m],
      onClick: () => navigate(m, { tool: null })
    }))
    const skills: SpotlightActionData[] = (status.data?.skills.canonical ?? []).map((name) => ({
      id: `skill:${name}`,
      group: t('nav.skills'),
      label: name,
      leftSection: MENU_ICON.skills,
      onClick: () => navigate('skills', { select: name })
    }))
    const servers: SpotlightActionData[] = (mcp.data?.servers ?? []).map((s) => ({
      id: `mcp:${s.name}`,
      group: t('nav.mcp'),
      label: s.name,
      description: s.url ?? s.command,
      leftSection: MENU_ICON.mcp,
      onClick: () => navigate('mcp', { select: s.name })
    }))
    const ruleFiles: SpotlightActionData[] = (rules.data?.files ?? []).map((f) => ({
      id: `rule:${f.name}`,
      group: t('nav.rules'),
      label: f.name,
      leftSection: MENU_ICON.rules,
      onClick: () => navigate('rules', { select: f.name })
    }))
    const agents: SpotlightActionData[] = (status.data?.roster.rows ?? []).map((r) => ({
      id: `agent:${r.name}`,
      group: t('nav.agents'),
      label: r.name,
      leftSection: MENU_ICON.agents,
      onClick: () => navigate('agents', { select: r.name })
    }))
    return [...nav, ...skills, ...servers, ...ruleFiles, ...agents]
  }, [t, navigate, status.data, mcp.data, rules.data])

  const startError = config?.libraryStartError
  const view: Record<Menu, React.JSX.Element> = {
    rules: <Rules />,
    memory: <Memory />,
    skills: <Skills />,
    mcp: <Mcp />,
    agents: <Agents />,
    artifacts: <Artifacts />,
    sessions: <Sessions />,
    backup: <Backup />,
    settings: <Settings />
  }

  return (
    <NavContext.Provider value={{ request, navigate }}>
      <ConfigContext.Provider value={configCtx}>
       <SyncContext.Provider value={syncCtx}>
        {/* Drag region for the macOS hiddenInset title bar */}
        <div className="ac-dragbar" />
        {onboarding === null ? null : onboarding ? (
          <Onboarding
            onDone={(menu) => {
              setOnboarding(false)
              onWorkspaceChange()
              if (menu) navigate(menu, { tool: null })
            }}
          />
        ) : (
        <Box style={{ display: 'flex', height: '100dvh', overflow: 'hidden' }}>
          <Sidebar onWorkspaceChange={onWorkspaceChange} />
          <Box component="main" style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'auto', position: 'relative' }}>
            <Box mx="auto" maw={1200} px={20} pt={48} pb={24} style={{ ...(FILL_MENUS.has(request.menu) ? { height: '100%' } : { minHeight: '100%' }), display: 'flex', flexDirection: 'column' }}>
              <RefreshContext.Provider value={tick}>
                <ReloadContext.Provider value={reload}>
                  {startError && (
                    <Alert color="red" variant="light" radius="lg" mb="md" title={t(`library.${startError.code}`)}>
                      {startError.detail}
                    </Alert>
                  )}
                  {view[request.menu]}
                </ReloadContext.Provider>
              </RefreshContext.Provider>
            </Box>
          </Box>
        </Box>
        )}
        <ApplyPreviewModal opened={previewOpen} onCancel={cancelPreview} onDone={finishPreview} />
       </SyncContext.Provider>
      </ConfigContext.Provider>
      <Spotlight
        actions={actions}
        shortcut={['mod + K', 'mod + P']}
        limit={12}
        highlightQuery
        radius="lg"
        nothingFound={t('spotlight.nothing')}
        searchProps={{ leftSection: <Search size={16} />, placeholder: t('spotlight.placeholder') }}
      />
    </NavContext.Provider>
  )
}

export default App

