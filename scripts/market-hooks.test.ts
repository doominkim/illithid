import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHook, readManifest, syncAll } from '../src/engine'
import {
  checkUpdates,
  commitHookPack,
  listHookPacks,
  prepareHookPack,
  readOrigins,
  type FetchFn
} from '../src/engine/market'
import { baseEnv, buildDemoHome } from './readme-shots'

const LIB = '.illithid/workspaces/default'
const API = 'https://api.github.com/repos/github/awesome-copilot'
const RAW = 'https://raw.githubusercontent.com/github/awesome-copilot'
const SHA1 = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

function demoHome(tools: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-market-hooks-'))
  buildDemoHome(home, { tools: 'all' })
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), toolsInUse: tools })
  )
  return home
}

function fakeFetch(routes: Record<string, string | object>): FetchFn & { calls: string[] } {
  const calls: string[] = []
  const fn = (async (url: string) => {
    calls.push(url)
    const r = routes[url]
    if (r === undefined) return new Response('not found', { status: 404 })
    return new Response(typeof r === 'string' ? r : JSON.stringify(r), { status: 200 })
  }) as FetchFn & { calls: string[] }
  fn.calls = calls
  return fn
}

const README = (name: string, description: string): string =>
  `---\nname: '${name}'\ndescription: '${description}'\ntags: ['security']\n---\n\n# ${name}\n`

const SCAN = '#!/bin/bash\n# scans the diff\nexit 0\n'
const START = '#!/bin/bash\necho start\n'
const PROMPT = '#!/bin/bash\necho prompt\n'
const PS = 'Write-Host hi\n'

/** awesome-copilot at a commit: three packs (one fine, one with three events, one Windows-only) */
function routes(sha: string, scanTree: string, scan = SCAN): Record<string, string | object> {
  const blob = (path: string): object => ({ path, mode: '100644', type: 'blob', size: 10 })
  return {
    [`${API}/commits/HEAD`]: sha,
    [`${API}/git/trees/${sha}?recursive=1`]: {
      sha: 'root',
      truncated: false,
      tree: [
        { path: 'hooks', mode: '040000', type: 'tree', sha: 'h' },
        { path: 'hooks/secrets-scanner', mode: '040000', type: 'tree', sha: scanTree },
        blob('hooks/secrets-scanner/README.md'),
        blob('hooks/secrets-scanner/hooks.json'),
        blob('hooks/secrets-scanner/scan-secrets.sh'),
        { path: 'hooks/governance-audit', mode: '040000', type: 'tree', sha: 'g1' },
        blob('hooks/governance-audit/README.md'),
        blob('hooks/governance-audit/hooks.json'),
        blob('hooks/governance-audit/audit-session-start.sh'),
        blob('hooks/governance-audit/audit-prompt.sh'),
        { path: 'hooks/windows-only', mode: '040000', type: 'tree', sha: 'w1' },
        blob('hooks/windows-only/README.md'),
        blob('hooks/windows-only/hooks.json'),
        blob('hooks/windows-only/run.ps1'),
        blob('skills/x/SKILL.md')
      ]
    },
    [`${RAW}/${sha}/hooks/secrets-scanner/README.md`]: README(
      'Secrets Scanner',
      'Scans changed files for leaked secrets'
    ),
    [`${RAW}/${sha}/hooks/secrets-scanner/hooks.json`]: {
      version: 1,
      hooks: {
        sessionEnd: [
          {
            type: 'command',
            bash: '.github/hooks/secrets-scanner/scan-secrets.sh',
            cwd: '.',
            env: { SCAN_MODE: 'warn' },
            timeoutSec: 30
          }
        ]
      }
    },
    [`${RAW}/${sha}/hooks/secrets-scanner/scan-secrets.sh`]: scan,
    [`${RAW}/${sha}/hooks/governance-audit/README.md`]: README(
      'Governance Audit',
      'Audits prompts'
    ),
    [`${RAW}/${sha}/hooks/governance-audit/hooks.json`]: {
      version: 1,
      hooks: {
        sessionStart: [{ type: 'command', bash: 'hooks/governance-audit/audit-session-start.sh' }],
        userPromptSubmitted: [
          {
            type: 'command',
            bash: '.github/hooks/governance-audit/audit-prompt.sh',
            env: { LEVEL: "it's strict" },
            timeoutSec: 10
          }
        ]
      }
    },
    [`${RAW}/${sha}/hooks/governance-audit/audit-session-start.sh`]: START,
    [`${RAW}/${sha}/hooks/governance-audit/audit-prompt.sh`]: PROMPT,
    [`${RAW}/${sha}/hooks/windows-only/README.md`]: README('Windows Only', 'PowerShell'),
    [`${RAW}/${sha}/hooks/windows-only/hooks.json`]: {
      version: 1,
      hooks: { sessionEnd: [{ type: 'command', powershell: 'run.ps1' }] }
    },
    [`${RAW}/${sha}/hooks/windows-only/run.ps1`]: PS
  }
}

