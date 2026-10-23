import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ESLint } from 'eslint'

// The engine runs regexes over transcripts and hook commands of unbounded size; a pattern that backtracks
// super-linearly froze the Electron main process once (request trace prototype, 2026-10-22). Lint must catch it.
async function ruleIds(code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: process.cwd() })
  const [result] = await eslint.lintText(code, { filePath: 'src/engine/lint-fixture.ts' })
  return result.messages.map((m) => m.ruleId ?? '')
}

test('lint reports a regex that backtracks super-linearly', async () => {
  const ids = await ruleIds('export const SCRIPT = /^(?:\\S+\\s*)*\\.sh$/\n')
  assert.ok(ids.includes('regexp/no-super-linear-backtracking'), ids.join(', '))
})

test('lint accepts a linear regex', async () => {
  const ids = await ruleIds('export const SCRIPT = /\\.(?:mjs|cjs|js|sh|py|ts)$/\n')
  assert.deepEqual(
    ids.filter((id) => id.startsWith('regexp/')),
    []
  )
})
