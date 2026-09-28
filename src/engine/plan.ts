import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toolHomeOverride } from './agents'
import { readConfig, syncTools } from './config'
import { activePending } from './pendingRetire'
import { defaultSecretBackend, memoSecretBackend, type SecretBackend } from './secrets'
import { readPlanSources } from './sources'
import { readState } from './state'
import { ALL_TARGETS, MCP_TARGET_TOOL, serverChanges, TARGETS } from './targets'
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
  const st = readState(home).state
  const owned = st.owned
  const pendingRetire = activePending(home, st.pendingRetire)
  const applied = Object.fromEntries(Object.entries(st.applied).map(([id, v]) => [id, v.regionHash]))
  return {
    sources,
    env,
    home,
    secrets: memoSecretBackend(secrets),
    ...(owned ? { owned } : {}),
    ...(Object.keys(applied).length ? { applied } : {}),
    ...(pendingRetire.length ? { pendingRetire } : {})
  }
}

/** Plan for one target. Also used by apply to recompute when writing the same file in sequence */
export function planTarget(home: string, t: TargetDef, planCtx: BuildContext): FileChange {
  // A retiring tool (every item off via offTools) also loses the memory index and leaves permissions as they are
  const retiring = !!planCtx.sources.manifest?.offTools?.includes(t.tool)
  const ctx: BuildContext = retiring
    ? { ...planCtx, retiring, sources: { ...planCtx.sources, memoryIndex: null, hasPermissions: false } }
    : planCtx
  const { sources } = ctx
  const path = join(home, t.rel)
  const label = `~/${t.rel}`
  const base = { id: t.id, path, label }

  const exists = existsSync(path)
  const seed = t.seed ?? ''
  const override = toolHomeOverride(home, t.tool, ctx.env)
  if (override)
    return {
      ...base,
      before: exists ? readFileSync(path, 'utf8') : '',
      after: exists ? readFileSync(path, 'utf8') : '',
      changed: false,
      notes: [
        t.tool === 'grok'
          ? `GROK_HOME is set to another folder — Grok doesn't read ~/.grok, so nothing is written`
          : `COPILOT_HOME is set to another folder — Copilot doesn't read ~/.copilot, so nothing is written`
      ],
      skip: t.tool === 'grok' ? 'grokHomeOverride' : 'copilotHomeOverride',
      beforeRegionHash: null,
      afterRegionHash: null
    }
  if (!exists) {
    // Missing file: only matters if the library has something for it (a build from the seed yields an owned region)
    let has = true
    try {
      has = regionHash(t, t.build(seed, ctx).after, sources, ctx) !== null
    } catch (e) {
      if (!(e instanceof TargetError)) throw e
    }
    const absent = (skip: NonNullable<FileChange['skip']>, notes: string[]): FileChange => ({
      ...base,
      before: '',
      after: '',
      changed: false,
      notes,
      skip,
      beforeRegionHash: null,
      afterRegionHash: null
    })
    if (!has || retiring) return absent('nothingToWrite', [`${label} absent — nothing to write`])
    const alternate = (t.alternates ?? []).find((r) => existsSync(join(home, r)))
    if (alternate) return absent('toolNotInitialized', [`${label} absent — ~/${alternate} is used instead, not creating a second file`])
    const creatable = t.optional || (!!t.createIfInUse && !!readConfig(home).config.toolsInUse?.includes(t.tool))
    if (!creatable) return absent('toolNotInitialized', [`${label} absent — run the tool once so it creates it`])
  }
  const before = exists ? readFileSync(path, 'utf8') : ''
  const beforeRegionHash = regionHash(t, before, sources, ctx)

  try {
    const { after, notes, error, owned, serverErrors, retired, importedChanged } = t.build(exists ? before : seed, ctx)
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
    if (change.changed && MCP_TARGET_TOOL[t.id]) {
      const servers = serverChanges(t.id, before, after)
      if (servers.length) change.servers = servers
    }
    if (retired?.length) change.retired = retired
    if (importedChanged?.length) change.importedChanged = importedChanged
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
 * Targets of tools not in use (config.toolsInUse) are left out — apply() re-plans through here, so they are never written either.
 */
export function plan(
  home: string,
  env: Env = process.env,
  ids?: readonly TargetId[],
  secrets?: SecretBackend
): FileChange[] {
  const sources = readPlanSources(home)
  const ctx = buildContext(home, sources, env, secrets)
  const inUse = syncTools(home)
  const targets = (ids ? ALL_TARGETS.filter((t) => ids.includes(t.id)) : TARGETS).filter((t) => inUse.includes(t.tool))
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
