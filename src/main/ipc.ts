/**
 * IPC registration. Reads run on a worker thread, writes run synchronously in main (writes.ts).
 * - main decides paths. home = ILLITHID_HOME (fixture) or os.homedir(). git repo = library root.
 * - artifactPreview only reads ids from the renderer that appear in the latest artifacts scan.
 * - There is no arbitrary-path read/write channel. The engine checks that file names and relative paths stay inside the library.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { trayCommand, traySessions, updateTray } from './tray'
import { checkForUpdate, clearUpdate, openUpgradeInTerminal, updateAvailable } from './update'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import {
  activeWorkspaceId,
  backupStatus,
  libraryRoot,
  workspaceRoot,
  claudeProjectSlug,
  connectBackup,
  moveClaudeMemory,
  promoteClaudeMemory,
  listCodexRolloutSummaries,
  readClaudeMemoryFile,
  readCodexMemoryFile,
  trashClaudeMemory,
  disconnect,
  history,
  pullOnStart,
  readSessionTranscript,
  restore,
  snapshot,
  watchLibrary,
  applyBackupCleanup,
  backupRetentionOf,
  detectTools,
  tilde,
  type Artifact,
  type CleanupPlan,
  type GitResult,
  type ToolId,
  type Unsubscribe
} from '../engine'
import type { IndexStatus, TranscriptOptions } from '../engine'
import type {
  AppConfig,
  ArtifactPreview,
  BackupCleanupView,
  BackupStatusView,
  Channel,
  ManifestKind,
  ModelDetail,
  ModelSummary,
  Refused,
  SearchIndexView,
  SessionModelShare,
  TranscriptView,
  TrayCommand,
  TraySession,
  TrayState,
  WriteResult
} from '../shared/api'
import type { Op } from './reads'
import { mcpToolInfo } from './reads'
import { fetchMcpTools } from './mcpTools'
import { defaultSecretBackend } from '../engine/secrets'
import type { UiPrefsPatch } from '../engine/uiPrefs'
import * as W from './writes'
import { adoptEditedRule } from '../engine/editedRules'
import { keepImportedOriginal } from './preview'
import { shellEnvReady } from './shellEnv'
import { marketHandlers } from './market'
import {
  advanceWorkspaceRevision,
  assertWorkspaceCurrent,
  captureWorkspace
} from './workspaceGuard'
import createWorker from './worker?nodeWorker'

/** fixture HOME. Used by check scripts to inject a temp directory instead of the real HOME */
export function resolveHome(): { home: string; fixture: boolean } {
  const f = process.env['ILLITHID_HOME']
  if (f && existsSync(f)) return { home: f, fixture: true }
  return { home: homedir(), fixture: false }
}

const TEXT_LIMIT = 200 * 1024
const IMAGE_LIMIT = 5 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
}

/** Worker reads that resolve tool files or ${VAR} values and so need the login shell environment */
const ENV_OPS: ReadonlySet<Op> = new Set<Op>([
  'status',
  'syncPending',
  'syncPreview',
  'mcp',
  'hooks',
  'permissions'
])

/** Run synchronous scans on a worker thread so the main event loop is not blocked */
/** Recent sessions for the menu bar item (worker scan; subagent, untitled and non-resumable sessions left out) */
export async function recentSessions(limit: number): Promise<TraySession[]> {
  const { home } = resolveHome()
  const r = await inWorker<{
    sessions: {
      title: string
      tool: string
      updatedAt?: string
      parentId?: string
      resumeCommand?: string
    }[]
  }>('sessions', home)
  return r.sessions
    .filter((s) => !s.parentId && s.resumeCommand && s.title.trim())
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, limit)
    .map((s) => ({
      title: s.title,
      tool: s.tool as ToolId,
      updatedAt: s.updatedAt,
      resumeCommand: s.resumeCommand!
    }))
}

async function inWorker<T>(
  op: Op,
  home: string,
  args: unknown[] = [],
  onProgress?: (p: unknown) => void
): Promise<T> {
  // Workers get a copy of process.env. Only reads that depend on it wait for the login shell environment,
  // so lists (rules, skills, sessions, artifacts, search) show right away even when the shell is slow to start
  if (ENV_OPS.has(op)) await shellEnvReady()
  return new Promise((resolve, reject) => {
    const w = createWorker({ workerData: { op, home, env: { ...process.env }, args } })
    let settled = false
    w.on(
      'message',
      (m: { ok: true; value: T } | { ok: false; message: string } | { progress: unknown }) => {
        if ('progress' in m) {
          onProgress?.(m.progress)
          return
        }
        settled = true
        if (m.ok) resolve(m.value)
        else reject(new Error(m.message))
      }
    )
    w.once('error', (e) => {
      settled = true
      reject(e)
    })
    w.once('exit', (code) => {
      if (!settled) reject(new Error(`worker exited (code ${code})`))
    })
  })
}

async function readPrefix(path: string, limit: number): Promise<{ buf: Buffer; size: number }> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, limit)
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, 0)
    return { buf: buf.subarray(0, bytesRead), size }
  } finally {
    await fh.close()
  }
}

const INLINE_IMAGE_LIMIT = 2 * 1024 * 1024
const INLINE_TOTAL_LIMIT = 15 * 1024 * 1024

/**
 * `<img src="relative">` → data URL, for images inside the html file's own folder (never outside it, never remote), within size
 * limits. Other references stay as they are and don't load in the sandbox
 */
