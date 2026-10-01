/**
 * Library hooks: `hooks/<name>/hook.json` plus the script files next to it.
 *
 *   hook.json  { description, timing, script, toolScripts?, triggers }
 *   run.sh     shared script (any file name; `script` points at it)
 *   run.<tool>.sh  optional tool-specific scripts (`toolScripts[tool]`)
 *
 * Triggers say which tools the hook is connected to and with which native event. Per-tool on/off lives in illithid.json
 * like the other kinds. Timeouts are stored in seconds; each tool's writer converts to its own unit.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { libraryPaths } from './sources'
import {
  HOOK_TIMINGS,
  hookEventInfo,
  isHookTool,
  type HookTiming,
  type HookTool
} from './hookEvents'

export const HOOKS_DIR = 'hooks'
export const HOOK_FILE = 'hook.json'
export const SHARED_SCRIPT = 'run.sh'
export const HOOK_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const SCRIPT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** Longest timeout accepted, in seconds */
export const MAX_HOOK_TIMEOUT = 3600

export interface HookTrigger {
  event: string
  matcher?: string
  /** Seconds */
  timeout?: number
}

export interface HookDef {
  description: string
  timing: HookTiming
  /** Shared script file in the hook folder */
  script: string
  /** Tool-specific script files used instead of the shared one */
  toolScripts?: Partial<Record<HookTool, string>>
  triggers: Partial<Record<HookTool, HookTrigger>>
}

export interface LibraryHook {
  name: string
  def: HookDef
  /** Script file name → content (only the files hook.json points at) */
  scripts: Record<string, string>
}

export function hooksDir(home: string): string {
  return join(libraryPaths(home).root, HOOKS_DIR)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Schema problems of a hook.json value (empty when valid). File existence is checked by the caller */
export function validateHookDef(v: unknown): string[] {
  if (!isObj(v)) return ['hook.json is not an object']
  const errors: string[] = []
  if (typeof v.description !== 'string') errors.push('description must be a string')
  if (!(HOOK_TIMINGS as readonly unknown[]).includes(v.timing))
    errors.push(`unknown timing: ${String(v.timing)}`)
  if (typeof v.script !== 'string' || !SCRIPT_NAME_RE.test(v.script))
    errors.push('script must be a file name in the hook folder')
  if (v.toolScripts !== undefined) {
    if (!isObj(v.toolScripts)) errors.push('toolScripts must be an object')
    else
      for (const [tool, file] of Object.entries(v.toolScripts)) {
        if (!isHookTool(tool)) errors.push(`toolScripts.${tool}: not a hook tool`)
        else if (typeof file !== 'string' || !SCRIPT_NAME_RE.test(file))
          errors.push(`toolScripts.${tool} must be a file name`)
      }
  }
  if (!isObj(v.triggers)) errors.push('triggers must be an object')
  else
    for (const [tool, t] of Object.entries(v.triggers)) {
      if (!isHookTool(tool)) {
        errors.push(`triggers.${tool}: not a hook tool`)
        continue
      }
      if (!isObj(t) || typeof t.event !== 'string') {
        errors.push(`triggers.${tool}.event is required`)
        continue
      }
      const info = hookEventInfo(tool, t.event)
      if (!info) errors.push(`triggers.${tool}: ${t.event} is not a ${tool} event`)
      if (t.matcher !== undefined) {
        if (typeof t.matcher !== 'string') errors.push(`triggers.${tool}.matcher must be a string`)
        else if (info && !info.matcher) errors.push(`triggers.${tool}: ${t.event} takes no matcher`)
      }
      if (
        t.timeout !== undefined &&
        (typeof t.timeout !== 'number' ||
          !Number.isInteger(t.timeout) ||
          t.timeout < 1 ||
          t.timeout > MAX_HOOK_TIMEOUT)
      )
        errors.push(
          `triggers.${tool}.timeout must be whole seconds between 1 and ${MAX_HOOK_TIMEOUT}`
        )
    }
  return errors
}

/** Script files a hook points at: the shared one and every tool-specific one */
export function hookScriptFiles(def: HookDef): string[] {
  return [...new Set([def.script, ...Object.values(def.toolScripts ?? {})])].filter(
    (f): f is string => typeof f === 'string'
  )
}

/** Script a tool runs (its own if it has one, else the shared one) */
export function scriptForTool(def: HookDef, tool: HookTool): string {
  return def.toolScripts?.[tool] ?? def.script
}

/** Hook names in the library (folders with a hook.json), sorted */
export function hookNames(home: string): string[] {
  const dir = hooksDir(home)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => HOOK_NAME_RE.test(n) && existsSync(join(dir, n, HOOK_FILE)))
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort()
}

/** One hook. Throws on a broken hook.json or a missing script (the source is broken — not a per-target error) */
export function readHook(home: string, name: string): LibraryHook {
  const dir = join(hooksDir(home), name)
  const raw = JSON.parse(readFileSync(join(dir, HOOK_FILE), 'utf8')) as unknown
  const errors = validateHookDef(raw)
  if (errors.length) throw new Error(`hooks/${name}/${HOOK_FILE}: ${errors.join('; ')}`)
  const def = raw as HookDef
  const scripts: Record<string, string> = {}
  for (const file of hookScriptFiles(def)) {
    const p = join(dir, file)
    if (!existsSync(p)) throw new Error(`hooks/${name}/${file}: script not found`)
    scripts[file] = readFileSync(p, 'utf8')
  }
  return { name, def, scripts }
}

export function readHooks(home: string): LibraryHook[] {
  return hookNames(home).map((n) => readHook(home, n))
}
