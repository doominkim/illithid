import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'
import { baseEnv, buildDemoHome } from './readme-shots'

async function launch(): Promise<Awaited<ReturnType<typeof electron.launch>>> {
  const home = mkdtempSync(join(tmpdir(), 'illithid-github-ui-'))
  buildDemoHome(home, { tools: 'all' })
  const config = join(home, '.config/illithid/config.json')
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, 'utf8')),
      toolsInUse: [],
      marketEnabled: false,
      updateCheck: false,
      autoBackup: false,
      ui: { language: 'en' }
    })
  )
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: {
      ...baseEnv(home),
      ILLITHID_HOME: home,
      ILLITHID_TEST: '1',
      ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-github-ui-ud-'))
    },
    timeout: 30000
  })
  await app.firstWindow()
  return app
}

test(
  'the registered Illithid GitHub App enables sign-in without environment configuration',
  { timeout: 60000 },
  async () => {
    const app = await launch()
    try {
      const page = await app.firstWindow()
      await page.locator('[data-menu="backup"]').click()
      const button = page.getByTestId('github-sign-in')
      await button.waitFor()
      assert.equal(await button.isEnabled(), true)
      assert.equal(
        await page
          .getByText(
            'GitHub sign-in is not available in this build yet. You can still connect an existing repository URL.'
          )
          .count(),
        0
      )
    } finally {
      await app.close()
    }
  }
)

