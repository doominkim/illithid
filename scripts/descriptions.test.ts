import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRule,
  deleteRule,
  readMcpServer,
  renameRule,
  setRuleDescription,
  syncAll
} from '../src/engine'
import { mcp as mcpView, rules as rulesView } from '../src/main/reads'
import { mcpSave } from '../src/main/writes'
import { baseEnv, buildDemoHome } from './readme-shots'

const LIB = '.illithid/workspaces/default'

function demoHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-desc-'))
  buildDemoHome(home, { tools: 'all' })
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({
      ...JSON.parse(readFileSync(cfg, 'utf8')),
      toolsInUse: ['claude', 'codex', 'opencode']
    })
  )
  return home
}

const sync = (home: string): void => {
  const r = syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
  assert.equal(r.refused, undefined)
}

test('REQ-DESC-1 a rule has a description kept beside the rules, never in what the tools get', () => {
  const home = demoHome()
  createRule(home, 'zz-tone.md', '# Tone\n\nBe brief.\n')
  setRuleDescription(home, 'zz-tone.md', 'How replies should sound')
  assert.deepEqual(JSON.parse(readFileSync(join(home, LIB, 'rules/_meta.json'), 'utf8')), {
    descriptions: { 'zz-tone.md': 'How replies should sound' }
  })
  assert.equal(rulesView(home).descriptions?.['zz-tone.md'], 'How replies should sound')
  // The rule file itself is unchanged
  assert.equal(readFileSync(join(home, LIB, 'rules/zz-tone.md'), 'utf8'), '# Tone\n\nBe brief.\n')
  sync(home)
  const claudeRules = join(home, '.claude/rules/illithid')
  assert.ok(readdirSync(claudeRules).includes('zz-tone.md'))
  assert.equal(readdirSync(claudeRules).includes('_meta.json'), false)
  const agents = readFileSync(join(home, '.codex/AGENTS.md'), 'utf8')
  assert.match(agents, /Be brief\./)
  assert.doesNotMatch(agents, /How replies should sound/)
  // Rename carries it, an empty one clears it, delete drops it
  renameRule(home, 'zz-tone.md', 'zz-voice.md')
  assert.deepEqual(rulesView(home).descriptions, { 'zz-voice.md': 'How replies should sound' })
  setRuleDescription(home, 'zz-voice.md', '  ')
  assert.deepEqual(rulesView(home).descriptions ?? {}, {})
  setRuleDescription(home, 'zz-voice.md', 'Voice')
  deleteRule(home, 'zz-voice.md')
  assert.deepEqual(rulesView(home).descriptions ?? {}, {})
  assert.throws(() => setRuleDescription(home, 'missing.md', 'x'), { code: 'notFound' })
})

test("REQ-DESC-2 an MCP server's description lives in its meta key and never reaches a tool", () => {
  const home = demoHome()
  mcpSave(home, 'docs', {
    transport: 'http',
    url: 'https://example.com/mcp',
    _: { description: 'Library docs lookup' }
  })
  assert.deepEqual(readMcpServer(home, 'docs')._, { description: 'Library docs lookup' })
  assert.equal(
    mcpView(home, baseEnv(home)).servers.find((s) => s.name === 'docs')?.description,
    'Library docs lookup'
  )
  sync(home)
  const claude = readFileSync(join(home, '.claude.json'), 'utf8')
  assert.match(claude, /example\.com\/mcp/)
  assert.doesNotMatch(claude, /Library docs lookup/)
  const codex = readFileSync(join(home, '.codex/config.toml'), 'utf8')
  assert.doesNotMatch(codex, /Library docs lookup/)
  assert.ok(existsSync(join(home, LIB, 'mcps/docs.json')))
})
