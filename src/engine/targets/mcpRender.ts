import { isSecretRef, MissingSecretError, resolveSecret, type SecretBackend } from '../secrets'
import { TargetError, type Env, type McpServer } from '../types'

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export type RenderSyntax = 'claude' | 'opencode' | 'literal'

/**
 * Converts SSOT values to each tool's syntax.
 * - `secret:` references are fetched from the backend as literals (MissingSecretError if missing — a per-server error)
 * - ${VAR} stays as-is for claude, becomes {env:VAR} for opencode, and literal resolves from env (TargetError if missing)
 */
export function renderValue(
  value: string,
  syntax: RenderSyntax,
  env: Env,
  secrets?: SecretBackend
): string {
  if (isSecretRef(value)) return secretValue(value, secrets)
  if (syntax === 'claude') return value // Claude expands ${VAR} itself
  if (syntax === 'opencode') return value.replace(PLACEHOLDER, (_, v) => `{env:${v}}`)
  if (syntax === 'literal') {
    return value.replace(PLACEHOLDER, (_, v: string) => {
      const resolved = env[v]
      if (resolved === undefined) {
        throw new TargetError(`environment variable ${v} is not set — this target needs a literal, so it is not generated`)
      }
      return resolved
    })
  }
  throw new Error(`unknown syntax ${syntax as string}`)
}

/** secret: reference -> value. MissingSecretError if there is no backend or no value */
export function secretValue(ref: string, secrets?: SecretBackend): string {
  if (!secrets) throw new MissingSecretError(ref.slice('secret:'.length))
  return resolveSecret(ref, secrets)
}

/**
 * Headers of an http server (SSOT form, before rendering). bearerEnv -> `Bearer ${VAR}`, bearerToken -> token reference in Authorization.
 * bearerToken holds only the token, so `Bearer ` must be prepended at render time -> returned separately as bearerRef.
 */
export function httpHeaders(s: McpServer): { headers: Record<string, string>; bearerRef?: string } {
  const headers: Record<string, string> = { ...(s.headers ?? {}) }
  if (s.bearerEnv) headers.Authorization = `Bearer \${${s.bearerEnv}}`
  if (typeof s.bearerToken === 'string' && s.bearerToken) {
    delete headers.Authorization
    return { headers, bearerRef: s.bearerToken }
  }
  return { headers }
}

/** Renders http headers for the given syntax (including bearerToken) */
export function renderHttpHeaders(
  s: McpServer,
  syntax: RenderSyntax,
  env: Env,
  secrets?: SecretBackend
): Record<string, string> {
  const { headers, bearerRef } = httpHeaders(s)
  const out = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, renderValue(v, syntax, env, secrets)])
  )
  if (bearerRef) out.Authorization = `Bearer ${secretValue(bearerRef, secrets)}`
  return out
}

/** Whether the exception should be treated as a per-server error (missing secret, backend failure) */
export function isServerError(e: unknown): e is Error {
  return e instanceof MissingSecretError || (e instanceof Error && e.name === 'SecretError')
}

/** If a header value is exactly one ${VAR}, returns the variable name (for Codex env_http_headers) */
export function bareEnvName(value: string): string | null {
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
  return m ? m[1] : null
}
