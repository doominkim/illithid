/**
 * New version notice: checks the latest GitHub release once shortly after start and then daily (packaged app only, unless
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
const INTERVAL_MS = 24 * 60 * 60 * 1000
const fetchFn: FetchFn = (url, init) => fetch(url, init)

let available: UpdateView | null = null

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

/** One check. Never throws (offline, rate limits: the next check tries again) */
export async function checkForUpdate(home: string): Promise<UpdateView | null> {
  const cfg = readConfig(home).config
  if (cfg.updateCheck === false) {
    publish(null)
    return null
  }
  try {
    const u = await latestUpdate(fetchFn, currentVersion())
    const skipped = !!u && !!cfg.updateSkip && compareVersions(u.version, cfg.updateSkip) <= 0
    const forced = process.env['ILLITHID_UPDATE_INSTALL']
    const install = !app.isPackaged && (forced === 'brew' || forced === 'dmg') ? forced : installKind()
    publish(u && !skipped ? { ...u, current: currentVersion(), install, command: install === 'brew' ? BREW_UPGRADE : null } : null)
  } catch {
    // keep the previous result
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
}

/**
 * Homebrew installs: open Terminal running the upgrade command. A .command file is opened rather than scripting Terminal,
 * so no automation permission is asked. The command is the fixed BREW_UPGRADE, nothing from the release
 */
export async function openUpgradeInTerminal(): Promise<void> {
  const file = join(tmpdir(), 'illithid-upgrade.command')
  writeFileSync(file, `#!/bin/zsh -l\n${BREW_UPGRADE}\n`)
  chmodSync(file, 0o755)
  const err = await shell.openPath(file)
  if (err) throw new Error(err)
}
