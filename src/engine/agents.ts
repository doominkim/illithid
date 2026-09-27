import { join } from 'node:path'
import { libraryRoot } from './config'
import type { ToolId } from './toolIds'

export { TOOL_IDS, type ToolId } from './toolIds'

/** How shared rules reach each tool */
export type RulesInjection =
  | { kind: 'symlink'; path: string; target: string }
  | { kind: 'markerBlock'; path: string }
  | { kind: 'instructionsGlob'; path: string; key: 'instructions'; glob: string }

/** How skills become visible to each tool */
export type SkillsInjection =
  | { kind: 'symlinkDir'; dir: string }
  /** The tool scans multiple roots itself (no symlinks are created) */
  | { kind: 'autoScan'; roots: string[] }

export interface RosterSource {
  /** Agent definition directory (skipped if missing) */
  dirs: string[]
  ext: '.md' | '.toml'
  /** Definitions stored inside the config file (OpenCode opencode.json `agent`) */
  inline?: { path: string; key: string }
}

export interface ModelKeys {
  path: string
  format: 'json' | 'toml'
  /** Key names. For JSON, `a.b` is the nested key b inside object a */
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
  const opencodeConfig = join(home, '.config/opencode/opencode.json')
  const geminiSettings = join(home, '.gemini/settings.json')
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
    }
  ]
}

export function tool(home: string, id: ToolId): ToolInfo {
  const t = tools(home).find((x) => x.id === id)
  if (!t) throw new Error(`unknown tool ${id}`)
  return t
}

/** Display path: replaces the home prefix with ~ */
export function tilde(home: string, p: string): string {
  return p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
}
