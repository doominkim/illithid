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
import { createHook, syncAll } from '../src/engine'
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
  'REQ-HOOKS-UI-1 an existing recipe hook (notify) keeps its generated scripts; edit and advanced settings follow',
  { timeout: 180000 },
  async () => {
    const { home, app } = await launch(['claude', 'codex', 'gemini'], 'illithid-hooks-ui-', (h) => {
      createHook(h, 'notify-stop', {
        description: '',
        when: 'stop',
        action: 'notify',
        options: { message: 'All done' }
      })
      // Made before this launch: written to the tools up front
      syncAll(h, baseEnv(h), { allowReal: true })
    })
    try {
      const page = await app.firstWindow()
      const synced = (): Promise<void> =>
        page.locator('[data-testid="sync-button"][data-state="synced"]').waitFor({ timeout: 30000 })
      await page.locator('[data-menu="hooks"]').click()
      await page.getByText('notify-stop', { exact: true }).first().click()

      // Detail: a one-line summary; outside the real HOME the library syncs at once
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
  'REQ-HOOKS-UI-3 an AI check runs in every tool: a prompt hook in Claude Code, a judging CLI elsewhere',
  { timeout: 180000 },
  async () => {
    const { home, app } = await launch(['claude', 'gemini'], 'illithid-hooks-ui-ask-')
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="hooks"]').click()
      await page.getByTestId('hook-new').click()
      await page.getByTestId('hook-new-mode').getByText('Let AI judge', { exact: true }).click()
      assert.equal(await page.getByTestId('hook-new-unsupported-claudeOnly').count(), 0)
      await page.getByTestId('hook-option-judge').waitFor()
      // Judging before every tool call is slow: the form says so
      await page.getByTestId('hook-new-timing').click()
      await page.getByRole('option', { name: 'Before a tool runs' }).click()
      await page.getByTestId('hook-ask-slow').waitFor()
      await page.getByTestId('hook-new-timing').click()
      await page.getByRole('option', { name: 'Reply finished' }).click()
      await page.getByTestId('hook-instruction').fill('Keep working until the tests pass.')
      await page.getByTestId('hook-create').click()
      await page.getByTestId('hook-summary').waitFor()
      await page
        .locator('[data-testid="sync-button"][data-state="synced"]')
        .waitFor({ timeout: 30000 })
      const s = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')) as {
        hooks: { Stop: { hooks: { type: string; prompt: string }[] }[] }
      }
      assert.equal(s.hooks.Stop[0].hooks[0].type, 'prompt')
      assert.match(s.hooks.Stop[0].hooks[0].prompt, /^Keep working until the tests pass\./)
      const gemini = JSON.parse(readFileSync(join(home, '.gemini/settings.json'), 'utf8')) as {
        hooks: { AfterAgent: { hooks: { command: string }[] }[] }
      }
      assert.match(gemini.hooks.AfterAgent[0].hooks[0].command, /ask-stop\/run\.sh' gemini$/)
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
  'REQ-HOOKS-UI-4 one form for every hook: a script before shell commands, with a timeout, reaches each tool with its own shell tool name',
  { timeout: 180000 },
  async () => {
    const { home, app } = await launch(['claude', 'gemini', 'copilot'], 'illithid-hooks-ui-form-')
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="hooks"]').click()
      await page.getByTestId('hook-new').click()
      // No recipe cards: the form is there at once
      assert.equal(await page.locator('[data-card^="hook-action-"]').count(), 0)
      await page.getByTestId('hook-new-script').waitFor()
      await page.getByTestId('hook-new-timing').click()
      await page.getByRole('option', { name: 'Before a tool runs' }).click()
      await page
        .getByTestId('hook-option-target')
        .getByText('Shell commands', { exact: true })
        .click()
      const script = '#!/bin/sh\necho checked >&2\nexit 0\n'
      await page.getByTestId('hook-new-script').fill(script)
      await page.getByTestId('hook-new-timeout').fill('15')
      assert.equal(await page.getByTestId('hook-new-name').inputValue(), 'script-before-tool')
      await page.getByTestId('hook-create').click()
      await page.getByTestId('hook-summary').waitFor()
      await page
        .locator('[data-testid="sync-button"][data-state="synced"]')
        .waitFor({ timeout: 30000 })
      assert.equal(readFileSync(join(home, LIB, 'hooks/script-before-tool/run.sh'), 'utf8'), script)
      const claude = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')) as {
        hooks: { PreToolUse: { matcher: string; hooks: { timeout: number }[] }[] }
      }
      assert.equal(claude.hooks.PreToolUse[0].matcher, 'Bash')
      assert.equal(claude.hooks.PreToolUse[0].hooks[0].timeout, 15)
      const gemini = JSON.parse(readFileSync(join(home, '.gemini/settings.json'), 'utf8')) as {
        hooks: { BeforeTool: { matcher: string; hooks: { timeout: number }[] }[] }
      }
      assert.equal(gemini.hooks.BeforeTool[0].matcher, 'run_shell_command')
      assert.equal(gemini.hooks.BeforeTool[0].hooks[0].timeout, 15000)
      const copilot = JSON.parse(
        readFileSync(join(home, '.copilot/hooks/illithid.json'), 'utf8')
      ) as { hooks: { preToolUse: { matcher: string; timeoutSec: number }[] } }
      assert.equal(copilot.hooks.preToolUse[0].matcher, 'bash')
      assert.equal(copilot.hooks.preToolUse[0].timeoutSec, 15)
    } finally {
      await app.close()
    }
  }
)
