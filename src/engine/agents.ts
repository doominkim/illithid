import { join, resolve } from 'node:path'
import { homeTilde } from './pathUtil'
import { libraryRoot } from './config'
import type { ToolId } from './toolIds'

export { TOOL_IDS, type ToolId } from './toolIds'

/** How shared rules reach each tool */
export type RulesInjection =
  | { kind: 'symlink'; path: string; target: string }
  | { kind: 'markerBlock'; path: string }
  | { kind: 'instructionsGlob'; path: string; key: 'instructions'; glob: string }
  /** Each rule copied as its own file into an app-owned folder (ruleSync) */
  | { kind: 'copyDir'; dir: string }

/** How skills become visible to each tool */
export type SkillsInjection =
  | { kind: 'symlinkDir'; dir: string }
  /** The tool scans multiple roots itself (no symlinks are created) */
  | { kind: 'autoScan'; roots: string[] }

export interface RosterSource {
  /** Agent definition directory (skipped if missing) */
  dirs: string[]
  ext: '.md' | '.toml' | '.agent.md'
  /** Definitions stored inside the config file (OpenCode opencode.json `agent`) */
  inline?: { path: string; key: string }
}

export interface ModelKeys {
  path: string
  format: 'json' | 'toml' | 'yaml'
  /** Key names. For JSON, `a.b` is the nested key b inside object a. Empty = no default model setting the app manages */
  keys: string[]
}

export interface ToolInfo {
  id: ToolId
  displayName: string
  /** The tool's main config file */
  configFile: string
  rules: RulesInjection
  skills: SkillsInjection
  models: ModelKeys
  roster: RosterSource
}

/** Shared source-of-truth directories (library root = config.libraryPath ?? <home>/.agents) */
export function canonicalPaths(home: string): { rules: string; skills: string } {
  const root = libraryRoot(home)
  return {
    rules: join(root, 'rules'),
    skills: join(root, 'skills')
  }
}

