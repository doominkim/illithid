import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  backupStatus,
  connectBackup,
  history,
  pullFromRemote,
  snapshot
} from '../src/engine/backup'

function homeAt(root: string, name: string): string {
  const home = join(root, name)
  mkdirSync(join(home, '.illithid/workspaces/default/rules'), { recursive: true })
  writeFileSync(join(home, '.illithid/workspaces/default/rules/keep.md'), `${name} content\n`)
  return home
}

function git(cwd: string, ...args: string[]): string {
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
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

/** A bare remote that already holds `count` snapshots from another device */
async function remoteWithSnapshots(root: string, count: number): Promise<string> {
  const remote = join(root, 'remote.git')
  git(root, 'init', '-q', '--bare', '--initial-branch=main', remote)
  const source = homeAt(root, 'source')
  assert.equal((await connectBackup(source, remote)).ok, true)
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(source, `.illithid/workspaces/default/rules/keep.md`), `source v${i}\n`)
    const saved = await snapshot(source, `remote snapshot ${i}`)
    assert.equal(saved.ok && saved.pushed, true)
  }
  return remote
}

test('connecting fetches the remote so a fresh device sees how many snapshots it is behind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illithid-backup-pull-behind-'))
  const remote = await remoteWithSnapshots(root, 2)
  const local = homeAt(root, 'local')
  const connected = await connectBackup(local, remote)
  assert.equal(connected.ok, true)
  if (!connected.ok) return
  assert.deepEqual(connected.remote, { reachable: true, snapshots: 2 })
  const status = await backupStatus(local)
  assert.equal(status.lastSnapshot, undefined)
  assert.equal(status.behind, 2)
  assert.equal(
    readFileSync(join(local, '.illithid/workspaces/default/rules/keep.md'), 'utf8'),
    'local content\n'
  )
})

test('connecting to an unreachable remote still saves the connection and says so', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illithid-backup-pull-unreachable-'))
  const local = homeAt(root, 'local')
  const connected = await connectBackup(local, join(root, 'missing.git'))
  assert.equal(connected.ok, true)
  if (!connected.ok) return
  assert.equal(connected.remote.reachable, false)
  assert.equal(connected.remote.snapshots, 0)
  assert.ok(connected.remote.error)
  assert.equal((await backupStatus(local)).remoteUrl, join(root, 'missing.git'))
})

test('pulling onto an unsaved local library is refused until the user confirms the replacement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illithid-backup-pull-refuse-'))
  const remote = await remoteWithSnapshots(root, 1)
  const local = homeAt(root, 'local')
  await connectBackup(local, remote)
  const pulled = await pullFromRemote(local)
  assert.equal(pulled.ok, false)
  if (!pulled.ok) assert.equal(pulled.reason, 'localUnsaved')
  assert.equal(
    readFileSync(join(local, '.illithid/workspaces/default/rules/keep.md'), 'utf8'),
    'local content\n'
  )
  assert.equal((await history(local)).length, 0)
})

test('a confirmed pull adopts the remote history, keeps local-only files and backs up what it overwrote', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illithid-backup-pull-adopt-'))
  const remote = await remoteWithSnapshots(root, 2)
  const local = homeAt(root, 'local')
  const library = join(local, '.illithid/workspaces/default')
  writeFileSync(join(library, 'rules/local-only.md'), 'only here\n')
  await connectBackup(local, remote)
  const pulled = await pullFromRemote(local, { replaceLocal: true })
  assert.equal(pulled.ok, true)
  if (!pulled.ok) return
  assert.equal(pulled.merged, 'adopted')
  // Remote content wins where names collide; the previous local file is copied aside, not lost
  assert.equal(readFileSync(join(library, 'rules/keep.md'), 'utf8'), 'source v2\n')
  assert.ok(pulled.backupPath)
  assert.equal(readFileSync(join(pulled.backupPath!, 'rules/keep.md'), 'utf8'), 'local content\n')
  assert.equal(existsSync(join(pulled.backupPath!, '.git')), false)
  // Local-only files stay and ride on top of the remote history as one commit
  assert.equal(readFileSync(join(library, 'rules/local-only.md'), 'utf8'), 'only here\n')
  const log = await history(local)
  assert.equal(log.length, 3)
  assert.equal(log[1].message, 'remote snapshot 2')
  const status = await backupStatus(local)
  assert.equal(status.dirty, false)
  assert.equal(status.behind, 0)
  assert.equal(status.ahead, 1)
  // The next snapshot uploads without any history conflict
  const saved = await snapshot(local, 'after pull')
  assert.equal(saved.ok && saved.pushed, true)
  assert.equal((await backupStatus(local)).ahead, 0)
  assert.equal(readdirSync(join(local, '.config/illithid/backups/replaced')).length, 1)
})

test('unrelated local snapshots are joined to the remote history by a merge, never discarded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illithid-backup-pull-merge-'))
  const remote = await remoteWithSnapshots(root, 1)
  const local = homeAt(root, 'local')
  const library = join(local, '.illithid/workspaces/default')
  // This device already snapshotted on its own (e.g. before the remote was connected)
  await connectBackup(local, join(root, 'nowhere.git'))
  const own = await snapshot(local, 'local snapshot')
  assert.equal(own.ok, true)
  writeFileSync(join(library, 'rules/draft.md'), 'unsaved draft\n')
  await connectBackup(local, remote)
  assert.equal((await pullFromRemote(local)).ok, false)
  const pulled = await pullFromRemote(local, { replaceLocal: true })
  assert.equal(pulled.ok, true)
  if (!pulled.ok) return
  assert.equal(pulled.merged, 'merged')
  assert.equal(readFileSync(join(library, 'rules/keep.md'), 'utf8'), 'source v1\n')
  assert.equal(readFileSync(join(library, 'rules/draft.md'), 'utf8'), 'unsaved draft\n')
  assert.equal(readFileSync(join(pulled.backupPath!, 'rules/keep.md'), 'utf8'), 'local content\n')
  const parents = git(library, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')
  assert.equal(parents.length, 3)
  assert.ok((await history(local)).some((h) => h.hash === (own.ok ? own.hash : '')))
  const saved = await snapshot(local, 'after merge')
  assert.equal(saved.ok && saved.pushed, true)
  assert.equal((await backupStatus(local)).ahead, 0)
})

test('a remote that is simply ahead fast-forwards without confirmation or a backup copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illithid-backup-pull-ff-'))
  const remote = join(root, 'remote.git')
  git(root, 'init', '-q', '--bare', '--initial-branch=main', remote)
  const a = homeAt(root, 'a')
  await connectBackup(a, remote)
  assert.equal((await snapshot(a, 'first')).ok, true)
  const b = join(root, 'b')
  mkdirSync(join(b, '.illithid/workspaces/default'), { recursive: true })
  await connectBackup(b, remote)
  assert.equal((await pullFromRemote(b)).ok, true)
  writeFileSync(join(a, '.illithid/workspaces/default/rules/keep.md'), 'a v2\n')
  assert.equal((await snapshot(a, 'second')).ok, true)
  assert.equal((await backupStatus(b)).behind, 0) // not fetched yet
  const pulled = await pullFromRemote(b)
  assert.equal(pulled.ok, true)
  if (!pulled.ok) return
  assert.equal(pulled.merged, 'ff')
  assert.equal(pulled.backupPath, undefined)
  assert.equal(
    readFileSync(join(b, '.illithid/workspaces/default/rules/keep.md'), 'utf8'),
    'a v2\n'
  )
  const again = await pullFromRemote(b)
  assert.equal(again.ok && again.merged, 'upToDate')
})
