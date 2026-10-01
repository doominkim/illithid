/**
 * Where hooks land in each tool and which hooks a tool gets.
 *
 * Script copies: `<tool home>/hooks/illithid/<hook>/<file>` (executable). Config entries run them as `'<copy>' <tool>`, so a
 * shared script can tell which tool called it. Everything under `hooks/illithid/` is the app's: a config entry whose command
 * points there is app-owned, any other entry is the user's and is left alone.
 *
 * Grok also runs the hooks in ~/.claude/settings.json unless `[compat.claude] hooks = false`. While Grok reads Claude's files
 * (config.grokReadsClaude not false) a hook that is on for Claude is not written for Grok again — it would run twice.
 */
import { join } from 'node:path'
import { readConfig, toolInUse } from './config'
import { HOOK_CATALOG, type HookTool } from './hookEvents'
import { hookTriggers, type HookTrigger, type LibraryHook } from './hooks'
import { renderAskPrompt, toolScript } from './hookScripts'
import { isEnabled, type Manifest } from './manifest'
import { grokClaudeReading } from './targets/grokCompat'

/** Tool home relative to HOME */
const TOOL_HOME: Readonly<Record<HookTool, string>> = {
  claude: '.claude',
  codex: '.codex',
  gemini: '.gemini',
  copilot: '.copilot',
  grok: '.grok'
}

/** App-owned script folder inside a tool home */
export const HOOK_COPY_DIR = 'hooks/illithid'

export function hookCopyRoot(home: string, tool: HookTool): string {
  return join(home, TOOL_HOME[tool], HOOK_COPY_DIR)
}

export function hookCopyPath(home: string, tool: HookTool, hook: string, file: string): string {
  return join(hookCopyRoot(home, tool), hook, file)
}

/** Single-quoted for the shell (the tools run commands through a shell) */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function hookCommand(home: string, tool: HookTool, hook: string, file: string): string {
  return `${shellQuote(hookCopyPath(home, tool, hook, file))} ${tool}`
}

/** Whether a command runs an app-owned script copy of this tool */
export function isAppHookCommand(home: string, tool: HookTool, command: unknown): boolean {
  return typeof command === 'string' && command.startsWith(`'${hookCopyRoot(home, tool)}/`)
}

/**
 * Grok runs Claude Code's hooks too: the default, unless config.grokReadsClaude = false (the app then writes
 * `[compat.claude] hooks = false`) or the user set that in ~/.grok/config.toml
 */
export function grokReadsClaudeHooks(home: string): boolean {
  return readConfig(home).config.grokReadsClaude !== false && grokClaudeReading(home).hooks
}

export interface ToolHook {
  hook: LibraryHook
  trigger: HookTrigger
  /** command: run a script copy; prompt: a Claude Code prompt hook */
  kind: 'command' | 'prompt'
  /** command: script copy file name */
  file: string
  /** command: script content; prompt: the prompt */
  content: string
}

/** Whether a hook runs in a tool: the tool can run it and it is on in illithid.json */
const runsIn = (h: LibraryHook, tool: HookTool, manifest: Manifest | undefined): boolean =>
  !!hookTriggers(h.doc)[tool] && isEnabled(manifest, 'hooks', h.name, tool)

/**
 * Hooks a tool gets, sorted by name: the tool can run them, they are on in illithid.json, and — for Grok — they don't already
 * reach it through Claude Code's settings. Retiring tools get none (offTools in the manifest)
 */
export function hooksForTool(
  home: string,
  tool: HookTool,
  hooks: readonly LibraryHook[],
  manifest: Manifest | undefined
): ToolHook[] {
  const viaClaude = tool === 'grok' && grokReadsClaudeHooks(home) && toolInUse(home, 'claude')
  return hooks
    .filter((h) => runsIn(h, tool, manifest))
    .filter((h) => !viaClaude || !runsIn(h, 'claude', manifest))
    .map((h): ToolHook => {
      const trigger = hookTriggers(h.doc)[tool]!
      const script = toolScript(tool, h)
      return script
        ? { hook: h, trigger, kind: 'command', file: script.file, content: script.content }
        : { hook: h, trigger, kind: 'prompt', file: '', content: renderAskPrompt(h.doc) }
    })
    .sort((a, b) => a.hook.name.localeCompare(b.hook.name))
}

/** Timeout in the tool's own unit */
export function toolTimeout(tool: HookTool, seconds: number | undefined): number | undefined {
  if (seconds === undefined) return undefined
  return HOOK_CATALOG[tool].timeoutUnit === 'ms' ? seconds * 1000 : seconds
}