/** Per-tool paths and injection methods. All paths are absolute, based on home. */
export function tools(home: string): ToolInfo[] {
  const canon = canonicalPaths(home)
  const claudeSettings = join(home, '.claude/settings.json')
  const codexConfig = join(home, '.codex/config.toml')
  const grokConfig = join(home, '.grok/config.toml')
  const opencodeConfig = join(home, '.config/opencode/opencode.json')
  const geminiSettings = join(home, '.gemini/settings.json')
  const copilotMcp = join(home, '.copilot/mcp-config.json')
  const qwenSettings = join(home, '.qwen/settings.json')
  const ompConfig = join(home, '.omp/agent/config.yml')
  return [
    {
      id: 'claude',
      displayName: 'Claude Code',
      configFile: claudeSettings,
      rules: { kind: 'symlink', path: join(home, '.claude/rules/shared'), target: canon.rules },
      skills: { kind: 'symlinkDir', dir: join(home, '.claude/skills') },
      models: { path: claudeSettings, format: 'json', keys: ['model', 'effortLevel'] },
      roster: {
        dirs: [join(home, '.claude/agents')],
        ext: '.md'
      }
    },
    {
      id: 'codex',
      displayName: 'Codex',
      configFile: codexConfig,
      rules: { kind: 'markerBlock', path: join(home, '.codex/AGENTS.md') },
      skills: { kind: 'symlinkDir', dir: join(home, '.codex/skills') },
      models: { path: codexConfig, format: 'toml', keys: ['model', 'model_reasoning_effort'] },
      roster: {
        dirs: [join(home, '.codex/agents')],
        ext: '.toml'
      }
    },
    {
      id: 'opencode',
      displayName: 'OpenCode',
      configFile: opencodeConfig,
      rules: {
        kind: 'instructionsGlob',
        path: opencodeConfig,
        key: 'instructions',
        glob: join(canon.rules, '*.md')
      },
      // Based on the opencode 1.18.27 binary's skill discovery code (global scope only):
      //   ~/.claude/skills/**/SKILL.md  (disabled by OPENCODE_DISABLE_CLAUDE_CODE_SKILLS or OPENCODE_DISABLE_EXTERNAL_SKILLS)
      //   ~/.agents/skills/**/SKILL.md  (disabled by OPENCODE_DISABLE_EXTERNAL_SKILLS)
      //   ~/.config/opencode/{skill,skills}/**/SKILL.md, opencode.json skills.paths
      // For duplicate names, the later scan wins (.claude, then .agents).
      // Library skills are made visible by the opencodeSkills target via opencode.json skills.paths (G3-2).
      skills: {
        kind: 'autoScan',
        roots: [
          join(home, '.claude/skills'),
          canon.skills,
          join(home, '.config/opencode/skill'),
          join(home, '.config/opencode/skills')
        ]
      },
      models: { path: opencodeConfig, format: 'json', keys: ['model', 'small_model'] },
      roster: {
        dirs: [join(home, '.config/opencode/agent'), join(home, '.config/opencode/agents')],
        ext: '.md',
        inline: { path: opencodeConfig, key: 'agent' }
      }
    },
    {
      id: 'gemini',
      displayName: 'Gemini CLI',
      configFile: geminiSettings,
      // GEMINI.md @imports are limited to its project root (~/.gemini), so rules are inlined in a marker block
      rules: { kind: 'markerBlock', path: join(home, '.gemini/GEMINI.md') },
      skills: { kind: 'symlinkDir', dir: join(home, '.gemini/skills') },
      models: { path: geminiSettings, format: 'json', keys: ['model.name'] },
      roster: {
        dirs: [join(home, '.gemini/agents')],
        ext: '.md'
      }
    },
    {
      id: 'copilot',
      displayName: 'GitHub Copilot',
      // ~/.copilot is read by Copilot CLI and VS Code Copilot. config.json there is the CLI's own state — never written
      configFile: copilotMcp,
      rules: { kind: 'copyDir', dir: join(home, '.copilot/instructions/illithid') },
      skills: { kind: 'symlinkDir', dir: join(home, '.copilot/skills') },
      // The default model key is not documented for ~/.copilot — not managed
      models: { path: join(home, '.copilot/settings.json'), format: 'json', keys: [] },
      roster: {
        dirs: [join(home, '.copilot/agents')],
        ext: '.agent.md'
      }
    },
    {
      id: 'grok',
      displayName: 'Grok CLI',
      configFile: grokConfig,
      // Grok reads *.md directly under ~/.grok/rules (not subfolders), a folder shared with the user — app copies are tracked in state
      rules: { kind: 'copyDir', dir: join(home, '.grok/rules') },
      skills: { kind: 'symlinkDir', dir: join(home, '.grok/skills') },
      models: { path: grokConfig, format: 'toml', keys: ['models.default'] },
      roster: {
        dirs: [join(home, '.grok/agents')],
        ext: '.md'
      }
    },
    {
      id: 'qwen',
      displayName: 'Qwen Code',
      configFile: qwenSettings,
      // Qwen loads ~/.qwen/rules/**/*.md recursively; QWEN.md @imports cannot leave ~/.qwen, so rules are copied into an app-owned folder
      rules: { kind: 'copyDir', dir: join(home, '.qwen/rules/illithid') },
      skills: { kind: 'symlinkDir', dir: join(home, '.qwen/skills') },
      models: { path: qwenSettings, format: 'json', keys: ['model.name'] },
      roster: {
        dirs: [join(home, '.qwen/agents')],
        ext: '.md'
      }
    },
    {
      id: 'omp',
      displayName: 'omp',
      configFile: ompConfig,
      // omp loads ~/.omp/agent/rules/*.{md,mdc} (not subfolders) — a folder shared with the user, app copies tracked in state.
      // The copies carry `alwaysApply: true` (a rule without it, description or a trigger is never used). Rules go there rather
      // than ~/.omp/agent/AGENTS.md: that file would shadow every other user-level context file (~/.agents/AGENTS.md, …)
      rules: { kind: 'copyDir', dir: join(home, '.omp/agent/rules') },
      skills: { kind: 'symlinkDir', dir: join(home, '.omp/agent/skills') },
      models: { path: ompConfig, format: 'yaml', keys: ['modelRoles.default'] },
      roster: {
        dirs: [join(home, '.omp/agent/agents')],
        ext: '.md'
      }
    }
  ]
}

