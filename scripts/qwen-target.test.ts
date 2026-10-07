import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyImport,
  createRule,
  planImport,
  readMcpServer,
  readManifest,
  readModels,
  seedNewToolToggles,
  setModel,
  setToggle,
  syncAll,
  tools
} from '../src/engine'
import { toolConfigFound } from '../src/engine/detect'
import { baseEnv, buildDemoHome } from './readme-shots'

function qwenHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-qwen-'))
  buildDemoHome(home)
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), toolsInUse: ['qwen'] })
  )
  return home
}
function writeSettings(home: string, value: unknown): string {
  const path = join(home, '.qwen/settings.json')
  mkdirSync(join(home, '.qwen'), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
  return path
}
function sync(home: string, env = baseEnv(home)): ReturnType<typeof syncAll> {
  const r = syncAll(home, env, { allowReal: true, approvedOnce: true })
  assert.equal(r.refused, undefined)
  return r
}

test('Qwen Code paths: settings.json, rules folder copy, skills folder, agents', () => {
  const home = join(tmpdir(), 'h')
  const at = (rel: string): string => join(home, rel)
  const qwen = tools(home).find((t) => t.id === 'qwen')
  assert.ok(qwen)
  assert.equal(qwen.displayName, 'Qwen Code')
  assert.equal(qwen.configFile, at('.qwen/settings.json'))
  assert.deepEqual(qwen.rules, { kind: 'copyDir', dir: at('.qwen/rules/illithid') })
  assert.deepEqual(qwen.skills, { kind: 'symlinkDir', dir: at('.qwen/skills') })
  assert.deepEqual(qwen.models, {
    path: at('.qwen/settings.json'),
    format: 'json',
    keys: ['model.name']
  })
  assert.deepEqual(qwen.roster, { dirs: [at('.qwen/agents')], ext: '.md' })
})

test('Qwen Code is detected by its ~/.qwen folder', () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-qwen-detect-'))
  assert.equal(toolConfigFound(home, 'qwen'), false)
  mkdirSync(join(home, '.qwen'))
  assert.equal(toolConfigFound(home, 'qwen'), true)
})

test('sync writes rules, skills, MCP servers and agents into ~/.qwen and keeps native settings', () => {
  const home = qwenHome()
  const path = writeSettings(home, {
    $version: 4,
    model: { name: 'qwen3.7-max' },
    ui: { theme: 'GitHub' },
    mcpServers: { native: { command: 'keep' } }
  })
  const r = sync(home)
  assert.deepEqual(r.plan.errors, [])

  const rule = join(home, '.qwen/rules/illithid/00-communication.md')
  assert.equal(
    readFileSync(rule, 'utf8'),
    `<!-- Illithid copy. Edit the source instead: ${join('~', '.illithid/workspaces/default/rules/00-communication.md')} -->\n` +
      readFileSync(join(home, '.illithid/workspaces/default/rules/00-communication.md'), 'utf8')
  )
  assert.ok(
    readFileSync(join(home, '.qwen/skills/code-review/SKILL.md'), 'utf8').includes(
      'name: code-review'
    )
  )
  assert.ok(readFileSync(join(home, '.qwen/agents/reviewer.md'), 'utf8').includes('name: reviewer'))

  const settings = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(settings.$version, 4)
  assert.deepEqual(settings.model, { name: 'qwen3.7-max' })
  assert.deepEqual(settings.ui, { theme: 'GitHub' })
  assert.deepEqual(settings.mcpServers.native, { command: 'keep' })
  assert.deepEqual(settings.mcpServers.playwright, {
    command: 'npx',
    args: ['@playwright/mcp@latest', '--isolated']
  })
  assert.equal(settings.mcpServers.context7.httpUrl, 'https://mcp.context7.com/mcp')

  const again = sync(home)
  assert.deepEqual(again.plan.errors, [])
  assert.equal(JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))), JSON.stringify(settings))
})

test('a Qwen settings.json with comments is left untouched', () => {
  const home = qwenHome()
  const source = '{\n  // native comment\n  "$version": 4\n}\n'
  const path = writeSettings(home, source)
  syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
  assert.equal(readFileSync(path, 'utf8'), source)
})

