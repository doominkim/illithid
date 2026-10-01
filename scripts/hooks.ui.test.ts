import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

const LIB = '.illithid/workspaces/default'

/** Electron with a demo HOME and the given tools in use */
async function launch(
  tools: string[],
  prefix: string,
  prepare?: (home: string) => void
): Promise<{ home: string; app: Awaited<ReturnType<typeof electron.launch>> }> {
  const home = mkdtempSync(join(tmpdir(), prefix))
  buildDemoHome(home, { tools: 'all' })
  const config = join(home, '.config/illithid/config.json')
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, 'utf8')),
      toolsInUse: tools,
      updateCheck: false,
      marketEnabled: false,
      ui: { language: 'en', views: { hooks: 'list' } }
    })
  )
  const env = {
    ...baseEnv(home),
    ILLITHID_HOME: home,
    ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-hooks-ud-')),
    ILLITHID_TEST: '1'
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  prepare?.(home)
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60000 })
  return { home, app }
}

test(
  'REQ-HOOKS-UI-1 pick "notify", fill the message, and every tool gets a generated script; edit and advanced settings follow',
  { timeout: 180000 },
  async () => {
    const { home, app } = await launch(['claude', 'codex', 'gemini'], 'illithid-hooks-ui-')
    try {
      const page = await app.firstWindow()
      const synced = (): Promise<void> =>
        page.locator('[data-testid="sync-button"][data-state="synced"]').waitFor({ timeout: 30000 })
      await page.locator('[data-menu="hooks"]').click()
      await page.getByTestId('empty-import').waitFor()

      // New hook: an action card, then a short form with the timing and the name already filled in
      await page.getByTestId('hook-new').click()
      await page.locator('[data-card="hook-action-notify"]').click()
      await page.getByTestId('hook-option-message').fill('All done')
      assert.equal(await page.getByTestId('hook-new-name').inputValue(), 'notify-stop')
      await page.getByTestId('hook-create').click()

      // Detail: a one-line summary; outside the real HOME a library write syncs at once
      await page.getByTestId('hook-summary').getByText('Reply finished').waitFor()
      await synced()
      const copy = join(home, '.claude/hooks/illithid/notify-stop/run.sh')
      const claude = (): {
        hooks: { Stop: { hooks: { command: string; timeout?: number }[] }[] }
      } => JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'))
      assert.equal(claude().hooks.Stop[0].hooks[0].command, `'${copy}' claude`)
      assert.equal(statSync(copy).mode & 0o111, 0o111)
      assert.match(readFileSync(copy, 'utf8'), /'All done'/)
      assert.ok(existsSync(join(home, '.gemini/hooks/illithid/notify-stop/run.sh')))
      assert.deepEqual(readdirSync(join(home, LIB, 'hooks/notify-stop')), ['HOOK.md'])

      // Edit: the options form; every tool's script is generated again
      await page.getByTestId('hook-tab-edit').click()
      await page.getByTestId('hook-option-message').fill('Finished')
      await page.getByTestId('hook-save').click()
      await page.getByText('Hook saved').waitFor()
      await synced()
      assert.match(readFileSync(copy, 'utf8'), /'Finished'/)

      // Advanced: a per-tool timeout, then turn the generated script into an own script
      await page.getByTestId('hook-tab-advanced').click()
      await page.getByTestId('hook-trigger-edit-claude').click()
      await page.getByTestId('hook-trigger-form-claude').getByLabel('Timeout (seconds)').fill('7')
      await page.getByTestId('hook-trigger-save-claude').click()
      await page.getByText('Hook saved').first().waitFor()
      await synced()
      assert.equal(claude().hooks.Stop[0].hooks[0].timeout, 7)
      await page.getByTestId('hook-script-show-claude').click()
      await page
        .getByTestId('hook-script-claude')
        .getByText(/osascript/)
        .waitFor()
      await page.getByTestId('hook-convert-claude').click()
      await page.getByTestId('confirm-ok').click()
      await page.getByText('Now runs its own script').waitFor()
      await synced()
      const own = readFileSync(join(home, LIB, 'hooks/notify-stop/run.sh'), 'utf8')
      assert.match(own, /'Finished'/)
      assert.equal(readFileSync(copy, 'utf8'), own)
    } finally {
      await app.close()
    }
  }
)

test(
  'REQ-HOOKS-UI-3 a natural-language check is Claude Code only: the other tools say why',
  { timeout: 180000 },
  async () => {
    const { home, app } = await launch(['claude', 'gemini'], 'illithid-hooks-ui-ask-')
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="hooks"]').click()
      await page.getByTestId('hook-new').click()
      await page.locator('[data-card="hook-action-ask"]').getByText('Claude Code only').waitFor()
      await page.locator('[data-card="hook-action-ask"]').click()
      await page.getByTestId('hook-new-unsupported-claudeOnly').waitFor()
      await page.getByTestId('hook-instruction').fill('Keep working until the tests pass.')
      await page.getByTestId('hook-create').click()
      await page.getByTestId('hook-unsupported-claudeOnly').waitFor()
      await page
        .locator('[data-testid="sync-button"][data-state="synced"]')
        .waitFor({ timeout: 30000 })
      const s = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')) as {
        hooks: { Stop: { hooks: { type: string; prompt: string }[] }[] }
      }
      assert.equal(s.hooks.Stop[0].hooks[0].type, 'prompt')
      assert.match(s.hooks.Stop[0].hooks[0].prompt, /^Keep working until the tests pass\./)
      const gemini = JSON.parse(readFileSync(join(home, '.gemini/settings.json'), 'utf8')) as {
        hooks?: unknown
      }
      assert.equal(gemini.hooks, undefined)
    } finally {
      await app.close()
    }
  }
)

