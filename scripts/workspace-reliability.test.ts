import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWorkspace, readMcpServer, switchWorkspace, upsertMcpServer } from '../src/engine'
import { fetchMcpTools } from '../src/main/mcpTools'
import { marketHandlers } from '../src/main/market'
import { readOrigins, recordOrigin } from '../src/engine/market/origins'
import { baseEnv, buildDemoHome } from './readme-shots'

async function waitFor(path: string): Promise<void> {
  const until = Date.now() + 10_000
  while (!existsSync(path)) {
    assert.ok(Date.now() < until, 'fixture MCP did not reach tools/list')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('an MCP tool response from one workspace never updates the same-name server in another workspace', async () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-workspace-mcp-'))
  buildDemoHome(home, { tools: 'all' })
  const signal = join(home, 'mcp-gate')
  const server = {
    transport: 'stdio' as const,
    command: process.execPath,
    args: [resolve('scripts/fixtures/mcp-tools-server.mjs')],
    env: { FIXTURE_WAIT_PATH: signal }
  }
  upsertMcpServer(home, 'fixture', server)
  const second = createWorkspace(home, 'Second', { from: 'current' })
  const request = fetchMcpTools(home, 'fixture', { env: baseEnv(home), timeoutMs: 15_000 })
  // Attach the expected rejection before releasing the server.
  const rejected = assert.rejects(request, { code: 'workspaceChanged' })
  await waitFor(`${signal}.started`)
  switchWorkspace(home, second.id)
  writeFileSync(`${signal}.release`, '')
  await rejected
  assert.equal(
    (readMcpServer(home, 'fixture')._ as { tools?: string[] } | undefined)?.tools,
    undefined
  )
  switchWorkspace(home, 'default')
  assert.equal(
    (readMcpServer(home, 'fixture')._ as { tools?: string[] } | undefined)?.tools,
    undefined
  )
})

test('an MCP tool response never attaches to a server edited while tools were loading', async () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-revision-mcp-'))
  buildDemoHome(home, { tools: 'all' })
  const signal = join(home, 'mcp-gate')
  const server = {
    transport: 'stdio' as const,
    command: process.execPath,
    args: [resolve('scripts/fixtures/mcp-tools-server.mjs')],
    env: { FIXTURE_WAIT_PATH: signal }
  }
  upsertMcpServer(home, 'fixture', server)
  const request = fetchMcpTools(home, 'fixture', { env: baseEnv(home), timeoutMs: 15_000 })
  const rejected = assert.rejects(request, { code: 'changed' })
  await waitFor(`${signal}.started`)
  upsertMcpServer(home, 'fixture', { ...server, env: { FIXTURE_MODE: 'x' } })
  writeFileSync(`${signal}.release`, '')
  await rejected
  assert.deepEqual(readMcpServer(home, 'fixture').env, { FIXTURE_MODE: 'x' })
  assert.equal(
    (readMcpServer(home, 'fixture')._ as { tools?: string[] } | undefined)?.tools,
    undefined
  )
})

test('a marketplace update prepared in one workspace never changes a clone after switching', async () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-workspace-market-'))
  buildDemoHome(home, { tools: 'all' })
  upsertMcpServer(home, 'docs', { transport: 'http', url: 'https://example.com/mcp' })
  recordOrigin(home, {
    kind: 'mcp',
    name: 'docs',
    source: 'mcp-registry',
    id: 'io.fixture/docs',
    ref: '1.0.0',
    choice: 'remote:0',
    installedAt: '2026-01-01T00:00:00Z'
  })
  const second = createWorkspace(home, 'Second', { from: 'current' })
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const reached = new Promise<void>((resolve) => {
    started = resolve
  })
  const previous = globalThis.fetch
  globalThis.fetch = async () => {
    started()
    await waiting
    return Response.json({
      server: {
        name: 'io.fixture/docs',
        version: '2.0.0',
        remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }]
      }
    })
  }
  try {
    const handlers = marketHandlers(home, async (fn) => ({ ok: true, value: fn() }))
    const updating = handlers.marketUpdate('mcp', 'docs')
    await reached
    switchWorkspace(home, second.id)
    release()
    const result = await updating
    assert.equal('ok' in result && result.ok, false)
    assert.equal(readOrigins(home)['mcp:docs'].ref, '1.0.0')
    switchWorkspace(home, 'default')
    assert.equal(readOrigins(home)['mcp:docs'].ref, '1.0.0')
  } finally {
    release()
    globalThis.fetch = previous
  }
})

test('a marketplace update refuses a same-workspace item edited while its download was pending', async () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-revision-market-'))
  buildDemoHome(home, { tools: 'all' })
  upsertMcpServer(home, 'docs', { transport: 'http', url: 'https://example.com/mcp' })
  recordOrigin(home, {
    kind: 'mcp',
    name: 'docs',
    source: 'mcp-registry',
    id: 'io.fixture/docs',
    ref: '1.0.0',
    choice: 'remote:0',
    installedAt: '2026-01-01T00:00:00Z'
  })
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const reached = new Promise<void>((resolve) => {
    started = resolve
  })
  const previous = globalThis.fetch
  globalThis.fetch = async () => {
    started()
    await waiting
    return Response.json({
      server: {
        name: 'io.fixture/docs',
        version: '2.0.0',
        remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }]
      }
    })
  }
  try {
    const handlers = marketHandlers(home, async (fn) => ({ ok: true, value: fn() }))
    const updating = handlers.marketUpdate('mcp', 'docs')
    await reached
    upsertMcpServer(home, 'docs', { transport: 'http', url: 'https://example.com/edited' })
    release()
    const result = await updating
    assert.equal('ok' in result && result.ok, false)
    assert.equal(readMcpServer(home, 'docs').url, 'https://example.com/edited')
    assert.equal(readOrigins(home)['mcp:docs'].ref, '1.0.0')
  } finally {
    release()
    globalThis.fetch = previous
  }
})
