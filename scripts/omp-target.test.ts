import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  readModels,
  savePermissionRules,
  setModel,
  setToggle,
  syncAll,
  type PermissionRules,
  type SyncAllResult
} from '../src/engine'
import { ompMcpToolName } from '../src/engine/targets/ompPermissions'
import { baseEnv, buildDemoHome } from './readme-shots'

const WS = '.illithid/workspaces/default'
type Json = Record<string, unknown>

function ompHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-omp-'))
  buildDemoHome(home)
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), toolsInUse: ['omp'] })
  )
  return home
}
function put(home: string, rel: string, text: string): string {
  const path = join(home, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}
function sync(home: string, env = baseEnv(home)): SyncAllResult {
  const r = syncAll(home, env, { allowReal: true, approvedOnce: true })
  assert.equal(r.refused, undefined)
  assert.deepEqual(r.plan.errors, [])
  return r
}
const read = (p: string): string => readFileSync(p, 'utf8')
const json = (p: string): Json => JSON.parse(read(p)) as Json

const RULES: PermissionRules = {
  commands: [
    { decision: 'allow', argv: ['git', 'status'], exact: false },
    { decision: 'allow', argv: ['ls'], exact: true },
    { decision: 'ask', argv: ['npm', 'publish'], exact: false },
    { decision: 'deny', argv: ['rm', '-rf'], exact: false },
    { decision: 'allow', argv: ['echo', 'a*b'], exact: false }
  ]
}

const CONFIG_YML = `# omp settings
modelRoles:
  default: anthropic/claude-opus-5-5:high # my pick
tools:
  approvalMode: write
  approval:
    bash: prompt
bash:
  patterns:
    - match: make *
      approval: allow
`

test('sync writes rules, skills, agents, MCP servers and permissions into ~/.omp/agent and keeps the user content', () => {
  const home = ompHome()
  // A library rule that already decides alwaysApply, an agent with omp settings, a server with tool decisions
  put(
    home,
    `${WS}/rules/60-manual.md`,
    '---\nalwaysApply: false\ndescription: manual\n---\n\n# Manual\n'
  )
  put(
    home,
    `${WS}/agents/reviewer.md`,
    '---\nname: reviewer\ndescription: Reviews changes.\nomp:\n  model: anthropic/claude-opus-5-5\n  effort: high\n---\n\n# reviewer\n'
  )
  put(
    home,
    `${WS}/mcps/playwright.json`,
    JSON.stringify({
      transport: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest'],
      timeoutMs: 30000,
      permissions: { default: 'ask', tools: { browser_navigate: 'deny', snapshot: 'allow' } }
    })
  )
  savePermissionRules(home, RULES)
  const userRule = put(home, '.omp/agent/rules/mine.md', '# mine\n')
  const mcpPath = put(
    home,
    '.omp/agent/mcp.json',
    JSON.stringify(
      {
        $schema: 'https://example.invalid/mcp-schema.json',
        mcpServers: {
          native: { command: 'keep' },
          playwright: { command: 'old', enabled: false, auth: { type: 'apikey' }, timeout: 5 }
        },
        disabledServers: ['github']
      },
      null,
      2
    ) + '\n'
  )
  const cfgPath = put(home, '.omp/agent/config.yml', CONFIG_YML)

  const r = sync(home)
  const rules = join(home, '.omp/agent/rules')

  // Rules: alwaysApply added (frontmatter created or extended), an existing alwaysApply respected, memory index renamed
  const comm = read(join(rules, '00-communication.md'))
  assert.match(comm, /^---\nalwaysApply: true\n---\n\n<!-- Illithid copy\./)
  assert.ok(comm.endsWith(read(join(home, `${WS}/rules/00-communication.md`))))
  const manual = read(join(rules, '60-manual.md'))
  assert.match(manual, /^---\nalwaysApply: false\n/)
  assert.equal(manual.match(/alwaysApply/g)?.length, 1)
  assert.match(read(join(rules, 'illithid-memory.md')), /^---\nalwaysApply: true\n---\n/)
  assert.equal(existsSync(join(rules, 'MEMORY.md')), false)
  assert.equal(read(userRule), '# mine\n')

  // Skills: delivered into omp's skills folder like every symlinkDir tool's
  assert.ok(lstatSync(join(home, '.omp/agent/skills/code-review')).isDirectory())
  assert.match(read(join(home, '.omp/agent/skills/code-review/SKILL.md')), /name: code-review/)

  // Agents: name, description, model, thinkingLevel
  assert.equal(
    read(join(home, '.omp/agent/agents/reviewer.md')),
    '---\nname: reviewer\ndescription: Reviews changes.\nmodel: anthropic/claude-opus-5-5\nthinkingLevel: high\n---\n\n# reviewer\n'
  )

  // mcp.json: other keys and servers kept, omp-only keys of a library server kept, the library's timeout wins
  const mcp = json(mcpPath)
  assert.equal(mcp.$schema, 'https://example.invalid/mcp-schema.json')
  assert.deepEqual(mcp.disabledServers, ['github'])
  const servers = mcp.mcpServers as Record<string, Json>
  assert.deepEqual(servers.native, { command: 'keep' })
  assert.deepEqual(servers.playwright, {
    type: 'stdio',
    command: 'npx',
    args: ['@playwright/mcp@latest'],
    timeout: 30000,
    auth: { type: 'apikey' },
    enabled: false
  })
  assert.deepEqual(servers.context7, {
    type: 'http',
    url: 'https://mcp.context7.com/mcp',
    headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' }
  })
  assert.deepEqual(servers.postgres.env, { DATABASE_URL: '${DATABASE_URL}' })

  // config.yml: patterns deny → prompt → allow (prefix rules twice, exact once, `*` rules left out); MCP tool decisions as
  // tools.approval; comments and every other key kept
  const cfgText = read(cfgPath)
  assert.ok(cfgText.startsWith('# omp settings\n'))
  assert.match(cfgText, /default: anthropic\/claude-opus-5-5:high # my pick/)
  const cfg = parseYaml(cfgText) as Json
  assert.deepEqual(cfg.modelRoles, { default: 'anthropic/claude-opus-5-5:high' })
  assert.deepEqual((cfg.bash as Json).patterns, [
    { match: 'rm -rf', approval: 'deny' },
    { match: 'rm -rf *', approval: 'deny' },
    { match: 'npm publish', approval: 'prompt' },
    { match: 'npm publish *', approval: 'prompt' },
    { match: 'git status', approval: 'allow' },
    { match: 'git status *', approval: 'allow' },
    { match: 'ls', approval: 'allow' }
  ])
  assert.deepEqual(cfg.tools, {
    approvalMode: 'write',
    approval: {
      bash: 'prompt',
      mcp__playwright_browser_navigate: 'deny',
      mcp__playwright_snapshot: 'allow'
    }
  })
  const notes = r.plan.targets.find((t) => t.id === 'ompPermissions')!.notes.join('\n')
  assert.match(notes, /make \*/) // the omp-only rule that was replaced
  assert.match(notes, /echo 'a\*b'|echo a\*b/) // the rule omp can't express
  assert.match(notes, /playwright \(ask\)/) // the server default omp can't express

  // A second sync changes nothing
  const again = sync(home)
  for (const id of ['ompMcp', 'ompPermissions'] as const)
    assert.equal(again.plan.targets.find((t) => t.id === id)?.changed, false, id)
  assert.equal(read(cfgPath), cfgText)
})

test('turned-off items are skipped or removed, and a dropped MCP decision leaves tools.approval', () => {
  const home = ompHome()
  put(
    home,
    `${WS}/mcps/playwright.json`,
    JSON.stringify({
      transport: 'stdio',
      command: 'npx',
      permissions: { tools: { click: 'deny' } }
    })
  )
  setToggle(home, 'rules', '10-code-style.md', 'omp', false)
  setToggle(home, 'agents', 'planner', 'omp', false)
  setToggle(home, 'skills', 'sql-explain', 'omp', false)
  const cfgPath = put(home, '.omp/agent/config.yml', 'tools:\n  approval:\n    eval: deny\n')
  sync(home)
  assert.equal(existsSync(join(home, '.omp/agent/rules/10-code-style.md')), false)
  assert.equal(existsSync(join(home, '.omp/agent/agents/planner.md')), false)
  assert.equal(existsSync(join(home, '.omp/agent/skills/sql-explain')), false)
  assert.ok(existsSync(join(home, '.omp/agent/agents/reviewer.md')))
  assert.deepEqual(parseYaml(read(cfgPath)), {
    tools: { approval: { eval: 'deny', mcp__playwright_click: 'deny' } }
  })

  // The server goes off for omp: its entry and its tool decision leave, the user's key stays
  setToggle(home, 'mcp', 'playwright', 'omp', false)
  sync(home)
  const servers = json(join(home, '.omp/agent/mcp.json')).mcpServers as Json
  assert.equal(servers.playwright, undefined)
  assert.ok(servers.context7)
  assert.deepEqual(parseYaml(read(cfgPath)), { tools: { approval: { eval: 'deny' } } })
})

test("without a library permissions.json the user's bash.patterns stay", () => {
  const home = ompHome()
  const cfgPath = put(home, '.omp/agent/config.yml', CONFIG_YML)
  sync(home)
  assert.equal(read(cfgPath), CONFIG_YML)
})

test('a config.yml omp could not parse is not written', () => {
  const home = ompHome()
  savePermissionRules(home, RULES)
  const broken = 'bash:\n  patterns: [\n'
  const cfgPath = put(home, '.omp/agent/config.yml', broken)
  const r = syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
  const c = r.plan.targets.find((t) => t.id === 'ompPermissions')!
  assert.match(c.error ?? '', /not valid YAML/)
  assert.equal(read(cfgPath), broken)
})

test("omp's agent folder moved elsewhere skips every omp write", () => {
  const home = ompHome()
  savePermissionRules(home, RULES)
  const cfgPath = put(home, '.omp/agent/config.yml', CONFIG_YML)
  const envs: Record<string, string>[] = [
    { PI_CODING_AGENT_DIR: join(home, 'elsewhere') },
    { OMP_PROFILE: 'work' },
    { PI_CONFIG_DIR: '.pi' }
  ]
  for (const env of envs) {
    const r = sync(home, { ...baseEnv(home), ...env })
    assert.equal(
      r.plan.targets.find((t) => t.id === 'ompPermissions')?.skip,
      'ompHomeOverride',
      JSON.stringify(env)
    )
    for (const dir of ['rules', 'skills', 'agents'])
      assert.equal(existsSync(join(home, '.omp/agent', dir)), false, dir)
    assert.equal(existsSync(join(home, '.omp/agent/mcp.json')), false)
    assert.equal(read(cfgPath), CONFIG_YML)
  }
})

test('omp default model is read from and written to modelRoles.default, keeping comments', () => {
  const home = ompHome()
  const cfgPath = put(home, '.omp/agent/config.yml', CONFIG_YML)
  const omp = readModels(home).find((m) => m.tool === 'omp')
  assert.deepEqual(omp?.values, [
    { key: 'modelRoles.default', value: 'anthropic/claude-opus-5-5:high' }
  ])
  setModel(home, 'omp', 'modelRoles.default', 'openai/gpt-6-sol')
  assert.equal(
    read(cfgPath),
    CONFIG_YML.replace('anthropic/claude-opus-5-5:high', 'openai/gpt-6-sol')
  )
  // A config without modelRoles gets the map; a modelRoles that is not a map is refused
  writeFileSync(cfgPath, 'theme:\n  dark: dark\n')
  setModel(home, 'omp', 'modelRoles.default', 'xai/grok-4.7')
  assert.deepEqual(parseYaml(read(cfgPath)), {
    theme: { dark: 'dark' },
    modelRoles: { default: 'xai/grok-4.7' }
  })
  writeFileSync(cfgPath, 'modelRoles: fast\n')
  assert.throws(() => setModel(home, 'omp', 'modelRoles.default', 'x/y'), /not an object/)
  assert.equal(read(cfgPath), 'modelRoles: fast\n')
})

test('agent names omp reserves are not written; a missing description falls back to the name', () => {
  const home = ompHome()
  put(home, `${WS}/agents/main.md`, '---\nname: main\ndescription: d\n---\n\nbody\n')
  put(home, `${WS}/agents/bare.md`, '---\nname: bare\n---\n\nbody\n')
  sync(home)
  assert.equal(existsSync(join(home, '.omp/agent/agents/main.md')), false)
  assert.match(
    read(join(home, '.omp/agent/agents/bare.md')),
    /^---\nname: bare\ndescription: bare\n---/
  )
})

test('MCP server names omp rejects are reported and not written', () => {
  const home = ompHome()
  put(home, `${WS}/mcps/bad@name.json`, JSON.stringify({ transport: 'stdio', command: 'x' }))
  const r = sync(home)
  const c = r.plan.targets.find((t) => t.id === 'ompMcp')!
  assert.ok(c.serverErrors?.['bad@name'])
  const servers = json(join(home, '.omp/agent/mcp.json')).mcpServers as Json
  assert.equal(servers['bad@name'], undefined)
  assert.ok(servers.playwright)
})

test('MCP tool approval keys match the names omp mints', () => {
  // src/mcp/tool-bridge.ts createMCPToolName: sanitized, server prefix dropped, overlong names hashed (values from omp under Bun)
  assert.equal(ompMcpToolName('My-Server', 'my_server_list_items'), 'mcp__my_server_list_items')
  assert.equal(ompMcpToolName('puppeteer', 'puppeteer_screenshot'), 'mcp__puppeteer_screenshot')
  assert.equal(ompMcpToolName('a:b', '...'), 'mcp__a_b_tool')
  assert.equal(
    ompMcpToolName('srv', 'a'.repeat(80)),
    'mcp__srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_27s3mlk7'
  )
})