test('QWEN_HOME pointing elsewhere skips every Qwen write', () => {
  const home = qwenHome()
  const path = writeSettings(home, { $version: 4 })
  const r = sync(home, { ...baseEnv(home), QWEN_HOME: join(home, 'elsewhere') })
  assert.deepEqual(r.plan.errors, [])
  assert.equal(existsSync(join(home, '.qwen/rules')), false)
  assert.equal(existsSync(join(home, '.qwen/skills')), false)
  assert.equal(existsSync(join(home, '.qwen/agents')), false)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { $version: 4 })
})

test('Qwen default model is read from and written to model.name', () => {
  const home = qwenHome()
  const path = writeSettings(home, { $version: 4, model: { name: 'coder-model' } })
  const qwen = readModels(home).find((m) => m.tool === 'qwen')
  assert.deepEqual(qwen?.values, [{ key: 'model.name', value: 'coder-model' }])
  setModel(home, 'qwen', 'model.name', 'qwen3.8-max')
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    $version: 4,
    model: { name: 'qwen3.8-max' }
  })
})

test('import reads Qwen MCP servers, skills and agents without rewriting settings.json', () => {
  const home = qwenHome()
  const source = JSON.stringify({
    $version: 4,
    mcpServers: { native: { command: 'fixture', args: ['--x'] } }
  })
  const path = writeSettings(home, source)
  mkdirSync(join(home, '.qwen/skills/qwen-skill'), { recursive: true })
  writeFileSync(
    join(home, '.qwen/skills/qwen-skill/SKILL.md'),
    '---\nname: qwen-skill\ndescription: From Qwen\n---\n\nBody\n'
  )
  mkdirSync(join(home, '.qwen/agents'), { recursive: true })
  writeFileSync(
    join(home, '.qwen/agents/qwen-agent.md'),
    '---\nname: qwen-agent\ndescription: From Qwen\nmodel: qwen3.7-max\n---\n\nPrompt\n'
  )
  const plan = planImport(home, 'tool:qwen')
  assert.ok(plan.mcp.some((x) => x.name === 'native'))
  assert.ok(plan.skills.some((x) => x.name === 'qwen-skill'))
  assert.ok(plan.agents.some((x) => x.name === 'qwen-agent'))
  const result = applyImport(home, [{ kind: 'mcp', name: 'native' }], 'tool:qwen')
  assert.equal(result[0].status, 'imported', JSON.stringify(result))
  assert.equal(readMcpServer(home, 'native').command, 'fixture')
  assert.equal(readFileSync(path, 'utf8'), source)
})

test('turning Qwen or Grok on for an older library turns off items every earlier tool has off', () => {
  const home = qwenHome()
  createRule(home, 'notes.md', '# notes\n')
  for (const t of ['claude', 'codex', 'opencode', 'gemini', 'copilot'] as const)
    setToggle(home, 'rules', 'notes.md', t, false)
  createRule(home, 'shared.md', '# shared\n')
  assert.equal(seedNewToolToggles(home, 'grok'), 1)
  assert.equal(seedNewToolToggles(home, 'qwen'), 1)
  const rules = readManifest(home).manifest.rules
  assert.equal(rules['notes.md']?.grok, false)
  assert.equal(rules['notes.md']?.qwen, false)
  assert.notEqual(rules['shared.md']?.qwen, false)
})

test('an imported ~/.qwen/rules file is retired once its library copy reaches Qwen', () => {
  const home = qwenHome()
  writeSettings(home, { $version: 4 })
  mkdirSync(join(home, '.qwen/rules'), { recursive: true })
  const original = join(home, '.qwen/rules/style.md')
  writeFileSync(original, '# Style\n\nTabs.\n')
  const result = applyImport(home, [{ kind: 'rule', name: 'style.md' }], 'tool:qwen')
  assert.equal(result[0].status, 'imported', JSON.stringify(result))
  sync(home)
  assert.ok(existsSync(join(home, '.qwen/rules/illithid/style.md')))
  assert.equal(existsSync(original), false, 'Qwen would otherwise load the rule twice')
})
