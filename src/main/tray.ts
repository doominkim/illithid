/**
 * macOS menu bar item / Windows notification-area icon. Clicking it opens a small popover window (the renderer's `#tray` view): update, recent sessions with a
 * Copy button for each resume command, workspace, Open / Settings / Quit. A dot on the icon while changes wait to be applied.
 * The main window's renderer pushes the icon state and runs the actions that need its flows (update notice, workspace switch)
 */
import { app, BrowserWindow, Menu, nativeImage, screen, Tray, type NativeImage } from 'electron'
import { readFileSync } from 'fs'
import icon1x from '../../resources/trayTemplate.png?asset'
import icon2x from '../../resources/trayTemplate@2x.png?asset'
import pending1x from '../../resources/trayPendingTemplate.png?asset'
import pending2x from '../../resources/trayPendingTemplate@2x.png?asset'
import appIcon from '../../resources/icon.png?asset'
import { popoverPosition } from './trayPosition'
import type { TrayAction, TrayCommand, TraySession, TrayState } from '../shared/api'

const POPOVER = { width: 380, height: 480 }
const SESSION_REFRESH_MS = 5 * 60 * 1000

let tray: Tray | null = null
let state: TrayState | null = null
let popover: BrowserWindow | null = null
let hiddenAt = 0
let sessions: TraySession[] = []
let loadSessions: (() => Promise<TraySession[]>) | null = null
let showWindow: (() => BrowserWindow | null) | null = null
let loadPopover: ((w: BrowserWindow) => void) | null = null
let popoverPreload = ''

function templateImage(x1: string, x2: string): NativeImage {
  const img = nativeImage.createEmpty()
  img.addRepresentation({ scaleFactor: 1, buffer: readFileSync(x1) })
  img.addRepresentation({ scaleFactor: 2, buffer: readFileSync(x2) })
  img.setTemplateImage(true)
  return img
}

/** Windows taskbars are light or dark and don't recolour template images: the coloured app icon at 16/32 px */
function windowsImage(): NativeImage {
  const src = nativeImage.createFromPath(appIcon)
  const img = nativeImage.createEmpty()
  img.addRepresentation({ scaleFactor: 1, buffer: src.resize({ width: 16, height: 16 }).toPNG() })
  img.addRepresentation({ scaleFactor: 2, buffer: src.resize({ width: 32, height: 32 }).toPNG() })
  return img
}

const WINDOWS = process.platform === 'win32'
let plain: NativeImage | null = null
let dotted: NativeImage | null = null
let closeHintShown = false

/** Actions the main window's renderer runs (it is shown first) */
function send(a: TrayAction): void {
  const w = showWindow?.()
  if (!w) return
  const go = (): void => w.webContents.send('api:trayAction', a)
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go)
  else go()
}

function createPopover(): BrowserWindow {
  const w = new BrowserWindow({
    ...POPOVER,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: { preload: popoverPreload, sandbox: false }
  })
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  w.on('blur', () => {
    w.hide()
    hiddenAt = Date.now()
  })
  loadPopover?.(w)
  return w
}

function togglePopover(): void {
  if (!tray) return
  if (!popover || popover.isDestroyed()) popover = createPopover()
  if (popover.isVisible()) return popover.hide()
  // The click that blurred (and hid) the popover shouldn't reopen it
  if (Date.now() - hiddenAt < 250) return
  const b = tray.getBounds()
  const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
  const { x, y } = popoverPosition(b, area, POPOVER)
  popover.setPosition(x, y)
  popover.show()
  popover.focus()
  void refreshTraySessions()
}

function render(): void {
  if (!tray) return
  const s = state
  const waiting = !!s && (s.pending > 0 || s.failed > 0)
  tray.setImage(waiting ? dotted! : plain!)
  // The Windows icon has no dot: the tooltip says it
  if (WINDOWS)
    tray.setToolTip(waiting ? `Illithid — ${s!.pending + s!.failed} to apply` : 'Illithid')
}

/** Re-read recent sessions (worker scan) and send them to the popover. Failures keep the previous list */
export async function refreshTraySessions(): Promise<void> {
  if (!tray || !loadSessions) return
  try {
    sessions = await loadSessions()
    if (popover && !popover.isDestroyed()) popover.webContents.send('api:traySessions', sessions)
  } catch {
    // keep the previous list
  }
}

/** Last read list (the popover asks on load; fresh lists follow as api:traySessions) */
export function traySessions(): TraySession[] {
  return sessions
}

/** Popover buttons */
export function trayCommand(c: TrayCommand): void {
  popover?.hide()
  switch (c.kind) {
    case 'open':
      showWindow?.()
      break
    case 'quit':
      app.quit()
      break
    case 'settings':
    case 'update':
      send({ kind: c.kind })
      break
    case 'workspace':
      send({ kind: 'workspace', id: c.id })
      break
    case 'hide':
      break
  }
}

/**
 * Create the menu bar item. `show` returns the (shown) main window, `recent` lists recent sessions, `load` loads the renderer's
 * `#tray` view into the popover (dev server or file), `preload` is the preload script path
 */
export function setupTray(
  show: () => BrowserWindow | null,
  recent: () => Promise<TraySession[]>,
  load: (w: BrowserWindow) => void,
  preload: string
): void {
  if (tray) return
  showWindow = show
  loadSessions = recent
  loadPopover = load
  popoverPreload = preload
  plain = WINDOWS ? windowsImage() : templateImage(icon1x, icon2x)
  dotted = WINDOWS ? plain : templateImage(pending1x, pending2x)
  tray = new Tray(plain)
  tray.setToolTip('Illithid')
  tray.on('click', togglePopover)
  // Windows users expect a menu on right-click
  if (WINDOWS)
    tray.on('right-click', () =>
      tray?.popUpContextMenu(
        Menu.buildFromTemplate([
          { label: 'Open Illithid', click: () => trayCommand({ kind: 'open' }) },
          { label: 'Settings', click: () => trayCommand({ kind: 'settings' }) },
          { type: 'separator' },
          { label: 'Quit', click: () => trayCommand({ kind: 'quit' }) }
        ])
      )
    )
  else tray.on('right-click', togglePopover)
  render()
  setTimeout(() => void refreshTraySessions(), 5000)
  setInterval(() => void refreshTraySessions(), SESSION_REFRESH_MS)
}

/** Windows: the first time the window closes to the tray, say that the app keeps running there */
export function noteClosedToTray(): void {
  if (!WINDOWS || !tray || closeHintShown) return
  closeHintShown = true
  tray.displayBalloon({
    title: 'Illithid is still running',
    content: 'It keeps your tools in sync from the notification area. Quit it from the icon menu.',
    iconType: 'info'
  })
}

export function updateTray(next: TrayState): void {
  state = next
  render()
}
