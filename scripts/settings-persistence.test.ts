import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPath, readConfig, validateConfig } from '../src/engine/config'
import { mergeUiPrefs } from '../src/engine/uiPrefs'
import { shouldWaitForLock, waitForLock } from '../src/main/singleInstance'

const homeWith = (config: unknown): string => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-settings-'))
  mkdirSync(join(home, '.config/illithid'), { recursive: true })
  writeFileSync(configPath(home), JSON.stringify(config))
  return home
}

test('REQ-SETTINGS-PERSISTENCE-6 a malformed ui is dropped while the rest of config.json is kept', () => {
  const home = homeWith({
    version: 1,
    activeWorkspace: 'work',
    updateCheck: false,
    ui: { language: 'fr', colorScheme: 'sepia', views: { skills: 'table' } }
  })
  const r = readConfig(home)
  assert.equal(r.error, undefined)
  assert.equal(r.config.activeWorkspace, 'work')
  assert.equal(r.config.updateCheck, false)
  assert.equal(r.config.ui, undefined)
  for (const ui of [null, [], 'ko', { language: 'fr' }, { colorScheme: 'sepia' }, { views: { skills: 'table' } }, { views: [] }])
    assert.ok(validateConfig({ version: 1, ui }).length > 0, JSON.stringify(ui))
  assert.deepEqual(
    validateConfig({ version: 1, ui: { language: 'ko', colorScheme: 'dark', views: { skills: 'grid', mcp: 'list' } } }),
    []
  )
  const ok = homeWith({ version: 1, ui: { language: 'ja', colorScheme: 'light' } })
  assert.deepEqual(readConfig(ok).config.ui, { language: 'ja', colorScheme: 'light' })
})

test('REQ-SETTINGS-PERSISTENCE-1 REQ-SETTINGS-PERSISTENCE-2 REQ-SETTINGS-PERSISTENCE-3 prefs merge per key and per screen; null removes', () => {
  const cur = { language: 'ko' as const, views: { skills: 'grid' as const } }
  assert.deepEqual(mergeUiPrefs(cur, { colorScheme: 'dark' }), { language: 'ko', colorScheme: 'dark', views: { skills: 'grid' } })
  assert.deepEqual(mergeUiPrefs(cur, { views: { mcp: 'grid' } }), { language: 'ko', views: { skills: 'grid', mcp: 'grid' } })
  assert.deepEqual(mergeUiPrefs(cur, { language: null }), { views: { skills: 'grid' } })
  assert.deepEqual(mergeUiPrefs(undefined, { language: 'en' }), { language: 'en' })
})

test('REQ-SETTINGS-PERSISTENCE-7 REQ-SETTINGS-PERSISTENCE-8 only a newer version (or an unknown running one) waits for the lock', () => {
  assert.equal(shouldWaitForLock('0.2.27', '0.2.26'), true)
  assert.equal(shouldWaitForLock('0.3.0', '0.2.30'), true)
  assert.equal(shouldWaitForLock('0.2.27', '0.2.27'), false)
  assert.equal(shouldWaitForLock('0.2.26', '0.2.27'), false)
  assert.equal(shouldWaitForLock('0.2.27', undefined), true)
})

test('REQ-SETTINGS-PERSISTENCE-9 the new instance gives up after 15 seconds, or takes the lock once it frees', async () => {
  let now = 0
  const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) }
  let tries = 0
  assert.equal(await waitForLock(() => (tries++, false), clock), false)
  assert.ok(now >= 15000 && now < 16000, String(now))
  assert.ok(tries > 1)
  now = 0
  let calls = 0
  assert.equal(await waitForLock(() => ++calls === 4, clock), true)
  assert.ok(now < 15000)
})

test('REQ-SETTINGS-PERSISTENCE-10 the published cask quits Illithid before upgrading', (t) => {
  let json: string
  try {
    json = execFileSync('brew', ['info', '--cask', '--json=v2', 'doominkim/tap/illithid'], {
      encoding: 'utf8',
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' }
    })
  } catch {
    t.skip('brew or the doominkim/tap tap is not available')
    return
  }
  const artifacts = JSON.parse(json).casks[0].artifacts as Record<string, unknown>[]
  const quits = artifacts
    .flatMap((a) => (Array.isArray(a.uninstall) ? a.uninstall : []))
    .flatMap((u: Record<string, unknown>) => [u.quit].flat())
  assert.ok(quits.includes('com.illithid.app'), JSON.stringify(artifacts))
})
