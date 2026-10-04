import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { savePermissionRules, setMcpDefault, syncAll, upsertMcpServer } from '../src/engine'
import { mcpSave } from '../src/main/writes'
import { baseEnv, buildDemoHome } from './readme-shots'

function demoHome(tools: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-mcp-perm-'))
  buildDemoHome(home, { tools: 'all' })
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), toolsInUse: tools })
  )
  savePermissionRules(home, { commands: [] })
  return home
}

const sync = (home: string): void => {
  const r = syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
  assert.equal(r.refused, undefined)
  assert.deepEqual(r.plan.errors, [])
}

/** kaneo: allowed, one tool blocked and one asked. gh: blocked, two tools let through, one Codex-only approval */
function withServers(home: string): void {
  mcpSave(home, 'kaneo', {
    transport: 'http',
    url: 'https://kaneo.example/mcp',
    permissions: { default: 'allow', tools: { delete_task: 'deny', update_task: 'ask' } }
  })
  mcpSave(home, 'gh', {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'gh-mcp'],
    codex: { toolApprovals: { list_repos: 'writes' } },
    permissions: { default: 'deny', tools: { get_issue: 'allow', search: 'ask' } }
  })
}

test('REQ-MCP-PERM-1 Claude Code gets a server rule and tool rules in allow, ask and deny', () => {
  const home = demoHome(['claude'])
  withServers(home)
  sync(home)
  const p = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).permissions as {
    allow: string[]
    ask: string[]
    deny: string[]
  }
  for (const r of ['mcp__kaneo', 'mcp__gh__get_issue']) assert.ok(p.allow.includes(r), r)
  // A Codex-only approval for a tool the rules leave alone still asks, as before
  for (const r of ['mcp__kaneo__update_task', 'mcp__gh__search', 'mcp__gh__list_repos'])
    assert.ok(p.ask.includes(r), r)
  for (const r of ['mcp__kaneo__delete_task', 'mcp__gh']) assert.ok(p.deny.includes(r), r)
  // The rules stay out of the server entry
  const servers = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers as Record<
    string,
    Record<string, unknown>
  >
  assert.equal(servers.kaneo.permissions, undefined)
})

test('REQ-MCP-PERM-2 Codex gets the default approval, per-tool approvals, disabled tools, and only the let-through tools when blocked', () => {
  const home = demoHome(['codex'])
  withServers(home)
  sync(home)
  const toml = parseToml(readFileSync(join(home, '.codex/config.toml'), 'utf8')) as {
    mcp_servers: Record<
      string,
      {
        default_tools_approval_mode?: string
        enabled_tools?: string[]
        disabled_tools?: string[]
        tools?: Record<string, { approval_mode: string }>
        permissions?: unknown
      }
    >
  }
  const kaneo = toml.mcp_servers.kaneo
  assert.equal(kaneo.default_tools_approval_mode, 'approve')
  assert.deepEqual(kaneo.disabled_tools, ['delete_task'])
  assert.equal(kaneo.tools?.update_task.approval_mode, 'prompt')
  assert.equal(kaneo.tools?.delete_task, undefined)
  assert.equal(kaneo.permissions, undefined)
  const gh = toml.mcp_servers.gh
  assert.equal(gh.default_tools_approval_mode, undefined)
  assert.deepEqual(gh.enabled_tools, ['get_issue', 'search'])
  assert.equal(gh.tools?.get_issue.approval_mode, 'approve')
  assert.equal(gh.tools?.search.approval_mode, 'prompt')
  assert.equal(gh.tools?.list_repos.approval_mode, 'writes')
})

test("REQ-MCP-PERM-3 Gemini CLI gets policy rules per server and tool, the tool's above the server's", () => {
  const home = demoHome(['gemini'])
  withServers(home)
  sync(home)
  const policy = parseToml(readFileSync(join(home, '.gemini/policies/illithid.toml'), 'utf8')) as {
    rule: { mcpName?: string; toolName?: string; decision: string; priority: number }[]
  }
  const mcp = policy.rule.filter((r) => r.mcpName)
  const find = (server: string, tool?: string): (typeof mcp)[number] | undefined =>
    mcp.find((r) => r.mcpName === server && r.toolName === tool)
  assert.equal(find('kaneo')?.decision, 'allow')
  assert.equal(find('kaneo', 'delete_task')?.decision, 'deny')
  assert.equal(find('kaneo', 'update_task')?.decision, 'ask_user')
  assert.equal(find('gh')?.decision, 'deny')
  assert.equal(find('gh', 'get_issue')?.decision, 'allow')
  for (const r of mcp.filter((x) => x.toolName))
    assert.ok(r.priority > find(r.mcpName!)!.priority, `${r.mcpName}/${r.toolName}`)
  const gemini = JSON.parse(readFileSync(join(home, '.gemini/settings.json'), 'utf8')).mcpServers
  assert.equal(gemini.kaneo.permissions, undefined)
})

