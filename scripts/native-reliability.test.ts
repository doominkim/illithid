import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import {
  applyImport,
  createWorkspace,
  memorySecretBackend,
  planImport,
  readMcpServer,
  switchWorkspace,
  syncAll,
  upsertMcpServer
} from '../src/engine'
import { baseEnv, buildDemoHome } from './readme-shots'
import { prepareSkill, type FetchFn } from '../src/engine/market'

const SHA = 'a'.repeat(40)
const SOURCE = 'fixture/skills'
function skillFetch(markdown: string): FetchFn {
  return async (url) => {
    if (url.endsWith('/commits/HEAD')) return new Response(SHA)
    if (url.includes('/git/trees/'))
      return new Response(
        JSON.stringify({
          sha: SHA,
          truncated: false,
          tree: [
            { path: 'skills/example', mode: '040000', type: 'tree', sha: 'folder' },
            { path: 'skills/example/SKILL.md', mode: '100644', type: 'blob', size: markdown.length }
          ]
        })
      )
    if (url.endsWith('/skills/example/SKILL.md')) return new Response(markdown)
    return new Response('not found', { status: 404 })
  }
}

test('market preparation rejects executable frontmatter without evaluating it', async () => {
  const probe = globalThis as typeof globalThis & { illithidNativeProbe?: number }
  probe.illithidNativeProbe = 0
  try {
    for (const engine of ['js', 'javascript']) {
      const md = `---${engine}\n(globalThis.illithidNativeProbe += 1, {name: 'example'})\n---\n# Example\n`
      await assert.rejects(prepareSkill(skillFetch(md), SOURCE, 'example'), { code: 'invalid' })
      assert.equal(probe.illithidNativeProbe, 0)
    }
  } finally {
    delete probe.illithidNativeProbe
  }
})

function nativeHome(tools: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-native-reliability-'))
  buildDemoHome(home, { tools: 'all' })
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), toolsInUse: tools })
  )
  return home
}
function sync(home: string): void {
  const r = syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
  assert.equal(r.refused, undefined)
  assert.deepEqual(r.plan.errors, [])
}

test('sync replaces a dotted-key Codex server and preserves unrelated native settings', () => {
  const home = nativeHome(['codex'])
  const path = join(home, '.codex/config.toml')
  writeFileSync(
    path,
    'model = "fixture-model"\nmcp_servers.demo = { command = "old" }\nmcp_servers.native = { command = "keep" }\n[sandbox_workspace_write]\nnetwork_access = true\n'
  )
  upsertMcpServer(home, 'demo', { transport: 'stdio', command: 'new' })
  sync(home)
  const config = JSON.parse(JSON.stringify(parseToml(readFileSync(path, 'utf8'))))
  assert.equal(config.model, 'fixture-model')
  assert.deepEqual(config.sandbox_workspace_write, { network_access: true })
  assert.deepEqual((config.mcp_servers as Record<string, unknown>).native, { command: 'keep' })
  assert.deepEqual((config.mcp_servers as Record<string, unknown>).demo, {
    command: 'new',
    args: []
  })
})

test('sync keeps indented native TOML headers and comments after a managed server', () => {
  const home = nativeHome(['codex'])
  const path = join(home, '.codex/config.toml')
  writeFileSync(
    path,
    '[mcp_servers.demo]\ncommand = "old"\n  [sandbox_workspace_write]\n# Native sandbox policy\nnetwork_access = true\n'
  )
  upsertMcpServer(home, 'demo', { transport: 'stdio', command: 'new' })
  sync(home)
  const output = readFileSync(path, 'utf8')
  assert.equal(
    (parseToml(output).sandbox_workspace_write as Record<string, unknown>).network_access,
    true
  )
  assert.ok(output.includes('# Native sandbox policy'))
})

