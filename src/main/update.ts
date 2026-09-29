/**
 * New version notice: checks the latest GitHub release once shortly after start, then daily and when a window gains focus at least
 * 30 minutes after the last check (packaged app only, unless
 * ILLITHID_UPDATE_CHECK=1; a dev run can pretend to be an older version with ILLITHID_UPDATE_FROM=x.y.z and force the install kind
 * with ILLITHID_UPDATE_INSTALL=brew|dmg). A newer version that
 * isn't skipped is kept here, sent to the window and shown in the menu bar
 */
import { app, BrowserWindow, shell } from 'electron'
import { chmodSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readConfig } from '../engine/config'
import type { FetchFn } from '../engine/market/http'
import { BREW_UPGRADE, compareVersions, installKind, latestUpdate } from '../engine/update'
import type { UpdateView } from '../shared/api'

const FIRST_DELAY_MS = 10_000
const APP_BUNDLE_ID = 'com.illithid.app'
const INTERVAL_MS = 24 * 60 * 60 * 1000
/** Focusing a window checks again once this long has passed since the last check */
const FOCUS_MIN_GAP_MS = 30 * 60 * 1000
const fetchFn: FetchFn = (url, init) => fetch(url, init)

let available: UpdateView | null = null
/** When the last check started (0 = never) */
let lastCheckAt = 0

function currentVersion(): string {
  const from = process.env['ILLITHID_UPDATE_FROM']
  return !app.isPackaged && from ? from : app.getVersion()
}
const listeners: ((v: UpdateView | null) => void)[] = []

function publish(v: UpdateView | null): void {
  available = v
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('api:updateEvent', v)
  for (const f of listeners) f(v)
}

/** Current notice (null = up to date, skipped, checks off, or not checked yet) */
export function updateAvailable(): UpdateView | null {
  return available
}

export function onUpdateChange(f: (v: UpdateView | null) => void): void {
  listeners.push(f)
}

/** One check. Automatic checks never throw (offline, rate limits: the next check tries again); Check now does */
export async function checkForUpdate(home: string, explicit = false): Promise<UpdateView | null> {
  lastCheckAt = Date.now()
  const cfg = readConfig(home).config
  // Check now in Settings runs even with automatic checks off, and shows a skipped version too
  if (cfg.updateCheck === false && !explicit) {
    publish(null)
    return null
  }
  try {
    const u = await latestUpdate(fetchFn, currentVersion())
    const skipped = !explicit && !!u && !!cfg.updateSkip && compareVersions(u.version, cfg.updateSkip) <= 0
    const forced = process.env['ILLITHID_UPDATE_INSTALL']
    const install = !app.isPackaged && (forced === 'brew' || forced === 'dmg') ? forced : installKind()
    publish(u && !skipped ? { ...u, current: currentVersion(), install, command: install === 'brew' ? BREW_UPGRADE : null } : null)
  } catch (e) {
    // keep the previous result; Check now reports the failure
    if (explicit) throw e
  }
  return available
}

/** Drop the notice (after skipping a version or turning checks off) */
export function clearUpdate(): void {
  publish(null)
}

export function startUpdateCheck(home: string): void {
  if (!app.isPackaged && process.env['ILLITHID_UPDATE_CHECK'] !== '1') return
  setTimeout(() => {
    void checkForUpdate(home)
    setInterval(() => void checkForUpdate(home), INTERVAL_MS)
  }, FIRST_DELAY_MS)
  // The app often stays open for days: opening a window (main or menu bar popover) checks again after a while
  app.on('browser-window-focus', () => {
    if (lastCheckAt && Date.now() - lastCheckAt >= FOCUS_MIN_GAP_MS) void checkForUpdate(home)
  })
}

/**
 * Homebrew installs: open Terminal running the upgrade, then quit so the running copy isn't the old version. The script waits for
 * the app to exit, upgrades, and opens the new version. A .command file is opened rather than scripting Terminal, so no
 * automation permission is asked. The commands are fixed here, nothing comes from the release
 */
export async function openUpgradeInTerminal(): Promise<void> {
  const file = join(tmpdir(), 'illithid-upgrade.command')
  const script = [
    '#!/bin/zsh -l',
    '# Wait up to 30s for Illithid to quit',
    'for i in {1..60}; do pgrep -xq Illithid || break; sleep 0.5; done',
    `${BREW_UPGRADE} && open -b ${APP_BUNDLE_ID}`,
    ''
  ].join('\n')
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  const err = await shell.openPath(file)
  if (err) throw new Error(err)
  setTimeout(() => app.quit(), 500)
}
