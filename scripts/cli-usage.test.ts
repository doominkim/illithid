import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSources } from '../src/engine/sources'
import { librarySkillNames } from '../src/engine/targets/skillOverrides'
import { openDb, searchIndexPath } from '../src/engine/search/sessionIndex'
import { dayOf, ensureUsage } from '../src/engine/search/usage'
import { buildDemoHome } from './readme-shots'

const tsx = createRequire(import.meta.url).resolve('tsx/cli')
const today = dayOf(new Date().toISOString(), undefined)

function cli(home: string, ...args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync(
    process.execPath,
    [tsx, 'src/cli/index.ts', 'usage', '--home', home, ...args],
    {
      encoding: 'utf8'
    }
  )
  return { status: r.status, stdout: r.stdout }
}

test('cli usage lists library skills nobody called and the recorded hook runs', () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-cli-usage-'))
  buildDemoHome(home, { tools: 'all' })
  const skills = librarySkillNames(readSources(home))
  assert.ok(skills.length >= 2, 'demo library has skills')
  const [used, ...rest] = skills
  const db = openDb(searchIndexPath(home))
  ensureUsage(db)
  const ins = db.prepare(
    'insert into usage(sid, tool, kind, name, item, model, day, n, outcome, ms) values (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  ins.run('claude', 'skill', used, '', 'claude-opus-5-5', today, 4, '', 0)
  ins.run('claude', 'hook', 'check-destructive', 'PreToolUse', '', today, 3, 'ok', 600)
  ins.run('claude', 'hook', 'check-destructive', 'PreToolUse', '', today, 1, 'timeout', 5000)
  db.close()

  const json = cli(home, '--json')
  assert.equal(json.status, 0)
  const out = JSON.parse(json.stdout)
  assert.equal(out.days, 30)
  assert.deepEqual(
    out.skills.find((s: { name: string }) => s.name === used),
    { name: used, recent: 4 }
  )
  assert.deepEqual(out.unusedSkills, rest)
  assert.equal(out.hooks[0].name, 'check-destructive')
  assert.equal(out.hooks[0].timeout, 1)
  assert.equal(out.hooks[0].avgMs, 1400)

  const text = cli(home, '--unused')
  assert.equal(text.status, 0)
  for (const name of rest) assert.match(text.stdout, new RegExp(`\\b${name}\\b`))
  assert.doesNotMatch(text.stdout, new RegExp(`\\b${used}\\b`))
})

test('cli usage says how to build the index when there is none', () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-cli-usage-empty-'))
  buildDemoHome(home, { tools: 'all' })
  const r = cli(home)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /no usage index/i)
})
