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

export const HOOK_ACTIONS = [
  'notify',
  'verify',
  'format',
  'protect',
  'context',
  'checkpoint',
  'guard',
  'ask',
  'log',
  'script'
] as const
export type HookAction = (typeof HOOK_ACTIONS)[number]

/** Why a tool can't run an action at a timing */
export type HookSupport =
  'ok' | 'wrongTiming' | 'noEvent' | 'noFilePath' | 'claudeOnly' | 'noContext'

export interface HookActionInfo {
  /** Timings the action makes sense at; the first is the default */
  timings: readonly HookTiming[]
  /** Tools that can't run it at all, and why */
  unsupported?: Partial<Record<HookTool, Exclude<HookSupport, 'ok' | 'wrongTiming' | 'noEvent'>>>
  /** Tools that can't run it at one timing, and why (checked before unsupported) */
  unsupportedAt?: Partial<
    Record<HookTiming, Partial<Record<HookTool, Exclude<HookSupport, 'ok' | 'wrongTiming'>>>>
  >
  /** Matcher per tool (tool name pattern) */
  matcher?: Partial<Record<HookTool, string>>
  /** Matcher per tool at one timing (overrides matcher) */
  matcherAt?: Partial<Record<HookTiming, Partial<Record<HookTool, string>>>>
  /** Options that take one of a few values */
  choices?: Record<string, readonly string[]>
  /** Timeout written for every tool unless the hook sets one (seconds) — when tool defaults are too short */
  timeout?: number
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

/** File edits including Codex's apply_patch: for script hooks, which read the tool's raw input (no file path needed) */
const EDIT_ALL: Record<HookTool, string> = { ...EDIT, codex: 'apply_patch' } as Record<
  HookTool,
  string
>

/** What a script hook at a tool call reacts to */
export const SCRIPT_TARGETS = ['all', 'shell', 'edit'] as const
export type ScriptTarget = (typeof SCRIPT_TARGETS)[number]

export const DEFAULT_GUARD_PATTERNS = ['rm -rf /', 'git push --force', 'git reset --hard']

/** File globs protect matches (a pattern with / is matched against the path, others against the file name) */
export const DEFAULT_PROTECT_PATTERNS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.git/*'
]
/** Characters a protect pattern may use (it is written into the script unquoted, as a glob) */
export const PROTECT_PATTERN_RE = /^[A-Za-z0-9._*?/-]+$/

/** "Waiting for you" notifications per tool (notification type filters). Codex has no notification event */
const WAITING: Partial<Record<HookTool, string>> = {
  claude: 'permission_prompt|idle_prompt',
  copilot: 'permission_prompt',
  grok: 'permission_prompt|idle_prompt'
}

/** CLIs that can judge for an ask hook ('same' = the tool running the hook) */
export const JUDGE_CLIS = ['same', 'claude', 'codex', 'gemini', 'copilot', 'grok'] as const
export type JudgeCli = (typeof JUDGE_CLIS)[number]

export const NOTIFY_CHANNELS = ['mac', 'ntfy', 'slack'] as const
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number]

