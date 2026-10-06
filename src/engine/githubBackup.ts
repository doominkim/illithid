/** GitHub App device login. Credentials remain behind this public, token-free interface. */
export interface GitHubLoginView {
  configured: boolean
  phase: 'signedOut' | 'pending' | 'signedIn'
  login?: string
  userCode?: string
  verificationUrl?: string
  expiresAt?: number
  error?: string
}
interface Credentials {
  token: string
  refreshToken?: string
  expiresAt?: number
  refreshExpiresAt?: number
  login: string
  userId: number
}
export interface CredentialStore {
  read(): unknown
  write(value: unknown): void
  clear(): void
}
interface Options {
  clientId: string
  appSlug: string
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  now?: () => number
  store: CredentialStore
}
export class GitHubBackupError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

export class GitHubBackup {
  private credentials: Credentials | null = null
  private pending: {
    code: string
    userCode: string
    expiresAt: number
    interval: number
    nextAt: number
  } | null = null
  private generation = 0
  private polling = false
  private refresh: Promise<string> | null = null
  private error?: string
  private readonly fetcher: NonNullable<Options['fetch']>
  private readonly now: () => number
  constructor(private readonly options: Options) {
    this.fetcher = options.fetch ?? fetch
    this.now = options.now ?? Date.now
  }
  private async request(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    try {
      const response = await this.fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(20000)
      })
      if (!response.ok)
        throw new GitHubBackupError(
          response.status === 401
            ? 'signInAgain'
            : response.status === 403
              ? 'permissionDenied'
              : response.status === 422
                ? 'repositoryExists'
                : 'githubUnavailable'
        )
      return (await response.json()) as Record<string, unknown>
    } catch (e) {
      if (e instanceof GitHubBackupError) throw e
      throw new GitHubBackupError('githubUnavailable')
    }
  }
  private async oauth(body: Record<string, string>): Promise<Record<string, unknown>> {
    return this.request('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString()
    })
  }
  status(): GitHubLoginView {
    return {
      configured: !!this.options.clientId && !!this.options.appSlug,
      phase: this.pending ? 'pending' : this.credentials ? 'signedIn' : 'signedOut',
      ...(this.credentials ? { login: this.credentials.login } : {}),
      ...(this.pending
        ? {
            userCode: this.pending.userCode,
            verificationUrl: 'https://github.com/login/device',
            expiresAt: this.pending.expiresAt
          }
        : {}),
      ...(this.error ? { error: this.error } : {})
    }
  }
  async start(): Promise<GitHubLoginView> {
    const generation = ++this.generation
    this.pending = null
    this.error = undefined
    if (!this.status().configured) throw new GitHubBackupError('notConfigured')
    const data = await this.request('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.options.clientId }).toString()
    })
    if (generation !== this.generation) return this.status()
    if (
      typeof data.device_code !== 'string' ||
      typeof data.user_code !== 'string' ||
      data.verification_uri !== 'https://github.com/login/device' ||
      !Number.isFinite(data.expires_in) ||
      !Number.isFinite(data.interval)
    )
      throw new GitHubBackupError('invalidResponse')
    const interval = Math.max(5, Number(data.interval)) * 1000
    this.pending = {
      code: data.device_code,
      userCode: data.user_code,
      expiresAt: this.now() + Number(data.expires_in) * 1000,
      interval,
      nextAt: this.now() + interval
    }
    return this.status()
  }
  cancel(): GitHubLoginView {
    ++this.generation
    this.pending = null
    this.error = undefined
    return this.status()
  }
  async poll(): Promise<GitHubLoginView> {
    const pending = this.pending
    if (!pending || this.polling) return this.status()
    if (this.now() >= pending.expiresAt) {
      this.pending = null
      this.error = 'expired'
      return this.status()
    }
    if (this.now() < pending.nextAt) return this.status()
    const generation = this.generation
    this.polling = true
    pending.nextAt = this.now() + pending.interval
    try {
      const data = await this.oauth({
        client_id: this.options.clientId,
        device_code: pending.code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
      if (generation !== this.generation) return this.status()
      if (data.error === 'authorization_pending') return this.status()
      if (data.error === 'slow_down') {
        pending.interval = Math.max(pending.interval + 5000, Number(data.interval || 0) * 1000)
        pending.nextAt = this.now() + pending.interval
        return this.status()
      }
      if (data.error)
        throw new GitHubBackupError(
          data.error === 'access_denied'
            ? 'denied'
            : data.error === 'expired_token'
              ? 'expired'
              : 'loginFailed'
        )
      if (typeof data.access_token !== 'string') throw new GitHubBackupError('invalidResponse')
      const user = await this.api('/user', data.access_token)
      if (generation !== this.generation) return this.status()
      if (typeof user.login !== 'string' || typeof user.id !== 'number')
        throw new GitHubBackupError('invalidResponse')
      const credentials: Credentials = {
        token: data.access_token,
        login: user.login,
        userId: user.id,
        ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : {}),
        ...(typeof data.expires_in === 'number'
          ? { expiresAt: this.now() + data.expires_in * 1000 }
          : {}),
        ...(typeof data.refresh_token_expires_in === 'number'
          ? { refreshExpiresAt: this.now() + data.refresh_token_expires_in * 1000 }
          : {})
      }
      this.options.store.write(credentials)
      this.credentials = credentials
      this.pending = null
    } catch (e) {
      if (generation === this.generation) {
        this.pending = null
        this.error = e instanceof GitHubBackupError ? e.code : 'secureStorageUnavailable'
      }
    } finally {
      this.polling = false
    }
    return this.status()
  }
  async restoreLogin(): Promise<GitHubLoginView> {
    try {
      const value = this.options.store.read() as Partial<Credentials> | null
      if (
        value &&
        typeof value.token === 'string' &&
        typeof value.login === 'string' &&
        typeof value.userId === 'number'
      )
        this.credentials = value as Credentials
    } catch {
      this.error = 'secureStorageUnavailable'
    }
    return this.status()
  }
  logout(): GitHubLoginView {
    this.cancel()
    this.options.store.clear()
    this.credentials = null
    return this.status()
  }
  installationUrl(): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(this.options.appSlug))
      throw new GitHubBackupError('notConfigured')
    return `https://github.com/apps/${this.options.appSlug}/installations/new`
  }
  private async token(): Promise<string> {
    const credentials = this.credentials
    if (!credentials) throw new GitHubBackupError('signInAgain')
    if (!credentials.expiresAt || credentials.expiresAt > this.now() + 60000)
      return credentials.token
    if (this.refresh) return this.refresh
    if (
      !credentials.refreshToken ||
      (credentials.refreshExpiresAt && credentials.refreshExpiresAt <= this.now())
    )
      throw new GitHubBackupError('signInAgain')
    const generation = this.generation
    this.refresh = (async () => {
      const data = await this.oauth({
        client_id: this.options.clientId,
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken!
      })
      if (
        generation !== this.generation ||
        data.error ||
        typeof data.access_token !== 'string' ||
        typeof data.refresh_token !== 'string' ||
        typeof data.expires_in !== 'number'
      )
        throw new GitHubBackupError('signInAgain')
      const next: Credentials = {
        ...credentials,
        token: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: this.now() + data.expires_in * 1000,
        ...(typeof data.refresh_token_expires_in === 'number'
          ? { refreshExpiresAt: this.now() + data.refresh_token_expires_in * 1000 }
          : {})
      }
      this.options.store.write(next)
      this.credentials = next
      return next.token
    })().finally(() => {
      this.refresh = null
    })
    return this.refresh
  }
  /** Main-process only: never expose these credentials over IPC. */
  async gitCredentials(remoteUrl: string): Promise<{ remoteUrl: string; token: string }> {
    const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\.git$/.exec(remoteUrl)
    if (!match || match[1].toLowerCase() !== this.credentials?.login.toLowerCase())
      throw new GitHubBackupError('invalidRemote')
    const token = await this.token()
    for (let page = 1; page <= 10; page++) {
      const data = await this.api(`/user/installations?per_page=100&page=${page}`, token)
      const installations = Array.isArray(data.installations)
        ? (data.installations as {
            id: number
            app_slug: string
            permissions?: { contents?: string }
            suspended_at?: string | null
          }[])
        : []
      for (const installation of installations) {
        if (
          installation.app_slug !== this.options.appSlug ||
          installation.permissions?.contents !== 'write' ||
          installation.suspended_at
        )
          continue
        for (let repoPage = 1; repoPage <= 20; repoPage++) {
          const result = await this.api(
            `/user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`,
            token
          )
          const repos = Array.isArray(result.repositories)
            ? (result.repositories as { full_name: string; private: boolean }[])
            : []
          if (
            repos.some(
              (repo) =>
                repo.private &&
                repo.full_name.toLowerCase() === `${match[1]}/${match[2]}`.toLowerCase()
            )
          )
            return { remoteUrl, token }
          if (repos.length < 100) break
        }
      }
      if (installations.length < 100) break
    }
    throw new GitHubBackupError('installationRequired')
  }
  async createRepository(name: string): Promise<{ id: number; name: string; url: string }> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) ||
      name.includes('..') ||
      name.endsWith('.git')
    )
      throw new GitHubBackupError('invalidRepositoryName')
    const token = await this.token()
    const repo = await this.api('/user/repos', token, {
      method: 'POST',
      body: JSON.stringify({
        name,
        private: true,
        auto_init: false,
        has_issues: false,
        has_projects: false,
        has_wiki: false,
        description: 'Private Illithid configuration backup'
      })
    })
    if (
      repo.private !== true ||
      typeof repo.id !== 'number' ||
      repo.clone_url !== `https://github.com/${this.credentials!.login}/${name}.git`
    )
      throw new GitHubBackupError('invalidResponse')
    return { id: repo.id, name, url: repo.clone_url as string }
  }
  private api(path: string, token: string, init?: RequestInit): Promise<Record<string, unknown>> {
    return this.request('https://api.github.com' + path, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2026-03-10',
        Authorization: `Bearer ${token}`
      }
    })
  }
}