/** `<VAR>` pointing somewhere other than `<home>/<dir>` (absolute path), else null. `~` and relative values resolve against home */
function homeOverride(home: string, value: string | undefined, dir: string): string | null {
  const v = value?.trim()
  if (!v) return null
  const abs = resolve(
    v === '~' ? home : v.startsWith('~/') ? join(home, v.slice(2)) : resolve(home, v)
  )
  return abs === join(home, dir) ? null : abs
}

/**
 * GROK_HOME pointing somewhere other than ~/.grok (absolute path), else null. Same handling as COPILOT_HOME: Grok writes are
 * skipped because Grok wouldn't read ~/.grok
 */
export function grokHomeOverride(
  home: string,
  env: Record<string, string | undefined>
): string | null {
  return homeOverride(home, env.GROK_HOME, '.grok')
}

/**
 * COPILOT_HOME pointing somewhere other than ~/.copilot (absolute path), else null. The app only writes ~/.copilot, which Copilot
 * wouldn't read then — so Copilot writes are skipped (skip=copilotHomeOverride) instead
 */
export function copilotHomeOverride(
  home: string,
  env: Record<string, string | undefined>
): string | null {
  return homeOverride(home, env.COPILOT_HOME, '.copilot')
}

/** QWEN_HOME pointing somewhere other than ~/.qwen (absolute path), else null. Same handling as COPILOT_HOME */
export function qwenHomeOverride(
  home: string,
  env: Record<string, string | undefined>
): string | null {
  return homeOverride(home, env.QWEN_HOME, '.qwen')
}

/**
 * The omp agent folder when the environment moves it away from ~/.omp/agent (absolute path), else null. Same handling as
 * COPILOT_HOME. Mirrors omp's own resolution (pi-utils dirs.ts): PI_CONFIG_DIR renames the root under home (default .omp);
 * a named profile (OMP_PROFILE, or PI_PROFILE when OMP_PROFILE is unset; "default" = none) uses <root>/profiles/<name>/agent;
 * otherwise PI_CODING_AGENT_DIR replaces <root>/agent
 */
export function ompHomeOverride(
  home: string,
  env: Record<string, string | undefined>
): string | null {
  const root = join(home, env.PI_CONFIG_DIR || '.omp')
  const profile = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim()
  const agentDir =
    profile && profile !== 'default'
      ? join(root, 'profiles', profile, 'agent')
      : (homeOverride(home, env.PI_CODING_AGENT_DIR, '.omp/agent') ?? join(root, 'agent'))
  return agentDir === join(home, '.omp/agent') ? null : agentDir
}

/** Home override of a tool that has one (COPILOT_HOME, GROK_HOME, QWEN_HOME, omp's agent folder) pointing away from the folder the app writes, else null */
export function toolHomeOverride(
  home: string,
  id: ToolId,
  env: Record<string, string | undefined>
): string | null {
  if (id === 'copilot') return copilotHomeOverride(home, env)
  if (id === 'grok') return grokHomeOverride(home, env)
  if (id === 'qwen') return qwenHomeOverride(home, env)
  if (id === 'omp') return ompHomeOverride(home, env)
  return null
}

export function tool(home: string, id: ToolId): ToolInfo {
  const t = tools(home).find((x) => x.id === id)
  if (!t) throw new Error(`unknown tool ${id}`)
  return t
}

/** Display path: replaces the home prefix with ~ */
export function tilde(home: string, p: string): string {
  return homeTilde(home, p)
}
