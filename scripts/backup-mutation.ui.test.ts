import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { _electron as electron, type Page } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'
import type { Api } from '../src/shared/api'

declare global {
  interface Window {
    api: Api
    qaSyncEvents?: number
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@local',
      '-c',
      'commit.gpgsign=false',
      ...args
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

async function waitFor(path: string): Promise<void> {
  const until = Date.now() + 15_000
  while (!existsSync(path)) {
    assert.ok(Date.now() < until, 'the real Git operation did not reach the scheduling barrier')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function remoteAhead(home: string, connect: boolean): string {
  const root = join(home, '.illithid/workspaces/default')
  const remote = join(home, 'remote.git')
  git(home, 'init', '-q', '--bare', '--initial-branch=main', remote)
  git(root, 'push', '-q', remote, 'HEAD:main')
  const source = join(home, 'remote-source')
  git(home, 'clone', '-q', remote, source)
  writeFileSync(join(source, 'memory/race.md'), '# Remote snapshot\n')
  git(source, 'add', '-A')
  git(source, 'commit', '-q', '-m', 'remote fixture')
  git(source, 'push', '-q', 'origin', 'HEAD:main')
  if (connect) git(root, 'remote', 'add', 'origin', remote)
  return remote
}

async function launch(blockCommand = 'read-tree'): Promise<{
  app: Awaited<ReturnType<typeof electron.launch>>
  page: Page
  home: string
  hash: string
  started: string
  release: () => void
}> {
  const home = mkdtempSync(join(tmpdir(), 'illithid-backup-mutation-ui-'))
  buildDemoHome(home, { tools: 'all' })
  const config = join(home, '.config/illithid/config.json')
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, 'utf8')),
      toolsInUse: [],
      allowRealApply: false,
      marketEnabled: false,
      updateCheck: false,
      autoBackup: false,
      ui: { language: 'en' }
    })
  )
  const root = join(home, '.illithid/workspaces/default')
  const memory = join(root, 'memory/race.md')
  mkdirSync(dirname(memory), { recursive: true })
  git(root, 'init', '-q', '--initial-branch=main')
  writeFileSync(memory, '# Older snapshot\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'older fixture')
  const hash = git(root, 'rev-parse', 'HEAD')
  writeFileSync(memory, '# Current snapshot\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'current fixture')
  const bin = join(home, 'git-bin')
  mkdirSync(bin)
  const started = join(home, 'git-started')
  const released = join(home, 'git-released')
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "${blockCommand}" ]; then\n    touch '${started}'\n    i=0\n    while [ ! -f '${released}' ] && [ "$i" -lt 1500 ]; do\n      sleep 0.02\n      i=$((i + 1))\n    done\n  fi\ndone\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 }
  )
  const app = await electron.launch({
    args: [resolve(process.env.ILLITHID_UI_ENTRY ?? 'out/main/index.js')],
    env: {
      ...baseEnv(home),
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      NODE_PATH: resolve('node_modules'),
      ILLITHID_HOME: home,
      ILLITHID_TEST: '1',
      ILLITHID_QA_MCP_WAIT_PATH: join(home, 'mcp-gate'),
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-backup-mutation-ud-'))
    },
    timeout: 30_000
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.api))
  return { app, page, home, hash, started, release: () => writeFileSync(released, '') }
}

test(
  'a memory save is refused during restore and can be retried without losing the saved content',
  {
    timeout: 90_000,
    skip: process.platform === 'win32' ? 'POSIX real-Git scheduling wrapper' : false
  },
  async () => {
    const fixture = await launch()
    const { page } = fixture
    const restoring = page.evaluate((hash) => window.api.backupRestore(hash, false), fixture.hash)
    try {
      await waitFor(fixture.started)
      const saved = await page.evaluate(() =>
        window.api.memorySave('race.md', '# Saved while restoring\n')
      )
      assert.equal(
        'ok' in saved && saved.ok,
        false,
        'restore must refuse competing saves before writing'
      )
      const during = await page.evaluate(() => window.api.memoryRead('race.md'))
      assert.equal(during.ok && during.value, '# Current snapshot\n')
      fixture.release()
      const restored = await restoring
      assert.equal('ok' in restored && restored.ok, true)
      const retried = await page.evaluate(() =>
        window.api.memorySave('race.md', '# Saved after restore\n')
      )
      assert.equal('ok' in retried && retried.ok, true)
      const after = await page.evaluate(() => window.api.memoryRead('race.md'))
      assert.equal(after.ok && after.value, '# Saved after restore\n')
    } finally {
      fixture.release()
      await restoring.catch(() => {})
      await fixture.app.close()
    }
  }
)