test(
  'a connected backup requires confirmed disconnection before setting up another repository',
  { timeout: 60000 },
  async () => {
    const app = await launch()
    try {
      await app.evaluate(({ ipcMain }) => {
        let connected = true
        const snapshot = {
          hash: '1234567890',
          message: 'Unique fixture snapshot',
          at: '2026-10-06T00:00:00Z',
          device: 'fixture'
        }
        ipcMain.removeHandler('api:githubLoginStatus')
        ipcMain.handle('api:githubLoginStatus', () => ({
          ok: true,
          value: { configured: true, phase: 'signedIn', login: 'fixture-user' }
        }))
        ipcMain.removeHandler('api:backupStatus')
        ipcMain.handle('api:backupStatus', () => ({
          initialized: connected,
          remoteUrl: connected ? 'https://github.com/fixture-user/illithid-backup.git' : undefined,
          libraryExists: true,
          root: '/synthetic/library',
          deviceName: 'fixture',
          dirty: false,
          ahead: 0,
          behind: 0,
          autoBackup: false,
          lastSnapshot: snapshot
        }))
        ipcMain.removeHandler('api:backupHistory')
        ipcMain.handle('api:backupHistory', () => ({ ok: true, value: [snapshot] }))
        ipcMain.removeHandler('api:backupDisconnect')
        ipcMain.handle('api:backupDisconnect', () => {
          connected = false
          return { ok: true, value: {} }
        })
      })
      const page = await app.firstWindow()
      await page.locator('[data-menu="backup"]').click()
      await page.getByTestId('backup-connected-summary').waitFor({ timeout: 3000 })
      await page.getByText('Unique fixture snapshot', { exact: true }).waitFor()
      const content = await page.locator('body').innerText()
      assert.equal(content.match(/fixture-user\/illithid-backup/g)?.length, 1)
      assert.equal(content.match(/Unique fixture snapshot/g)?.length, 1)
      assert.equal(await page.getByRole('link', { name: 'Open repository' }).count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Reload', exact: true }).count(), 1)
      assert.equal(await page.getByTestId('github-create-repository').count(), 0)
      assert.equal(
        await page.getByRole('textbox', { name: 'Repository name', includeHidden: true }).count(),
        0
      )
      assert.equal(await page.getByTestId('backup-url').count(), 0)
      assert.equal(await page.getByText('Change repository', { exact: true }).count(), 0)
      assert.equal(await page.getByText('Manage connection', { exact: true }).count(), 0)
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
      await page.getByTestId('confirm-ok').waitFor()
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      assert.equal(await page.getByTestId('backup-connected-summary').isVisible(), true)
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
      await page.getByTestId('confirm-ok').click()
      await page.getByTestId('github-create-repository').waitFor()
      assert.equal(await page.getByTestId('backup-connected-summary').count(), 0)
      await page.locator('[data-testid="backup-existing-url"] > summary').click()
      assert.equal(await page.getByTestId('backup-url').isVisible(), true)
    } finally {
      await app.close()
    }
  }
)

test(
  'repository creation requires confirmation and can resume after installation without uploading',
  { timeout: 60000 },
  async () => {
    const app = await launch()
    try {
      await app.evaluate('globalThis.__name = (fn) => fn')
      await app.evaluate(({ ipcMain }) => {
        const calls: string[] = []
        let installed = false
        const replace = (key: string, fn: (...args: unknown[]) => unknown): void => {
          ipcMain.removeHandler(`api:${key}`)
          ipcMain.handle(`api:${key}`, (_event, ...args) => fn(...args))
        }
        replace('githubLoginStatus', () => ({
          ok: true,
          value: { configured: true, phase: 'signedIn', login: 'fixture-user' }
        }))
        replace('githubRepositoryCreate', (name) => {
          calls.push(`create:${name}`)
          return {
            ok: true,
            value: { id: 1, name, url: `https://github.com/fixture-user/${name}.git` }
          }
        })
        replace('githubRepositoryConnect', () => {
          calls.push('connect')
          return installed ? { ok: true, value: {} } : { ok: false, code: 'installationRequired' }
        })
        replace('githubInstallationOpen', () => {
          installed = true
          calls.push('install')
          return { ok: true }
        })
        replace('backupSnapshot', () => {
          calls.push('upload')
          throw new Error('Upload must be explicit')
        })
        Object.assign(ipcMain, { githubFixtureCalls: calls })
      })
      const page = await app.firstWindow()
      await page.locator('[data-menu="backup"]').click()
      assert.equal(
        await page.getByRole('button', { name: 'Connect repository', exact: true }).count(),
        0
      )
      await page.getByTestId('github-create-repository').click()
      assert.deepEqual(
        await app.evaluate(
          ({ ipcMain }) =>
            (ipcMain as unknown as { githubFixtureCalls: string[] }).githubFixtureCalls
        ),
        []
      )
      const modal = page.getByRole('dialog')
      assert.ok((await modal.innerText()).includes('Creating it does not upload files'))
      await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.getByTestId('github-create-repository').click()
      await page.getByTestId('confirm-ok').click()
      await page
        .getByText('Allow this app to access the backup repository in GitHub, then connect again.')
        .waitFor()
      assert.equal(await page.getByTestId('github-create-repository').count(), 0)
      await page.getByTestId('github-allow-access').click()
      await page.getByTestId('github-finish-setup').click()
      await page
        .getByText('Allow this app to access the backup repository in GitHub, then connect again.')
        .waitFor({ state: 'hidden' })
      assert.deepEqual(
        await app.evaluate(
          ({ ipcMain }) =>
            (ipcMain as unknown as { githubFixtureCalls: string[] }).githubFixtureCalls
        ),
        ['create:illithid-backup', 'connect', 'install', 'connect']
      )
      // Public IPC mocks do not create a real repository or issue a remote push.
      mkdirSync(resolve('artifacts/github-backup'), { recursive: true })
      await page.screenshot({ path: resolve('artifacts/github-backup/connection.png') })
    } finally {
      await app.close()
    }
  }
)

test('one repository URL preserves manual Git connections', { timeout: 60000 }, async () => {
  const app = await launch()
  try {
    await app.evaluate(({ ipcMain }) => {
      const calls: string[] = []
      ipcMain.removeHandler('api:githubLoginStatus')
      ipcMain.handle('api:githubLoginStatus', () => ({
        ok: true,
        value: { configured: true, phase: 'signedIn', login: 'fixture-user' }
      }))
      ipcMain.removeHandler('api:backupConnect')
      ipcMain.handle('api:backupConnect', (_event, url: string) => {
        calls.push(url)
        return { ok: true, value: {} }
      })
      ipcMain.removeHandler('api:githubRepositoryConnect')
      ipcMain.handle('api:githubRepositoryConnect', () => {
        calls.push('unexpected-github-auth')
        return { ok: false, code: 'connectionFailed' }
      })
      Object.assign(ipcMain, { manualConnectionCalls: calls })
    })
    const page = await app.firstWindow()
    await page.locator('[data-menu="backup"]').click()
    await page.getByTestId('github-create-repository').waitFor()
    await page.locator('[data-testid="backup-existing-url"] > summary').click()
    await page.getByTestId('backup-url').fill('https://gitlab.com/fixture-user/backup.git')
    await page.getByTestId('backup-connect').click()
    await page.getByText('Backup connected', { exact: true }).waitFor()
    assert.deepEqual(
      await app.evaluate(
        ({ ipcMain }) =>
          (ipcMain as unknown as { manualConnectionCalls: string[] }).manualConnectionCalls
      ),
      ['https://gitlab.com/fixture-user/backup.git']
    )
  } finally {
    await app.close()
  }
})

test(
  'a failed initial GitHub status read shows a recoverable error',
  { timeout: 60000 },
  async () => {
    const app = await launch()
    try {
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:githubLoginStatus')
        ipcMain.handle('api:githubLoginStatus', () => ({ ok: false, code: 'githubUnavailable' }))
      })
      const page = await app.firstWindow()
      await page.locator('[data-menu="backup"]').click()
      await page
        .getByText('GitHub is temporarily unavailable. Try again.')
        .waitFor({ timeout: 3000 })
    } finally {
      await app.close()
    }
  }
)

