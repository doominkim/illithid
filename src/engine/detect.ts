/**
 * Which tools look installed on this device (read-only): the tool's config location exists, or its executable is on env.PATH.
 * Kept free of other engine modules so config.ts can use it (tools in use while config.toolsInUse is unset).
 */
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
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
    // Windows has no execute bit: a file with a PATHEXT extension is runnable
    if (process.platform !== 'win32') accessSync(p, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Absolute path of an executable on the environment's PATH, else undefined. On Windows the variable may be spelled `Path`,
 * entries are `;`-separated and the name is tried with each PATHEXT extension (`claude.cmd`, `codex.exe`)
 */
export function findExecutable(
  name: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  isExec: (path: string) => boolean = executableFile
): string | undefined {
  const lib = platform === 'win32' ? win32 : posix
  const key = Object.keys(env).find((k) =>
    platform === 'win32' ? k.toUpperCase() === 'PATH' : k === 'PATH'
  )
  const dirs = (key ? (env[key] ?? '') : '')
    .split(lib.delimiter)
    .filter((d) => d && lib.isAbsolute(d))
  const exts =
    platform === 'win32'
      ? (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  for (const d of dirs)
    for (const ext of exts) {
      const p = lib.join(d, name + ext)
      if (isExec(p)) return p
    }
  return undefined
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
  return TOOL_IDS.map((tool) => {
    const configFound = toolConfigFound(home, tool)
    const executable = env
      ? findExecutable(TOOL_EXECUTABLES[tool], env, process.platform, isExec)
      : undefined
    return {
      tool,
      configFound,
      ...(executable ? { executable } : {}),
      detected: configFound || !!executable
    }
  })
}
