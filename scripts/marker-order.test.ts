import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { syncAll, upsertMcpServer } from '../src/engine'
import { blockBody, outsideBlock, spliceBlock, spliceBlockMulti } from '../src/engine/text'
import { baseEnv, buildDemoHome } from './readme-shots'

const BEGIN = '# BEGIN illithid mcp — DO NOT EDIT: generated from library mcps/'
const END = '# END illithid mcp'
const count = (text: string, s: string): number => text.split(s).length - 1

test('an END marker stranded before the block does not hide the block', () => {
  const text = `a = 1\n${END}\n\n${BEGIN}\nbody\n${END}\n`
  assert.equal(blockBody(text, BEGIN, END), '\nbody\n')
  assert.equal(outsideBlock(text, BEGIN, END), `a = 1\n${END}\n\n\n`)
})

test('splicing over stray and repeated markers leaves exactly one block', () => {
  const text = `a = 1\n${END}\n\n${BEGIN}\n\n${BEGIN}\nold\n${END}\n`
  const once = spliceBlock(text, BEGIN, END, 'new')
  assert.equal(count(once, BEGIN), 1)
  assert.equal(count(once, END), 1)
  assert.ok(once.indexOf(BEGIN) < once.indexOf(END))
  assert.equal(blockBody(once, BEGIN, END), '\nnew\n')
  assert.ok(once.startsWith('a = 1\n'))
  assert.equal(spliceBlock(once, BEGIN, END, 'new'), once)
  const trailing = spliceBlock(`${BEGIN}\nold\n${END}\n${END}\nb = 2\n`, BEGIN, END, 'new')
  assert.equal(trailing, `${BEGIN}\nnew\n${END}\nb = 2\n`)
})

test('replacing a legacy block also clears stray current markers around it', () => {
  const LEGACY: [string, string] = ['# BEGIN old mcp', '# END old mcp']
  const text = `a = 1\n${END}\n${LEGACY[0]}\nold\n${LEGACY[1]}\n${BEGIN}\n`
  const out = spliceBlockMulti(text, [BEGIN, END], [LEGACY], 'new')
  assert.equal(out, `a = 1\n${BEGIN}\nnew\n${END}\n`)
})

function homeFor(tool: string): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-marker-order-'))
  buildDemoHome(home, { tools: 'all' })
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), toolsInUse: [tool] })
  )
  return home
}

test('Codex sync converges when the tool moved an END marker above the block', () => {
  const home = homeFor('codex')
  const path = join(home, '.codex/config.toml')
  // Shape Codex left behind: its own tables were inserted above our END marker, and earlier applies stacked BEGIN lines
  writeFileSync(
    path,
    `model = "fixture-model"\n\n[otel]\nexporter = "none"\n${END}\n\n${BEGIN}\n\n${BEGIN}\n[mcp_servers.demo]\ncommand = "old"\n${END}\n`
  )
  upsertMcpServer(home, 'demo', { transport: 'stdio', command: 'new' })

  const applied = syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
  assert.equal(applied.refused, undefined)
  assert.deepEqual(applied.plan.errors, [])

  const text = readFileSync(path, 'utf8')
  assert.equal(count(text, BEGIN), 1)
  assert.equal(count(text, END), 1)
  assert.ok(text.indexOf(BEGIN) < text.indexOf(END))
  const config = JSON.parse(JSON.stringify(parseToml(text)))
  assert.equal(config.model, 'fixture-model')
  assert.deepEqual(config.otel, { exporter: 'none' })
  assert.equal(config.mcp_servers.demo.command, 'new')

  const next = syncAll(home, baseEnv(home), { allowReal: false })
  const codex = next.plan.targets.find((t) => t.id === 'codexMcp')!
  assert.equal(codex.changed, false)
  assert.notEqual(codex.beforeRegionHash, null)
})

test('Grok sync converges when a stray compat END sits above the compat block', () => {
  const C_BEGIN = '# BEGIN illithid compat — DO NOT EDIT: generated from Illithid settings'
  const C_END = '# END illithid compat'
  const home = homeFor('grok')
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), grokReadsClaude: false })
  )
  mkdirSync(join(home, '.grok'), { recursive: true })
  const path = join(home, '.grok/config.toml')
  writeFileSync(
    path,
    `[permission]\nallow = ["Read(*)"]\n${C_END}\n\n${C_BEGIN}\n[compat.claude]\nskills = false\nmcps = false\nhooks = false\n${C_END}\n\n${BEGIN}\n[mcp_servers.demo]\ncommand = "old"\n${END}\n`
  )
  upsertMcpServer(home, 'demo', { transport: 'stdio', command: 'new' })

  const applied = syncAll(home, baseEnv(home), { allowReal: true, approvedOnce: true })
  assert.deepEqual(applied.plan.errors, [])

  const text = readFileSync(path, 'utf8')
  assert.equal(count(text, C_BEGIN), 1)
  assert.equal(count(text, C_END), 1)
  assert.ok(text.indexOf(C_BEGIN) < text.indexOf(C_END))
  const config = JSON.parse(JSON.stringify(parseToml(text)))
  assert.deepEqual(config.permission, { allow: ['Read(*)'] })
  assert.equal(config.mcp_servers.demo.command, 'new')

  const next = syncAll(home, baseEnv(home), { allowReal: false })
  for (const id of ['grokMcp', 'grokCompat'])
    assert.equal(next.plan.targets.find((t) => t.id === id)?.changed, false, id)
})
