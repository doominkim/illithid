/**
 * MCP secret store. The library keeps only `secret:<server>/<headers|env>/<KEY>` references;
 * actual values live in a backend (default: macOS Keychain, service `Illithid`). Sync writes them as literals into tool config files.
 * Values under the previous app-name service (`HarnessSync`) are read when missing from the new one (writes go to the new service, deletes hit both).
 *
 * - The engine does not depend on electron. Every function takes a SecretBackend (fixtures use memory/file backends).
 * - Error messages contain only account names (server and key names). Never values.
 * - The macOS `security` CLI is invoked via execFile (no shell strings).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWrite } from './write'

export const SECRET_SERVICE = 'Illithid'
/** Keychain services from previous app names (newest first). Used only as a read fallback */
export const LEGACY_SECRET_SERVICES = ['HarnessSync'] as const
export const SECRET_PREFIX = 'secret:'
export type SecretTable = 'headers' | 'env'

export type SecretErrorCode =
  'unsupportedPlatform' | 'backendFailed' | 'invalidValue' | 'invalidRef'

export class SecretError extends Error {
  constructor(
    public code: SecretErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SecretError'
  }
}

/** Secret store. account = `<server>/<headers|env>/<KEY>` */
export interface SecretBackend {
  /** null if absent */
  get(account: string): string | null
  /** Overwrites if present */
  set(account: string, value: string): void
  /** true if deleted, false if absent */
  delete(account: string): boolean
}

// ---------------------------------------------------------------- Reference format

const SERVER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const KEY_RE = /^[^/\s]{1,128}$/
const REF_RE = /^secret:([a-z0-9][a-z0-9._-]{0,63})\/(headers|env)\/([^/\s]{1,128})$/

export interface SecretRef {
  account: string
  server: string
  table: SecretTable
  key: string
}

export function secretAccount(server: string, table: SecretTable, key: string): string {
  if (!SERVER_RE.test(server) || server.includes('..'))
    throw new SecretError('invalidRef', 'Invalid server name')
  if (table !== 'headers' && table !== 'env')
    throw new SecretError('invalidRef', 'table must be headers | env')
  if (!KEY_RE.test(key)) throw new SecretError('invalidRef', `${table} key is invalid`)
  return `${server}/${table}/${key}`
}

/** `secret:<server>/<table>/<KEY>` */
export function secretRef(server: string, table: SecretTable, key: string): string {
  return SECRET_PREFIX + secretAccount(server, table, key)
}

export function isSecretRef(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith(SECRET_PREFIX)
}

/** Parse if well-formed, otherwise null */
export function parseSecretRef(v: string): SecretRef | null {
  const m = REF_RE.exec(v)
  if (!m || m[1].includes('..')) return null
  return { account: `${m[1]}/${m[2]}/${m[3]}`, server: m[1], table: m[2] as SecretTable, key: m[3] }
}

/** Value check: non-empty printable ASCII (the range where Keychain -w output is not turned into hex) */
export function assertStorableSecret(value: string): void {
  if (typeof value !== 'string' || !value)
    throw new SecretError('invalidValue', 'Secret value is empty')
  if (!/^[\x20-\x7e]+$/.test(value))
    throw new SecretError('invalidValue', 'Secret values must be printable ASCII')
}

// ---------------------------------------------------------------- Backends

/** In-memory backend for tests */
export function memorySecretBackend(initial: Record<string, string> = {}): SecretBackend & {
  entries(): Record<string, string>
} {
  const m = new Map(Object.entries(initial))
  return {
    get: (a) => m.get(a) ?? null,
    set: (a, v) => {
      assertStorableSecret(v)
      m.set(a, v)
    },
    delete: (a) => m.delete(a),
    entries: () => Object.fromEntries(m)
  }
}

/** File backend for tests (JSON, 0600). Used to pass values between processes */
export function fileSecretBackend(path: string): SecretBackend {
  const load = (): Record<string, string> => {
    if (!existsSync(path)) return {}
    try {
      const o = JSON.parse(readFileSync(path, 'utf8')) as unknown
      return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, string>) : {}
    } catch {
      throw new SecretError('backendFailed', 'Failed to parse secrets file')
    }
  }
  const save = (o: Record<string, string>): void => {
    atomicWrite(path, JSON.stringify(o, null, 2) + '\n', { mode: 0o600 })
  }
  return {
    get: (a) => load()[a] ?? null,
    set: (a, v) => {
      assertStorableSecret(v)
      save({ ...load(), [a]: v })
    },
    delete: (a) => {
      const o = load()
      if (!(a in o)) return false
      delete o[a]
      save(o)
      return true
    }
  }
}

/** `security` exit code for "item not found" (errSecItemNotFound) */
const SEC_NOT_FOUND = 44

export interface KeychainOptions {
  service?: string
  /** security binary path for tests */
  bin?: string
}

/**
 * macOS Keychain (login keychain, generic password). Invokes the `security` CLI via execFile.
 * Caveat: add passes the value as `-w <value>`, so it is visible in process args while running (a security CLI limitation).
 */