async function inlineLocalImages(html: string, dir: string): Promise<string> {
  const refs = [
    ...new Set([...html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(["'])([^"']+)\1/gi)].map((m) => m[2]))
  ]
  const urls = new Map<string, string>()
  let total = 0
  for (const ref of refs) {
    if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(ref)) continue
    let rel: string
    try {
      rel = decodeURIComponent(ref.split(/[?#]/)[0])
    } catch {
      continue
    }
    const file = resolve(dir, rel)
    if (!file.startsWith(dir + sep)) continue
    const mime = MIME[extname(file).toLowerCase()]
    if (!mime) continue
    try {
      const { buf, size } = await readPrefix(file, INLINE_IMAGE_LIMIT)
      if (size > INLINE_IMAGE_LIMIT || total + size > INLINE_TOTAL_LIMIT) continue
      total += size
      urls.set(ref, `data:${mime};base64,${buf.toString('base64')}`)
    } catch {
      // missing image: left as is
    }
  }
  if (!urls.size) return html
  return html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi,
    (m, pre: string, q: string, ref: string) =>
      urls.has(ref) ? `${pre}${q}${urls.get(ref)}${q}` : m
  )
}

async function preview(a: Artifact): Promise<ArtifactPreview> {
  const base = { id: a.id, size: a.size, truncated: false }
  try {
    if (a.kind === 'image') {
      const mime = MIME[extname(a.path).toLowerCase()]
      if (!mime) return { ...base, kind: 'binary' }
      if (a.size > IMAGE_LIMIT) return { ...base, kind: 'image', error: 'tooLarge' }
      const { buf } = await readPrefix(a.path, IMAGE_LIMIT)
      return { ...base, kind: 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    }
    const { buf, size } = await readPrefix(a.path, TEXT_LIMIT)
    // A NUL byte means it is not text
    if (a.kind === 'other' && buf.subarray(0, 8192).includes(0)) {
      return { ...base, size, kind: 'binary' }
    }
    const kind = a.kind === 'md' ? 'md' : a.kind === 'html' ? 'html' : 'text'
    const text = buf.toString('utf8')
    return {
      ...base,
      size,
      kind,
      text,
      ...(kind === 'html' ? { rendered: await inlineLocalImages(text, dirname(a.path)) } : {}),
      truncated: size > TEXT_LIMIT
    }
  } catch (e) {
    return {
      ...base,
      kind: 'binary',
      error: `readFailed:${(e as NodeJS.ErrnoException).code ?? 'unknown'}`
    }
  }
}

/** GitResult → WriteResult */
function fromGit<T extends object>(r: GitResult<T>): WriteResult<T> {
  if (r.ok) {
    const { ok, ...rest } = r
    void ok
    return { ok: true, value: rest as T }
  }
  return { ok: false, code: 'git', message: r.reason }
}

/** autoBackup from config.json (validateConfig allows unknown keys) */
function autoBackupOn(home: string): boolean {
  const c = W.configView(home, false).config as unknown as Record<string, unknown>
  return c.autoBackup === true
}

// Keep git from blocking on credential prompts (applies to all engine git calls)
process.env.GIT_TERMINAL_PROMPT = '0'

/** Artifact thumbnails by id:mtime (data URL or null) */
const thumbs = new Map<string, string | null>()

export function registerIpc(): void {
  const { home, fixture } = resolveHome()
  // Read at call time, after the login shell environment has loaded (Finder launches start with a minimal PATH)
  const envNow = async (): Promise<NodeJS.ProcessEnv> => {
    await shellEnvReady()
    return { ...process.env }
  }
  /** Latest artifacts scan result. preview only reads ids listed here */
  let artifacts = new Map<string, Artifact>()
  const switchPreviews = new Map<string, ReturnType<typeof captureWorkspace>>()
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  /** Tool file write: runs after passing the allowRealApply gate */
  const gated = <T>(fn: () => T): WriteResult<T> | Refused => W.gate(home) ?? W.wrap(fn)
  /** Library write: readiness gate → run → sync immediately if allowRealApply (result attached as sync) */
  const libWrite = async <T>(fn: () => T): Promise<WriteResult<T> | Refused> => {
    const origin = captureWorkspace(home)
    const workspaceId = activeWorkspaceId(home)
    const g = W.libGate(home)
    if (g) return g
    const env = await envNow()
    W.markSelfWrite()
    const r = W.wrap(() => {
      assertWorkspaceCurrent(home, origin, false)
      return fn()
    })
    if (!r.ok) return r
    advanceWorkspaceRevision()
    scheduleAutoBackup(home, workspaceId)
    const sync = W.syncNow(home, env)
    W.markSelfWrite()
    return { ...r, sync }
  }
  /** Engine backupStatus can throw a git log error on an empty repo before the first commit — guard so the UI survives */
  const backupView = async (): Promise<BackupStatusView> => {
    try {
      const root = libraryRoot(home)
      const status = await backupStatus(home)
      return {
        ...status,
        autoBackup: autoBackupOn(home),
        ...(status.remoteUrl && backupErrors.has(root)
          ? { remoteError: backupErrors.get(root) }
          : {})
      }
    } catch (e) {
      const st = W.libraryState(home)
      return {
        initialized: existsSync(`${st.root}/.git`),
        dirty: false,
        ahead: 0,
        behind: 0,
        deviceName: (W.configView(home, false).config.deviceName ?? '').trim() || hostname(),
        root: st.root,
        libraryExists: st.exists,
        autoBackup: autoBackupOn(home),
        error: (e as Error).message
      }
    }
  }
  const historySafe = async (): Promise<Awaited<ReturnType<typeof history>>> => {
    try {
      return await history(home, 30)
    } catch {
      return []
    }
  }

  const market = marketHandlers(home, libWrite)
  const handlers: Record<Channel, (...args: unknown[]) => Promise<unknown>> = {
    ...market,
    status: () => inWorker('status', home),
    rules: () => inWorker('rules', home),
    skills: () => inWorker('skills', home),
    agents: () => inWorker('agents', home),
    mcp: () => inWorker('mcp', home),
    hooks: () => inWorker('hooks', home),
    permissions: () => inWorker('permissions', home),
    scripts: () => inWorker('scripts', home),
    sessions: async () => {
      const r = await inWorker('sessions', home)
      // Session refresh = incremental index (if already running, run once more afterwards)
      runSearchIndex()
      return r
    },
    sessionSearch: (q, filters) => inWorker('searchSessions', home, [str(q), filters ?? {}]),
    sessionIndexStatus: () => searchIndexView(),
    // null = nothing indexed yet (fresh install or upgrade): start an index run; the panel reloads when it finishes
    usage: async (kind, name) => {
      const r = await inWorker('usage', home, [kind, name])
      if (r === null) runSearchIndex()
      return r
    },
    usageSummary: async (kind, names) => {
      const r = await inWorker('usageSummary', home, [kind, names])
      if (r === null) runSearchIndex()
      return r
    },
    models: async (range) => {
      const r = await inWorker<ModelSummary[] | null>('models', home, [range ?? {}])
      if (r === null) runSearchIndex()
      return r
    },
    modelDetail: async (key, range) => {
      const r = await inWorker<ModelDetail | null>('modelDetail', home, [key, range ?? {}])
      if (r === null) runSearchIndex()
      return r
    },
    sessionModels: async (tool, id) => {
      const r = await inWorker<SessionModelShare[] | null>('sessionModels', home, [tool, str(id)])
      if (r === null) runSearchIndex()
      return r
    },
    docSearch: (q, filters) => inWorker('searchDocs', home, [str(q), filters ?? {}]),
    searchAll: (q) => inWorker('searchAll', home, [str(q)]),
    sessionTranscript: async (tool, id, opts): Promise<TranscriptView> => {
      try {
        const tr = await readSessionTranscript(
          home,
          tool as ToolId,
          str(id),
          (opts ?? {}) as TranscriptOptions
        )
        return { ...tr, available: true }
      } catch (e) {
        return {
          available: false,
          messages: [],
          prompts: [],
          total: 0,
          truncated: false,
          error: (e as Error).message
        }
      }
    },
    artifacts: async () => {
      const list = await inWorker<Artifact[]>('artifacts', home)
      artifacts = new Map(list.map((a) => [a.id, a]))
      // Artifact refresh = incremental index (documents are indexed in the same run)
      runSearchIndex()
      return list
    },
    artifactOpen: async (id) => {
      const a = typeof id === 'string' ? artifacts.get(id) : undefined
      if (!a) return { ok: false, code: 'notFound', message: 'unknownId' }
      // Never open executables with the default app (that would be the same as double-click running them)
      if (/\.(command|app|sh|tool|terminal|scpt|workflow|pkg|dmg)$/i.test(a.path))
        return { ok: false, code: 'refused', message: 'executable' }
      const err = await shell.openPath(a.path)
      return err ? { ok: false, code: 'openFailed', message: err } : { ok: true, value: undefined }
    },
    artifactReveal: async (id) => {
      const a = typeof id === 'string' ? artifacts.get(id) : undefined
      if (!a) return { ok: false, code: 'notFound', message: 'unknownId' }
      shell.showItemInFolder(a.path)
      return { ok: true, value: undefined }
    },
    artifactThumb: async (id) => {
      const a = typeof id === 'string' ? artifacts.get(id) : undefined
      if (!a || (a.kind !== 'image' && a.kind !== 'html')) return null
      const key = `${a.id}:${a.mtime}`
      const hit = thumbs.get(key)
      if (hit !== undefined) return hit
      // Quick Look thumbnail (async, off the main thread; handles SVG and renders HTML without running it)
      const url = await nativeImage
        .createThumbnailFromPath(a.path, { width: 256, height: 256 })
        .then((img) => (img.isEmpty() ? null : img.toDataURL()))
        .catch(() => null)
      if (thumbs.size > 1000) thumbs.clear()
      thumbs.set(key, url)
      return url
    },
    artifactPreview: async (id) => {
      const a = typeof id === 'string' ? artifacts.get(id) : undefined
      if (!a)
        return { id: String(id), kind: 'binary', size: 0, truncated: false, error: 'unknownId' }
      return preview(a)
    },
    // ---- Settings and library setup
    configGet: async () => W.configView(home, fixture),
    configSet: async (patch) => {
      const r = W.wrap(() => {
        W.configSet(home, (patch ?? {}) as Partial<AppConfig>)
        return W.configView(home, fixture)
      })
      // Retention settings changed → clean up with the new values (if enabled)
      if (r.ok && patch && typeof patch === 'object' && 'backupRetention' in patch)
        void runBackupCleanup()
      return r
    },
    uiPrefsSet: async (patch) => {
      const r = W.wrap(() => W.uiPrefsSet(home, (patch ?? {}) as UiPrefsPatch))
      if (r.ok)
        for (const w of BrowserWindow.getAllWindows())
          w.webContents.send('api:uiPrefsEvent', r.value)
      return r
    },
    toolsInUseGet: async () => W.toolsInUseView(home, await envNow()),
    toolsInUseSet: async (tools, retiring) => {
      const env = await envNow()
      return W.wrap(() => {
        W.toolsInUseSet(home, tools as ToolId[] | null, retiring as ToolId[] | undefined)
        return W.toolsInUseView(home, env)
      })
    },
    detectTools: async () => detectTools(home, await envNow()),
    traySet: async (state) => updateTray(state as TrayState),
    traySessions: async () => traySessions(),
    trayCommand: async (c) => trayCommand(c as TrayCommand),
    appVersion: async () => app.getVersion(),
    updateStatus: async () => updateAvailable(),
    updateCheckNow: async () => checkForUpdate(home, true),
    updateOpenTerminal: async () => {
      try {
        await openUpgradeInTerminal()
        return { ok: true, value: null }
      } catch (e) {
        return { ok: false, message: (e as Error).message }
      }
    },
    updateSkip: async (version) =>
      W.wrap(() => {
        W.configSet(home, { updateSkip: String(version) })
        clearUpdate()
        return null
      }),
    pickDirectory: async (current) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const opts = {
        properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
        ...(typeof current === 'string' && current ? { defaultPath: current } : {})
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
    },
    // ---- Workspaces
    workspaces: async () => W.workspaces(home),
    workspaceCreate: async (name, from) =>
      W.wrap(() => {
        W.markSelfWrite(3000)
        return W.workspaceCreate(home, str(name), from === 'current' ? 'current' : 'empty')
      }),
    workspaceRename: async (id, name) => W.wrap(() => W.workspaceRename(home, str(id), str(name))),
    workspaceDelete: async (id) =>
      W.wrap(() => {
        W.markSelfWrite(3000)
        return W.workspaceDelete(home, str(id))
      }),
    workspaceSwitchPreview: async (id) => {
      const origin = captureWorkspace(home)
      const env = await envNow()
      const r = W.wrap(() => {
        assertWorkspaceCurrent(home, origin)
        if (!W.workspaces(home).some((w) => w.id === str(id)))
          throw Object.assign(new Error('Workspace no longer exists'), { code: 'notFound' })
        return W.workspaceSwitchPreview(home, env, str(id))
      })
      if (r.ok) switchPreviews.set(str(id), origin)
      return r
    },
    workspaceSwitch: async (id, apply) => {
      const origin = captureWorkspace(home)
      const env = await envNow()
      W.markSelfWrite(5000)
      const r = W.wrap(() => {
        assertWorkspaceCurrent(home, origin)
        if (apply !== false) {
          const preview = switchPreviews.get(str(id))
          if (!preview)
            throw Object.assign(new Error('Review the workspace switch preview first'), {
              code: 'previewRequired'
            })
          assertWorkspaceCurrent(home, preview)
        }
        return W.workspaceSwitch(home, str(id))
      })
      if (!r.ok) return r
      advanceWorkspaceRevision('switch')
      switchPreviews.clear()
      reattachLibraryWatch()
      // apply=false (first run): switch only, the apply preview follows
      if (apply === false) return { ok: true, value: W.syncStatus() }
      // Confirming the switch is the apply approval — align tools to the new workspace even if auto-apply is off
      const sync = W.syncNow(home, env, true)
      W.markSelfWrite(3000)
      return { ok: true, value: sync }
    },
    workspaceExport: async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const opts = {
        defaultPath: join(app.getPath('downloads'), W.workspaceExportFileName(home)),
        filters: [{ name: 'Illithid', extensions: ['zip'] }]
      }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return { ok: true, value: null }
      const filePath = r.filePath
      return W.wrap(() => {
        const out = W.workspaceExportData(home, app.getVersion())
        writeFileSync(filePath, out.data, { mode: 0o600 })
        return { path: W.tildePath(home, filePath), files: out.files, skipped: out.skipped }
      })
    },
    workspaceImport: async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const opts = {
        properties: ['openFile'] as 'openFile'[],
        filters: [{ name: 'Illithid', extensions: ['zip'] }]
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const file = r.canceled ? undefined : r.filePaths[0]
      if (!file) return { ok: true, value: null }
      return W.wrap(() => {
        // Check file size before reading (reject if even the compressed file exceeds the limit)
        if (statSync(file).size > 50 * 1024 * 1024)
          throw Object.assign(new Error('file is too large'), { code: 'tooLarge' })
        W.markSelfWrite(3000)
        return W.workspaceImportData(home, new Uint8Array(readFileSync(file)))
      })
    },
    libraryInit: async (path, importLegacy) => {
      const env = await envNow()
      W.markSelfWrite(3000)
      const r = W.wrap(() =>
        W.libraryInitRun(home, typeof path === 'string' && path ? path : undefined, !!importLegacy)
      )
      if (!r.ok) return r
      const sync = W.syncNow(home, env)
      W.markSelfWrite(3000)
      return { ...r, sync }
    },
    // ---- Library writes (+ immediate sync)
    toggle: async (kind, name, tool, on) =>
      libWrite(() => W.lib.toggle(home, kind as ManifestKind, str(name), tool as ToolId, !!on)),
    ruleRead: async (name) => W.wrap(() => W.lib.ruleRead(home, str(name))),
    ruleSave: async (name, content) =>
      libWrite(() => W.lib.ruleSave(home, str(name), str(content))),
    ruleCreate: async (name, content, description) =>
      libWrite(() =>
        W.lib.ruleCreate(
          home,
          str(name),
          str(content),
          typeof description === 'string' ? description : undefined
        )
      ),
    ruleDescriptionSave: async (name, text) =>
      libWrite(() => W.lib.ruleDescriptionSave(home, str(name), str(text))),
    ruleDelete: async (name) => libWrite(() => W.lib.ruleDelete(home, str(name))),
    ruleRename: async (from, to) => libWrite(() => W.lib.ruleRename(home, str(from), str(to))),
    skillFiles: async (name) => W.wrap(() => W.lib.skillFiles(home, str(name))),
    skillFileRead: async (name, rel) =>
      W.wrap(() => W.lib.skillFileRead(home, str(name), str(rel))),
    skillFileSave: async (name, rel, content) =>
      libWrite(() => W.lib.skillFileSave(home, str(name), str(rel), str(content))),
    skillCreate: async (name, description, body) =>
      libWrite(() =>
        W.lib.skillCreate(
          home,
          str(name),
          str(description),
          typeof body === 'string' ? body : undefined
        )
      ),
    skillDelete: async (name) => libWrite(() => W.lib.skillDelete(home, str(name))),
    skillDoc: async (name) => W.wrap(() => W.lib.skillDoc(home, str(name))),
    skillDocSave: async (name, doc) =>
      libWrite(() => W.lib.skillDocSave(home, str(name), doc as never)),
    skillRename: async (from, to) => libWrite(() => W.lib.skillRename(home, str(from), str(to))),
    agentCreate: async (name, description, body) =>
      libWrite(() =>
        W.lib.agentCreate(
          home,
          str(name),
          str(description),
          typeof body === 'string' ? body : undefined
        )
      ),
    agentDelete: async (name) => libWrite(() => W.lib.agentDelete(home, str(name))),
    agentDoc: async (name) => W.wrap(() => W.lib.agentDoc(home, str(name))),
    agentDocSave: async (name, doc) =>
      libWrite(() => W.lib.agentDocSave(home, str(name), doc as never)),
    agentRename: async (from, to) => libWrite(() => W.lib.agentRename(home, str(from), str(to))),
    mcpRead: async (name) => W.wrap(() => W.mcpRead(home, str(name))),
    mcpSave: async (name, def) => libWrite(() => W.mcpSave(home, str(name), def as never)),
    mcpDelete: async (name) => libWrite(() => W.lib.mcpDelete(home, str(name))),
    hookRead: async (name) => W.wrap(() => W.hookRead(home, str(name))),
    hookCreate: async (name, input) =>
      libWrite(() => W.lib.hookCreate(home, str(name), input as never)),
    hookSave: async (name, doc) => libWrite(() => W.lib.hookSave(home, str(name), doc as never)),
    permissionsSave: async (rules) => libWrite(() => W.lib.permissionsSave(home, rules as never)),
    scriptCreate: async (name, content) =>
      libWrite(() =>
        W.lib.scriptCreate(home, str(name), typeof content === 'string' ? content : undefined)
      ),
    scriptSave: async (name, content) =>
      libWrite(() => W.lib.scriptSave(home, str(name), str(content))),
    scriptDelete: async (name) => libWrite(() => W.lib.scriptDelete(home, str(name))),
    scriptCreateFolder: async (name, description, content) =>
      libWrite(() =>
        W.lib.scriptCreateFolder(
          home,
          str(name),
          str(description),
          typeof content === 'string' ? content : undefined
        )
      ),
    scriptFileRead: async (name, rel) =>
      W.wrap(() => W.lib.scriptFileRead(home, str(name), str(rel))),
    scriptFileSave: async (name, rel, content) =>
      libWrite(() => W.lib.scriptFileSave(home, str(name), str(rel), str(content))),
    scriptFileDelete: async (name, rel) =>
      libWrite(() => W.lib.scriptFileDelete(home, str(name), str(rel))),
    scriptInfoSave: async (name, info) =>
      libWrite(() =>
        W.lib.scriptInfoSave(
          home,
          str(name),
          info && typeof info === 'object' ? (info as Record<string, unknown>) : {}
        )
      ),
    scriptToFolder: async (name) => libWrite(() => W.lib.scriptToFolder(home, str(name))),
    scriptImportFolder: async (name, from, entry) =>
      libWrite(() =>
        W.lib.scriptImportFolder(
          home,
          str(name),
          str(from),
          typeof entry === 'string' ? entry : undefined
        )
      ),
    mcpToolInfo: async (name) => W.wrap(() => mcpToolInfo(home, str(name))),
    mcpPermissionsSave: async (name, permissions) =>
      libWrite(() => W.lib.mcpPermissionsSave(home, str(name), permissions)),
    mcpFetchTools: async (name) => {
      const g = W.libGate(home)
      if (g) return g
      try {
        const env = await envNow()
        W.markSelfWrite()
        const tools = await fetchMcpTools(home, str(name), {
          env,
          secrets: defaultSecretBackend()
        })
        W.markSelfWrite()
        scheduleAutoBackup(home)
        return { ok: true, value: tools }
      } catch (e) {
        const err = e as { code?: string; message?: string }
        return { ok: false, code: err.code ?? 'error', message: err.message ?? String(e) }
      }
    },
    scriptReveal: async (name) =>
      W.wrap(() => {
        shell.showItemInFolder(W.lib.scriptLocation(home, str(name)))
      }),
    hookConvert: async (name, tool, script) =>
      libWrite(() =>
        W.lib.hookConvert(
          home,
          str(name),
          str(tool),
          typeof script === 'string' ? script : undefined
        )
      ),
    hookDelete: async (name) => libWrite(() => W.lib.hookDelete(home, str(name))),
    hookScriptSave: async (name, file, content) =>
      libWrite(() => W.lib.hookScriptSave(home, str(name), str(file), str(content))),
    hookToolScriptCreate: async (name, tool) =>
      libWrite(() => W.lib.hookToolScriptCreate(home, str(name), str(tool))),
    hookToolScriptDrop: async (name, tool) =>
      libWrite(() => W.lib.hookToolScriptDrop(home, str(name), str(tool))),
    hookKeepCopy: async (name, tool, file) =>
      libWrite(() => W.lib.hookKeepCopy(home, str(name), str(tool), str(file))),
    memoryFiles: async () => W.wrap(() => W.lib.memoryFiles(home)),
    memoryRead: async (rel) => W.wrap(() => W.lib.memoryRead(home, str(rel))),
    memorySave: async (rel, content) =>
      libWrite(() => W.lib.memorySave(home, str(rel), str(content))),
    memoryDelete: async (rel) => libWrite(() => W.lib.memoryDelete(home, str(rel))),
    // ---- Tool auto memory. Writes use the tool write gate; promote also uses the library write path (libGate + sync)
    toolMemoryScan: () => inWorker('toolMemory', home),
    toolMemoryRead: async (slug, file) =>
      W.wrap(() => readClaudeMemoryFile(home, str(slug), str(file))),
    codexMemoryRead: async (rel, offset) =>
      W.wrap(() => readCodexMemoryFile(home, str(rel), typeof offset === 'number' ? offset : 0)),
    codexRollouts: async () => W.wrap(() => listCodexRolloutSummaries(home)),
    toolMemorySlug: async (path) => {
      const p = str(path)
        .trim()
        .replace(/^~(?=\/|$)/, home)
      return p.startsWith('/') ? claudeProjectSlug(p) : ''
    },
    toolMemoryPromote: async (slug, file, type) =>
      W.gate(home) ?? libWrite(() => promoteClaudeMemory(home, str(slug), str(file), str(type))),
    toolMemoryMove: async (slug, file, toSlug) =>
      gated(() => moveClaudeMemory(home, str(slug), str(file), str(toSlug))),
    toolMemoryTrash: async (slug, file) =>
      gated(() => trashClaudeMemory(home, str(slug), str(file))),
    importSources: async () => W.importSources(home),
    importPlan: async (sourceId) => W.wrap(() => W.importPlanView(home, str(sourceId))),
    importApply: async (sourceId, selections) =>
      libWrite(() => W.importApplyRun(home, str(sourceId), selections as never)),
    // ---- Sync
    syncStatus: async () => W.syncStatus(),
    syncNow: async () => {
      const status = W.syncNow(home, await envNow())
      runSearchIndex()
      return status
    },
    syncPending: async () => ({
      pending: await inWorker<number>('syncPending', home),
      failed: W.syncFailedCount()
    }),
    // Sidebar sync button: a user click is a one-time approval (independent of allowRealApply, which is not changed)
    syncApplyOnce: async (fingerprint) => {
      const env = await envNow()
      W.markSelfWrite(3000)
      const s = W.syncNow(home, env, true, typeof fingerprint === 'string' ? fingerprint : '')
      W.markSelfWrite(3000)
      return s
    },
    syncPreview: () => inWorker('syncPreview', home),
    importedKeep: async (item) => {
      const g = W.libGate(home)
      if (g) return g
      const env = await envNow()
      W.markSelfWrite()
      const req = (item ?? {}) as { kind?: unknown; tool?: unknown; path?: unknown }
      return W.wrap(() =>
        keepImportedOriginal(home, env, {
          kind: req.kind as never,
          tool: req.tool as ToolId,
          path: str(req.path)
        })
      )
    },
    editedRuleKeep: async (tool, name) => {
      const g = W.libGate(home)
      if (g) return g
      const env = await envNow()
      W.markSelfWrite()
      const r = W.wrap(() => adoptEditedRule(home, env, tool as ToolId, str(name)))
      W.markSelfWrite()
      return r
    },
    deleteCandidates: async (items) => {
      const env = await envNow()
      return gated(() => W.deleteCandidates(home, env, items as never))
    },
    modelSet: async (tool, key, value) =>
      gated(() => W.modelSet(home, tool as ToolId, str(key), str(value))),
    // ---- Backup (library git). Remote access only via the user-provided URL
    backupStatus: async () => backupView(),
    backupConnect: async (url) => {
      const g = W.libGate(home)
      if (g) return g
      W.markSelfWrite(5000)
      const r = fromGit(await connectBackup(home, str(url)))
      return r.ok ? { ok: true, value: await backupView() } : r
    },
    backupSnapshot: async (message) => {
      const g = W.libGate(home)
      if (g) return g
      W.markSelfWrite(5000)
      const workspaceId = activeWorkspaceId(home)
      const saved = await runSnapshot(
        home,
        typeof message === 'string' && message ? message : undefined,
        workspaceId
      )
      recordBackupResult(workspaceRoot(home, workspaceId), saved)
      return fromGit(saved)
    },
    backupHistory: async () => W.libGate(home) ?? { ok: true, value: await historySafe() },
    backupRestore: async (hash, snapshotFirst) => {
      const origin = captureWorkspace(home)
      const g = W.libGate(home)
      if (g) return g
      W.markSelfWrite(8000)
      if (snapshotFirst) {
        const s0 = fromGit(await runSnapshot(home, 'before restore'))
        if (!s0.ok) return s0
      }
      const current = W.wrap(() => assertWorkspaceCurrent(home, origin))
      if (!current.ok) return current
      const r = fromGit(await restore(home, str(hash)))
      if (!r.ok) return r
      const env = await envNow()
      const unchanged = W.wrap(() => assertWorkspaceCurrent(home, origin))
      if (!unchanged.ok) return unchanged
      advanceWorkspaceRevision()
      scheduleAutoBackup(home)
      // Apply the restored source to tools
      const sync = W.syncNow(home, env)
      W.markSelfWrite(3000)
      return { ok: true, value: sync }
    },
    backupDisconnect: async () => {
      const g = W.libGate(home)
      if (g) return g
      const r = fromGit(await disconnect(home))
      return r.ok ? { ok: true, value: await backupView() } : r
    },
    backupSetDevice: async (name) =>
      W.wrap(() => {
        W.configSet(home, { deviceName: str(name).trim() || undefined })
      }).ok
        ? { ok: true, value: await backupView() }
        : { ok: false, code: 'config', message: 'deviceName' },
    backupSetAuto: async (on) => {
      const r = W.wrap(() =>
        W.configSet(home, { autoBackup: !!on } as unknown as Partial<AppConfig>)
      )
      return r.ok ? { ok: true, value: await backupView() } : r
    },
    backupCleanupPreview: async () => {
      try {
        const p = await inWorker<CleanupPlan>('backupCleanupPlan', home)
        return { ok: true, value: { count: p.count, bytes: p.bytes } }
      } catch (e) {
        return { ok: false, code: 'cleanup', message: (e as Error).message }
      }
    },
    backupCleanupRun: async () => {
      try {
        return { ok: true, value: await runBackupCleanup(true) }
      } catch (e) {
        return { ok: false, code: 'cleanup', message: (e as Error).message }
      }
    }
  }

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(`api:${channel}`, (_event, ...args) => fn(...args))
  }
  // Synchronous on purpose: the renderer needs language and color scheme before its first render
  ipcMain.on('api:uiPrefsInitial', (event) => {
    try {
      event.returnValue = W.uiPrefsGet(home)
    } catch {
      event.returnValue = {}
    }
  })
}

/** Finish library setup and workspace migration before opening the window (so the renderer's first read never sees pre-move paths) */
export function prepareLibraryOnStart(): void {
  W.ensureLibraryOnStart(resolveHome().home)
}

/**
 * Content index (worker): sessions, then documents (artifacts + library). Only one runs at a time — a request during a run
 * triggers one more run afterwards.
 * Progress and completion are sent to all windows via api:searchIndexEvent.
 */
const searchIndex: {
  running: boolean
  again: boolean
  progress?: { done: number; total: number }
  error?: string
  lastSent: number
} = { running: false, again: false, lastSent: 0 }

async function searchIndexView(): Promise<SearchIndexView> {
  const { home } = resolveHome()
  let st: IndexStatus = { exists: false, sessions: 0, messages: 0 }
  try {
    st = await inWorker<IndexStatus>('searchStatus', home)
  } catch (e) {
    return { ...st, running: searchIndex.running, error: (e as Error).message }
  }
  return {
    ...st,
    running: searchIndex.running,
    ...(searchIndex.running && searchIndex.progress ? { progress: searchIndex.progress } : {}),
    ...(searchIndex.error ? { error: searchIndex.error } : {})
  }
}

function broadcastSearchIndex(v: SearchIndexView): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('api:searchIndexEvent', v)
}

export function runSearchIndex(): void {
  if (searchIndex.running) {
    searchIndex.again = true
    return
  }
  const { home } = resolveHome()
  searchIndex.running = true
  searchIndex.again = false
  searchIndex.progress = undefined
  const empty = { exists: true, sessions: 0, messages: 0 }
  void inWorker('searchIndex', home, [], (p) => {
    searchIndex.progress = p as { done: number; total: number }
    // Progress at most 5 times per second
    const now = Date.now()
    const { done, total } = searchIndex.progress
    if (now - searchIndex.lastSent < 200 && done < total) return
    searchIndex.lastSent = now
    if (total > 0) broadcastSearchIndex({ ...empty, running: true, progress: searchIndex.progress })
  })
    .then(
      () => {
        searchIndex.error = undefined
      },
      (e) => {
        searchIndex.error = (e as Error).message
      }
    )
    .finally(async () => {
      searchIndex.running = false
      searchIndex.progress = undefined
      broadcastSearchIndex(await searchIndexView())
      if (searchIndex.again) runSearchIndex()
    })
}

/**
 * Backup cleanup: plan in the worker, move each target to the Trash in main (never deleted permanently).
 * Automatic runs (start, settings change) only when enabled; results are logged and only failures are sent to the renderer.
 * One run at a time — a request during a run waits for it.
 */
let cleanupRun: Promise<BackupCleanupView> | null = null

export function runBackupCleanup(manual = false): Promise<BackupCleanupView> {
  const { home } = resolveHome()
  const empty: BackupCleanupView = { moved: 0, bytes: 0, failed: [] }
  if (!manual && !backupRetentionOf(home).enabled) return Promise.resolve(empty)
  if (cleanupRun) return cleanupRun
  cleanupRun = (async (): Promise<BackupCleanupView> => {
    const plan = await inWorker<CleanupPlan>('backupCleanupPlan', home)
    if (!plan.count) return empty
    const r = await applyBackupCleanup(home, plan, (p) => shell.trashItem(p))
    const view: BackupCleanupView = {
      moved: r.moved,
      bytes: r.bytes,
      failed: r.failed.map((f) => ({ path: tilde(home, f.path), reason: f.reason }))
    }
    if (r.moved) console.log(`[backup-cleanup] moved ${r.moved} to Trash (${r.bytes} bytes)`)
    if (r.failed.length) {
      console.warn(`[backup-cleanup] ${r.failed.length} failed`)
      if (!manual)
        for (const w of BrowserWindow.getAllWindows())
          w.webContents.send('api:backupCleanupEvent', view)
    }
    return view
  })().finally(() => {
    cleanupRun = null
  })
  return cleanupRun
}

/** Automatic cleanup (errors are logged only) */
export function backupCleanupOnStart(): void {
  void runBackupCleanup().catch((e) => console.warn(`[backup-cleanup] ${(e as Error).message}`))
}

/** Sync on app start (only a plan if allowRealApply is off). Writes nothing if there is no library */
export function syncOnStart(): void {
  const { home } = resolveHome()
  W.ensureLibraryOnStart(home)
  W.syncNow(home, { ...process.env })
}

/**
 * Library watch (engine watchLibrary) → sync → push to renderer. With auto backup on, snapshot 3 minutes after a change.
 * Watcher events from app writes are ignored; successful app mutations schedule their own workspace-bound backup.
 * Re-attaches when the library root changes (settings change).
 */
const AUTO_BACKUP_DEBOUNCE = 3 * 60_000
const autoBackupTimers = new Map<
  string,
  { home: string; workspaceId: string; timer: NodeJS.Timeout }
>()
const backupErrors = new Map<string, string>()
const backupInFlight = new Map<string, Promise<Awaited<ReturnType<typeof snapshot>>>>()

function recordBackupResult(root: string, result: Awaited<ReturnType<typeof snapshot>>): void {
  const error = result.ok ? result.remoteError : result.reason
  if (error) backupErrors.set(root, error)
  else backupErrors.delete(root)
}

/** Every snapshot of a workspace waits for its preceding snapshot, including manual and quit snapshots. */
function runSnapshot(
  home: string,
  message?: string,
  workspaceId = activeWorkspaceId(home)
): ReturnType<typeof snapshot> {
  const root = workspaceRoot(home, workspaceId)
  const previous = backupInFlight.get(root)
  const pending = (previous ? previous.catch(() => {}) : Promise.resolve()).then(() => {
    W.markSelfWrite(5000)
    return snapshot(home, message, { workspaceId })
  })
  backupInFlight.set(root, pending)
  void pending
    .then((r) => recordBackupResult(root, r))
    .catch((e) => backupErrors.set(root, String((e as Error).message)))
    .finally(() => {
      if (backupInFlight.get(root) === pending) backupInFlight.delete(root)
    })
  return pending
}

function scheduleAutoBackup(home: string, workspaceId = activeWorkspaceId(home)): void {
  if (!autoBackupOn(home)) return
  const root = workspaceRoot(home, workspaceId)
  const existing = autoBackupTimers.get(root)
  if (existing) clearTimeout(existing.timer)
  const fixtureDelay =
    resolveHome().fixture && process.env.ILLITHID_TEST === '1'
      ? Number(process.env.ILLITHID_TEST_BACKUP_DELAY_MS)
      : 0
  const timer = setTimeout(
    () => {
      autoBackupTimers.delete(root)
      if (!autoBackupOn(home)) return
      W.markSelfWrite(5000)
      void runSnapshot(home, 'auto backup', workspaceId).catch(() => {})
    },
    fixtureDelay > 0 ? fixtureDelay : AUTO_BACKUP_DEBOUNCE
  )
  timer.unref()
  autoBackupTimers.set(root, { home, workspaceId, timer })
}

/** On quit, flush every queued workspace so switching never loses an earlier workspace's backup. */
export async function snapshotOnQuit(): Promise<void> {
  const { home } = resolveHome()
  const queued: [string, { home: string; workspaceId: string }][] = [...autoBackupTimers.entries()]
  for (const job of autoBackupTimers.values()) clearTimeout(job.timer)
  autoBackupTimers.clear()
  await Promise.allSettled([...backupInFlight.values()])
  if (!autoBackupOn(home)) return
  const active = activeWorkspaceId(home)
  const activeRoot = workspaceRoot(home, active)
  if (!queued.some(([root]) => root === activeRoot) && W.libraryState(home).ready)
    queued.push([activeRoot, { home, workspaceId: active }])
  for (const [root, job] of queued) {
    try {
      recordBackupResult(root, await runSnapshot(job.home, 'on quit', job.workspaceId))
    } catch {
      // Never block quitting on a backup failure.
    }
  }
}

/** On app start: pull from remote (only when connected) and sync if anything changed */
export async function pullOnStartAndSync(): Promise<void> {
  const { home } = resolveHome()
  if (!W.libraryState(home).ready) return
  try {
    W.markSelfWrite(8000)
    const root = libraryRoot(home)
    const origin = captureWorkspace(home)
    const r = await pullOnStart(home)
    if (!r.ok) backupErrors.set(root, r.reason)
    else backupErrors.delete(root)
    assertWorkspaceCurrent(home, origin)
    if (r.ok && !r.skipped && r.summary) {
      const s = W.syncNow(home, { ...process.env })
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('api:syncEvent', s)
    }
  } catch {
    // Offline etc. — skip silently
  }
}

/** After a workspace switch, move the watcher to the new root without waiting for the 5s poll */
let reattach: (() => void) | null = null
function reattachLibraryWatch(): void {
  reattach?.()
}

export function startLibraryWatch(): void {
  const { home } = resolveHome()
  let watched: string | null = null
  let unsubscribe: Unsubscribe | null = null

  const broadcast = (s: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('api:syncEvent', s)
  }
  const attach = (): void => {
    const st = W.libraryState(home)
    const root = st.ready ? st.root : null
    if (root === watched) return
    unsubscribe?.()
    unsubscribe = null
    watched = root
    if (!root) return
    unsubscribe = watchLibrary(
      root,
      () => {
        if (W.isSelfWriteWindow()) return
        if (!W.libraryState(home).ready) return
        advanceWorkspaceRevision()
        broadcast(W.syncNow(home, { ...process.env }))
        scheduleAutoBackup(home)
      },
      {
        debounceMs: 800,
        onError: () => {
          unsubscribe = null
          watched = null
        }
      }
    )
  }
  attach()
  reattach = attach
  // The library location changes with workspace switches — also re-check periodically
  setInterval(attach, 5000).unref()
}
