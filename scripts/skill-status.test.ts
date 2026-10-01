import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skills } from '../src/main/reads'
import { baseEnv, buildDemoHome } from './readme-shots'

function homeUsing(tools: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-skill-status-'))
  buildDemoHome(home, { tools: 'all' })
  const path = join(home, '.config/illithid/config.json')
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), toolsInUse: tools }))
  return home
}

test('REQ-SKILL-STATUS-1 a skill has no OpenCode state while OpenCode is not in use', () => {
  const home = homeUsing(['claude', 'codex'])
  const data = skills(home, baseEnv(home))
  assert.ok(data.names.length > 0)
  for (const name of data.names) assert.equal(data.state[name]?.opencode, undefined, name)
})

test('REQ-SKILL-STATUS-2 with OpenCode in use the state comes from its sync plan', () => {
  const home = homeUsing(['claude', 'codex', 'opencode'])
  const data = skills(home, baseEnv(home))
  for (const name of data.names) assert.ok(['synced', 'needsSync'].includes(data.state[name]?.opencode ?? ''), `${name}: ${data.state[name]?.opencode}`)
})
