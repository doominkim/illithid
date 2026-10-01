import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcp, skills } from '../src/main/reads'
import { baseEnv, buildDemoHome } from './readme-shots'

function homeUsing(tools: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-skill-status-'))
  buildDemoHome(home, { tools: 'all' })
  const path = join(home, '.config/illithid/config.json')
  writeFileSync(
    path,
    JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), toolsInUse: tools })
  )
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
  for (const name of data.names)
    assert.ok(
      ['synced', 'needsSync'].includes(data.state[name]?.opencode ?? ''),
      `${name}: ${data.state[name]?.opencode}`
    )
})

test('REQ-TOOL-PROBLEM-REASONS-2 error cells carry their reason (OpenCode skill config, Claude MCP config)', () => {
  const home = homeUsing(['claude', 'codex', 'opencode'])
  writeFileSync(join(home, '.config/opencode/opencode.json'), '{ "skills": ')
  writeFileSync(join(home, '.claude.json'), '{ not json')
  const s = skills(home, baseEnv(home))
  for (const name of s.names) {
    assert.equal(s.state[name]?.opencode, 'error', name)
    assert.ok(s.reasons?.[name]?.opencode, `${name} has an OpenCode reason`)
  }
  const m = mcp(home, baseEnv(home))
  assert.ok(m.servers.length > 0)
  for (const server of m.servers) {
    assert.equal(server.tools.claude, 'error', server.name)
    assert.ok(server.reasons?.claude, `${server.name} has a Claude reason`)
    assert.equal(server.reasons?.codex, undefined, `${server.name} codex is fine`)
  }
})