test('MCP-only Claude permissions apply without replacing native command permissions', () => {
  const home = nativeHome(['claude'])
  const path = join(home, '.claude/settings.json')
  writeFileSync(
    path,
    JSON.stringify({
      theme: 'fixture',
      permissions: {
        allow: ['Bash(git status:*)', 'mcp__native'],
        deny: ['Read(.env)'],
        defaultMode: 'default'
      }
    })
  )
  upsertMcpServer(home, 'demo', {
    transport: 'stdio',
    command: 'fixture',
    permissions: { tools: { erase: 'deny' } }
  })
  sync(home)
  const config = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(config.theme, 'fixture')
  assert.deepEqual(config.permissions.allow, ['Bash(git status:*)', 'mcp__native'])
  assert.deepEqual(config.permissions.deny.sort(), ['Read(.env)', 'mcp__demo__erase'].sort())
  assert.equal(config.permissions.defaultMode, 'default')
})

test('Claude settings without managed permissions stay byte-for-byte unchanged', () => {
  const home = nativeHome(['claude'])
  const path = join(home, '.claude/settings.json')
  const native = '{"theme":"fixture"}\n'
  writeFileSync(path, native)
  sync(home)
  assert.equal(readFileSync(path, 'utf8'), native)
})

test('Codex import and sync retain disabled tools alongside an enabled tool list', () => {
  const home = nativeHome(['codex'])
  const path = join(home, '.codex/config.toml')
  writeFileSync(
    path,
    '[mcp_servers.demo]\ncommand = "fixture"\nenabled_tools = ["read", "erase"]\ndisabled_tools = ["erase"]\n[mcp_servers.demo.tools.erase]\napproval_mode = "approve"\n'
  )
  const plan = planImport(home, 'tool:codex')
  const candidate = plan.mcp.find((x) => x.name === 'demo')
  assert.ok(candidate)
  const imported = applyImport(home, [{ kind: 'mcp', name: 'demo' }], 'tool:codex')
  assert.equal(imported[0].status, 'imported')
  assert.deepEqual(readMcpServer(home, 'demo').permissions, { tools: { erase: 'deny' } })
  sync(home)
  const config = parseToml(readFileSync(path, 'utf8'))
  const server = (config.mcp_servers as Record<string, Record<string, unknown>>).demo
  assert.deepEqual(server.enabled_tools, ['read', 'erase'])
  assert.deepEqual(server.disabled_tools, ['erase'])
  assert.equal(server.tools, undefined)
  assert.equal(
    planImport(home, 'tool:codex').mcp.some((x) => x.name === 'demo'),
    false
  )
})

test('OpenCode JSONC-only configs import MCP servers and inline agents with comments and trailing commas', () => {
  const home = nativeHome(['opencode'])
  const path = join(home, '.config/opencode/opencode.jsonc')
  unlinkSync(join(home, '.config/opencode/opencode.json'))
  const source = `{
    // Native OpenCode settings
    "mcp": { "demo": { "type": "local", "command": ["fixture"], }, },
    "agent": { "jsonc-reviewer": { "description": "Reviews", "prompt": "Check changes,] // literal", }, },
  }\n`
  writeFileSync(path, source)
  const plan = planImport(home, 'tool:opencode')
  assert.ok(plan.mcp.some((x) => x.name === 'demo'))
  assert.ok(plan.agents.some((x) => x.name === 'jsonc-reviewer'))
  const result = applyImport(
    home,
    [
      { kind: 'mcp', name: 'demo' },
      { kind: 'agent', name: 'jsonc-reviewer' }
    ],
    'tool:opencode'
  )
  assert.deepEqual(
    result.map((x) => x.status),
    ['imported', 'imported'],
    JSON.stringify(result)
  )
  assert.equal(readMcpServer(home, 'demo').command, 'fixture')
  assert.equal(readFileSync(path, 'utf8'), source, 'import does not rewrite the source config')
})

