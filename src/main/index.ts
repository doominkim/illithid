import { app, shell, BrowserWindow } from 'electron'
import { cpSync, existsSync } from 'fs'
import { basename, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { prepareLibraryOnStart, pullOnStartAndSync, registerIpc, runSearchIndex, snapshotOnQuit, startLibraryWatch, syncOnStart } from './ipc'

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

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
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

  mainWindow.on('ready-to-show', () => {
    if (!TEST_MODE) mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Keep link clicks inside previews from navigating the app window away
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (is.dev && devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
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

  registerIpc()
  prepareLibraryOnStart()
  createWindow()
  // Sync source -> tools once right after startup (deferred so it does not block showing the window)
  setTimeout(() => {
    syncOnStart()
    startLibraryWatch()
    void pullOnStartAndSync()
  }, 500)
  // Session content index (worker scans sessions -> incremental index). Slightly delayed to avoid overlapping window display and first reads
  setTimeout(runSearchIndex, 3000)

  // Auto backup on quit (once; quits for real when done)
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    quitting = true
    e.preventDefault()
    void snapshotOnQuit().finally(() => app.quit())
  })

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

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
