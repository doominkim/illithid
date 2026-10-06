/** GitHub credentials are sealed by the OS and stored outside every workspace backup. */
import { app, safeStorage } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GitHubBackup, GitHubBackupError } from '../engine/githubBackup'
import { atomicWrite } from '../engine/write'
import { workspaceRoot } from '../engine/config'

let client: GitHubBackup | undefined
function storageReady(): void {
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
  )
    throw new GitHubBackupError('secureStorageUnavailable')
}
export function githubBackup(): GitHubBackup {
  if (client) return client
  const path = join(app.getPath('userData'), 'github-backup-auth.enc')
  client = new GitHubBackup({
    clientId:
      import.meta.env.MAIN_VITE_GITHUB_APP_CLIENT_ID ||
      process.env.ILLITHID_GITHUB_APP_CLIENT_ID ||
      'Iv23liRVxwaWmdfVT4oz',
    appSlug:
      import.meta.env.MAIN_VITE_GITHUB_APP_SLUG ||
      process.env.ILLITHID_GITHUB_APP_SLUG ||
      'illithid-backup',
    store: {
      read: () => {
        if (!existsSync(path)) return null
        storageReady()
        return JSON.parse(
          safeStorage.decryptString(Buffer.from(readFileSync(path, 'utf8'), 'base64'))
        )
      },
      write: (value) => {
        storageReady()
        atomicWrite(path, safeStorage.encryptString(JSON.stringify(value)).toString('base64'), {
          mode: 0o600
        })
      },
      clear: () => {
        storageReady()
        atomicWrite(path, safeStorage.encryptString('null').toString('base64'), { mode: 0o600 })
      }
    }
  })
  // Each IPC request that needs the stored identity explicitly waits for initialization.
  return client
}
let ready: Promise<unknown> | undefined
export async function githubReady(): Promise<GitHubBackup> {
  const value = githubBackup()
  await (ready ??= value.restoreLogin())
  return value
}
const bindingsFile = (): string => join(app.getPath('userData'), 'github-backup-repositories.json')
function bindings(): Record<string, string> {
  if (!existsSync(bindingsFile())) return {}
  return JSON.parse(readFileSync(bindingsFile(), 'utf8')) as Record<string, string>
}
export function bindGithubBackup(root: string, remote: string): void {
  atomicWrite(bindingsFile(), JSON.stringify({ ...bindings(), [root]: remote }, null, 2), {
    mode: 0o600
  })
}
export function unbindGithubBackup(root: string): void {
  if (!existsSync(bindingsFile())) return
  const current = bindings()
  delete current[root]
  atomicWrite(bindingsFile(), JSON.stringify(current, null, 2), { mode: 0o600 })
}
export function githubAuthForWorkspace(
  home: string,
  workspaceId: string
): (() => ReturnType<GitHubBackup['gitCredentials']>) | undefined {
  try {
    const remote = bindings()[workspaceRoot(home, workspaceId)]
    return remote ? async () => (await githubReady()).gitCredentials(remote) : undefined
  } catch {
    // Resolve this failure inside the remote push phase, after the local snapshot is committed.
    return async () => {
      throw new GitHubBackupError('connectionFailed')
    }
  }
}