test(
  'REQ-HOOKS-UI-2 import a Claude Code hook: it joins the library and its original entry is replaced',
  { timeout: 180000 },
  async () => {
    const settingsPath = (home: string): string => join(home, '.claude/settings.json')
    const { home, app } = await launch(['claude'], 'illithid-hooks-ui-import-', (home) => {
      mkdirSync(join(home, 'bin'), { recursive: true })
      writeFileSync(join(home, 'bin/guard.sh'), '#!/bin/sh\nexit 0\n')
      mkdirSync(join(home, '.claude'), { recursive: true })
      const prev = existsSync(settingsPath(home))
        ? JSON.parse(readFileSync(settingsPath(home), 'utf8'))
        : {}
      writeFileSync(
        settingsPath(home),
        JSON.stringify({
          ...prev,
          hooks: {
            PreToolUse: [
              { matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/guard.sh' }] }
            ]
          }
        })
      )
    })
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="hooks"]').click()
      await page.getByTestId('hook-import').click()
      await page.getByTestId('import-source-tool:claude').click()
      await page.getByTestId('import-hook-guard').check()
      await page.getByTestId('import-apply').click()
      await page.getByText('Imported into the library').waitFor()
      await page.keyboard.press('Escape')
      await page
        .locator('main [data-card="guard"], main')
        .getByText('guard', { exact: true })
        .first()
        .waitFor()
      await page
        .locator('[data-testid="sync-button"][data-state="synced"]')
        .waitFor({ timeout: 30000 })
      const s = JSON.parse(readFileSync(settingsPath(home), 'utf8')) as {
        hooks: { PreToolUse: { hooks: { command: string }[] }[] }
      }
      assert.equal(s.hooks.PreToolUse.length, 1)
      assert.match(s.hooks.PreToolUse[0].hooks[0].command, /illithid\/guard\/run\.sh' claude$/)
    } finally {
      await app.close()
    }
  }
)

test(
  "REQ-HOOKS-UI-4 recipes: check before finishing gets a long timeout everywhere, protect files says where it can't run, phone notifications ask for a variable",
  { timeout: 180000 },
  async () => {
    const { home, app } = await launch(['claude', 'codex', 'copilot'], 'illithid-hooks-ui-recipes-')
    try {
      const page = await app.firstWindow()
      const synced = (): Promise<void> =>
        page.locator('[data-testid="sync-button"][data-state="synced"]').waitFor({ timeout: 30000 })
      await page.locator('[data-menu="hooks"]').click()

      await page.getByTestId('hook-new').click()
      await page.locator('[data-card="hook-action-verify"]').click()
      assert.equal(await page.getByTestId('hook-new-name').inputValue(), 'verify-stop')
      await page.getByTestId('hook-create').click()
      await page.getByTestId('hook-summary').getByText('Check before finishing').waitFor()
      await synced()
      const claude = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')) as {
        hooks: Record<string, { matcher?: string; hooks: { timeout?: number }[] }[]>
      }
      assert.equal(claude.hooks.Stop[0].hooks[0].timeout, 300)
      const copilot = JSON.parse(
        readFileSync(join(home, '.copilot/hooks/illithid.json'), 'utf8')
      ) as { hooks: { agentStop: { timeoutSec: number }[] } }
      assert.equal(copilot.hooks.agentStop[0].timeoutSec, 300)
      await page.keyboard.press('Escape')

      await page.getByTestId('hook-new').click()
      await page.locator('[data-card="hook-action-protect"]').click()
      await page
        .getByTestId('hook-new-unsupported-noFilePath')
        .getByText(/Codex, GitHub Copilot/)
        .waitFor()
      await page.getByTestId('hook-create').click()
      await page.getByTestId('hook-summary').waitFor()
      await synced()
      const after = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')) as {
        hooks: Record<string, { matcher?: string }[]>
      }
      assert.equal(after.hooks.PreToolUse[0].matcher, 'Write|Edit')
      await page.keyboard.press('Escape')

      await page.getByTestId('hook-new').click()
      await page.locator('[data-card="hook-action-notify"]').click()
      await page.getByTestId('hook-option-channel').getByText('ntfy', { exact: true }).click()
      await page.getByTestId('hook-option-urlenv').waitFor()
      assert.equal(
        await page.getByTestId('hook-option-urlenv').getAttribute('placeholder'),
        'ILLITHID_NTFY_URL'
      )
    } finally {
      await app.close()
    }
  }
)