test(
  'a confirmed remote pull refuses competing saves and releases the workspace for a retry',
  {
    timeout: 90_000,
    skip: process.platform === 'win32' ? 'POSIX real-Git scheduling wrapper' : false
  },
  async () => {
    const fixture = await launch('merge')
    const { page } = fixture
    // The initial automatic pull has no remote; attach the local fixture only after startup settles.
    await new Promise((resolve) => setTimeout(resolve, 700))
    remoteAhead(fixture.home, true)
    const pulling = page.evaluate(() => window.api.backupPull(true))
    try {
      await waitFor(fixture.started)
      const saved = await page.evaluate(() => window.api.memorySave('race.md', '# During pull\n'))
      assert.equal(
        'refused' in saved && saved.refused,
        'notAvailable',
        'pull must refuse competing saves before Git changes the files'
      )
      fixture.release()
      const pulled = await pulling
      assert.equal('ok' in pulled && pulled.ok, true)
      const remote = await page.evaluate(() => window.api.memoryRead('race.md'))
      assert.equal(remote.ok && remote.value, '# Remote snapshot\n')
      const retried = await page.evaluate(() => window.api.memorySave('race.md', '# After pull\n'))
      assert.equal('ok' in retried && retried.ok, true)
      const after = await page.evaluate(() => window.api.memoryRead('race.md'))
      assert.equal(after.ok && after.value, '# After pull\n')
    } finally {
      fixture.release()
      await pulling.catch(() => {})
      await fixture.app.close()
    }
  }
)

test(
  'the automatic pull after connecting a remote refuses competing library saves',
  {
    timeout: 90_000,
    skip: process.platform === 'win32' ? 'POSIX real-Git scheduling wrapper' : false
  },
  async () => {
    const fixture = await launch('merge')
    const { page } = fixture
    await new Promise((resolve) => setTimeout(resolve, 700))
    const remote = remoteAhead(fixture.home, false)
    const connecting = page.evaluate((url) => window.api.backupConnect(url), remote)
    try {
      await waitFor(fixture.started)
      const saved = await page.evaluate(() =>
        window.api.memorySave('race.md', '# During connection\n')
      )
      assert.equal(
        'refused' in saved && saved.refused,
        'notAvailable',
        'the automatic pull must protect its working tree'
      )
      fixture.release()
      const connected = await connecting
      assert.equal('ok' in connected && connected.ok, true)
      const content = await page.evaluate(() => window.api.memoryRead('race.md'))
      assert.equal(content.ok && content.value, '# Remote snapshot\n')
      const retried = await page.evaluate(() =>
        window.api.memorySave('race.md', '# After connection\n')
      )
      assert.equal('ok' in retried && retried.ok, true)
    } finally {
      fixture.release()
      await connecting.catch(() => {})
      await fixture.app.close()
    }
  }
)

test(
  'restore preserves a save included in an already running snapshot before replacing the library',
  {
    timeout: 90_000,
    skip: process.platform === 'win32' ? 'POSIX real-Git scheduling wrapper' : false
  },
  async () => {
    const fixture = await launch('commit')
    const { page } = fixture
    const edit = await page.evaluate(() => window.api.memorySave('race.md', '# Before snapshot\n'))
    assert.equal('ok' in edit && edit.ok, true)
    const snapshot = page.evaluate(() => window.api.backupSnapshot('saved before restore'))
    let restoring: ReturnType<Api['backupRestore']> | undefined
    try {
      await waitFor(fixture.started)
      restoring = page.evaluate((hash) => window.api.backupRestore(hash, false), fixture.hash)
      await new Promise((resolve) => setTimeout(resolve, 250))
      const pending = await page.evaluate(() => window.api.memoryRead('race.md'))
      assert.equal(
        pending.ok && pending.value,
        '# Before snapshot\n',
        'restore must wait for the earlier snapshot'
      )
      fixture.release()
      const saved = await snapshot
      assert.equal('ok' in saved && saved.ok, true)
      const restored = await restoring
      assert.equal('ok' in restored && restored.ok, true)
      if (!('ok' in saved) || !saved.ok) return
      const recovered = await page.evaluate(
        (hash) => window.api.backupRestore(hash, false),
        saved.value.hash
      )
      assert.equal('ok' in recovered && recovered.ok, true)
      const content = await page.evaluate(() => window.api.memoryRead('race.md'))
      assert.equal(content.ok && content.value, '# Before snapshot\n')
    } finally {
      fixture.release()
      await snapshot.catch(() => {})
      await restoring?.catch(() => {})
      await fixture.app.close()
    }
  }
)