test('REQ-MCP-PERM-4 broken rules are refused', () => {
  const home = demoHome(['claude'])
  const def = { transport: 'http', url: 'https://x.example/mcp' }
  for (const permissions of [
    { default: 'nope' },
    { tools: { get: 'maybe' } },
    { tools: { 'bad name!': 'allow' } },
    'allow'
  ])
    assert.throws(() => upsertMcpServer(home, 'x', { ...def, permissions } as never), {
      code: 'invalidSchema'
    })
})

test('REQ-MCP-PERM-5 OpenCode gets permission keys, each server catch-all before its tools (the last match wins); the rest stays', () => {
  const home = demoHome(['opencode'])
  withServers(home)
  sync(home)
  const file = join(home, '.config/opencode/opencode.json')
  // A rule of the user's stays where it is
  const config = JSON.parse(readFileSync(file, 'utf8'))
  config.permission = { edit: 'ask', ...(config.permission ?? {}) }
  writeFileSync(file, JSON.stringify(config, null, 2))
  sync(home)
  const perm = JSON.parse(readFileSync(file, 'utf8')).permission as Record<string, unknown>
  const mcpKeys = Object.entries(perm).filter(([k]) => /^(kaneo|gh)_/.test(k))
  assert.deepEqual(mcpKeys, [
    ['gh_*', 'deny'],
    ['gh_get_issue', 'allow'],
    ['gh_search', 'ask'],
    ['kaneo_*', 'allow'],
    ['kaneo_delete_task', 'deny'],
    ['kaneo_update_task', 'ask']
  ])
  assert.equal(perm.edit, 'ask')
  assert.ok(Object.keys(perm).indexOf('edit') < Object.keys(perm).indexOf('gh_*'))
  // Rules gone: their keys go, the user's stays
  mcpSave(home, 'gh', { transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'] })
  mcpSave(home, 'kaneo', { transport: 'http', url: 'https://kaneo.example/mcp' })
  sync(home)
  const after = JSON.parse(readFileSync(file, 'utf8')).permission as Record<string, unknown>
  assert.deepEqual(
    Object.keys(after).filter((k) => /^(kaneo|gh)_/.test(k)),
    []
  )
  assert.equal(after.edit, 'ask')
})

test('REQ-MCP-PERM-6 the default for all MCP servers applies to servers without their own default, in every tool, new servers included', () => {
  const home = demoHome(['claude', 'codex', 'gemini', 'opencode'])
  withServers(home)
  // notion has no rules; kaneo keeps a tool rule but follows the default for the rest
  mcpSave(home, 'notion', { transport: 'http', url: 'https://notion.example/mcp' })
  mcpSave(home, 'kaneo', {
    transport: 'http',
    url: 'https://kaneo.example/mcp',
    permissions: { tools: { delete_task: 'deny' } }
  })
  setMcpDefault(home, 'allow')
  sync(home)

  const claude = (): { allow: string[]; ask: string[]; deny: string[] } =>
    JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).permissions
  for (const r of ['mcp__notion', 'mcp__kaneo']) assert.ok(claude().allow.includes(r), r)
  // gh keeps its own default (block)
  assert.ok(!claude().allow.includes('mcp__gh'))
  for (const r of ['mcp__gh', 'mcp__kaneo__delete_task']) assert.ok(claude().deny.includes(r), r)

  const codex = parseToml(readFileSync(join(home, '.codex/config.toml'), 'utf8')) as {
    mcp_servers: Record<string, { default_tools_approval_mode?: string; enabled_tools?: string[] }>
  }
  assert.equal(codex.mcp_servers.notion.default_tools_approval_mode, 'approve')
  assert.equal(codex.mcp_servers.kaneo.default_tools_approval_mode, 'approve')
  assert.deepEqual(codex.mcp_servers.gh.enabled_tools, ['get_issue', 'search'])

  const policy = parseToml(readFileSync(join(home, '.gemini/policies/illithid.toml'), 'utf8')) as {
    rule: { mcpName?: string; toolName?: string; decision: string }[]
  }
  const server = (name: string): string | undefined =>
    policy.rule.find((r) => r.mcpName === name && !r.toolName)?.decision
  assert.equal(server('notion'), 'allow')
  assert.equal(server('gh'), 'deny')

  const perm = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(home, '.config/opencode/opencode.json'), 'utf8')).permission
  assert.equal(perm()['notion_*'], 'allow')
  assert.equal(perm()['gh_*'], 'deny')

  // A server added later follows the default
  mcpSave(home, 'later', { transport: 'http', url: 'https://later.example/mcp' })
  sync(home)
  assert.ok(claude().allow.includes('mcp__later'))

  // Cleared: the servers without their own default go back to each tool's default
  setMcpDefault(home, null)
  sync(home)
  for (const r of ['mcp__notion', 'mcp__later', 'mcp__kaneo'])
    assert.ok(!claude().allow.includes(r), r)
  assert.ok(claude().deny.includes('mcp__gh'))
  assert.equal(perm()['notion_*'], undefined)

  assert.throws(() => setMcpDefault(home, 'maybe' as never), { code: 'invalidSchema' })
})