test('REQ-MARKET-HOOKS-1 the hook packs of awesome-copilot are listed with name, description and what each runs on; cached for a day', async () => {
  const home = demoHome(['claude', 'copilot'])
  const f = fakeFetch(routes(SHA1, 's1'))
  const packs = await listHookPacks(f, home)
  assert.deepEqual(
    packs.map((p) => [p.id, p.name, p.installable]),
    [
      ['governance-audit', 'Governance Audit', true],
      ['secrets-scanner', 'Secrets Scanner', true],
      ['windows-only', 'Windows Only', false]
    ]
  )
  const scan = packs.find((p) => p.id === 'secrets-scanner')!
  assert.equal(scan.description, 'Scans changed files for leaked secrets')
  assert.deepEqual(
    scan.entries.map((e) => [e.event, e.timing, e.script]),
    [['sessionEnd', 'session-end', 'scan-secrets.sh']]
  )
  assert.equal(packs.find((p) => p.id === 'windows-only')!.entries[0].problem, 'noBash')
  const before = f.calls.length
  await listHookPacks(f, home)
  assert.equal(f.calls.length, before, 'second list comes from the cache')
})

test('REQ-MARKET-HOOKS-2 installing a pack adds one script hook per entry, on for Copilot only, with its env and timeout', async () => {
  const home = demoHome(['claude', 'copilot'])
  const f = fakeFetch(routes(SHA1, 's1'))
  const prep = await prepareHookPack(f, home, 'governance-audit')
  assert.deepEqual(
    prep.hooks.map((h) => [h.name, h.when]),
    [
      ['governance-audit-session-start', 'session-start'],
      ['governance-audit-prompt', 'prompt']
    ]
  )
  // Pinned to the commit
  assert.ok(f.calls.includes(`${RAW}/${SHA1}/hooks/governance-audit/audit-prompt.sh`))
  const r = commitHookPack(home, prep)
  assert.deepEqual(r.names, ['governance-audit-session-start', 'governance-audit-prompt'])
  const h = readHook(home, 'governance-audit-prompt')
  assert.equal(h.doc.action, 'script')
  assert.equal(h.doc.when, 'prompt')
  assert.equal(h.doc.tools?.copilot?.timeout, 10)
  // The env defaults go in after the shebang; the user's own value still wins
  assert.equal(
    h.scripts['run.sh'],
    "#!/bin/bash\n[ -n \"${LEVEL+x}\" ] || LEVEL='it'\\''s strict'; export LEVEL\necho prompt\n"
  )
  assert.equal(
    statSync(join(home, LIB, 'hooks/governance-audit-prompt/run.sh')).mode & 0o111,
    0o111
  )
  const toggles = readManifest(home).manifest.hooks?.['governance-audit-prompt'] ?? {}
  assert.equal(toggles.claude, false)
  assert.notEqual(toggles.copilot, false)
  const o = readOrigins(home)['hook:governance-audit-prompt']
  assert.equal(o.source, 'awesome-copilot')
  assert.equal(o.id, 'governance-audit')
  assert.equal(o.ref, 'g1')
  // Copilot runs it after a sync; Claude Code doesn't
  syncAll(home, baseEnv(home), { allowReal: true })
  assert.ok(existsSync(join(home, '.copilot/hooks/illithid/governance-audit-prompt/run.sh')))
  assert.equal(existsSync(join(home, '.claude/hooks/illithid/governance-audit-prompt')), false)
  // Installing again: the names are taken
  await assert.rejects(
    async () => commitHookPack(home, await prepareHookPack(f, home, 'governance-audit')),
    {
      code: 'exists'
    }
  )
})

test('REQ-MARKET-HOOKS-3 packs that need Windows or more files than their script are not installable', async () => {
  const home = demoHome(['copilot'])
  const f = fakeFetch(routes(SHA1, 's1', '#!/bin/bash\nsource ./helpers.sh\n'))
  // A script that loads another file of its pack
  const r = routes(SHA1, 's1', '#!/bin/bash\n. "$(dirname "$0")/patterns.txt"\n')
  ;(r[`${API}/git/trees/${SHA1}?recursive=1`] as { tree: object[] }).tree.push({
    path: 'hooks/secrets-scanner/patterns.txt',
    mode: '100644',
    type: 'blob',
    size: 3
  })
  const g = fakeFetch(r)
  const prep = await prepareHookPack(g, home, 'secrets-scanner')
  assert.equal(prep.hooks[0].problem, 'needsOtherFiles')
  assert.throws(() => commitHookPack(home, prep), { code: 'invalid' })
  await assert.rejects(prepareHookPack(f, home, 'windows-only'), { code: 'invalid' })
})

test('REQ-MARKET-HOOKS-4 a changed pack shows as an update and updating replaces the script, keeping the toggles', async () => {
  const home = demoHome(['claude', 'copilot'])
  const f1 = fakeFetch(routes(SHA1, 's1'))
  commitHookPack(home, await prepareHookPack(f1, home, 'secrets-scanner'))
  const f2 = fakeFetch(routes(SHA2, 's2', '#!/bin/bash\necho v2\n'))
  const { updates } = await checkUpdates(f2, home)
  assert.deepEqual(
    updates.map((u) => [u.kind, u.name, u.current, u.latest]),
    [['hook', 'secrets-scanner', 's1', 's2']]
  )
  const prep = await prepareHookPack(f2, home, 'secrets-scanner', { force: true })
  commitHookPack(home, prep, { update: true })
  assert.match(readHook(home, 'secrets-scanner').scripts['run.sh'], /echo v2/)
  assert.equal(readOrigins(home)['hook:secrets-scanner'].ref, 's2')
  assert.equal(readManifest(home).manifest.hooks?.['secrets-scanner']?.claude, false)
})
