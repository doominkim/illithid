import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { GitHubBackup } from '../src/engine/githubBackup'

test('device login keeps credentials out of public status and honours polling intervals', async () => {
  let now = 0
  let credentials: unknown = null
  const calls: string[] = []
  const fetcher = async (url: string): Promise<Response> => {
    calls.push(url)
    const body = url.endsWith('/device/code')
      ? {
          device_code: 'private-device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5
        }
      : url.endsWith('/access_token')
        ? {
            access_token: 'ghu_fixture_secret',
            refresh_token: 'ghr_fixture_secret',
            expires_in: 28800,
            refresh_token_expires_in: 15897600
          }
        : { login: 'fixture-user', id: 42 }
    return new Response(JSON.stringify(body), { status: 200 })
  }
  const app = new GitHubBackup({
    clientId: 'public-client-id',
    appSlug: 'illithid-test',
    fetch: fetcher,
    now: () => now,
    store: {
      read: () => credentials,
      write: (value) => {
        credentials = value
      },
      clear: () => {
        credentials = null
      }
    }
  })
  await app.start()
  assert.equal(app.status().phase, 'pending')
  assert.equal(app.status().userCode, 'ABCD-EFGH')
  await app.poll()
  assert.equal(calls.length, 1)
  now = 5000
  await app.poll()
  assert.equal(app.status().phase, 'signedIn')
  assert.equal(app.status().login, 'fixture-user')
  assert.ok(credentials)
  assert.doesNotMatch(JSON.stringify(app.status()), /ghu_|ghr_|private-device-code/)
  assert.equal(calls.filter((url) => url.endsWith('/access_token')).length, 1)
})

test('cancelling login ignores a late token response and stores nothing', async () => {
  let now = 0
  let finish!: (r: Response) => void
  let writes = 0
  const app = new GitHubBackup({
    clientId: 'client',
    appSlug: 'app',
    now: () => now,
    store: {
      read: () => null,
      write: () => {
        writes++
      },
      clear: () => {}
    },
    fetch: async (url) =>
      url.endsWith('/device/code')
        ? new Response(
            JSON.stringify({
              device_code: 'device',
              user_code: 'ABCD-EFGH',
              verification_uri: 'https://github.com/login/device',
              expires_in: 900,
              interval: 5
            })
          )
        : new Promise((resolve) => {
            finish = resolve
          })
  })
  await app.start()
  now = 5000
  const polling = app.poll()
  app.cancel()
  finish(new Response(JSON.stringify({ access_token: 'ghu_late' })))
  await polling
  assert.equal(app.status().phase, 'signedOut')
  assert.equal(writes, 0)
})

test('device login backs off on slow_down and returns a terminal error on expiry or denial', async () => {
  let now = 0
  let polls = 0
  let response = 'slow_down'
  const app = new GitHubBackup({
    clientId: 'client',
    appSlug: 'illithid',
    now: () => now,
    store: {
      read: () => null,
      write: () => {
        throw new Error('Must not store an unauthorized token')
      },
      clear: () => {}
    },
    fetch: async (url) => {
      if (url.endsWith('/device/code'))
        return new Response(
          JSON.stringify({
            device_code: 'private-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://github.com/login/device',
            expires_in: 20,
            interval: 5
          })
        )
      polls++
      return new Response(JSON.stringify({ error: response }))
    }
  })
  await app.start()
  now = 5000
  await app.poll()
  now = 10000
  await app.poll()
  assert.equal(polls, 1)
  response = 'access_denied'
  now = 15000
  assert.equal((await app.poll()).error, 'denied')
  assert.equal(app.status().phase, 'signedOut')
  await app.start()
  now = 35000
  assert.equal((await app.poll()).error, 'expired')
  assert.equal(polls, 2, 'expired code must not be sent to GitHub again')
})

