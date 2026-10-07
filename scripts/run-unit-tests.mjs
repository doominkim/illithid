// Runs the unit tests (scripts/*.test.ts, not *.ui.test.ts) without a POSIX shell, so `npm run test:unit` works on Windows.
// On Windows, files that exercise POSIX hook scripts (run through /bin/sh, exec bits, symlinks) are left out with a reason:
// hooks are not written on Windows yet (phase 1).
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const WINDOWS_SKIP = {
  'hooks-actions.test.ts': 'runs generated /bin/sh hook scripts',
  'hooks-sync.test.ts': 'hook sync is off on Windows',
  'hooks-import.test.ts': 'hook sync is off on Windows',
  'hooks-view.test.ts': 'hook sync is off on Windows',
  'market-hooks.test.ts': 'hook sync is off on Windows',
  'scripts-library.test.ts': 'asserts POSIX exec bits and symlinks'
}

const win = process.platform === 'win32'
const files = readdirSync('scripts')
  .filter((f) => f.endsWith('.test.ts') && !f.endsWith('.ui.test.ts'))
  .filter((f) => {
    if (win && WINDOWS_SKIP[f]) {
      console.log(`skip ${f}: ${WINDOWS_SKIP[f]}`)
      return false
    }
    return true
  })
  .sort()
  .map((f) => `scripts/${f}`)

const tsx = createRequire(import.meta.url).resolve('tsx/cli')
const r = spawnSync(process.execPath, [tsx, '--test', ...process.argv.slice(2), ...files], {
  stdio: 'inherit'
})
process.exit(r.status ?? 1)