test('saving an MCP server keeps credentials used by a cloned workspace until the last reference is removed', () => {
  const home = nativeHome(['claude'])
  const secrets = memorySecretBackend()
  upsertMcpServer(
    home,
    'demo',
    {
      transport: 'http',
      url: 'https://fixture.example/mcp',
      headers: { Authorization: 'fixture-credential' }
    },
    { secrets }
  )
  const clone = createWorkspace(home, 'Credential clone', { from: 'current' })
  upsertMcpServer(
    home,
    'demo',
    { transport: 'http', url: 'https://fixture.example/new' },
    { secrets }
  )
  assert.equal(secrets.get('demo/headers/Authorization'), 'fixture-credential')
  switchWorkspace(home, clone.id)
  assert.equal(
    readMcpServer(home, 'demo').headers?.Authorization,
    'secret:demo/headers/Authorization'
  )
  upsertMcpServer(
    home,
    'demo',
    { transport: 'http', url: 'https://fixture.example/final' },
    { secrets }
  )
  assert.equal(secrets.get('demo/headers/Authorization'), null)
})

test('import replacement keeps credentials referenced by a cloned workspace', () => {
  const home = nativeHome(['codex'])
  const secrets = memorySecretBackend()
  upsertMcpServer(
    home,
    'demo',
    {
      transport: 'http',
      url: 'https://fixture.example/mcp',
      headers: { Authorization: 'fixture-credential' }
    },
    { secrets }
  )
  const clone = createWorkspace(home, 'Import credential clone', { from: 'current' })
  writeFileSync(join(home, '.codex/config.toml'), '[mcp_servers.demo]\ncommand = "fixture"\n')
  const result = applyImport(home, [{ kind: 'mcp', name: 'demo', overwrite: true }], 'tool:codex', {
    secrets
  })
  assert.equal(result[0].status, 'imported')
  assert.equal(secrets.get('demo/headers/Authorization'), 'fixture-credential')
  switchWorkspace(home, clone.id)
  assert.equal(
    readMcpServer(home, 'demo').headers?.Authorization,
    'secret:demo/headers/Authorization'
  )
})

test('Codex import reports server settings that cannot be carried into the library', () => {
  const home = nativeHome(['codex'])
  writeFileSync(
    join(home, '.codex/config.toml'),
    '[mcp_servers.demo]\ncommand = "fixture"\nrequired = true\ntool_timeout_sec = 15\n'
  )
  const plan = planImport(home, 'tool:codex')
  const candidate = plan.mcp.find((x) => x.name === 'demo')!
  assert.ok(candidate)
  assert.ok(candidate.variants[0].warnings.some((x) => x.includes('required')))
  assert.ok(candidate.variants[0].warnings.some((x) => x.includes('tool_timeout_sec')))
})

test('Grok sync replaces dotted MCP entries while keeping compat and native server settings', () => {
  const home = nativeHome(['grok'])
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), grokReadsClaude: false })
  )
  mkdirSync(join(home, '.grok'), { recursive: true })
  const path = join(home, '.grok/config.toml')
  writeFileSync(
    path,
    'mcp_servers.demo = { command = "old", tool_timeout_sec = 30 }\nmcp_servers.native = { command = "keep" }\n[permission]\nallow = ["Read(*)"]\n'
  )
  upsertMcpServer(home, 'demo', { transport: 'stdio', command: 'new' })
  sync(home)
  sync(home)
  const config = JSON.parse(JSON.stringify(parseToml(readFileSync(path, 'utf8'))))
  assert.equal(config.mcp_servers.demo.command, 'new')
  assert.equal(config.mcp_servers.demo.tool_timeout_sec, 30)
  assert.deepEqual(config.mcp_servers.native, { command: 'keep' })
  assert.deepEqual(config.permission, { allow: ['Read(*)'] })
  assert.deepEqual(config.compat.claude, { skills: false, mcps: false, hooks: false })
})

