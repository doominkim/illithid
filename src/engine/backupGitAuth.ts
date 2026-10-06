/** A credential is valid for one exact remote, never persisted in Git config or command arguments. */
import { inspect } from 'node:util'
export interface BackupGitAuth {
  remoteUrl: string
  token: string
}
export function backupGitEnvironment(
  remote: string,
  auth: BackupGitAuth,
  parent: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (
    remote !== auth.remoteUrl ||
    !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\.git$/.test(remote) ||
    !/^[A-Za-z0-9_]+$/.test(auth.token)
  )
    throw new Error('invalidRemote')
  const env = { ...parent }
  for (const key of Object.keys(env))
    if (
      key.startsWith('GIT_TRACE') ||
      key === 'GIT_CURL_VERBOSE' ||
      key.startsWith('GIT_CONFIG_KEY_') ||
      key.startsWith('GIT_CONFIG_VALUE_')
    )
      delete env[key]
  const config = [
    ['http.extraHeader', ''],
    // GitHub Actions may inject checkout credentials at the github.com host scope.
    ['http.https://github.com/.extraHeader', ''],
    [
      `http.${remote}.extraHeader`,
      `Authorization: Basic ${Buffer.from(`x-access-token:${auth.token}`).toString('base64')}`
    ],
    ['http.followRedirects', 'false'],
    ['credential.helper', '']
  ]
  env.GIT_CONFIG_COUNT = String(config.length)
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key
    env[`GIT_CONFIG_VALUE_${i}`] = value
  })
  env.GIT_TERMINAL_PROMPT = '0'
  // simple-git can inspect spawn options when DEBUG is enabled. Hide the entire child environment.
  Object.defineProperty(env, inspect.custom, { value: () => '[redacted Git environment]' })
  return env
}
