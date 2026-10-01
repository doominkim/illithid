/**
 * Library scripts: `scripts/<name>.sh`, shared by hooks (the script action's `use` option). A script's description is the
 * first `# description: …` comment line. Every hook that uses a script gets a copy of it in each tool, like its own run.sh.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIBRARY_SCRIPT_RE } from './scriptNames'
import { libraryPaths } from './sources'

export { LIBRARY_SCRIPT_RE, SCRIPT_TEMPLATE } from './scriptNames'

export const SCRIPTS_DIR = 'scripts'

export interface LibraryScript {
  name: string
  description: string
  content: string
}

export function scriptsDir(home: string): string {
  return join(libraryPaths(home).root, SCRIPTS_DIR)
}

export function scriptPath(home: string, name: string): string {
  return join(scriptsDir(home), `${name}.sh`)
}

/** The first `# description: …` line (empty when there is none) */
export function scriptDescription(content: string): string {
  const m = /^#\s*description:[ \t]*(.*)$/im.exec(content)
  return m ? m[1].trim() : ''
}

export function scriptNames(home: string): string[] {
  const dir = scriptsDir(home)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sh') && LIBRARY_SCRIPT_RE.test(f.slice(0, -3)))
    .map((f) => f.slice(0, -3))
    .sort()
}

/** null when the script is missing */
export function readScript(home: string, name: string): LibraryScript | null {
  const p = scriptPath(home, name)
  if (!LIBRARY_SCRIPT_RE.test(name) || !existsSync(p)) return null
  const content = readFileSync(p, 'utf8')
  return { name, description: scriptDescription(content), content }
}

export function readScripts(home: string): LibraryScript[] {
  return scriptNames(home)
    .map((n) => readScript(home, n))
    .filter((s): s is LibraryScript => !!s)
}