test('private repository creation is explicit, empty, and can be resumed after installation', async () => {
  const requests: { url: string; body?: string }[] = []
  const app = new GitHubBackup({
    clientId: 'client',
    appSlug: 'illithid',
    store: {
      read: () => ({ token: 'ghu_fixture', login: 'fixture-user', userId: 42 }),
      write: () => {},
      clear: () => {}
    },
    fetch: async (url, init) => {
      requests.push({ url, body: init?.body as string })
      return new Response(
        JSON.stringify({
          id: 7,
          name: 'illithid-backup',
          full_name: 'fixture-user/illithid-backup',
          private: true,
          clone_url: 'https://github.com/fixture-user/illithid-backup.git',
          owner: { login: 'fixture-user' }
        }),
        { status: 201 }
      )
    }
  })
  await app.restoreLogin()
  assert.equal(requests.length, 0)
  const repo = await app.createRepository('illithid-backup')
  assert.equal(repo.url, 'https://github.com/fixture-user/illithid-backup.git')
  assert.deepEqual(JSON.parse(requests[0].body!), {
    name: 'illithid-backup',
    private: true,
    auto_init: false,
    has_issues: false,
    has_projects: false,
    has_wiki: false,
    description: 'Private Illithid configuration backup'
  })
  await assert.rejects(app.createRepository('../invalid'), /invalidRepositoryName/)
  assert.equal(requests.length, 1)
})

test('backup credentials refresh without a client secret and require the selected installation repository', async () => {
  let saved: unknown
  let installed = false
  const requests: { url: string; body?: string }[] = []
  const app = new GitHubBackup({
    clientId: 'client',
    appSlug: 'illithid',
    now: () => 100000,
    store: {
      read: () => ({
        token: 'ghu_expired',
        login: 'fixture-user',
        userId: 42,
        expiresAt: 1,
        refreshToken: 'ghr_refresh',
        refreshExpiresAt: 999999
      }),
      write: (value) => {
        saved = value
      },
      clear: () => {}
    },
    fetch: async (url, init) => {
      requests.push({ url, body: init?.body as string })
      const body = url.endsWith('/access_token')
        ? {
            access_token: 'ghu_new',
            refresh_token: 'ghr_new',
            expires_in: 28800,
            refresh_token_expires_in: 15897600
          }
        : url.includes('/installations/9/repositories')
          ? {
              repositories: installed
                ? [{ id: 7, full_name: 'fixture-user/illithid-backup', private: true }]
                : []
            }
          : { installations: [{ id: 9, app_slug: 'illithid', permissions: { contents: 'write' } }] }
      return new Response(JSON.stringify(body))
    }
  })
  await app.restoreLogin()
  await assert.rejects(
    app.gitCredentials('https://github.com/fixture-user/illithid-backup.git'),
    /installationRequired/
  )
  installed = true
  const auth = await app.gitCredentials('https://github.com/fixture-user/illithid-backup.git')
  assert.equal(auth.token, 'ghu_new')
  assert.ok(saved)
  const refresh = new URLSearchParams(requests.find((r) => r.url.endsWith('/access_token'))!.body)
  assert.equal(refresh.get('grant_type'), 'refresh_token')
  assert.equal(refresh.has('client_secret'), false)
  await assert.rejects(
    app.gitCredentials('https://github.com.evil.test/fixture-user/illithid-backup.git'),
    /invalidRemote/
  )
})

test('Git credentials are scoped to one HTTPS repository and never change the parent environment', async () => {
  const { backupGitEnvironment } = await import('../src/engine/backupGitAuth')
  const parent = {
    PATH: '/usr/bin',
    GIT_TRACE: '1',
    GIT_CURL_VERBOSE: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: 'inherited'
  }
  const auth = {
    remoteUrl: 'https://github.com/fixture-user/illithid-backup.git',
    token: 'ghu_fixture'
  }
  const child = backupGitEnvironment(auth.remoteUrl, auth, parent)
  assert.equal(child.GIT_TRACE, undefined)
  assert.equal(child.GIT_CURL_VERBOSE, undefined)
  assert.equal(
    child.GIT_CONFIG_KEY_1,
    'http.https://github.com/fixture-user/illithid-backup.git.extraHeader'
  )
  assert.equal(child.GIT_CONFIG_KEY_2, 'http.followRedirects')
  assert.equal(child.GIT_CONFIG_VALUE_2, 'false')
  assert.equal(parent.GIT_CONFIG_VALUE_0, 'inherited')
  const { inspect } = await import('node:util')
  assert.equal(inspect({ env: child }).includes(child.GIT_CONFIG_VALUE_1!), false)
  const config = (url: string): string =>
    execFileSync('git', ['config', '--get-urlmatch', 'http.extraHeader', url], {
      env: child,
      encoding: 'utf8'
    })
  assert.ok(config(auth.remoteUrl).includes(child.GIT_CONFIG_VALUE_1!))
  assert.equal(config('https://github.com/another-user/another-repo.git').trim(), '')
  assert.throws(
    () => backupGitEnvironment('https://evil.test/backup.git', auth, parent),
    /invalidRemote/
  )
})
