/**
 * macOS menu bar item. Clicking it opens a small popover window (the renderer's `#tray` view): update, recent sessions with a
 * Copy button for each resume command, workspace, Open / Settings / Quit. A dot on the icon while changes wait to be applied.
 * The main window's renderer pushes the icon state and runs the actions that need its flows (update notice, workspace switch)
 */
import { app, BrowserWindow, nativeImage, screen, Tray, type NativeImage } from 'electron'
import { readFileSync } from 'fs'
import icon1x from '../../resources/trayTemplate.png?asset'
import icon2x from '../../resources/trayTemplate@2x.png?asset'
import pending1x from '../../resources/trayPendingTemplate.png?asset'
import pending2x from '../../resources/trayPendingTemplate@2x.png?asset'
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

let plain: NativeImage | null = null
let dotted: NativeImage | null = null

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
    type: 'panel',
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
  // Right edge under the icon's right edge, opening to the left; kept on screen
  const x = Math.round(Math.min(Math.max(b.x + b.width - POPOVER.width, area.x + 8), area.x + area.width - POPOVER.width - 8))
  popover.setPosition(x, Math.round(b.y + b.height + 4))
  popover.show()
  popover.focus()
  void refreshTraySessions()
}

function render(): void {
  if (!tray) return
  const s = state
  tray.setImage(s && (s.pending > 0 || s.failed > 0) ? dotted! : plain!)
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
  plain = templateImage(icon1x, icon2x)
  dotted = templateImage(pending1x, pending2x)
  tray = new Tray(plain)
  tray.setToolTip('Illithid')
  tray.on('click', togglePopover)
  tray.on('right-click', togglePopover)
  render()
  setTimeout(() => void refreshTraySessions(), 5000)
  setInterval(() => void refreshTraySessions(), SESSION_REFRESH_MS)
}

export function updateTray(next: TrayState): void {
  state = next
  render()
}
