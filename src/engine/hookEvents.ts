/**
 * Hook event catalog: per tool, the native events Illithid can write and how each tool treats their options.
 * Dependency-free so the renderer can use it too.
 *
 * Checked 2026-10-01 against each tool's own docs and source (links in HOOK_CATALOG[tool].sources).
 * Event names, matcher support and timeout units differ per tool; the same option is not assumed to behave the same.
 * OpenCode has no command hooks (JS plugins only) and is not a hook target yet.
 */
import type { ToolId } from './toolIds'

export const HOOK_TOOLS = [
  'claude',
  'codex',
  'gemini',
  'copilot',
  'grok'
] as const satisfies readonly ToolId[]
export type HookTool = (typeof HOOK_TOOLS)[number]

/** What a hook is for, in tool-neutral terms. Each tool maps it to its own event */
export const HOOK_TIMINGS = [
  'before-tool',
  'after-tool',
  'prompt',
  'stop',
  'session-start',
  'session-end',
  'notification'
] as const
export type HookTiming = (typeof HOOK_TIMINGS)[number]

export interface HookEventInfo {
  event: string
  timing: HookTiming
  /** The event filters by a matcher (tool name pattern, session source, notification type) */
  matcher: boolean
  /** The hook can stop what triggered it (deny a tool call, block a prompt, keep the agent going) */
  canBlock: boolean
}

export interface HookToolInfo {
  /** Unit the tool's config uses for timeouts. The library always stores seconds */
  timeoutUnit: 's' | 'ms'
  /** Key the tool reads the timeout from */
  timeoutKey: 'timeout' | 'timeoutSec'
  /** Shape of the config entry: nested matcher groups ({matcher, hooks: [...]}) or one flat list per event */
  shape: 'nested' | 'flat'
  events: readonly HookEventInfo[]
  sources: readonly string[]
}

const ev = (
  event: string,
  timing: HookTiming,
  matcher: boolean,
  canBlock: boolean
): HookEventInfo => ({
  event,
  timing,
  matcher,
  canBlock
})

export const HOOK_CHECKED = '2026-10-01'

export const HOOK_CATALOG: Readonly<Record<HookTool, HookToolInfo>> = {
  claude: {
    timeoutUnit: 's',
    timeoutKey: 'timeout',
    shape: 'nested',
    events: [
      ev('PreToolUse', 'before-tool', true, true),
      ev('PostToolUse', 'after-tool', true, true),
      ev('UserPromptSubmit', 'prompt', false, true),
      ev('Stop', 'stop', false, true),
      ev('SubagentStop', 'stop', false, true),
      ev('SessionStart', 'session-start', true, false),
      ev('SessionEnd', 'session-end', false, false),
      ev('Notification', 'notification', true, false)
    ],
    sources: ['https://code.claude.com/docs/en/hooks']
  },
  codex: {
    timeoutUnit: 's',
    timeoutKey: 'timeout',
    shape: 'nested',
    // No Notification event (Codex's separate `notify` setting is not a hook)
    events: [
      ev('PreToolUse', 'before-tool', true, true),
      ev('PostToolUse', 'after-tool', true, false),
      ev('UserPromptSubmit', 'prompt', false, true),
      ev('Stop', 'stop', false, true),
      ev('SubagentStop', 'stop', false, true),
      ev('SessionStart', 'session-start', true, false),
      ev('SessionEnd', 'session-end', false, false)
    ],
    sources: [
      'https://learn.chatgpt.com/docs/hooks',
      'https://github.com/openai/codex/blob/main/codex-rs/config/src/hook_config.rs'
    ]
  },
  gemini: {
    timeoutUnit: 'ms',
    timeoutKey: 'timeout',
    shape: 'nested',
    events: [
      ev('BeforeTool', 'before-tool', true, true),
      ev('AfterTool', 'after-tool', true, false),
      ev('BeforeAgent', 'prompt', false, true),
      ev('AfterAgent', 'stop', false, true),
      ev('SessionStart', 'session-start', false, false),
      ev('SessionEnd', 'session-end', false, false),
      ev('Notification', 'notification', false, false)
    ],
    sources: ['https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md']
  },
  copilot: {
    timeoutUnit: 's',
    timeoutKey: 'timeoutSec',
    shape: 'flat',
    events: [
      ev('preToolUse', 'before-tool', true, true),
      ev('postToolUse', 'after-tool', true, false),
      ev('userPromptSubmitted', 'prompt', false, false),
      ev('agentStop', 'stop', false, true),
      ev('subagentStop', 'stop', false, false),
      ev('sessionStart', 'session-start', false, false),
      ev('sessionEnd', 'session-end', false, false),
      ev('notification', 'notification', true, false)
    ],
    sources: ['https://docs.github.com/en/copilot/reference/hooks-reference']
  },
  grok: {
    timeoutUnit: 's',
    timeoutKey: 'timeout',
    shape: 'nested',
    events: [
      ev('PreToolUse', 'before-tool', true, true),
      ev('PostToolUse', 'after-tool', true, false),
      ev('UserPromptSubmit', 'prompt', false, true),
      ev('Stop', 'stop', false, true),
      ev('SubagentStop', 'stop', false, true),
      ev('SessionStart', 'session-start', false, false),
      ev('SessionEnd', 'session-end', false, false),
      ev('Notification', 'notification', false, false)
    ],
    sources: [
      'https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md'
    ]
  }
}

export function isHookTool(tool: string): tool is HookTool {
  return (HOOK_TOOLS as readonly string[]).includes(tool)
}

/** Events of a tool for a timing (first one is the default) */
export function hookEventsFor(tool: HookTool, timing: HookTiming): HookEventInfo[] {
  return HOOK_CATALOG[tool].events.filter((e) => e.timing === timing)
}

/** The tool's event for a timing, or null if the tool has none */
export function defaultHookEvent(tool: HookTool, timing: HookTiming): string | null {
  return hookEventsFor(tool, timing)[0]?.event ?? null
}

export function hookEventInfo(tool: HookTool, event: string): HookEventInfo | null {
  return HOOK_CATALOG[tool].events.find((e) => e.event === event) ?? null
}
