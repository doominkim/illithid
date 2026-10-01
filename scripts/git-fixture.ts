/**
 * git module fixture check. Never touches the real library.
 *
 * Creates a bare remote + two clones in a temp directory and checks, in order:
 * status → commit (given paths) → push → push from the other clone → pull (ff-only) → pull refused on divergence.
 * Prints PASS/FAIL per step and exits 1 if any step fails.
 * The fixture commit identity comes only from each temp repo's local config (user.name=fixture).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitCommit, gitLog, gitPull, gitPush, gitStatus } from '../src/engine'

const ID = [
  '-c',
  'user.name=fixture',
  '-c',
  'user.email=fixture@local',
  '-c',
  'commit.gpgsign=false'
]

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...ID, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function setupClone(root: string, remote: string, name: string): string {
  const dir = join(root, name)
  execFileSync('git', ['clone', '-q', remote, dir], { stdio: 'ignore' })
  // The identity used by engine functions (simple-git) comes only from this temp repo's local config
  sh(dir, 'config', 'user.name', 'fixture')
  sh(dir, 'config', 'user.email', 'fixture@local')
  sh(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

async function run(root: string): Promise<void> {
  const remote = join(root, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', remote], {
    stdio: 'ignore'
  })

  // The initial commit is fixture setup, so it uses raw git (including upstream setup)
  const a = setupClone(root, remote, 'a')
  sh(a, 'checkout', '-q', '-b', 'main')
  writeFileSync(join(a, 'README.md'), 'fixture\n')
  writeFileSync(join(a, 'keep.txt'), 'keep\n')
  writeFileSync(join(a, 'gone.txt'), 'gone\n')
  sh(a, 'add', '.')
  sh(a, 'commit', '-q', '-m', 'initial commit')
  sh(a, 'push', '-q', '-u', 'origin', 'main')
  const b = setupClone(root, remote, 'b')

  // 1. status after changes
  writeFileSync(join(a, 'README.md'), 'fixture\nchanged\n')
  writeFileSync(join(a, 'new.txt'), 'new\n')
  unlinkSync(join(a, 'gone.txt'))
  writeFileSync(join(a, 'keep.txt'), 'keep\nlocal only\n')
  let s = await gitStatus(a)
  const byPath = new Map(s.files.map((f) => [f.path, `${f.index}${f.workingDir}`]))
  check(
    'gitStatus: detects 4 changed files',
    s.files.length === 4 &&
      byPath.get('README.md') === ' M' &&
      byPath.get('new.txt') === '??' &&
      byPath.get('gone.txt') === ' D' &&
      byPath.get('keep.txt') === ' M',
    JSON.stringify([...byPath])
  )
  check(
    'gitStatus: branch and upstream',
    s.branch === 'main' && s.upstream === 'origin/main',
    `${s.branch} / ${s.upstream}`
  )
  check('gitStatus: clean=false', !s.clean)

  // 2. input validation
  const noPaths = await gitCommit(a, 'x', [])
  check('gitCommit: refused without paths', !noPaths.ok)
  const outside = await gitCommit(a, 'x', ['../etc'])
  check('gitCommit: refuses path outside repo', !outside.ok)
  const notRoot = await gitCommit(join(a, '.git'), 'x', ['README.md'])
  check('gitCommit: refuses non-root repo path', !notRoot.ok, notRoot.ok ? '' : notRoot.reason)

  // Even if keep.txt is staged beforehand, it must not be committed when outside the given paths
  sh(a, 'add', 'keep.txt')

  // 3. commit with given paths
  const msg = 'commit with given paths'
  const c = await gitCommit(a, msg, ['README.md', 'new.txt', 'gone.txt'])
  check('gitCommit: succeeds', c.ok, c.ok ? c.hash.slice(0, 7) : c.reason)
  const committed = sh(a, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').sort()
  check(
    'gitCommit: commits only given paths (staged keep.txt excluded)',
    JSON.stringify(committed) === JSON.stringify(['A\tnew.txt', 'D\tgone.txt', 'M\tREADME.md']),
    JSON.stringify(committed)
  )
  const body = sh(a, 'log', '-1', '--format=%B').trim()
  check('gitCommit: message verbatim (no trailer)', body === msg, JSON.stringify(body))
  s = await gitStatus(a)
  check(
    'gitStatus: ahead 1 after commit',
    s.ahead === 1 && s.behind === 0,
    `ahead ${s.ahead} behind ${s.behind}`
  )
  check(
    'gitStatus: keep.txt remains',
    s.files.length === 1 && s.files[0].path === 'keep.txt',
    JSON.stringify(s.files)
  )
  // Revert the keep.txt change for later steps
  sh(a, 'checkout', '-q', 'HEAD', '--', 'keep.txt')

  // 4. push
  const p = await gitPush(a)
  check('gitPush: succeeds', p.ok, p.ok ? p.upstream : p.reason)
  const remoteHead = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], {
    encoding: 'utf8'
  }).trim()
  check('gitPush: remote main == local HEAD', remoteHead === sh(a, 'rev-parse', 'HEAD').trim())

  // 5. commit and push from the second clone
  const pullB = await gitPull(b)
  check('gitPull(b): up to date', pullB.ok, pullB.ok ? '' : pullB.reason)
  writeFileSync(join(b, 'from-b.txt'), 'b\n')
  const cb = await gitCommit(b, 'commit from b', ['from-b.txt'])
  const pb = cb.ok ? await gitPush(b) : cb
  check('clone b: commit then push', cb.ok && pb.ok, pb.ok ? '' : pb.reason)

  // 6. ff-only pull in the first clone
  const pa = await gitPull(a)
  check('gitPull(a): ff-only succeeds', pa.ok, pa.ok ? '' : pa.reason)
  check(
    'gitPull(a): includes b commit',
    sh(a, 'rev-parse', 'HEAD').trim() === sh(b, 'rev-parse', 'HEAD').trim()
  )
  const log = await gitLog(a, 5)
  check(
    'gitLog: recent commits',
    log.length === 3 && log[0].message === 'commit from b' && log[0].author === 'fixture',
    JSON.stringify(log.map((l) => l.message))
  )

  // 7. divergence: commit on both sides
  writeFileSync(join(b, 'from-b.txt'), 'b2\n')
  const cb2 = await gitCommit(b, 'b divergent commit', ['from-b.txt'])
  const pb2 = cb2.ok ? await gitPush(b) : cb2
  check('divergence setup: b push', cb2.ok && pb2.ok, pb2.ok ? '' : pb2.reason)
  writeFileSync(join(a, 'from-b.txt'), 'a2\n')
  const ca2 = await gitCommit(a, 'a divergent commit', ['from-b.txt'])
  check('divergence setup: a local commit', ca2.ok, ca2.ok ? '' : ca2.reason)
  const headBefore = sh(a, 'rev-parse', 'HEAD').trim()

  const pushDiverged = await gitPush(a)
  check(
    'gitPush: refused on divergence (no force)',
    !pushDiverged.ok,
    pushDiverged.ok ? '' : pushDiverged.reason.split('\n')[0]
  )

  const pullDiverged = await gitPull(a)
  check(
    'gitPull: ok:false on divergence',
    !pullDiverged.ok,
    pullDiverged.ok ? '' : pullDiverged.reason.split('\n').slice(-1)[0]
  )
  s = await gitStatus(a)
  check(
    'gitPull: no merge attempted (HEAD unchanged)',
    sh(a, 'rev-parse', 'HEAD').trim() === headBefore
  )
  check(
    'gitPull: no conflicts or changes',
    s.clean && s.conflicted.length === 0,
    JSON.stringify(s.files)
  )
  check(
    'gitStatus: diverged ahead 1 · behind 1',
    s.ahead === 1 && s.behind === 1,
    `ahead ${s.ahead} behind ${s.behind}`
  )
}

async function main(): Promise<void> {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'illithid-git-')))
  try {
    await run(root)
  } catch (e) {
    failures++
    console.log(`FAIL  exception — ${(e as Error).message}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  console.log(failures ? `\n${failures} failed` : '\nall steps PASS')
  process.exitCode = failures ? 1 : 0
}

void main()
