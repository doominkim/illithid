/**
 * Which tools look installed on this device (read-only): the tool's config location exists, or its executable is on env.PATH.
 * Kept free of other engine modules so config.ts can use it (tools in use while config.toolsInUse is unset).
 */
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { TOOL_IDS, type ToolId } from './toolIds'

/** Executable names looked up on PATH per tool */
export const TOOL_EXECUTABLES: Readonly<Record<ToolId, string>> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  gemini: 'gemini',
  copilot: 'copilot',
  grok: 'grok',
  qwen: 'qwen'
}

export interface ToolDetection {
  tool: ToolId
  /** The tool's config folder/file exists (same check as the import sources) */
  configFound: boolean
  /** Absolute path of the executable found on PATH */
  executable?: string
  /** configFound or executable */
  detected: boolean
}

export interface DetectToolsOptions {
  /** Executable check (default: regular file with an execute bit). Injected by fixtures */
  isExecutable?: (path: string) => boolean
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The tool's own config location exists (the folder the app would write into, or Claude's ~/.claude.json) */
export function toolConfigFound(home: string, tool: ToolId): boolean {
  switch (tool) {
    case 'claude':
      return isDir(join(home, '.claude')) || existsSync(join(home, '.claude.json'))
    case 'codex':
      return isDir(join(home, '.codex'))
    case 'opencode':
      return isDir(join(home, '.config/opencode'))
    case 'gemini':
      return isDir(join(home, '.gemini'))
    case 'copilot':
      return isDir(join(home, '.copilot'))
    case 'grok':
      return isDir(join(home, '.grok'))
    case 'qwen':
      return isDir(join(home, '.qwen'))
  }
}

function executableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Detection per tool. Without env only config locations count (no PATH lookup) — callers that have the user's environment pass it,
 * so the tools the app treats as in use match what Settings shows
 */
export function detectTools(
  home: string,
  env: Record<string, string | undefined> | undefined = process.env,
  opts: DetectToolsOptions = {}
): ToolDetection[] {
  const isExec = opts.isExecutable ?? executableFile
  const dirs = (env?.PATH ?? '').split(':').filter((d) => d && isAbsolute(d))
  return TOOL_IDS.map((tool) => {
    const configFound = toolConfigFound(home, tool)
    const executable = dirs.map((d) => join(d, TOOL_EXECUTABLES[tool])).find((p) => isExec(p))
    return {
      tool,
      configFound,
      ...(executable ? { executable } : {}),
      detected: configFound || !!executable
    }
  })
}
