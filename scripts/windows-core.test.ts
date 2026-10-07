import assert from 'node:assert/strict'
import { test } from 'node:test'
import { homeTilde, isUnder, toPosix } from '../src/engine/pathUtil'
import { findExecutable } from '../src/engine/detect'
import { resumeCommand } from '../src/engine/scan/sessions'
import { renameWithRetry } from '../src/engine/write'
import { isExecutablePath } from '../src/main/openGuard'
import { buildClaudeMcp } from '../src/engine/targets/claudeMcp'
import { isLocalPath } from '../src/engine/importer'

test('isUnder compares paths by segment on POSIX and Windows', () => {
  assert.equal(isUnder('/home/a/.claude', '/home/a/.claude/rules/x.md', 'darwin'), true)
  assert.equal(isUnder('/home/a/.claude', '/home/a/.claude', 'darwin'), false)
  assert.equal(isUnder('/home/a/.claude', '/home/a/.claude-old/x.md', 'darwin'), false)
  assert.equal(
    isUnder('C:\\Users\\a\\.claude', 'C:\\Users\\a\\.claude\\rules\\x.md', 'win32'),
    true
  )
  assert.equal(
    isUnder('C:\\Users\\a\\.claude', 'c:\\users\\A\\.CLAUDE\\rules\\x.md', 'win32'),
    true
  )
  assert.equal(isUnder('C:\\Users\\a\\.claude', 'C:\\Users\\a\\.claude-old\\x.md', 'win32'), false)
  assert.equal(isUnder('C:\\Users\\a\\.claude', 'D:\\Users\\a\\.claude\\x.md', 'win32'), false)
})

test('toPosix and homeTilde', () => {
  assert.equal(toPosix('C:\\Users\\a\\.claude\\rules'), 'C:/Users/a/.claude/rules')
  assert.equal(homeTilde('/home/a', '/home/a/.codex/config.toml', 'darwin'), '~/.codex/config.toml')
  assert.equal(homeTilde('/home/a', '/home/a', 'darwin'), '~')
  assert.equal(homeTilde('/home/a', '/home/ab/x', 'darwin'), '/home/ab/x')
  assert.equal(
    homeTilde('C:\\Users\\a', 'C:\\Users\\a\\.codex\\config.toml', 'win32'),
    '~\\.codex\\config.toml'
  )
  assert.equal(homeTilde('C:\\Users\\a', 'D:\\x', 'win32'), 'D:\\x')
})