for (const tool of ['codex', 'grok'] as const)
  test(`${tool} sync keeps the full external native server when a required secret is missing`, () => {
    const inline =
      '{ command = "old", args = ["native"], env = { MODE = "native" }, tool_timeout_sec = 19 }'
    const table =
      '[mcp_servers.demo]\n# Preserved native server\ncommand = "old"\nargs = ["native"]\ntool_timeout_sec = 19\n[mcp_servers.demo.env]\nMODE = "native"\n'
    const forms = [
      `mcp_servers.demo = ${inline}\n`,
      `mcp_servers = { demo = ${inline} }\n`,
      table,
      `# BEGIN illithid mcp — DO NOT EDIT: generated from library mcps/\n${table}# END illithid mcp\n`
    ]
    for (const source of forms) {
      const home = nativeHome([tool])
      mkdirSync(join(home, `.${tool}`), { recursive: true })
      const path = join(home, `.${tool}/config.toml`)
      const original = {
        command: 'old',
        args: ['native'],
        env: { MODE: 'native' },
        tool_timeout_sec: 19
      }
      writeFileSync(path, source + '[sandbox_workspace_write]\nnetwork_access = true\n')
      upsertMcpServer(home, 'demo', {
        transport: 'stdio',
        command: 'new',
        env: { TOKEN: 'secret:demo/env/TOKEN' }
      })
      for (let pass = 0; pass < 2; pass++) {
        const result = syncAll(home, baseEnv(home), {
          allowReal: true,
          approvedOnce: true,
          secrets: memorySecretBackend()
        })
        assert.equal(result.refused, undefined)
        assert.deepEqual(result.plan.errors, [])
        assert.ok(result.plan.targets.find((x) => x.id === `${tool}Mcp`)?.serverErrors?.demo)
        const output = readFileSync(path, 'utf8')
        const config = JSON.parse(JSON.stringify(parseToml(output)))
        assert.deepEqual(config.mcp_servers?.demo, original)
        assert.deepEqual(config.sandbox_workspace_write, { network_access: true })
        if (source.includes('# Preserved native server'))
          assert.ok(output.includes('# Preserved native server'))
      }
    }
  })

test('MCP-only Claude sync preserves unmanaged and ambiguous server names while removing normal managed stale rules', () => {
  const home = nativeHome(['claude'])
  const path = join(home, '.claude/settings.json')
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: { demo__native: { command: 'native' } }
    })
  )
  writeFileSync(
    path,
    JSON.stringify({
      permissions: {
        allow: ['mcp__demo__native'],
        deny: ['mcp__demo__stale', 'mcp__demo__native__delete', 'mcp__demo__unknown__delete']
      }
    })
  )
  upsertMcpServer(home, 'demo', {
    transport: 'stdio',
    command: 'managed',
    permissions: { tools: { erase: 'deny' } }
  })
  sync(home)
  const permissions = JSON.parse(readFileSync(path, 'utf8')).permissions
  assert.deepEqual(permissions.allow, ['mcp__demo__native'])
  assert.deepEqual(
    permissions.deny.sort(),
    ['mcp__demo__erase', 'mcp__demo__native__delete', 'mcp__demo__unknown__delete'].sort()
  )
})

test('Codex disabled-tool import preserves the accepted __proto__ tool name', () => {
  const home = nativeHome(['codex'])
  const path = join(home, '.codex/config.toml')
  writeFileSync(path, '[mcp_servers.demo]\ncommand = "fixture"\ndisabled_tools = ["__proto__"]\n')
  const result = applyImport(home, [{ kind: 'mcp', name: 'demo' }], 'tool:codex')
  assert.equal(result[0].status, 'imported')
  const permissions = readMcpServer(home, 'demo').permissions
  assert.ok(permissions?.tools && Object.hasOwn(permissions.tools, '__proto__'))
  assert.equal(permissions.tools.__proto__, 'deny')
  sync(home)
  const servers = parseToml(readFileSync(path, 'utf8')).mcp_servers as Record<
    string,
    Record<string, unknown>
  >
  assert.deepEqual(servers.demo.disabled_tools, ['__proto__'])
})

