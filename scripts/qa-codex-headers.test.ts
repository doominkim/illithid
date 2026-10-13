import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parse } from 'smol-toml'
import { buildCodexMcpBody } from '../src/engine/targets/codexMcp'

test('Codex environment-backed HTTP headers preserve dotted header names as literal keys', () => {
  const { body, warnings, serverErrors } = buildCodexMcpBody(
    {
      servers: {
        fixture: {
          transport: 'http',
          url: 'https://fixture.invalid/mcp',
          headers: { 'X.Company': '${FIXTURE_KEY}', 'X-Other': '${OTHER_KEY}' }
        }
      }
    },
    {}
  )
  assert.deepEqual(warnings, [])
  assert.deepEqual(serverErrors, {})
  const parsed = parse(body).mcp_servers as Record<
    string,
    { env_http_headers: Record<string, string> }
  >
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.fixture.env_http_headers)), {
    'X.Company': 'FIXTURE_KEY',
    'X-Other': 'OTHER_KEY'
  })
})
