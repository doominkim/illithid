import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as engine from '../src/engine'
import {
  assertWorkspaceCurrent,
  advanceWorkspaceRevision,
  captureWorkspace
} from '../src/main/workspaceGuard'
import { buildDemoHome } from './readme-shots'
import type { SnapshotResult } from '../src/engine/backup'

const nativeRequire = createRequire(resolve('package.json'))

type SnapshotPort = (
  home: string,
  message?: string,
  opts?: { workspaceId?: string }
) => Promise<SnapshotResult>

/** Load the public IPC host with a controlled Git snapshot port and clock; no Electron or remote process is started. */
function ipcHost(
  home: string,
  snapshot: SnapshotPort,
  unbind: (root: string) => void = () => {}
): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  fireTimers: () => void
  quit: () => Promise<void>
} {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const timers = new Set<{ fire: () => void; unref: () => void }>()
  const source = readFileSync(resolve('src/main/ipc.ts'), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const exports: { registerIpc?: () => void; snapshotOnQuit?: () => Promise<void> } = {}
  const writes = {
    libGate: () => undefined,
    configView: () => ({ config: { autoBackup: true } }),
    libraryState: () => ({ ready: true, root: engine.libraryRoot(home) }),
    markSelfWrite: () => {},
    wrap: (fn: () => unknown) => {
      try {
        return { ok: true, value: fn() }
      } catch (e) {
        return { ok: false, code: 'error', message: String(e) }
      }
    },
    syncNow: () => ({}),
    syncStatus: () => ({}),
    workspaces: () => engine.listWorkspaces(home),
    workspaceSwitch: (_home: string, id: string) => engine.switchWorkspace(home, id),
    lib: { memorySave: engine.writeMemoryFile }
  }
  const modules: Record<string, unknown> = {
    electron: {
      ipcMain: {
        handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) =>
          handlers.set(channel, fn),
        on: () => {}
      },
      BrowserWindow: { getAllWindows: () => [] }
    },
    '../engine': { ...engine, snapshot },
    './writes': writes,
    './shellEnv': { shellEnvReady: async () => {} },
    './githubBackup': { githubAuthForWorkspace: () => undefined, unbindGithubBackup: unbind },
    './market': { marketHandlers: () => ({}) },
    './workspaceGuard': { assertWorkspaceCurrent, advanceWorkspaceRevision, captureWorkspace },
    './worker?nodeWorker': {
      default: () => {
        throw new Error('The backup IPC test must not run an index worker')
      }
    }
  }
  runInNewContext(compiled, {
    exports,
    require: (id: string): unknown => {
      if (id.startsWith('node:')) return nativeRequire(id)
      return modules[id] ?? {}
    },
    process: { env: { ILLITHID_HOME: home, ILLITHID_TEST: '1' } },
    setTimeout: (fire: () => void) => {
      const timer = { fire, unref: () => {} }
      timers.add(timer)
      return timer
    },
    clearTimeout: (timer: { fire: () => void; unref: () => void }) => timers.delete(timer),
    console
  })
  exports.registerIpc!()
  return {
    invoke: (channel, ...args) => handlers.get(`api:${channel}`)!(undefined, ...args),
    fireTimers: () => {
      for (const timer of [...timers]) {
        timers.delete(timer)
        timer.fire()
      }
    },
    quit: () => exports.snapshotOnQuit!()
  }
}

const saved: SnapshotResult = {
  ok: true,
  hash: 'a'.repeat(40),
  committed: true,
  pushed: false,
  message: 'fixture'
}

test('manual remote connection and disconnection remove the previous GitHub credential binding', async () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-backup-manual-binding-'))
  buildDemoHome(home, { tools: 'all' })
  const removed: string[] = []
  const host = ipcHost(
    home,
    async () => saved,
    (root) => removed.push(root)
  )
  const result = await host.invoke('backupConnect', join(home, 'local-remote.git'))
  assert.equal((result as { ok: boolean }).ok, true)
  assert.deepEqual(removed, [engine.libraryRoot(home)])
  await host.invoke('backupDisconnect')
  assert.deepEqual(removed, [engine.libraryRoot(home), engine.libraryRoot(home)])
})

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('quit waits for an in-flight snapshot in a previously active workspace', async () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-backup-ipc-'))
  buildDemoHome(home, { tools: 'all' })
  const second = engine.createWorkspace(home, 'Second', { from: 'empty' })
  let release!: (result: SnapshotResult) => void
  const pending = new Promise<SnapshotResult>((resolve) => {
    release = resolve
  })
  const started: string[] = []
  const host = ipcHost(home, async (_home, message, opts) => {
    started.push(`${opts?.workspaceId}:${message}`)
    return message === 'auto backup' ? pending : saved
  })
  await host.invoke('memorySave', 'queued.md', '# Queued\n')
  host.fireTimers()
  await settle()
  await host.invoke('workspaceSwitch', second.id, false)
  let finished = false
  const quitting = host.quit().then(() => {
    finished = true
  })
  try {
    await settle()
    assert.equal(finished, false, 'quit must wait for the earlier workspace upload to finish')
    assert.ok(started.includes('default:auto backup'))
  } finally {
    release(saved)
    await quitting
  }
  assert.equal(finished, true)
})

test('manual snapshots wait behind an in-flight automatic snapshot of the same workspace', async () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-backup-ipc-serial-'))
  buildDemoHome(home, { tools: 'all' })
  let release!: (result: SnapshotResult) => void
  const pending = new Promise<SnapshotResult>((resolve) => {
    release = resolve
  })
  const started: string[] = []
  const host = ipcHost(home, async (_home, message) => {
    started.push(message ?? '')
    return message === 'auto backup' ? pending : saved
  })
  await host.invoke('memorySave', 'queued.md', '# Queued\n')
  host.fireTimers()
  await settle()
  const manual = host.invoke('backupSnapshot', 'manual fixture')
  try {
    await settle()
    assert.deepEqual(
      started,
      ['auto backup'],
      'one workspace must have only one Git snapshot in flight'
    )
  } finally {
    release(saved)
    await manual
    await host.quit()
  }
  assert.deepEqual(started, ['auto backup', 'manual fixture', 'on quit'])
})
