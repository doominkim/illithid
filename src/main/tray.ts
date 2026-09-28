/**
 * macOS menu bar item: switch workspace, open the window, Settings, quit. A dot on the icon while changes wait to be applied.
 * The renderer pushes the state and handles the clicks, so the menu runs the same flows as the window
 */
import { app, Menu, nativeImage, Tray, type BrowserWindow, type NativeImage } from 'electron'
import { readFileSync } from 'fs'
import icon1x from '../../resources/trayTemplate.png?asset'
import icon2x from '../../resources/trayTemplate@2x.png?asset'
import pending1x from '../../resources/trayPendingTemplate.png?asset'
import pending2x from '../../resources/trayPendingTemplate@2x.png?asset'
import type { TrayAction, TrayState } from '../shared/api'

let tray: Tray | null = null
let state: TrayState | null = null
let showWindow: (() => BrowserWindow | null) | null = null

function templateImage(x1: string, x2: string): NativeImage {
  const img = nativeImage.createEmpty()
  img.addRepresentation({ scaleFactor: 1, buffer: readFileSync(x1) })
  img.addRepresentation({ scaleFactor: 2, buffer: readFileSync(x2) })
  img.setTemplateImage(true)
  return img
}

let plain: NativeImage | null = null
let dotted: NativeImage | null = null

function send(a: TrayAction): void {
  const w = showWindow?.()
  if (!w) return
  const go = (): void => w.webContents.send('api:trayAction', a)
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go)
  else go()
}

function render(): void {
  if (!tray) return
  const s = state
  tray.setImage(s && (s.pending > 0 || s.failed > 0) ? dotted! : plain!)
  // Always English, regardless of the app language
  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Change Workspace',
      enabled: !!s?.workspaces.length,
      submenu: (s?.workspaces ?? []).map((w) => ({
        label: w.name,
        type: 'radio' as const,
        checked: w.active,
        click: () => {
          if (!w.active) send({ kind: 'workspace', id: w.id })
        }
      }))
    },
    { type: 'separator' },
    { label: 'Open Illithid', click: () => void showWindow?.() },
    { label: 'Settings', click: () => send({ kind: 'settings' }) },
    { label: 'Quit Illithid', click: () => app.quit() }
  ]
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

/** Create the menu bar item. `show` returns the (shown) main window */
export function setupTray(show: () => BrowserWindow | null): void {
  if (tray) return
  showWindow = show
  plain = templateImage(icon1x, icon2x)
  dotted = templateImage(pending1x, pending2x)
  tray = new Tray(plain)
  tray.setToolTip('Illithid')
  render()
}

export function updateTray(next: TrayState): void {
  state = next
  render()
}
