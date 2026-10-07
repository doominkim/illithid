import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

/** Hooks are generated as POSIX shell scripts and not written on Windows yet (phase 1) */
const NO_HOOKS = process.platform === 'win32' && 'hooks are not written on Windows yet'

const LIB = '.illithid/workspaces/default'
const API = 'https://api.github.com/repos/github/awesome-copilot'
const RAW = 'https://raw.githubusercontent.com/github/awesome-copilot'
const SHA = 'c'.repeat(40)

/** awesome-copilot with one hook pack, served by a stubbed fetch in the main process (no network) */
const ROUTES: Record<string, string> = {
  [`${API}/commits/HEAD`]: SHA,
  [`${API}/git/trees/${SHA}?recursive=1`]: JSON.stringify({
    sha: 'root',
    truncated: false,
    tree: [
      { path: 'hooks', mode: '040000', type: 'tree', sha: 'h' },
      { path: 'hooks/session-logger', mode: '040000', type: 'tree', sha: 'p1' },
      { path: 'hooks/session-logger/README.md', mode: '100644', type: 'blob', size: 1 },
      { path: 'hooks/session-logger/hooks.json', mode: '100644', type: 'blob', size: 1 },
      { path: 'hooks/session-logger/log-start.sh', mode: '100644', type: 'blob', size: 1 }
    ]
  }),
  [`${RAW}/${SHA}/hooks/session-logger/README.md`]:
    "---\nname: 'Session Logger'\ndescription: 'Logs sessions'\n---\n\n# Session Logger\n",
  [`${RAW}/${SHA}/hooks/session-logger/hooks.json`]: JSON.stringify({
    version: 1,
    hooks: {
      sessionStart: [
        { type: 'command', bash: '.github/hooks/session-logger/log-start.sh', timeoutSec: 5 }
      ]
    }
  }),
  [`${RAW}/${SHA}/hooks/session-logger/log-start.sh`]: '#!/bin/bash\necho started >> /tmp/x\n'
}

test(
  'REQ-MARKET-HOOKS-UI-1 the Hooks tab lists awesome-copilot packs; installing one adds a Copilot-only hook',
  { skip: NO_HOOKS, timeout: 180000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-market-hooks-ui-'))
    buildDemoHome(home, { tools: 'all' })
    const config = join(home, '.config/illithid/config.json')
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, 'utf8')),
        toolsInUse: ['claude', 'copilot'],
        updateCheck: false,
        marketEnabled: true,
        ui: { language: 'en' }
      })
    )
    const env = {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-market-ud-')),
      ILLITHID_TEST: '1'
    } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
    try {
      await app.evaluate((_e, routes) => {
        globalThis.fetch = (async (url: string) => {
          const r = routes[String(url)]
          return r === undefined
            ? new Response('not found', { status: 404 })
            : new Response(r, { status: 200 })
        }) as typeof fetch
      }, ROUTES)
      const page = await app.firstWindow()
      await page.locator('[data-menu="market"]').click()
      await page.getByTestId('market-tabs').getByText('Hooks', { exact: true }).click()
      await page.getByText('Session Logger', { exact: true }).click()
      await page.getByTestId('market-hook-copilot').waitFor()
      await page.getByTestId('market-hook-entries').getByText('echo started').waitFor()
      await page.getByTestId('market-install').click()
      // Opens the new hook
      await page.getByTestId('hook-tab-preview').waitFor()
      const doc = readFileSync(join(home, LIB, 'hooks/session-logger/HOOK.md'), 'utf8')
      assert.match(doc, /when: session-start/)
      assert.match(doc, /action: script/)
      await page
        .locator('[data-testid="sync-button"][data-state="synced"]')
        .waitFor({ timeout: 30000 })
      assert.ok(existsSync(join(home, '.copilot/hooks/illithid/session-logger/run.sh')))
      assert.equal(existsSync(join(home, '.claude/hooks/illithid/session-logger')), false)
    } finally {
      await app.close()
    }
  }
)
