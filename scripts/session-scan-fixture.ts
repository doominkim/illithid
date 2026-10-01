/**
 * Session scan cache fixture check. Never touches the real home.
 *
 * Builds a fake HOME with one Claude and one Codex session and checks that the parse cache
 * picks up added, modified and deleted files, the Codex thread name, a corrupt cache file and partial scans.
 * Prints PASS/FAIL per step and exits 1 if any step fails.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSessions } from '../src/engine/scan/sessions'
import { sessionScanCachePath } from '../src/engine/scan/sessionCache'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

const home = mkdtempSync(join(tmpdir(), 'illithid-session-scan-'))
const CLAUDE = 'aaaaaaaa-0000-0000-0000-000000000001'
const CLAUDE2 = 'aaaaaaaa-0000-0000-0000-000000000002'
const CODEX = 'bbbbbbbb-0000-0000-0000-000000000001'
const claudeDir = join(home, '.claude/projects/-p-a')
const codexDir = join(home, '.codex/sessions/2026/09/01')
const codexPath = join(codexDir, `rollout-2026-09-01T00-00-00-${CODEX}.jsonl`)
const codexIndex = join(home, '.codex/session_index.jsonl')
const cachePath = sessionScanCachePath(home)

function claudeSession(id: string, text: string): void {
  writeFileSync(
    join(claudeDir, `${id}.jsonl`),
    jsonl([
      {
        type: 'user',
        sessionId: id,
        cwd: '/p/a',
        timestamp: '2026-09-01T00:00:00Z',
        message: { role: 'user', content: text }
      }
    ])
  )
}

function titles(tools?: Parameters<typeof scanSessions>[1]): Record<string, string> {
  return Object.fromEntries(
    scanSessions(home, tools, { cache: true }).sessions.map((s) => [s.id, s.title])
  )
}

try {
  mkdirSync(claudeDir, { recursive: true })
  mkdirSync(codexDir, { recursive: true })
  claudeSession(CLAUDE, 'first title')
  writeFileSync(
    codexPath,
    jsonl([
      {
        type: 'session_meta',
        payload: { id: CODEX, cwd: '/p/b', timestamp: '2026-09-01T00:00:00Z' }
      },
      {
        type: 'event_msg',
        timestamp: '2026-09-01T00:00:01Z',
        payload: { type: 'user_message', message: 'codex first' }
      }
    ])
  )

  let t = titles()
  check('first scan', t[CLAUDE] === 'first title' && t[CODEX] === 'codex first', JSON.stringify(t))
  check('cache file written', existsSync(cachePath))
  t = titles()
  check(
    'second scan from cache',
    t[CLAUDE] === 'first title' && t[CODEX] === 'codex first',
    JSON.stringify(t)
  )

  claudeSession(CLAUDE, 'changed title')
  // Same-second rewrites can keep mtime; move it forward so the change is visible to the stat check
  utimesSync(join(claudeDir, `${CLAUDE}.jsonl`), new Date(), new Date(Date.now() + 5000))
  check('modified file reparsed', titles()[CLAUDE] === 'changed title')

  claudeSession(CLAUDE2, 'new session')
  check('added file listed', titles()[CLAUDE2] === 'new session')
  rmSync(join(claudeDir, `${CLAUDE2}.jsonl`))
  check('deleted file dropped', !(CLAUDE2 in titles()))
  check('deleted file pruned from cache', !readFileSync(cachePath, 'utf8').includes(CLAUDE2))

  writeFileSync(codexIndex, jsonl([{ id: CODEX, thread_name: 'Named thread' }]))
  check('codex thread name wins over cached title', titles()[CODEX] === 'Named thread')
  rmSync(codexIndex)
  check('codex falls back to first input', titles()[CODEX] === 'codex first')

  writeFileSync(cachePath, '{not json')
  check('corrupt cache falls back to a full scan', titles()[CLAUDE] === 'changed title')

  titles(['claude'])
  check('partial scan keeps other tools', readFileSync(cachePath, 'utf8').includes(CODEX))

  rmSync(join(home, '.config'), { recursive: true, force: true })
  scanSessions(home)
  check('scan without the cache option writes nothing', !existsSync(cachePath))
} finally {
  rmSync(home, { recursive: true, force: true })
}

if (failures) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
