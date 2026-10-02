/**
 * Library hooks: `hooks/<name>/HOOK.md`, shaped like a skill.
 *
 *   ---
 *   name: notify-done
 *   description: Tell me when the reply is done
 *   when: stop                 # timing (hookEvents.ts)
 *   action: notify             # what it does (hookActions.ts)
 *   options: {"message":"Done"}
 *   tools: {"gemini":{"timeout":10}}        # optional per-tool overrides (event, matcher, timeout)
 *   toolScripts: {"copilot":"run.copilot.sh"}  # script action only
 *   ---
 *   body: the instruction for ask, notes otherwise
 *
 * Built-in actions need no script in the library — each tool gets one rendered at sync time. The script action keeps its own
 * run.sh (and optional run.<tool>.sh). Per-tool on/off lives in illithid.json like the other kinds; every tool that can run the
 * hook is on unless turned off there.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import {
  actionMatcher,
  ENV_NAME_RE,
  HOOK_ACTION_INFO,
  PROTECT_PATTERN_RE,
  hookSupport,
  isHookAction,
  type HookAction
} from './hookActions'
import {
  defaultHookEvent,
  HOOK_TIMINGS,
  HOOK_TOOLS,
  hookEventInfo,
  isHookTool,
  type HookTiming,
  type HookTool
} from './hookEvents'
import { LIBRARY_SCRIPT_RE, readScript } from './scripts'
import { libraryPaths } from './sources'

export const HOOKS_DIR = 'hooks'
export const HOOK_FILE = 'HOOK.md'
export const SHARED_SCRIPT = 'run.sh'
export const HOOK_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const SCRIPT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** Longest timeout accepted, in seconds */
export const MAX_HOOK_TIMEOUT = 3600

export type HookOptionValue = string | boolean | string[]

/** Advanced per-tool settings; anything left out comes from the timing and the action */
export interface HookToolSettings {
  event?: string
  matcher?: string
  /** Seconds */
  timeout?: number
}

export interface HookDoc {
  description: string
  when: HookTiming
  action: HookAction
  /** Action options, with the action defaults filled in */
  options: Record<string, HookOptionValue>
  tools?: Partial<Record<HookTool, HookToolSettings>>
  /** Script action: tool-specific scripts used instead of run.sh */
  toolScripts?: Partial<Record<HookTool, string>>
  /** ask: the instruction. Otherwise free notes */
  body: string
  /** The tool it was imported from (left out for hooks made here) */
  importedFrom?: HookTool
}

/** A tool's trigger for a hook: its own event, the matcher and timeout to write */
export interface HookTrigger {
  event: string
  matcher?: string
  /** Seconds */
  timeout?: number
}

export interface LibraryHook {
  name: string
  doc: HookDoc
  /** Script action: script file name → content. Empty for the other actions */
  scripts: Record<string, string>
  /** Script action running a folder library script: the tools run its entry from one shared copy */
  folder?: { name: string; entry: string }
}

export function hooksDir(home: string): string {
  return join(libraryPaths(home).root, HOOKS_DIR)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

const sameType = (v: unknown, def: HookOptionValue): boolean =>
  Array.isArray(def)
    ? Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '')
    : typeof v === typeof def

/** Action options with the defaults filled in (unknown keys dropped) */
export function hookOptions(action: HookAction, given: unknown): Record<string, HookOptionValue> {
  const defaults = HOOK_ACTION_INFO[action].defaults
  const out: Record<string, HookOptionValue> = {}
  for (const [k, d] of Object.entries(defaults)) {
    const v = isObj(given) ? given[k] : undefined
    out[k] = v !== undefined && sameType(v, d) ? (v as HookOptionValue) : d
  }
  return out
}