test(
  'restore keeps its workspace active and refuses overlapping backup mutations',
  {
    timeout: 90_000,
    skip: process.platform === 'win32' ? 'POSIX real-Git scheduling wrapper' : false
  },
  async () => {
    const fixture = await launch()
    const { page } = fixture
    const second = await page.evaluate(() => window.api.workspaceCreate('Second', 'empty'))
    assert.equal(second.ok, true)
    if (!second.ok) return
    const restoring = page.evaluate((hash) => window.api.backupRestore(hash, false), fixture.hash)
    try {
      await waitFor(fixture.started)
      const switched = await page.evaluate(
        (id) => window.api.workspaceSwitch(id, false),
        second.value.id
      )
      assert.equal(
        switched.ok,
        false,
        'a rewrite must refuse workspace switches before changing the active root'
      )
      const workspaces = await page.evaluate(() => window.api.workspaces())
      assert.equal(workspaces.find((workspace) => workspace.active)?.id, 'default')
      const repeated = await page.evaluate(
        (hash) => window.api.backupRestore(hash, false),
        fixture.hash
      )
      assert.equal('refused' in repeated && repeated.refused, 'notAvailable')
      const pulled = await page.evaluate(() => window.api.backupPull(true))
      assert.equal('refused' in pulled && pulled.refused, 'notAvailable')
      const snapshot = await page.evaluate(() => window.api.backupSnapshot('during restore'))
      assert.equal('refused' in snapshot && snapshot.refused, 'notAvailable')
      fixture.release()
      const restored = await restoring
      assert.equal('ok' in restored && restored.ok, true)
      const after = await page.evaluate(
        (id) => window.api.workspaceSwitch(id, false),
        second.value.id
      )
      assert.equal(after.ok, true)
    } finally {
      fixture.release()
      await restoring.catch(() => {})
      await fixture.app.close()
    }
  }
)

test(
  'an MCP tool response started earlier cannot write into a workspace being restored',
  {
    timeout: 90_000,
    skip: process.platform === 'win32' ? 'POSIX real-Git scheduling wrapper' : false
  },
  async () => {
    const fixture = await launch()
    const { page } = fixture
    const signal = join(fixture.home, 'mcp-gate')
    const created = await page.evaluate(
      ({ command, server }) =>
        window.api.mcpSave('race-tools', {
          transport: 'stdio',
          command,
          args: [server],
          env: { FIXTURE_WAIT_PATH: '${ILLITHID_QA_MCP_WAIT_PATH}' }
        }),
      { command: process.execPath, server: resolve('scripts/fixtures/mcp-tools-server.mjs') }
    )
    if (!('ok' in created) || !created.ok) {
      await fixture.app.close()
      assert.fail(`The synthetic MCP fixture could not be created: ${JSON.stringify(created)}`)
    }
    const fetching = page.evaluate(() => window.api.mcpFetchTools('race-tools'))
    let restoring: ReturnType<Api['backupRestore']> | undefined
    try {
      await waitFor(`${signal}.started`)
      restoring = page.evaluate((hash) => window.api.backupRestore(hash, false), fixture.hash)
      await waitFor(fixture.started)
      writeFileSync(`${signal}.release`, '')
      const fetched = await fetching
      assert.equal(
        'ok' in fetched && fetched.ok,
        false,
        'a late MCP response must not write during restore'
      )
      const current = await page.evaluate(() => window.api.mcpRead('race-tools'))
      assert.equal(
        current.ok && (current.value.def._ as { tools?: string[] } | undefined)?.tools,
        undefined
      )
      fixture.release()
      const restored = await restoring
      assert.equal('ok' in restored && restored.ok, true)
    } finally {
      writeFileSync(`${signal}.release`, '')
      fixture.release()
      await fetching.catch(() => {})
      await restoring?.catch(() => {})
      await fixture.app.close()
    }
  }
)

test(
  'failed restores and pulls leave the workspace available for the next save',
  {
    timeout: 90_000,
    skip: process.platform === 'win32' ? 'POSIX real-Git scheduling wrapper' : false
  },
  async () => {
    const fixture = await launch()
    const { page } = fixture
    try {
      const restored = await page.evaluate(() => window.api.backupRestore('not-a-hash', false))
      assert.equal('ok' in restored && restored.ok, false)
      const afterRestore = await page.evaluate(() =>
        window.api.memorySave('race.md', '# After failed restore\n')
      )
      assert.equal('ok' in afterRestore && afterRestore.ok, true)
      const pulled = await page.evaluate(() => window.api.backupPull(true))
      assert.equal('ok' in pulled && pulled.ok, false)
      const afterPull = await page.evaluate(() =>
        window.api.memorySave('race.md', '# After failed pull\n')
      )
      assert.equal('ok' in afterPull && afterPull.ok, true)
      const content = await page.evaluate(() => window.api.memoryRead('race.md'))
      assert.equal(content.ok && content.value, '# After failed pull\n')
    } finally {
      fixture.release()
      await fixture.app.close()
    }
  }
)

