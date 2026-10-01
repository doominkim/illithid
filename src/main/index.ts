import { app, shell, BrowserWindow } from 'electron'
import { refreshTraySessions, setupTray } from './tray'
import { startUpdateCheck } from './update'
import { cpSync, existsSync } from 'fs'
import { basename, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { shellEnvReady } from './shellEnv'
import {
  decideHandoff,
  readRunningVersion,
  shouldWaitForLock,
  waitForLock,
  writeRunningVersion
} from './singleInstance'
import {
  backupCleanupOnStart,
  prepareLibraryOnStart,
  pullOnStartAndSync,
  recentSessions,
  registerIpc,
  resolveHome,
  runSearchIndex,
  snapshotOnQuit,
  startLibraryWatch,
  syncOnStart
} from './ipc'

/** userData folder names from previous app names (`<appData>/<name>`, most recent first) */
const LEGACY_USER_DATA_DIRS = ['harnesssync']

// Lets the screenshot script use a temp directory instead of the real userData (~/Library/Application Support)
if (process.env['ILLITHID_USER_DATA']) {
  app.setPath('userData', process.env['ILLITHID_USER_DATA'])
} else {
  migrateUserData()
}

/**
 * Copies userData from the previous app name (`<appData>/harnesssync`, localStorage and window state) to the new userData.
 * Only when the new userData is missing (on case-insensitive filesystems, a folder differing only in case counts as existing).
 * The old folder is not deleted. Runtime lock files (Singleton*) are not copied
 */
function migrateUserData(): void {
  try {
    const dest = app.getPath('userData')
    if (existsSync(dest)) return
    for (const name of LEGACY_USER_DATA_DIRS) {
      const src = join(app.getPath('appData'), name)
      if (!existsSync(src)) continue
      cpSync(src, dest, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
        filter: (from) => !basename(from).startsWith('Singleton')
      })
      return
    }
  } catch {
    // Copy failed — start with a fresh userData (language and color settings fall back to defaults)
  }
}

/** Automated test (playwright) mode: keep the window hidden from the user and do not steal focus */
const TEST_MODE = process.env['ILLITHID_TEST'] === '1'

// macOS: even with the window hidden, activating the app takes the menu bar and focus.
// In test mode, launch as an accessory app without a Dock icon so it never activates.
if (TEST_MODE && process.platform === 'darwin') {
  app.setActivationPolicy('accessory')
  app.dock?.hide()
}

/** Version used for the single-instance handoff; tests may pose as a newer build */
const VERSION = (TEST_MODE && process.env['ILLITHID_TEST_VERSION']) || app.getVersion()

/**
 * One app per userData, so a new build opened while the old one sits in the menu bar does not start a second instance with
 * empty Chromium storage. A newer build takes over (the running one quits); anything else brings the running window forward.
 * `npm run dev` skips it: it shares userData with the installed app at the same version and would close right away.
 */
const DEV_SERVER = is.dev && !!process.env['ELECTRON_RENDERER_URL']
async function acquireSingleInstance(): Promise<boolean> {
  if (DEV_SERVER) return true
  const data = { version: VERSION }
  if (app.requestSingleInstanceLock(data)) return true
  if (!shouldWaitForLock(VERSION, readRunningVersion(app.getPath('userData')))) return false
  return waitForLock(() => app.requestSingleInstanceLock(data))
}

/** macOS outside tests: closing the window hides it and the app stays in the menu bar (Cmd+Q quits) */
const MENU_BAR = process.platform === 'darwin' && !TEST_MODE
let mainWindow: BrowserWindow | null = null
let quitting = false

/** Show the main window (re-created if it was destroyed) and bring the Dock icon back */
function showMainWindow(): BrowserWindow | null {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  const w = mainWindow
  if (!w) return null
  if (MENU_BAR) void app.dock?.show()
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  return w
}

function createWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    ...(TEST_MODE ? { skipTaskbar: true, focusable: false, x: -4000, y: -4000 } : {}),
    // macOS: hide the title bar and keep only the traffic lights (the renderer provides a top drag region)
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
      : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // offscreen so rendering and screenshots work even with the window hidden
      ...(TEST_MODE ? { offscreen: true } : {})
    }
  })

  const win = mainWindow
  win.webContents.on('before-input-event', (event, input) => {
    if (
      input.type !== 'keyDown' ||
      input.alt ||
      !(process.platform === 'darwin' ? input.meta : input.control)
    )
      return
    const action =
      input.code === 'Minus' || input.code === 'NumpadSubtract' || input.key === '-'
        ? -1
        : input.code === 'Equal' ||
            input.code === 'NumpadAdd' ||
            input.key === '+' ||
            input.key === '='
          ? 1
          : input.code === 'Digit0' || input.code === 'Numpad0'
            ? 0
            : null
    if (action === null) return
    event.preventDefault()
    win.webContents.setZoomLevel(
      action === 0 ? 0 : Math.max(-3, Math.min(3, win.webContents.getZoomLevel() + action))
    )
  })
  win.on('ready-to-show', () => {
    if (!TEST_MODE) win.show()
  })
  // Close hides; the renderer keeps running so the menu bar item stays current
  win.on('close', (e) => {
    if (!MENU_BAR || quitting) return
    e.preventDefault()
    win.hide()
    app.dock?.hide()
    void refreshTraySessions()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Keep link clicks inside previews from navigating the app window away
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (is.dev && devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
void acquireSingleInstance().then((locked) => {
  if (!locked) {
    app.exit(0)
    return
  }
  if (!DEV_SERVER) writeRunningVersion(app.getPath('userData'), VERSION)
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    if (quitting) return
    if (decideHandoff(VERSION, (data as { version?: unknown } | null)?.version) === 'yield')
      app.quit()
    else showMainWindow()
  })
  void app.whenReady().then(startApp)
})

function startApp(): void {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.illithid.app')
  // Dev builds run inside the stock Electron bundle; show the app icon in the Dock anyway
  if (process.platform === 'darwin' && is.dev && !TEST_MODE) app.dock?.setIcon(icon)

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Finder/Dock launches lack the shell's variables; sync waits for them, the window does not
  const envReady = shellEnvReady()
  registerIpc()
  prepareLibraryOnStart()
  createWindow()
  if (MENU_BAR)
    setupTray(
      showMainWindow,
      () => recentSessions(10),
      (w) => {
        if (is.dev && process.env['ELECTRON_RENDERER_URL'])
          void w.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#tray`)
        else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'tray' })
      },
      join(__dirname, '../preload/index.js')
    )
  if (!TEST_MODE) startUpdateCheck(resolveHome().home)
  // Sync source -> tools once right after startup (deferred so it does not block showing the window)
  setTimeout(() => {
    void envReady.then(() => {
      syncOnStart()
      backupCleanupOnStart()
      startLibraryWatch()
      void pullOnStartAndSync()
    })
  }, 500)
  // Content index (worker scans sessions and documents -> incremental index). Slightly delayed to avoid overlapping window display and first reads
  setTimeout(runSearchIndex, 3000)

  // Auto backup on quit (once; quits for real when done). Also lets the hidden window close for real
  app.on('before-quit', (e) => {
    if (quitting) return
    quitting = true
    e.preventDefault()
    void snapshotOnQuit().finally(() => app.quit())
  })

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (MENU_BAR) showMainWindow()
    else if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