test(
  'repository loading stays on the initiating action and prevents overlapping requests',
  { timeout: 60000 },
  async () => {
    const app = await launch()
    try {
      await app.evaluate('globalThis.__name = (fn) => fn')
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('api:githubLoginStatus')
        ipcMain.handle('api:githubLoginStatus', () => ({
          ok: true,
          value: { configured: true, phase: 'signedIn', login: 'fixture-user' }
        }))
        ipcMain.removeHandler('api:githubRepositoryCreate')
        ipcMain.handle(
          'api:githubRepositoryCreate',
          () =>
            new Promise((resolve) => {
              Object.assign(ipcMain, {
                releaseGithubCreation: () => resolve({ ok: false, code: 'permissionDenied' })
              })
            })
        )
        ipcMain.removeHandler('api:githubRepositoryConnect')
        ipcMain.handle('api:githubRepositoryConnect', () => new Promise(() => {}))
      })
      const page = await app.firstWindow()
      await page.locator('[data-menu="backup"]').click()
      const create = page.getByTestId('github-create-repository')
      const connect = page.getByTestId('backup-connect')
      await create.click()
      await page.getByTestId('confirm-ok').click()
      await page
        .locator('[data-testid="github-create-repository"][data-loading]')
        .waitFor({ timeout: 3000 })
      assert.equal(await connect.getAttribute('data-loading'), null)
      assert.equal(await connect.isDisabled(), true)
      await app.evaluate(({ ipcMain }) =>
        (ipcMain as unknown as { releaseGithubCreation: () => void }).releaseGithubCreation()
      )
      await page
        .locator('[data-testid="github-create-repository"][data-loading]')
        .waitFor({ state: 'hidden' })
      await page.locator('[data-testid="backup-existing-url"] > summary').click()
      assert.equal(await page.getByTestId('backup-url').isVisible(), true)
      await page
        .getByTestId('backup-url')
        .fill('https://github.com/fixture-user/illithid-backup.git')
      await connect.click()
      await page.locator('[data-testid="backup-connect"][data-loading]').waitFor({ timeout: 3000 })
      assert.equal(await create.getAttribute('data-loading'), null)
      assert.equal(await create.isDisabled(), true)
    } finally {
      await app.close()
    }
  }
)