/** Schema problems of a hook (empty when valid). File existence is checked by the caller */
export function validateHookDoc(v: unknown): string[] {
  if (!isObj(v)) return ['the hook is not an object']
  const errors: string[] = []
  if (typeof v.description !== 'string') errors.push('description must be a string')
  if (typeof v.body !== 'string') errors.push('body must be a string')
  const whenOk = (HOOK_TIMINGS as readonly unknown[]).includes(v.when)
  if (!whenOk) errors.push(`unknown timing: ${String(v.when)}`)
  if (!isHookAction(v.action)) {
    errors.push(`unknown action: ${String(v.action)}`)
    return errors
  }
  const info = HOOK_ACTION_INFO[v.action]
  if (whenOk && !info.timings.includes(v.when as HookTiming))
    errors.push(`${v.action} does not run at ${String(v.when)}`)
  if (v.options !== undefined && !isObj(v.options)) errors.push('options must be an object')
  else
    for (const [k, val] of Object.entries(v.options ?? {})) {
      const d = info.defaults[k]
      if (d === undefined) errors.push(`options.${k}: not an option of ${v.action}`)
      else if (!sameType(val, d))
        errors.push(`options.${k} must be ${Array.isArray(d) ? 'a list of texts' : typeof d}`)
      else if (info.choices?.[k] && !info.choices[k].includes(val as string))
        errors.push(`options.${k} must be one of ${info.choices[k].join(', ')}`)
      else if (k === 'urlEnv' && val && !ENV_NAME_RE.test(val as string))
        errors.push('options.urlEnv must be an environment variable name')
      else if (
        v.action === 'protect' &&
        k === 'patterns' &&
        !(val as string[]).every((p) => PROTECT_PATTERN_RE.test(p))
      )
        errors.push('options.patterns: file patterns may use letters, digits and . _ - / * ?')
    }
  if (
    v.action === 'script' &&
    isObj(v.options) &&
    typeof v.options.use === 'string' &&
    v.options.use &&
    !LIBRARY_SCRIPT_RE.test(v.options.use)
  )
    errors.push('options.use must be a script name')
  if (v.action === 'ask' && typeof v.body === 'string' && !v.body.trim())
    errors.push('ask needs an instruction')
  if (v.importedFrom !== undefined && !(HOOK_TOOLS as readonly unknown[]).includes(v.importedFrom))
    errors.push(`importedFrom: unknown tool ${String(v.importedFrom)}`)
  if (v.tools !== undefined) {
    if (!isObj(v.tools)) errors.push('tools must be an object')
    else
      for (const [tool, s] of Object.entries(v.tools)) {
        if (!isHookTool(tool)) {
          errors.push(`tools.${tool}: not a hook tool`)
          continue
        }
        if (!isObj(s)) {
          errors.push(`tools.${tool} must be an object`)
          continue
        }
        const info2 = typeof s.event === 'string' ? hookEventInfo(tool, s.event) : null
        if (s.event !== undefined && !info2)
          errors.push(`tools.${tool}: ${String(s.event)} is not a ${tool} event`)
        if (s.matcher !== undefined && typeof s.matcher !== 'string')
          errors.push(`tools.${tool}.matcher must be a string`)
        if (
          s.timeout !== undefined &&
          (typeof s.timeout !== 'number' ||
            !Number.isInteger(s.timeout) ||
            s.timeout < 1 ||
            s.timeout > MAX_HOOK_TIMEOUT)
        )
          errors.push(
            `tools.${tool}.timeout must be whole seconds between 1 and ${MAX_HOOK_TIMEOUT}`
          )
      }
  }
  if (v.toolScripts !== undefined) {
    if (v.action !== 'script') errors.push('toolScripts is only for the script action')
    else if (!isObj(v.toolScripts)) errors.push('toolScripts must be an object')
    else
      for (const [tool, file] of Object.entries(v.toolScripts)) {
        if (!isHookTool(tool)) errors.push(`toolScripts.${tool}: not a hook tool`)
        else if (typeof file !== 'string' || !SCRIPT_NAME_RE.test(file))
          errors.push(`toolScripts.${tool} must be a file name`)
      }
  }
  return errors
}

/** Each tool that can run the hook → its trigger. Tools that can't (timing, missing event, action limits) are left out */
export function hookTriggers(doc: HookDoc): Partial<Record<HookTool, HookTrigger>> {
  const out: Partial<Record<HookTool, HookTrigger>> = {}
  for (const tool of HOOK_TOOLS) {
    if (hookSupport(doc.action, doc.when, tool) !== 'ok') continue
    const s = doc.tools?.[tool] ?? {}
    const event = s.event ?? defaultHookEvent(tool, doc.when)!
    const takesMatcher = !!hookEventInfo(tool, event)?.matcher
    const matcher = s.matcher ?? actionMatcher(doc.action, tool, doc.when, doc.options)
    const timeout = s.timeout ?? HOOK_ACTION_INFO[doc.action].timeout
    out[tool] = {
      event,
      ...(takesMatcher && matcher ? { matcher } : {}),
      ...(timeout !== undefined ? { timeout } : {})
    }
  }
  return out
}

/** Script a tool runs for the script action */
export function scriptForTool(doc: HookDoc, tool: HookTool): string {
  return doc.toolScripts?.[tool] ?? SHARED_SCRIPT
}

/** Library script a script-action hook runs instead of its own run.sh (null when none) */
export function usedScript(doc: HookDoc): string | null {
  return doc.action === 'script' && typeof doc.options.use === 'string' && doc.options.use
    ? doc.options.use
    : null
}