test(
  'workspace metadata and tool setup cannot write through an active restore',
  {
    timeout: 90_000,
    skip: process.platform === 'win32' ? 'POSIX real-Git scheduling wrapper' : false
  },
  async () => {
    const fixture = await launch()
    const { page } = fixture
    const restoring = page.evaluate((hash) => window.api.backupRestore(hash, false), fixture.hash)
    try {
      await waitFor(fixture.started)
      const renamed = await page.evaluate(() =>
        window.api.workspaceRename('default', 'During restore')
      )
      assert.equal(renamed.ok, false, 'the workspace name is part of the restored library')
      const tools = await page.evaluate(() => window.api.toolsInUseSet(['qwen']))
      assert.equal(tools.ok, false, 'tool setup can seed toggles into the library')
      const initialized = await page.evaluate(() => window.api.libraryInit(undefined, true))
      assert.equal(
        initialized.ok,
        false,
        'library initialization and import must not race with restore'
      )
      fixture.release()
      const restored = await restoring
      assert.equal('ok' in restored && restored.ok, true)
    } finally {
      fixture.release()
      await restoring.catch(() => {})
      await fixture.app.close()
    }
  }
)

test(
  'public sync requests wait for restore while the owning restore still completes its final sync',
  {
    timeout: 90_000,
    skip: process.platform === 'win32' ? 'POSIX real-Git scheduling wrapper' : false
  },
  async () => {
    const fixture = await launch()
    const { page } = fixture
    const restoring = page.evaluate((hash) => window.api.backupRestore(hash, false), fixture.hash)
    try {
      await waitFor(fixture.started)
      const requested = await page.evaluate(() => window.api.syncNow())
      assert.ok(
        requested.errors.some((error) => error.includes('being restored or pulled')),
        'public sync must not read the changing library'
      )
      // A mismatching fingerprint prevents native writes even if the regression remains unfixed.
      const once = await page.evaluate(() =>
        window.api.syncApplyOnce('invalid-fixture-fingerprint')
      )
      assert.ok(
        once.errors.some((error) => error.includes('being restored or pulled')),
        'one-time approval must not bypass the rewrite owner'
      )
      assert.equal(requested.wrote, false)
      assert.equal(once.wrote, false)
      fixture.release()
      const restored = await restoring
      assert.equal('ok' in restored && restored.ok, true)
      if ('ok' in restored && restored.ok) assert.deepEqual(restored.value.errors, [])
    } finally {
      fixture.release()
      await restoring.catch(() => {})
      await fixture.app.close()
    }
  }
)

test(
  'library watch ignores intermediate restore writes after the self-write timeout expires',
  {
    timeout: 90_000,
    skip: process.platform === 'win32' ? 'POSIX real-Git scheduling wrapper' : false
  },
  async () => {
    const fixture = await launch()
    const { page } = fixture
    // Let the normal startup watcher attach before starting the controlled rewrite.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await page.evaluate(() => {
      window.qaSyncEvents = 0
      window.api.onSyncEvent(() => {
        window.qaSyncEvents = (window.qaSyncEvents ?? 0) + 1
      })
    })
    const restoring = page.evaluate((hash) => window.api.backupRestore(hash, false), fixture.hash)
    try {
      await waitFor(fixture.started)
      // Clock is a system boundary: expire the fixed self-write window without delaying Git for eight seconds.
      await fixture.app.evaluate(
        'globalThis.qaActualNow = Date.now; Date.now = () => globalThis.qaActualNow() + 20000'
      )
      writeFileSync(
        join(fixture.home, '.illithid/workspaces/default/memory/race.md'),
        '# Intermediate restore write\n'
      )
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const events = await page.evaluate(() => window.qaSyncEvents)
      assert.equal(
        events,
        0,
        'the rewrite lock must suppress watcher events even after the fixed timer expires'
      )
      fixture.release()
      const restored = await restoring
      assert.equal(
        'ok' in restored && restored.ok,
        true,
        'watcher activity must not invalidate the owning restore'
      )
      const content = await page.evaluate(() => window.api.memoryRead('race.md'))
      assert.equal(content.ok && content.value, '# Older snapshot\n')
    } finally {
      fixture.release()
      await restoring.catch(() => {})
      await fixture.app.close()
    }
  }
)
