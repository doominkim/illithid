/**
 * Apps opened from Finder or the Dock start with a minimal environment: no PATH additions and no variables
 * exported in ~/.zshrc and friends. MCP targets that need literal values (Codex) then fail with
 * "environment variable X is not set". Load the login shell's environment once at startup, like
 * terminals and editors do. Skipped when launched from a terminal (already inherited) and in test runs.
 */
// Heavy zsh setups can take several seconds (10+ seen). Only sync and MCP reads wait, so allow a generous limit
const TIMEOUT_MS = 30_000

let ready: Promise<void> | null = null

/**
 * Loads once; every caller gets the same promise. Anything that reads process.env for tool paths or variables
 * (sync, detection, worker reads) awaits it, so a Finder launch never runs them with the minimal environment
 */
export function shellEnvReady(): Promise<void> {
  ready ??= loadShellEnv()
  return ready
}

async function loadShellEnv(): Promise<void> {
  if (process.platform === 'win32') return
  if (process.env['TERM'] || process.env['ILLITHID_TEST'] || process.env['ILLITHID_HOME']) return
  try {
    const { shellEnv } = await import('shell-env')
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS)
    })
    const env = await Promise.race([shellEnv(), timeout]).finally(() => clearTimeout(timer))
    for (const [k, v] of Object.entries(env)) {
      // ILLITHID_* from shell rc files (e.g. ILLITHID_HOME) would split the app between two HOMEs
      if (v === undefined || k.startsWith('ELECTRON_') || k.startsWith('ILLITHID_')) continue
      process.env[k] = v
    }
  } catch (e) {
    console.warn('[shell-env] could not load the login shell environment:', (e as Error).message)
  }
}
