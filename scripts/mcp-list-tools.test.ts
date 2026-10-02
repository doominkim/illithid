import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readMcpServer, upsertMcpServer } from '../src/engine'
import { fetchMcpTools, listMcpTools } from '../src/main/mcpTools'
import { baseEnv, buildDemoHome } from './readme-shots'

const SERVER = resolve('scripts/fixtures/mcp-tools-server.mjs')

function demoHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-mcp-tools-'))
  buildDemoHome(home, { tools: 'all' })
  return home
}

test('REQ-MCP-TOOLS-1 the full tool list comes from the server itself; the names are kept with the server', async () => {
  const home = demoHome()
  // The engine's write: values stay in the file (mcpSave would move them to the real Keychain)
  upsertMcpServer(home, 'fixture', {
    transport: 'stdio',
    command: process.execPath,
    args: [SERVER],
    env: { FIXTURE_MODE: 'x' },
    _: { description: 'Test server' }
  })
  const env = baseEnv(home)
  assert.deepEqual(await listMcpTools(home, 'fixture', { env }), [
    'delete_task',
    'from_env',
    'get_task'
  ])
  await fetchMcpTools(home, 'fixture', { env })
  assert.deepEqual(readMcpServer(home, 'fixture')._, {
    description: 'Test server',
    tools: ['delete_task', 'from_env', 'get_task']
  })
  // Kept with the server, never in what a tool gets
  assert.doesNotMatch(
    readFileSync(join(home, '.illithid/workspaces/default/mcps/fixture.json'), 'utf8'),
    /"permissions"/
  )
})

test('REQ-MCP-TOOLS-2 a server that never answers stops at the time limit', async () => {
  const home = demoHome()
  upsertMcpServer(home, 'stuck', {
    transport: 'stdio',
    command: process.execPath,
    args: [SERVER, 'hang']
  })
  const started = Date.now()
  await assert.rejects(listMcpTools(home, 'stuck', { env: baseEnv(home), timeoutMs: 1500 }), {
    code: 'timeout'
  })
  assert.ok(Date.now() - started < 6000)
})
