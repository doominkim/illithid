import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { compareVersions } from '../engine/update'

/**
 * One app per userData. The running instance records its version in `<userData>/instance.json`; a newly opened instance reads it:
 * a newer build waits for the old one to quit (the old one quits on `second-instance`), anything else leaves at once and the
 * running window comes forward. Electron gives the second instance no reply, so the file is how it learns which case it is in.
 */
export const LOCK_TIMEOUT_MS = 15000
const LOCK_INTERVAL_MS = 250
const INSTANCE_FILE = 'instance.json'

/** A newer build, or a running one whose version is unknown (older builds that never wrote the file), waits for the lock */
export function shouldWaitForLock(own: string, running: string | undefined): boolean {
  return running === undefined || compareVersions(own, running) > 0
}

/** The running instance quits when the one being opened is newer; otherwise it brings its window forward */
export function decideHandoff(own: string, incoming: unknown): 'yield' | 'focus' {
  return typeof incoming === 'string' && compareVersions(incoming, own) > 0 ? 'yield' : 'focus'
}

interface Clock {
  now: () => number
  sleep: (ms: number) => Promise<void>
}
const realClock: Clock = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }

/** Retry the lock until it frees or LOCK_TIMEOUT_MS passes */
export async function waitForLock(
  tryLock: () => boolean,
  clock: Clock = realClock
): Promise<boolean> {
  const end = clock.now() + LOCK_TIMEOUT_MS
  while (clock.now() < end) {
    await clock.sleep(LOCK_INTERVAL_MS)
    if (tryLock()) return true
  }
  return false
}

export function readRunningVersion(userData: string): string | undefined {
  try {
    const v = (
      JSON.parse(readFileSync(join(userData, INSTANCE_FILE), 'utf8')) as { version?: unknown }
    ).version
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

export function writeRunningVersion(userData: string, version: string): void {
  try {
    writeFileSync(
      join(userData, INSTANCE_FILE),
      JSON.stringify({ version, pid: process.pid }) + '\n'
    )
  } catch {
    // Without the file a later instance just waits for the lock (shouldWaitForLock treats unknown as older)
  }
}