/** Environment variable a phone channel reads its address from when the hook names none */
export const NOTIFY_URL_ENV: Record<Exclude<NotifyChannel, 'mac'>, string> = {
  ntfy: 'ILLITHID_NTFY_URL',
  slack: 'ILLITHID_SLACK_WEBHOOK'
}
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export const HOOK_ACTION_INFO: Readonly<Record<HookAction, HookActionInfo>> = {
  notify: {
    timings: [
      'stop',
      'notification',
      ...ALL_TIMINGS.filter((t) => t !== 'stop' && t !== 'notification')
    ],
    matcherAt: { notification: WAITING },
    choices: { channel: NOTIFY_CHANNELS },
    // urlEnv: environment variable with the ntfy / Slack address ('' = the channel's default name). project: add the folder name
    defaults: {
      title: 'Illithid',
      message: '',
      sound: false,
      channel: 'mac',
      urlEnv: '',
      project: true
    }
  },
  // command: '' = pick the project's test command (npm test, pytest, go test, cargo test)
  verify: { timings: ['stop'], timeout: 300, defaults: { command: '' } },
  // Codex edits through apply_patch (no file path); Copilot's edit/create path key is not documented
  protect: {
    timings: ['before-tool'],
    matcher: EDIT,
    unsupported: { codex: 'noFilePath', copilot: 'noFilePath' },
    defaults: { patterns: DEFAULT_PROTECT_PATTERNS }
  },
  // git: the branch and uncommitted changes; the hook body is added as a note. Grok ignores session start output
  context: {
    timings: ['session-start'],
    unsupported: { grok: 'noContext' },
    defaults: { git: true }
  },
  // snapshot: a commit object under refs/illithid/checkpoints (work tree, index and branch untouched); commit: a WIP commit
  checkpoint: {
    timings: ['stop'],
    choices: { mode: ['snapshot', 'commit'] },
    defaults: { mode: 'snapshot' }
  },
  guard: {
    timings: ['before-tool'],
    matcher: SHELL,
    defaults: { patterns: DEFAULT_GUARD_PATTERNS }
  },
  // stop (default): once on every file changed in the git work tree (works without a file path); after-tool: the edited file
  format: {
    timings: ['stop', 'after-tool'],
    matcher: EDIT,
    unsupportedAt: { 'after-tool': { codex: 'noFilePath' } },
    defaults: { command: 'npx --yes prettier --write --ignore-unknown' }
  },
  log: {
    timings: ALL_TIMINGS,
    defaults: { path: '~/.local/state/illithid/hooks.log' }
  },
  // Claude Code judges with its own prompt hook. The other tools run a script that asks a CLI to judge (judge: 'same' = the
  // tool's own CLI; model: '' = the CLI's default, haiku for Claude Code) and enforce its answer.
  // verbatim: the body is a complete Claude Code prompt (imported) — written as is, without the reply-format wrapper
  ask: {
    timings: ['stop', 'before-tool', 'prompt'],
    timeout: 120,
    choices: { judge: JUDGE_CLIS, target: SCRIPT_TARGETS },
    defaults: { verbatim: false, judge: 'same', model: '', target: 'all' }
  },
  // use: a library script (scripts/<name>.sh) instead of the hook's own run.sh
  // target (before/after a tool call): every call, shell commands or file edits
  script: {
    timings: ALL_TIMINGS,
    choices: { target: SCRIPT_TARGETS },
    defaults: { use: '', target: 'all' }
  }
}

export function isHookAction(v: unknown): v is HookAction {
  return (HOOK_ACTIONS as readonly unknown[]).includes(v)
}

/** Whether a tool can run an action at a timing */
export function hookSupport(action: HookAction, when: HookTiming, tool: HookTool): HookSupport {
  const info = HOOK_ACTION_INFO[action]
  if (!info.timings.includes(when)) return 'wrongTiming'
  const no = info.unsupportedAt?.[when]?.[tool] ?? info.unsupported?.[tool]
  if (no) return no
  return defaultHookEvent(tool, when) ? 'ok' : 'noEvent'
}

/** The action's matcher for a tool at a timing (tool calls: tool names; notifications: notification types) */
export function actionMatcher(
  action: HookAction,
  tool: HookTool,
  when?: HookTiming,
  options?: Record<string, unknown>
): string | undefined {
  // Script hooks and plain-language checks pick their own target (every action, shell commands, file edits)
  if (action === 'script' || action === 'ask') {
    if (when !== 'before-tool' && when !== 'after-tool') return undefined
    const target = options?.target
    return target === 'shell' ? SHELL[tool] : target === 'edit' ? EDIT_ALL[tool] : undefined
  }
  const info = HOOK_ACTION_INFO[action]
  return (when && info.matcherAt?.[when]?.[tool]) ?? info.matcher?.[tool]
}