/** Script files a script-action hook keeps in its folder (run.sh unless it uses a library script, and tool-only ones) */
export function hookScriptFiles(doc: HookDoc): string[] {
  if (doc.action !== 'script') return []
  const own = usedScript(doc) ? [] : [SHARED_SCRIPT]
  return [...new Set([...own, ...Object.values(doc.toolScripts ?? {})])].filter(
    (f): f is string => typeof f === 'string'
  )
}

/** YAML-safe text: JSON strings and flow maps are valid YAML */
const y = (v: unknown): string => JSON.stringify(v)

/** HOOK.md text for a hook (the app owns the format: always written whole) */
export function renderHookDoc(name: string, doc: HookDoc): string {
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${y(doc.description)}`,
    `when: ${doc.when}`,
    `action: ${doc.action}`,
    `options: ${y(doc.options)}`,
    ...(doc.tools && Object.keys(doc.tools).length ? [`tools: ${y(doc.tools)}`] : []),
    ...(doc.toolScripts && Object.keys(doc.toolScripts).length
      ? [`toolScripts: ${y(doc.toolScripts)}`]
      : []),
    ...(doc.importedFrom ? [`importedFrom: ${doc.importedFrom}`] : []),
    '---',
    ''
  ]
  const body = doc.body.trim()
  return lines.join('\n') + (body ? `\n${body}\n` : '')
}

// gray-matter must never evaluate code in frontmatter
const noEval = (): never => {
  throw new Error('code frontmatter is not supported')
}
const MATTER_OPTS = { engines: { js: noEval, javascript: noEval } }

/** HOOK.md text → hook, with defaults filled in. Throws with the schema problems */
export function parseHookDoc(text: string, label = HOOK_FILE): HookDoc {
  let parsed: { data: unknown; content: string }
  try {
    const m = matter(text, MATTER_OPTS)
    parsed = { data: structuredClone(m.data), content: m.content }
  } catch {
    throw new Error(`${label}: frontmatter cannot be read`)
  }
  const d = isObj(parsed.data) ? parsed.data : {}
  const body = parsed.content.replace(/^\s*\n/, '')
  const raw: Record<string, unknown> = {
    description: typeof d.description === 'string' ? d.description : '',
    when: d.when,
    action: d.action,
    options: d.options ?? {},
    ...(d.tools !== undefined ? { tools: d.tools } : {}),
    ...(d.toolScripts !== undefined ? { toolScripts: d.toolScripts } : {}),
    ...(d.importedFrom !== undefined ? { importedFrom: d.importedFrom } : {}),
    body
  }
  const errors = validateHookDoc(raw)
  if (errors.length) throw new Error(`${label}: ${errors.join('; ')}`)
  const action = raw.action as HookAction
  return { ...(raw as unknown as HookDoc), options: hookOptions(action, raw.options) }
}

/** Hook names in the library (folders with a HOOK.md), sorted */
export function hookNames(home: string): string[] {
  const dir = hooksDir(home)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => HOOK_NAME_RE.test(n) && existsSync(join(dir, n, HOOK_FILE)))
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort()
}

/** One hook. Throws on a broken HOOK.md or a missing script (the source is broken — not a per-target error) */
export function readHook(home: string, name: string): LibraryHook {
  const dir = join(hooksDir(home), name)
  const doc = parseHookDoc(readFileSync(join(dir, HOOK_FILE), 'utf8'), `hooks/${name}/${HOOK_FILE}`)
  const scripts: Record<string, string> = {}
  for (const file of hookScriptFiles(doc)) {
    const p = join(dir, file)
    if (!existsSync(p)) throw new Error(`hooks/${name}/${file}: script not found`)
    scripts[file] = readFileSync(p, 'utf8')
  }
  // A library script stands in for run.sh, so the tools copy it like the hook's own
  const use = usedScript(doc)
  if (use) {
    const lib = readScript(home, use)
    if (!lib) throw new Error(`hooks/${name}: library script ${use} not found`)
    if (lib.problem)
      throw new Error(`hooks/${name}: library script ${use} can't be copied (${lib.problem})`)
    scripts[SHARED_SCRIPT] = lib.content
    if (lib.kind === 'folder')
      return { name, doc, scripts, folder: { name: use, entry: lib.entry ?? SHARED_SCRIPT } }
  }
  return { name, doc, scripts }
}

export function readHooks(home: string): LibraryHook[] {
  return hookNames(home).map((n) => readHook(home, n))
}
