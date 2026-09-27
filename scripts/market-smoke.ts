/**
 * Marketplace smoke test against the real public APIs (GET only, no credentials). Installs into a temp fixture HOME,
 * never the real one. Uses about 4 unauthenticated GitHub API calls.
 * Run: npx tsx scripts/market-smoke.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initLibrary, libraryRoot, memorySecretBackend, setToolsInUse } from '../src/engine'
import {
  checkUpdates,
  commitMcp,
  commitRule,
  commitSkill,
  installChoices,
  listInstructions,
  popularSkills,
  rankServers,
  prepareRule,
  prepareSkill,
  searchServers,
  searchSkills,
  serverDetail,
  skillAudit,
  type FetchFn
} from '../src/engine/market'
import { cleanupFixtures, cleanupOnSignals, makeFixture } from './lib/fixtureHome'

const fetchFn: FetchFn = (url, init) => fetch(url, init)
const rows: { step: string; ok: boolean; detail: string }[] = []
const check = (step: string, ok: boolean, detail: string): void => void rows.push({ step, ok, detail })

async function run(): Promise<void> {
  const H = makeFixture('illithid-market-smoke-')
  initLibrary(H)
  setToolsInUse(H, ['claude'])

  const skills = await searchSkills(fetchFn, 'pdf')
  const pdf = skills.find((s) => s.id === 'anthropics/skills/pdf') ?? skills[0]
  check('skills.sh search', skills.length > 0, `${skills.length} results, first ${pdf?.id}`)
  const audit = await skillAudit(fetchFn, pdf.source, pdf.skillId).catch((e) => String(e))
  check('audit', audit === null || typeof audit === 'object', JSON.stringify(audit)?.slice(0, 120) ?? '')
  const prep = await prepareSkill(fetchFn, pdf.source, pdf.skillId)
  commitSkill(H, prep, prep.name)
  const dir = join(libraryRoot(H), 'skills', prep.name)
  check('skill install', existsSync(join(dir, 'SKILL.md')), `${prep.name}: ${readdirSync(dir).join(', ')} (skipped ${prep.skipped.length})`)

  const servers = await searchServers(fetchFn, 'filesystem')
  const pick = servers.items.find((s) => s.installable && s.kinds.includes('npm'))
  check('registry search', servers.items.length > 0 && !!pick, `${servers.items.length} results, pick ${pick?.name}`)
  if (pick) {
    const s = await serverDetail(fetchFn, pick.name)
    const c = installChoices(s).find((x) => x.kind === 'npm')!
    const values = Object.fromEntries(c.inputs.filter((i) => i.required && !i.default).map((i) => [i.key, i.format === 'filepath' ? '/tmp' : 'x']))
    const secrets = memorySecretBackend()
    commitMcp(H, s, c.id, values, 'fs', secrets)
    const def = JSON.parse(readFileSync(join(libraryRoot(H), 'mcps', 'fs.json'), 'utf8'))
    check('MCP install', def.command === 'npx', JSON.stringify(def).slice(0, 200))
  }

  const rules = await listInstructions(fetchFn, H, { force: true })
  check('rule index', rules.length > 100, `${rules.length} rules`)
  const r = await prepareRule(fetchFn, H, rules.find((x) => x.id.includes('security'))?.id ?? rules[0].id)
  commitRule(H, r, r.name)
  const body = readFileSync(join(libraryRoot(H), 'rules', r.name), 'utf8')
  check('rule install', body.length > 0 && !body.startsWith('---'), `${r.name} ${body.length} bytes`)

  const topSkills = await popularSkills(fetchFn, H)
  check('skills leaderboard', topSkills.length > 100 && topSkills[0].installs >= topSkills[1].installs, `${topSkills.length}, top ${topSkills.slice(0, 3).map((x) => `${x.id}:${x.installs}`).join(' ')}`)
  const ranked = await rankServers(fetchFn, (await searchServers(fetchFn, 'github')).items)
  check('ranked search', ranked.length > 0, ranked.slice(0, 4).map((x) => `${x.name}:${x.downloads ?? '-'}`).join(' '))

  const u = await checkUpdates(fetchFn, H)
  check('no updates right after install', u.updates.length === 0 && u.failed.length === 0, JSON.stringify(u))
}

async function main(): Promise<void> {
  cleanupOnSignals()
  try {
    await run()
  } catch (e) {
    rows.push({ step: 'crash', ok: false, detail: (e as Error).stack ?? String(e) })
  } finally {
    cleanupFixtures()
  }
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}  ${r.detail}`)
  if (rows.some((r) => !r.ok)) process.exit(1)
}

void main()
