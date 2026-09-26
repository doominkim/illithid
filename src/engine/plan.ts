import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultSecretBackend, memoSecretBackend, type SecretBackend } from './secrets'
import { readSources } from './sources'
import { readState } from './state'
import { ALL_TARGETS, TARGETS } from './targets'
import { sha256 } from './text'
import {
  TargetError,
  type BuildContext,
  type Env,
  type FileChange,
  type Sources,
  type TargetDef,
  type TargetId
} from './types'

/** Hash of the target's owned region. null if there is no region */
export function regionHash(
  t: TargetDef,
  text: string,
  sources: Sources,
  ctx?: BuildContext
): string | null {
  const region = t.region(text, sources, ctx)
  return region === null ? null : sha256(region)
}

/**
 * Common context passed to plan (including previously owned entries from state).
 * If secrets is omitted, the default backend (macOS Keychain) is used. The backend is not called if there are no `secret:` references
 */
export function buildContext(
  home: string,
  sources: Sources,
  env: Env,
  secrets: SecretBackend = defaultSecretBackend()
): BuildContext {
  const owned = readState(home).state.owned
  return { sources, env, home, secrets: memoSecretBackend(secrets), ...(owned ? { owned } : {}) }
}

/** Plan for one target. Also used by apply to recompute when writing the same file in sequence */
export function planTarget(home: string, t: TargetDef, ctx: BuildContext): FileChange {
  const { sources } = ctx
  const path = join(home, t.rel)
  const label = `~/${t.rel}`
  const base = { id: t.id, path, label }

  if (!existsSync(path) && !t.optional) {
    return {
      ...base,
      before: '',
      after: '',
      changed: false,
      notes: [],
      error: 'file not found',
      beforeRegionHash: null,
      afterRegionHash: null
    }
  }
  const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const beforeRegionHash = regionHash(t, before, sources, ctx)

  try {
    const { after, notes, error, owned, serverErrors } = t.build(before, ctx)
    const change: FileChange = {
      ...base,
      before,
      after,
      changed: before !== after,
      notes,
      beforeRegionHash,
      afterRegionHash: regionHash(t, after, sources, ctx)
    }
    if (owned) change.owned = owned
    if (serverErrors && Object.keys(serverErrors).length) change.serverErrors = serverErrors
    if (error) change.error = error
    return change
  } catch (e) {
    if (!(e instanceof TargetError)) throw e
    return {
      ...base,
      before,
      after: before,
      changed: false,
      notes: [],
      error: e.message,
      beforeRegionHash,
      afterRegionHash: beforeRegionHash
    }
  }
}

/**
 * Library source -> target change plan. Writes no files.
 * Without ids, the 6 default targets (TARGETS); with ids, only those from ALL_TARGETS (in ALL_TARGETS order).
 * Per-target failures (file not found, parse failure, missing env var, change outside the owned scope) are returned as that change's error.
 */
export function plan(
  home: string,
  env: Env = process.env,
  ids?: readonly TargetId[],
  secrets?: SecretBackend
): FileChange[] {
  const sources = readSources(home)
  const ctx = buildContext(home, sources, env, secrets)
  const targets = ids ? ALL_TARGETS.filter((t) => ids.includes(t.id)) : TARGETS
  return targets.map((t) => planTarget(home, t, ctx))
}

/** Plan for all targets (ALL_TARGETS) */
export function planAll(home: string, env: Env = process.env, secrets?: SecretBackend): FileChange[] {
  return plan(
    home,
    env,
    ALL_TARGETS.map((t) => t.id),
    secrets
  )
}
