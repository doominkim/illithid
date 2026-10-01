/**
 * What a hook does. Built-in actions are rendered into a small script per tool (hookScripts.ts), so a hook needs no script of its
 * own; ask becomes a Claude Code prompt hook; script runs the hook's own run.sh.
 * Dependency-free so the renderer can use it too.
 *
 * Tool facts (checked 2026-10-01 against each tool's docs and source):
 * - shell tool: Claude Code / Codex `Bash`, Gemini CLI `run_shell_command`, Copilot `bash`, Grok `run_terminal_command`
 * - file-writing tools: Claude Code `Write|Edit`, Gemini CLI `write_file|replace`, Copilot `edit|create`, Grok `search_replace`.
 *   Codex edits through `apply_patch`, which carries no file path — format can't run there
 * - only Claude Code has LLM-judged hooks (`type: "prompt"`); Codex skips them, the others have command (and HTTP) hooks only
 */
import { defaultHookEvent, type HookTiming, type HookTool } from './hookEvents'

export const HOOK_ACTIONS = ['notify', 'guard', 'format', 'log', 'ask', 'script'] as const
export type HookAction = (typeof HOOK_ACTIONS)[number]

/** Why a tool can't run an action at a timing */
export type HookSupport = 'ok' | 'wrongTiming' | 'noEvent' | 'noFilePath' | 'claudeOnly'

export interface HookActionInfo {
  /** Timings the action makes sense at; the first is the default */
  timings: readonly HookTiming[]
  /** Tools that can't run it at all, and why */
  unsupported?: Partial<Record<HookTool, Exclude<HookSupport, 'ok' | 'wrongTiming' | 'noEvent'>>>
  /** Matcher per tool (tool name pattern) */
  matcher?: Partial<Record<HookTool, string>>
  /** Option defaults; options the user leaves out get these */
  defaults: Record<string, string | boolean | string[]>
}

const ALL_TIMINGS: readonly HookTiming[] = [
  'stop',
  'before-tool',
  'after-tool',
  'prompt',
  'session-start',
  'session-end',
  'notification'
]

const SHELL: Record<HookTool, string> = {
  claude: 'Bash',
  codex: 'Bash',
  gemini: 'run_shell_command',
  copilot: 'bash',
  grok: 'run_terminal_command'
}

const EDIT: Partial<Record<HookTool, string>> = {
  claude: 'Write|Edit',
  gemini: 'write_file|replace',
  copilot: 'edit|create',
  grok: 'search_replace'
}

export const DEFAULT_GUARD_PATTERNS = ['rm -rf /', 'git push --force', 'git reset --hard']

export const HOOK_ACTION_INFO: Readonly<Record<HookAction, HookActionInfo>> = {
  notify: { timings: ALL_TIMINGS, defaults: { title: 'Illithid', message: '', sound: false } },
  guard: {
    timings: ['before-tool'],
    matcher: SHELL,
    defaults: { patterns: DEFAULT_GUARD_PATTERNS }
  },
  format: {
    timings: ['after-tool'],
    matcher: EDIT,
    unsupported: { codex: 'noFilePath' },
    defaults: { command: 'npx --yes prettier --write' }
  },
  log: {
    timings: ALL_TIMINGS,
    defaults: { path: '~/.local/state/illithid/hooks.log' }
  },
  ask: {
    timings: ['stop', 'before-tool', 'prompt'],
    unsupported: {
      codex: 'claudeOnly',
      gemini: 'claudeOnly',
      copilot: 'claudeOnly',
      grok: 'claudeOnly'
    },
    // verbatim: the body is a complete Claude Code prompt (imported) — written as is, without the reply-format wrapper
    defaults: { verbatim: false }
  },
  // use: a library script (scripts/<name>.sh) instead of the hook's own run.sh
  script: { timings: ALL_TIMINGS, defaults: { use: '' } }
}

export function isHookAction(v: unknown): v is HookAction {
  return (HOOK_ACTIONS as readonly unknown[]).includes(v)
}

/** Whether a tool can run an action at a timing */
export function hookSupport(action: HookAction, when: HookTiming, tool: HookTool): HookSupport {
  const info = HOOK_ACTION_INFO[action]
  if (!info.timings.includes(when)) return 'wrongTiming'
  const no = info.unsupported?.[tool]
  if (no) return no
  return defaultHookEvent(tool, when) ? 'ok' : 'noEvent'
}

/** The action's matcher for a tool (only tool-call timings use one) */
export function actionMatcher(action: HookAction, tool: HookTool): string | undefined {
  return HOOK_ACTION_INFO[action].matcher?.[tool]
}
