import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspace, switchWorkspace } from '../src/engine/workspace'
import { backupStatus, connectBackup, history, pullOnStart, snapshot } from '../src/engine/backup'

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
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }
  ).trim()
}

test('expired GitHub authentication preserves a local snapshot and leaves credentials out of Git config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illithid-backup-auth-expired-'))
  const home = homeAt(root, 'local')
  await connectBackup(home, 'https://github.com/fixture-user/illithid-backup.git')
  const result = await snapshot(home, 'offline authenticated fixture', {
    auth: async () => {
      throw new Error('signInAgain')
    }
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.committed, true)
  assert.equal(result.pushed, false)
  assert.match(result.remoteError!, /signInAgain/)
  assert.equal((await history(home))[0].hash, result.hash)
  const config = readFileSync(join(home, '.illithid/workspaces/default/.git/config'), 'utf8')
  assert.equal(config.includes('extraHeader'), false)
  assert.equal(config.includes('Authorization'), false)
})

test('authenticated startup pull refuses a changed remote before fetching or changing the library', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illithid-backup-auth-mismatch-'))
  const home = homeAt(root, 'local')
  await connectBackup(home, join(root, 'unreachable.git'))
  const result = await pullOnStart(home, {
    auth: { remoteUrl: 'https://github.com/fixture-user/illithid-backup.git', token: 'ghu_fixture' }
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'invalidRemote')
  assert.equal(
    readFileSync(join(home, '.illithid/workspaces/default/rules/keep.md'), 'utf8'),
    'local content\n'
  )
})

test('startup pull preserves an existing library before its first local snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illithid-backup-preserve-'))
  const remote = join(root, 'remote.git')
  git(root, 'init', '-q', '--bare', '--initial-branch=main', remote)
  const source = homeAt(root, 'source')
  assert.equal((await connectBackup(source, remote)).ok, true)
  assert.equal((await snapshot(source, 'remote fixture')).ok, true)
  const local = homeAt(root, 'local')
  assert.equal((await connectBackup(local, remote)).ok, true)
  const pulled = await pullOnStart(local)
  assert.equal(pulled.ok, false)
  assert.equal(
    readFileSync(join(local, '.illithid/workspaces/default/rules/keep.md'), 'utf8'),
    'local content\n'
  )
  assert.equal((await history(local)).length, 0)
})

test('a failed remote push retains the successful local snapshot and explains the pending upload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illithid-backup-offline-'))
  const home = homeAt(root, 'local')
  assert.equal((await connectBackup(home, join(root, 'missing-remote.git'))).ok, true)
  const saved = await snapshot(home, 'local fixture')
  assert.equal(saved.ok, true)
  if (!saved.ok) return
  assert.equal(saved.committed, true)
  assert.equal(saved.pushed, false)
  assert.match(saved.hash, /^[a-f0-9]{40}$/)
  assert.ok(saved.remoteError)
  assert.equal((await history(home))[0].hash, saved.hash)
  assert.equal((await backupStatus(home)).dirty, false)
})

test('a local snapshot without a remote branch remains pending in backup status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illithid-backup-pending-'))
  const home = homeAt(root, 'local')
  await connectBackup(home, join(root, 'missing-remote.git'))
  await snapshot(home, 'local fixture')
  const status = await backupStatus(home)
  assert.equal(status.dirty, false)
  assert.equal(status.ahead, 1)
})

test('a queued snapshot stays bound to its originating workspace after switching', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illithid-backup-workspace-'))
  const home = homeAt(root, 'local')
  await connectBackup(home, join(root, 'missing-remote.git'))
  const second = createWorkspace(home, 'Second', { from: 'empty' })
  switchWorkspace(home, second.id)
  const saved = await snapshot(home, 'queued fixture', { workspaceId: 'default' })
  assert.equal(saved.ok, true)
  assert.equal((await history(home)).length, 0)
  switchWorkspace(home, 'default')
  assert.equal((await history(home))[0].message, 'queued fixture')
})

test('startup pull preserves existing ignored files in an unborn local repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illithid-backup-ignored-'))
  const remote = join(root, 'remote.git')
  git(root, 'init', '-q', '--bare', '--initial-branch=main', remote)
  const source = homeAt(root, 'source')
  await connectBackup(source, remote)
  await snapshot(source, 'remote fixture')
  const local = homeAt(root, 'local')
  await connectBackup(local, remote)
  const library = join(local, '.illithid/workspaces/default')
  writeFileSync(join(library, '.gitignore'), '*\n')
  assert.equal(git(library, 'status', '--porcelain'), '')
  const pulled = await pullOnStart(local)
  assert.equal(pulled.ok, false)
  assert.equal(readFileSync(join(library, 'rules/keep.md'), 'utf8'), 'local content\n')
})

test('an empty library with only generated exclusions and empty directories can fetch an existing backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'illithid-backup-empty-'))
  const remote = join(root, 'remote.git')
  git(root, 'init', '-q', '--bare', '--initial-branch=main', remote)
  const source = homeAt(root, 'source')
  await connectBackup(source, remote)
  const saved = await snapshot(source, 'remote fixture')
  assert.equal(saved.ok, true)
  const local = join(root, 'empty')
  const library = join(local, '.illithid/workspaces/default')
  mkdirSync(join(library, 'rules/empty'), { recursive: true })
  mkdirSync(join(library, 'skills'), { recursive: true })
  await connectBackup(local, remote)
  const pulled = await pullOnStart(local)
  assert.equal(pulled.ok, true)
  assert.equal(readFileSync(join(library, 'rules/keep.md'), 'utf8'), 'source content\n')
  assert.equal((await history(local))[0].hash, saved.ok ? saved.hash : '')
})