export function macKeychainBackend(opts: KeychainOptions = {}): SecretBackend {
  if (process.platform !== 'darwin')
    throw new SecretError(
      'unsupportedPlatform',
      'Secret storage is only supported via the macOS Keychain'
    )
  const service = opts.service ?? SECRET_SERVICE
  const bin = opts.bin ?? '/usr/bin/security'
  const run = (args: string[]): { code: number; out: string } => {
    try {
      const out = execFileSync(bin, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        maxBuffer: 1024 * 1024
      })
      return { code: 0, out }
    } catch (e) {
      const status = (e as { status?: number | null }).status
      // stderr has no values, but it is still not passed through
      return { code: typeof status === 'number' ? status : -1, out: '' }
    }
  }
  return {
    get(account) {
      const r = run(['find-generic-password', '-s', service, '-a', account, '-w'])
      if (r.code === SEC_NOT_FOUND) return null
      if (r.code !== 0)
        throw new SecretError('backendFailed', `Keychain read failed (${account}, exit ${r.code})`)
      return r.out.endsWith('\n') ? r.out.slice(0, -1) : r.out
    },
    set(account, value) {
      assertStorableSecret(value)
      const r = run([
        'add-generic-password',
        '-U',
        '-s',
        service,
        '-a',
        account,
        '-l',
        `${service} ${account}`,
        '-w',
        value
      ])
      if (r.code !== 0)
        throw new SecretError('backendFailed', `Keychain write failed (${account}, exit ${r.code})`)
    },
    delete(account) {
      const r = run(['delete-generic-password', '-s', service, '-a', account])
      if (r.code === SEC_NOT_FOUND) return false
      if (r.code !== 0)
        throw new SecretError(
          'backendFailed',
          `Keychain delete failed (${account}, exit ${r.code})`
        )
      return true
    }
  }
}

/** Backend that errors on use (default on non-macOS platforms). Never called if there are no references */
export function unsupportedSecretBackend(): SecretBackend {
  const fail = (): never => {
    throw new SecretError(
      'unsupportedPlatform',
      'Secret storage is only supported via the macOS Keychain'
    )
  }
  return { get: fail, set: fail, delete: fail }
}

/**
 * Previous-service fallback: reads try legacy in order when missing from primary; writes go to primary only.
 * Deletes also hit legacy (so a deleted value does not come back via fallback)
 */
export function withLegacySecrets(primary: SecretBackend, legacy: SecretBackend[]): SecretBackend {
  return {
    get(a) {
      const v = primary.get(a)
      if (v !== null) return v
      for (const b of legacy) {
        const x = b.get(a)
        if (x !== null) return x
      }
      return null
    },
    set: (a, v) => primary.set(a, v),
    delete(a) {
      let removed = primary.delete(a)
      for (const b of legacy) removed = b.delete(a) || removed
      return removed
    }
  }
}

let defaultBackend: SecretBackend | null = null

/** Default backend for the app and CLI: Keychain on macOS, an explicit error elsewhere. Created on first use */
export function defaultSecretBackend(): SecretBackend {
  if (defaultBackend) return defaultBackend
  let inner: SecretBackend | null = null
  const lazy = (): SecretBackend =>
    (inner ??=
      process.platform === 'darwin'
        ? withLegacySecrets(
            macKeychainBackend(),
            LEGACY_SECRET_SERVICES.map((service) => macKeychainBackend({ service }))
          )
        : unsupportedSecretBackend())
  defaultBackend = {
    get: (a) => lazy().get(a),
    set: (a, v) => lazy().set(a, v),
    delete: (a) => lazy().delete(a)
  }
  return defaultBackend
}

/** Caches get so one computation does not read the same account repeatedly (set/delete pass through and clear the cache) */
export function memoSecretBackend(b: SecretBackend): SecretBackend {
  const memo = new Map<string, string | null>()
  return {
    get(a) {
      if (!memo.has(a)) memo.set(a, b.get(a))
      return memo.get(a)!
    },
    set(a, v) {
      memo.delete(a)
      b.set(a, v)
    },
    delete(a) {
      memo.delete(a)
      return b.delete(a)
    }
  }
}

// ---------------------------------------------------------------- Server definition helpers

/** Whether the value is a ${VAR} reference to store as is (the app keeps it out of the Keychain) */
export function isEnvRefValue(v: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(v)
}

/** Collect every secret: reference in a server definition (headers, env, bearerToken) */
export function secretRefsOf(def: unknown): SecretRef[] {
  const out: SecretRef[] = []
  if (!def || typeof def !== 'object') return out
  const d = def as Record<string, unknown>
  const push = (v: unknown): void => {
    if (typeof v === 'string' && isSecretRef(v)) {
      const r = parseSecretRef(v)
      if (r) out.push(r)
    }
  }
  for (const t of ['headers', 'env'] as const) {
    const o = d[t]
    if (o && typeof o === 'object' && !Array.isArray(o)) Object.values(o).forEach(push)
  }
  push(d.bearerToken)
  return out
}

/** secret: reference → actual value. SecretError(invalidRef) if malformed, MissingSecretError if absent */
export function resolveSecret(ref: string, backend: SecretBackend): string {
  const r = parseSecretRef(ref)
  if (!r) throw new SecretError('invalidRef', 'Invalid secret reference')
  const v = backend.get(r.account)
  if (v === null) throw new MissingSecretError(r.account)
  return v
}

/** Value missing from the backend (message has the account name only) */
export class MissingSecretError extends Error {
  constructor(public account: string) {
    super(`Missing secret: ${account}`)
    this.name = 'MissingSecretError'
  }
}