test('Codex approval import preserves prototype-like tool names as own properties', () => {
  const home = nativeHome(['codex'])
  const path = join(home, '.codex/config.toml')
  writeFileSync(
    path,
    '[mcp_servers.demo]\ncommand = "fixture"\n[mcp_servers.demo.tools.__proto__]\napproval_mode = "prompt"\n[mcp_servers.demo.tools.constructor]\napproval_mode = "writes"\n'
  )
  const result = applyImport(home, [{ kind: 'mcp', name: 'demo' }], 'tool:codex')
  assert.equal(result[0].status, 'imported')
  const approvals = readMcpServer(home, 'demo').codex?.toolApprovals
  assert.ok(approvals && Object.hasOwn(approvals, '__proto__'))
  assert.equal(approvals.__proto__, 'prompt')
  assert.equal(approvals.constructor, 'writes')
  sync(home)
  const servers = parseToml(readFileSync(path, 'utf8')).mcp_servers as Record<
    string,
    Record<string, unknown>
  >
  const tools = servers.demo.tools as Record<string, Record<string, unknown>>
  assert.equal(tools.__proto__.approval_mode, 'prompt')
  assert.equal(
    Object.entries(tools).find(([name]) => name === 'constructor')?.[1].approval_mode,
    'writes'
  )
})

test('shared MCP permissions project the accepted __proto__ tool to a Codex approval', () => {
  const home = nativeHome(['codex'])
  upsertMcpServer(home, 'demo', {
    transport: 'stdio',
    command: 'fixture',
    permissions: JSON.parse('{"tools":{"__proto__":"ask"}}')
  })
  sync(home)
  const servers = parseToml(readFileSync(join(home, '.codex/config.toml'), 'utf8'))
    .mcp_servers as Record<string, Record<string, unknown>>
  const tools = servers.demo.tools as Record<string, Record<string, unknown>> | undefined
  assert.equal(tools?.__proto__?.approval_mode, 'prompt')
})

test('Claude mirrors prototype-like Codex tool approvals despite unrelated shared permissions', () => {
  const home = nativeHome(['claude', 'codex'])
  upsertMcpServer(home, 'demo', {
    transport: 'stdio',
    command: 'fixture',
    codex: { toolApprovals: JSON.parse('{"__proto__":"writes","constructor":"prompt"}') },
    permissions: { tools: { erase: 'deny' } }
  })
  sync(home)
  const permissions = JSON.parse(
    readFileSync(join(home, '.claude/settings.json'), 'utf8')
  ).permissions
  assert.deepEqual(
    permissions.ask?.sort(),
    ['mcp__demo____proto__', 'mcp__demo__constructor'].sort()
  )
  assert.deepEqual(permissions.deny, ['mcp__demo__erase'])
})

test('Claude sync reports preserved compound MCP permissions when prior state has only server ownership', () => {
  const home = nativeHome(['claude'])
  upsertMcpServer(home, 'demo', { transport: 'stdio', command: 'fixture' })
  const settings = join(home, '.claude/settings.json')
  const before = JSON.stringify({ permissions: { deny: ['mcp__demo__group__delete'] } })
  writeFileSync(settings, before)
  writeFileSync(
    join(home, '.config/illithid/state.json'),
    JSON.stringify({
      version: 1,
      applied: {},
      owned: { claudeMcp: ['demo'] }
    })
  )
  const result = syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
  assert.deepEqual(result.plan.errors, [])
  assert.equal(readFileSync(settings, 'utf8'), before)
  const target = result.plan.targets.find((x) => x.id === 'claudePermissions')
  assert.ok(
    target?.notes.some(
      (note) => note.includes('ambiguous MCP permission') && note.includes('preserved')
    )
  )
})
