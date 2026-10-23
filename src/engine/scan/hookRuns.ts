/**
 * Hook runs recorded in Claude Code transcripts (`attachment` lines of type hook_success / hook_cancelled / hook_*error).
 * Only a readable name, the event, the outcome and the duration are kept — never the command, its output or its input.
 * Claude Code records a run when the hook printed something, failed or was cancelled, so silent successes are not all here.
 */
type Json = Record<string, unknown>

export interface HookRun {
  /** Library hook folder (`check-destructive`), script (`orca · claude-hook.sh`) or first word of the command */
  name: string
  event: string
  /** ok: exit 0 · fail: non-zero exit (a block) · timeout: cancelled at its timeout · error: other cancel or hook error */
  outcome: 'ok' | 'fail' | 'timeout' | 'error'
  ms: number
  at?: string
}

const SCRIPT_RE = /\.(?:sh|mjs|cjs|js|py|ts)$/
const RUN_SCRIPT_RE = /^run(?:\.[a-z]+)?\.sh$/
const LIBRARY_HOOK_RE = /\/hooks\/illithid\/([^/\s'"]+)\//
const TOKEN_SPLIT_RE = /[\s"'`;()|&<>]+/

/**
 * Readable hook name from its command: an Illithid hook copy is named after its library folder, a script after its file
 * (or its folder for run.sh), prefixed with the hidden tool dir it lives in (`orca · claude-hook.sh`); else the first word
 */
export function hookName(command: unknown): string {
  if (typeof command !== 'string' || !command.trim()) return 'hook'
  const lib = LIBRARY_HOOK_RE.exec(command)
  if (lib) return lib[1]
  const tokens = command.split(TOKEN_SPLIT_RE).filter(Boolean)
  const script = tokens.find((t) => SCRIPT_RE.test(t))
  if (!script) return (tokens[0] ?? 'hook').split('/').pop()!.slice(0, 32) || 'hook'
  const parts = script.split('/').filter(Boolean)
  const base = parts[parts.length - 1]
  if (RUN_SCRIPT_RE.test(base) && parts.length > 1) return parts[parts.length - 2]
  const owner = parts.find((p) => p.length > 1 && p.startsWith('.') && p !== '..')
  return owner ? `${owner.slice(1)} · ${base}` : base
}

/** One hook run from an attachment payload; undefined for anything else (additional context, other attachments) */
export function hookRunOf(a: unknown, at?: string): HookRun | undefined {
  if (!a || typeof a !== 'object') return undefined
  const o = a as Json
  const type = typeof o.type === 'string' ? o.type : ''
  let outcome: HookRun['outcome']
  if (type === 'hook_success')
    outcome = typeof o.exitCode === 'number' && o.exitCode !== 0 ? 'fail' : 'ok'
  else if (type === 'hook_cancelled') outcome = o.timedOut ? 'timeout' : 'error'
  else if (type.startsWith('hook_') && type.endsWith('error')) outcome = 'error'
  else return undefined
  return {
    name: hookName(o.command),
    event: typeof o.hookEvent === 'string' && o.hookEvent ? o.hookEvent : 'Hook',
    outcome,
    ms: typeof o.durationMs === 'number' && o.durationMs > 0 ? Math.round(o.durationMs) : 0,
    at
  }
}