test('findExecutable uses Path, the path delimiter and PATHEXT on Windows', () => {
  const found = new Set(['C:\\tools\\claude.CMD', '/usr/local/bin/codex'])
  const isExec = (p: string): boolean => found.has(p)
  assert.equal(
    findExecutable(
      'claude',
      { Path: 'C:\\bin;C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      'win32',
      isExec
    ),
    'C:\\tools\\claude.CMD'
  )
  assert.equal(
    findExecutable('codex', { PATH: '/usr/bin:/usr/local/bin' }, 'darwin', isExec),
    '/usr/local/bin/codex'
  )
  assert.equal(findExecutable('claude', { PATH: 'relative:dir' }, 'darwin', isExec), undefined)
})

test('resume commands use PowerShell syntax on Windows', () => {
  assert.equal(
    resumeCommand('gemini', 'abc-1', "C:\\Users\\a\\it's", 'win32'),
    "Set-Location -LiteralPath 'C:\\Users\\a\\it''s'; gemini --resume abc-1"
  )
  assert.equal(resumeCommand('claude', 'abc-1', undefined, 'win32'), 'claude --resume abc-1')
  assert.equal(
    resumeCommand('qwen', 'abc-1', '/Users/a/shop', 'darwin'),
    'cd -- /Users/a/shop && qwen --resume abc-1'
  )
})

test('renameWithRetry retries a locked file and rethrows anything else', () => {
  let calls = 0
  const busy = (): void => {
    calls++
    if (calls < 3) throw Object.assign(new Error('locked'), { code: 'EBUSY' })
  }
  renameWithRetry('a', 'b', busy, () => {})
  assert.equal(calls, 3)
  assert.throws(
    () =>
      renameWithRetry(
        'a',
        'b',
        () => {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' })
        },
        () => {}
      ),
    { code: 'ENOENT' }
  )
  let tries = 0
  assert.throws(
    () =>
      renameWithRetry(
        'a',
        'b',
        () => {
          tries++
          throw Object.assign(new Error('perm'), { code: 'EPERM' })
        },
        () => {}
      ),
    { code: 'EPERM' }
  )
  assert.ok(tries > 1 && tries <= 10, `${tries}`)
})

test('opening an artifact refuses executables of each platform', () => {
  for (const p of ['/a/run.command', '/a/x.app', '/a/s.sh'])
    assert.equal(isExecutablePath(p, 'darwin'), true)
  for (const p of [
    'C:\\a\\setup.EXE',
    'C:\\a\\x.bat',
    'C:\\a\\x.ps1',
    'C:\\a\\x.lnk',
    'C:\\a\\x.js',
    'C:\\a\\x.msi'
  ])
    assert.equal(isExecutablePath(p, 'win32'), true, p)
  assert.equal(isExecutablePath('C:\\a\\report.html', 'win32'), false)
  assert.equal(isExecutablePath('/a/report.md', 'darwin'), false)
})

test('Claude Code on Windows runs npx-style MCP servers through cmd /c', () => {
  const mcp = {
    servers: {
      pw: { transport: 'stdio' as const, command: 'npx', args: ['-y', '@playwright/mcp'] },
      local: { transport: 'stdio' as const, command: 'C:\\tools\\srv.exe', args: [] }
    }
  }
  const win = buildClaudeMcp(mcp, {}, {}, undefined, {}, 'win32').mcpServers as Record<
    string,
    { command: string; args: string[] }
  >
  assert.deepEqual(win.pw, {
    type: 'stdio',
    command: 'cmd',
    args: ['/c', 'npx', '-y', '@playwright/mcp']
  })
  assert.deepEqual(win.local, { type: 'stdio', command: 'C:\\tools\\srv.exe', args: [] })
  const mac = buildClaudeMcp(mcp, {}, {}, undefined, {}, 'darwin').mcpServers as Record<
    string,
    { command: string }
  >
  assert.equal(mac.pw.command, 'npx')
})

test('Windows user paths count as machine-specific', () => {
  assert.equal(isLocalPath('C:\\Users\\a', 'C:\\Users\\alex\\bin\\tool.exe'), true)
  assert.equal(isLocalPath('C:\\Users\\a', '%USERPROFILE%\\bin'), true)
  assert.equal(isLocalPath('C:\\Users\\a', 'C:\\Users\\a\\x'), true)
  assert.equal(isLocalPath('/Users/a', 'npx'), false)
})

test('importing a Claude server written as cmd /c npx keeps the portable command', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { buildDemoHome } = await import('./readme-shots')
  const { planImport } = await import('../src/engine')
  const home = mkdtempSync(join(tmpdir(), 'illithid-win-import-'))
  buildDemoHome(home)
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: { pw: { command: 'cmd', args: ['/c', 'npx', '-y', '@playwright/mcp'] } }
    })
  )
  const pw = planImport(home, 'tool:claude').mcp.find((x) => x.name === 'pw')
  assert.ok(pw)
  assert.deepEqual(
    { command: pw.variants[0].server.command, args: pw.variants[0].server.args },
    { command: 'npx', args: ['-y', '@playwright/mcp'] }
  )
})

test('a Windows install updates through the setup installer', async () => {
  const { installKind } = await import('../src/engine/update')
  assert.equal(
    installKind(() => false, 'win32'),
    'nsis'
  )
  assert.equal(
    installKind(() => true, 'win32'),
    'nsis'
  )
  assert.equal(
    installKind((p) => p === '/opt/homebrew/Caskroom/illithid', 'darwin'),
    'brew'
  )
  assert.equal(
    installKind(() => false, 'darwin'),
    'dmg'
  )
})
