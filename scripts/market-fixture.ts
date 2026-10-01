/**
 * Marketplace determinism guard. Temp fixture HOMEs only, and a fake fetch — no network.
 * Run: npx tsx scripts/market-fixture.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  initLibrary,
  libraryRoot,
  memorySecretBackend,
  readManifest,
  setToolsInUse,
  writeConfig
} from '../src/engine'
import {
  checkUpdates,
  commitMcp,
  commitMcpUpdate,
  commitRule,
  commitSkill,
  installChoices,
  installedIndex,
  listInstructions,
  MarketError,
  parseLeaderboard,
  parseServer,
  collectPopularServers,
  findSkills,
  popularSkills,
  prepareRule,
  prepareSkill,
  readOrigins,
  searchServers,
  searchSkills,
  rankServers,
  toItem,
  toMcpServer,
  type FetchFn,
  type RegistryServer
} from '../src/engine/market'
import { cleanupFixtures, cleanupOnSignals, makeFixture } from './lib/fixtureHome'

const rows: { step: string; ok: boolean; detail: string }[] = []
function check(step: string, ok: boolean, detail: string): void {
  rows.push({ step, ok, detail })
}

// ---------------------------------------------------------------- fake network

type Route = string | Uint8Array | object | { status: number; headers?: Record<string, string> }
function fakeFetch(routes: Record<string, Route>): FetchFn & { calls: string[] } {
  const calls: string[] = []
  const fn = (async (url: string) => {
    calls.push(url)
    const r = routes[url]
    if (r === undefined) return new Response('not found', { status: 404 })
    if (typeof r === 'string') return new Response(r, { status: 200 })
    if (r instanceof Uint8Array) return new Response(r as BodyInit, { status: 200 })
    if ('status' in (r as object) && typeof (r as { status: unknown }).status === 'number')
      return new Response('', {
        status: (r as { status: number }).status,
        headers: (r as { headers?: Record<string, string> }).headers
      })
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as FetchFn & { calls: string[] }
  fn.calls = calls
  return fn
}

const SHA1 = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const API = 'https://api.github.com/repos/acme/skills'
const RAW = 'https://raw.githubusercontent.com/acme/skills'
const SKILL_MD = '---\nname: PDF Tools\ndescription: Work with PDFs\n---\n\n# PDF\n'

function skillRoutes(
  sha: string,
  dirSha: string,
  extra: Record<string, Route> = {}
): Record<string, Route> {
  return {
    [`${API}/commits/HEAD`]: sha,
    [`${API}/git/trees/${sha}?recursive=1`]: {
      sha: 'root' + sha.slice(4),
      truncated: false,
      tree: [
        { path: 'skills', mode: '040000', type: 'tree', sha: 't1' },
        { path: 'skills/pdf', mode: '040000', type: 'tree', sha: dirSha },
        { path: 'skills/pdf/SKILL.md', mode: '100644', type: 'blob', size: SKILL_MD.length },
        { path: 'skills/pdf/scripts/run.py', mode: '100755', type: 'blob', size: 5 },
        { path: 'skills/pdf/sub/SKILL.md', mode: '100644', type: 'blob', size: 3 },
        { path: 'skills/pdf/sub/x.md', mode: '100644', type: 'blob', size: 3 },
        { path: 'skills/pdf/link', mode: '120000', type: 'blob', size: 10 },
        { path: 'skills/pdf/vendor', mode: '160000', type: 'commit' },
        { path: 'skills/pdf/.git/config', mode: '100644', type: 'blob', size: 1 },
        { path: 'skills/other/SKILL.md', mode: '100644', type: 'blob', size: 3 }
      ]
    },
    [`${RAW}/${sha}/skills/pdf/SKILL.md`]: SKILL_MD,
    [`${RAW}/${sha}/skills/pdf/scripts/run.py`]: 'print',
    ...extra
  }
}

const REG = 'https://registry.modelcontextprotocol.io/v0.1'
const meta = (status = 'active'): object => ({
  'io.modelcontextprotocol.registry/official': { status, isLatest: true }
})
const FS_SERVER = {
  server: {
    name: 'io.github.acme/fs-mcp',
    description: 'Files',
    version: '1.2.0',
    repository: { url: 'https://github.com/acme/fs-mcp' },
    packages: [
      {
        registryType: 'npm',
        identifier: '@acme/fs-mcp',
        version: '1.2.0',
        transport: { type: 'stdio' },
        runtimeArguments: [{ type: 'positional', value: '-y' }],
        packageArguments: [
          {
            type: 'positional',
            valueHint: 'allowed_directory',
            isRequired: true,
            format: 'filepath'
          },
          { type: 'named', name: '--read-only', format: 'boolean' }
        ],
        environmentVariables: [
          { name: 'FS_TOKEN', isRequired: true, isSecret: true },
          { name: 'FS_MODE', default: 'safe' },
          { name: 'FS_OPTIONAL' }
        ]
      },
      {
        registryType: 'pypi',
        identifier: 'fs-mcp',
        version: '1.2.0',
        transport: { type: 'stdio' }
      },
      {
        registryType: 'oci',
        identifier: 'ghcr.io/acme/fs-mcp:1.2.0',
        transport: { type: 'stdio' },
        runtimeArguments: [
          {
            type: 'named',
            name: '-v',
            isRequired: true,
            value: '{host_dir}:/workspace:ro',
            variables: { host_dir: { isRequired: true } }
          }
        ],
        environmentVariables: [{ name: 'FS_TOKEN', isRequired: true, isSecret: true }]
      },
      { registryType: 'mcpb', identifier: 'https://x/y.mcpb', transport: { type: 'stdio' } }
    ],
    remotes: [
      {
        type: 'streamable-http',
        url: 'https://{region}.acme.dev/mcp',
        variables: { region: { default: 'us' } },
        headers: [
          { name: 'Authorization', value: 'Bearer {api_key}', isRequired: true, isSecret: true }
        ]
      },
      { type: 'sse', url: 'https://acme.dev/sse' }
    ]
  },
  _meta: meta()
}

async function run(): Promise<void> {
  // a. skills.sh search parsing
  {
    const f = fakeFetch({
      'https://skills.sh/api/search?q=pdf&limit=100': {
        skills: [
          {
            id: 'big/skills/popular',
            source: 'big/skills',
            skillId: 'popular',
            name: 'popular',
            installs: 900
          },
          {
            id: 'pdf-org/tools/convert',
            source: 'pdf-org/tools',
            skillId: 'convert',
            name: 'convert',
            installs: 50
          },
          {
            id: 'acme/skills/pdf',
            source: 'acme/skills',
            skillId: 'pdf',
            name: 'pdf',
            installs: 5
          },
          { id: 'bad', source: '../etc', skillId: 'x', name: 'x', installs: 1 },
          { id: 'bad2', source: 'a/b', skillId: 'x/../y', name: 'y', installs: 1 }
        ]
      }
    })
    const r = await searchSkills(f, 'pdf')
    const none = await searchSkills(f, 'p')
    check(
      'a. skills.sh search: name match first, then repo match, then popular fuzzy hits; invalid sources dropped',
      r.map((x) => x.id).join() === 'acme/skills/pdf,pdf-org/tools/convert,big/skills/popular' &&
        none.length === 0 &&
        f.calls.length === 1,
      JSON.stringify(r.map((x) => x.id))
    )
  }

  // a2. findSkills: shorter-query hits and leaderboard substring hits merged, unrelated fuzzy hits dropped
  {
    const H = makeFixture('illithid-market-a2-')
    const sk = (id: string, installs: number): object => ({
      id,
      source: id.split('/').slice(0, 2).join('/'),
      skillId: id.split('/')[2],
      name: id.split('/')[2],
      installs
    })
    const f = fakeFetch({
      'https://skills.sh/api/search?q=nest&limit=100': {
        skills: [sk('a/b/nestjs-one', 10), sk('big/x/popular', 9000)]
      },
      'https://skills.sh/api/search?q=nes&limit=100': {
        skills: [sk('c/d/nestjs-two', 50), sk('e/f/nesting-other', 5), sk('g/h/ones', 7)]
      },
      'https://skills.sh/':
        '"source":"i/j","skillId":"nest-top","name":"nest-top","installs":100 "source":"k/l","skillId":"else","name":"else","installs":999'
    })
    const r = await findSkills(f, H, 'nest')
    check(
      'a2. skill search: prefix + leaderboard matches merged, unrelated popular hits hidden',
      r.map((x) => x.id).join() === 'i/j/nest-top,c/d/nestjs-two,a/b/nestjs-one,e/f/nesting-other',
      JSON.stringify(r.map((x) => x.id))
    )
  }

  // b. registry search filtering + conversion
  {
    const f = fakeFetch({
      [`${REG}/servers?version=latest&limit=30&search=fs`]: {
        servers: [
          FS_SERVER,
          {
            server: {
              name: 'ai.smithery/x',
              description: '',
              version: '1',
              remotes: [{ type: 'streamable-http', url: 'https://server.smithery.ai/x/mcp' }]
            },
            _meta: meta()
          },
          {
            server: {
              name: 'io.github.z/hosted',
              description: '',
              version: '1',
              remotes: [{ type: 'streamable-http', url: 'https://server.smithery.ai/@z/mcp' }]
            },
            _meta: meta()
          },
          {
            server: { name: 'io.github.z/old', description: '', version: '1', packages: [] },
            _meta: meta('deprecated')
          }
        ],
        metadata: { nextCursor: 'io.github.z/old:1' }
      }
    })
    const r = await searchServers(f, 'fs')
    check(
      'b1. registry search: smithery name/host and deprecated hidden, cursor kept',
      r.items.length === 1 &&
        r.items[0].name === 'io.github.acme/fs-mcp' &&
        r.nextCursor === 'io.github.z/old:1' &&
        r.items[0].installable,
      JSON.stringify(r.items.map((i) => i.name))
    )

    const s = parseServer(FS_SERVER) as RegistryServer
    const choices = installChoices(s)
    const ids = choices.map((c) => `${c.id}:${c.kind}:${c.supported}`)
    check(
      'b2. install options ordered npm·pypi·oci·remote, mcpb/sse unsupported',
      choices[0].kind === 'npm' &&
        choices
          .filter((c) => c.supported)
          .map((c) => c.kind)
          .join() === 'npm,pypi,oci,remote' &&
        choices.filter((c) => !c.supported).length === 2,
      ids.join(' ')
    )

    const npm = toMcpServer(s, 'package:0', {
      'arg:0': '/tmp/x',
      'arg:1': 'true',
      'env:FS_TOKEN': 'tok'
    })
    const npmOk =
      npm.command === 'npx' &&
      JSON.stringify(npm.args) ===
        JSON.stringify(['-y', '@acme/fs-mcp@1.2.0', '/tmp/x', '--read-only']) &&
      JSON.stringify(npm.env) === JSON.stringify({ FS_TOKEN: 'tok' })
    const typed = toMcpServer(s, 'package:0', {
      'arg:0': '/tmp/x',
      'env:FS_TOKEN': 'tok',
      'env:FS_MODE': 'strict'
    })
    check(
      'b3. npm → npx -y pkg@ver args, untouched optional env omitted, typed optional kept',
      npmOk && typed.env?.FS_MODE === 'strict',
      JSON.stringify(npm)
    )

    const py = toMcpServer(s, 'package:1', {})
    check(
      'b4. pypi → uvx pkg@ver',
      py.command === 'uvx' && JSON.stringify(py.args) === JSON.stringify(['fs-mcp@1.2.0']),
      JSON.stringify(py)
    )

    const oci = toMcpServer(s, 'package:2', {
      'var:host_dir': '/data',
      'env:FS_TOKEN': '${FS_TOKEN}'
    })
    check(
      'b5. oci → docker run -i --rm, template filled, env passed with -e',
      oci.command === 'docker' &&
        JSON.stringify(oci.args) ===
          JSON.stringify([
            'run',
            '-i',
            '--rm',
            '-v',
            '/data:/workspace:ro',
            '-e',
            'FS_TOKEN',
            'ghcr.io/acme/fs-mcp:1.2.0'
          ]) &&
        oci.env?.FS_TOKEN === '${FS_TOKEN}',
      JSON.stringify(oci)
    )

    const remoteId = choices.find((c) => c.kind === 'remote' && c.supported)!.id
    const rem = toMcpServer(s, remoteId, { 'var:api_key': 'k1' })
    check(
      'b6. remote → http url with variable default, header template filled',
      rem.transport === 'http' &&
        rem.url === 'https://us.acme.dev/mcp' &&
        rem.headers?.Authorization === 'Bearer k1',
      JSON.stringify(rem)
    )

    let missing = ''
    try {
      toMcpServer(s, 'package:0', { 'arg:0': '/tmp/x' })
    } catch (e) {
      missing = e instanceof MarketError ? e.code : 'other'
    }
    let unsupported = ''
    try {
      toMcpServer(s, choices.find((c) => c.kind === 'other')!.id, {})
    } catch (e) {
      unsupported = e instanceof MarketError ? e.code : 'other'
    }
    check(
      'b7. missing required value → invalid, mcpb → unsupported',
      missing === 'invalid' && unsupported === 'unsupported',
      `${missing} ${unsupported}`
    )
  }

  // b8. review fixes: secrets never land in args/URL, fixed and templated env values, URL values encoded
  {
    const srv = parseServer({
      server: {
        name: 'io.github.acme/secret-mcp',
        description: '',
        version: '1.0.0',
        packages: [
          {
            registryType: 'npm',
            identifier: 'sa',
            version: '1.0.0',
            transport: { type: 'stdio' },
            packageArguments: [{ type: 'named', name: '--key', isSecret: true, isRequired: true }]
          },
          {
            registryType: 'npm',
            identifier: 'sb',
            version: '1.0.0',
            transport: { type: 'stdio' },
            environmentVariables: [
              { name: 'MODE', value: 'stdio' },
              {
                name: 'AUTH',
                value: 'Bearer {tok}',
                isRequired: true,
                isSecret: true,
                variables: { tok: { isRequired: true } }
              },
              { name: 'OPT', value: 'x-{o}', variables: { o: {} } }
            ]
          }
        ],
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://h.dev/{key}/mcp',
            variables: { key: { isSecret: true, isRequired: true } }
          },
          {
            type: 'streamable-http',
            url: 'https://{tenant}.h.dev/mcp',
            variables: { tenant: { isRequired: true } }
          }
        ]
      },
      _meta: meta()
    }) as RegistryServer
    const ch = installChoices(srv)
    const sa = ch.find((c) => c.label === 'sa')!
    const secretUrl = ch.find((c) => c.label.includes('{key}'))!
    const sb = toMcpServer(srv, ch.find((c) => c.label === 'sb')!.id, { 'var:tok': 't1' })
    const tenant = toMcpServer(srv, ch.find((c) => c.label.includes('{tenant}'))!.id, {
      'var:tenant': 'evil.com#'
    })
    check(
      'b8. secret arg/URL option unsupported, fixed env kept, template env filled, empty optional template dropped, URL value encoded',
      !sa.supported &&
        sa.reason === 'secretInArgs' &&
        !secretUrl.supported &&
        JSON.stringify(sb.env) === JSON.stringify({ MODE: 'stdio', AUTH: 'Bearer t1' }) &&
        tenant.url === 'https://evil.com%23.h.dev/mcp',
      JSON.stringify({ sb: sb.env, url: tenant.url })
    )
  }

  // c. skill install: path filtering, bytes, toggles, origin, conflict
  {
    const H = makeFixture('illithid-market-c-')
    initLibrary(H)
    setToolsInUse(H, ['claude'])
    const f = fakeFetch(skillRoutes(SHA1, 'd1'))
    const p = await prepareSkill(f, 'acme/skills', 'pdf')
    const bad: string[] = []
    if (p.name !== 'pdf-tools') bad.push(`name ${p.name}`)
    if (
      p.files
        .map((x) => x.rel)
        .sort()
        .join() !== 'SKILL.md,scripts/run.py'
    )
      bad.push(`files ${p.files.map((x) => x.rel)}`)
    if (!['link', 'vendor', '.git/config'].every((x) => p.skipped.includes(x)))
      bad.push(`skipped ${p.skipped}`)
    if (f.calls.filter((u) => u.startsWith('https://api.github.com')).length !== 2)
      bad.push('api calls != 2')
    commitSkill(H, p, p.name)
    const dir = join(libraryRoot(H), 'skills', 'pdf-tools')
    if (readFileSync(join(dir, 'SKILL.md'), 'utf8') !== SKILL_MD) bad.push('SKILL.md bytes')
    if (readFileSync(join(dir, 'scripts', 'run.py'), 'utf8') !== 'print') bad.push('run.py bytes')
    if ((statSync(join(dir, 'scripts', 'run.py')).mode & 0o111) === 0) bad.push('exec bit lost')
    if (existsSync(join(dir, 'sub'))) bad.push('nested skill copied')
    if (existsSync(join(dir, 'link')) || existsSync(join(dir, 'vendor')))
      bad.push('symlink/submodule written')
    const m = (readManifest(H).manifest.skills['pdf-tools'] ?? {}) as Record<string, boolean>
    if (m.claude === false || m.codex !== false || m.gemini !== false || m.copilot !== false)
      bad.push(`toggles ${JSON.stringify(m)}`)
    const o = readOrigins(H)['skill:pdf-tools']
    if (!o || o.ref !== 'd1' || o.path !== 'skills/pdf' || o.id !== 'acme/skills/pdf')
      bad.push(`origin ${JSON.stringify(o)}`)
    if (installedIndex(H)['skill:acme/skills/pdf'] !== 'pdf-tools') bad.push('installed index')
    let conflict = ''
    try {
      commitSkill(H, p, 'pdf-tools')
    } catch (e) {
      conflict = (e as { code?: string }).code ?? ''
    }
    if (conflict !== 'exists') bad.push(`conflict ${conflict}`)
    check(
      'c. skill install: symlink·submodule·.git·nested skill skipped, exec bit kept, bytes equal, only tools in use on, origin, conflict refused',
      !bad.length,
      bad.join('; ') || 'ok'
    )
  }

  // d. unsafe paths and limits
  {
    const tree = (entries: object[]): Record<string, Route> => ({
      [`${API}/commits/HEAD`]: SHA1,
      [`${API}/git/trees/${SHA1}?recursive=1`]: {
        sha: 'r',
        tree: [{ path: 'pdf/SKILL.md', mode: '100644', type: 'blob', size: 3 }, ...entries]
      },
      [`${RAW}/${SHA1}/pdf/SKILL.md`]: 'x'
    })
    const evil = fakeFetch(
      tree([
        { path: 'pdf/../../etc/x', mode: '100644', type: 'blob', size: 1 },
        { path: 'pdf/a\\b', mode: '100644', type: 'blob', size: 1 }
      ])
    )
    const p = await prepareSkill(evil, 'acme/skills', 'pdf')
    const many = fakeFetch(
      tree(
        Array.from({ length: 501 }, (_, i) => ({
          path: `pdf/f${i}`,
          mode: '100644',
          type: 'blob',
          size: 1
        }))
      )
    )
    const big = fakeFetch(
      tree([{ path: 'pdf/big.bin', mode: '100644', type: 'blob', size: 6 * 1024 * 1024 }])
    )
    const codes: string[] = []
    for (const f of [many, big])
      try {
        await prepareSkill(f, 'acme/skills', 'pdf')
        codes.push('none')
      } catch (e) {
        codes.push(e instanceof MarketError ? e.code : 'other')
      }
    let repo = ''
    try {
      await prepareSkill(evil, '../x', 'pdf')
    } catch (e) {
      repo = e instanceof MarketError ? e.code : 'other'
    }
    // Root SKILL.md for a different skill is not a fallback
    const rootOther = fakeFetch({
      [`${API}/commits/HEAD`]: SHA1,
      [`${API}/git/trees/${SHA1}?recursive=1`]: {
        sha: 'r',
        tree: [{ path: 'SKILL.md', mode: '100644', type: 'blob', size: 30 }]
      },
      [`${RAW}/${SHA1}/SKILL.md`]: '---\nname: other\n---\nbody\n'
    })
    let rootCode = ''
    try {
      await prepareSkill(rootOther, 'acme/skills', 'missing-id')
    } catch (e) {
      rootCode = e instanceof MarketError ? e.code : 'other'
    }
    codes.push(rootCode)
    check(
      'd. ".." and backslash paths skipped, 501 files / 6MB file → tooLarge, root SKILL.md of another skill → notFound, bad repo refused',
      p.files.length === 1 &&
        p.skipped.length === 2 &&
        codes.join() === 'tooLarge,tooLarge,notFound' &&
        repo === 'invalid',
      `files ${p.files.length} skipped ${p.skipped} codes ${codes} repo ${repo}`
    )
  }

  // e. rules: frontmatter stripped, cache, toggles
  {
    const H = makeFixture('illithid-market-e-')
    initLibrary(H)
    setToolsInUse(H, ['claude', 'codex'])
    const index = {
      items: [
        {
          id: 'go',
          title: 'Go',
          description: 'Go rules',
          applyTo: '**/*.go',
          path: 'instructions/go.instructions.md',
          lastUpdated: '2026-01-01'
        },
        { id: 'bad', title: 'Bad', path: '../x.md' }
      ]
    }
    const body = "---\ndescription: 'Go'\napplyTo: '**/*.go'\n---\n\n# Go\n\nUse gofmt.\n"
    const routes: Record<string, Route> = {
      'https://awesome-copilot.github.com/data/instructions.json': index,
      'https://raw.githubusercontent.com/github/awesome-copilot/main/instructions/go.instructions.md':
        body
    }
    const f = fakeFetch(routes)
    const list = await listInstructions(f, H)
    const again = await listInstructions(f, H)
    const bad: string[] = []
    if (list.length !== 1 || again.length !== 1) bad.push('index filter')
    if (f.calls.filter((u) => u.endsWith('instructions.json')).length !== 1)
      bad.push('cache not used')
    const p = await prepareRule(f, H, 'go')
    commitRule(H, p, p.name)
    const content = readFileSync(join(libraryRoot(H), 'rules', 'go.md'), 'utf8')
    if (content !== '# Go\n\nUse gofmt.\n') bad.push(`content ${JSON.stringify(content)}`)
    const m = (readManifest(H).manifest.rules['go.md'] ?? {}) as Record<string, boolean>
    if (
      m.claude === false ||
      m.codex === false ||
      m.opencode !== false ||
      m.gemini !== false ||
      m.copilot !== false
    )
      bad.push(`toggles ${JSON.stringify(m)}`)
    check(
      'e. rule: frontmatter removed, index cached a day, only tools in use on',
      !bad.length,
      bad.join('; ') || 'ok'
    )

    // g-rule. update detection + replace in place (toggles kept)
    const f2 = fakeFetch({
      ...routes,
      'https://awesome-copilot.github.com/data/instructions.json': {
        items: [{ ...index.items[0], lastUpdated: '2026-02-01' }]
      },
      'https://raw.githubusercontent.com/github/awesome-copilot/main/instructions/go.instructions.md':
        '# Go 2\n'
    })
    const u = await checkUpdates(f2, H)
    const p2 = await prepareRule(f2, H, 'go')
    commitRule(H, p2, 'go.md', { update: true })
    const after = readFileSync(join(libraryRoot(H), 'rules', 'go.md'), 'utf8')
    const m2 = (readManifest(H).manifest.rules['go.md'] ?? {}) as Record<string, boolean>
    const ruleTrash = join(libraryRoot(H), '.trash')
    check(
      'g1. rule update: detected by lastUpdated, old copy in .trash, toggles kept',
      u.updates.length === 1 &&
        u.updates[0].latest === '2026-02-01' &&
        after === '# Go 2\n' &&
        m2.opencode === false &&
        readOrigins(H)['rule:go.md'].ref === '2026-02-01' &&
        existsSync(ruleTrash),
      JSON.stringify(u)
    )
  }

  // f. MCP install: secrets to keychain, origin, update keeps refs
  {
    const H = makeFixture('illithid-market-f-')
    initLibrary(H)
    setToolsInUse(H, ['claude', 'codex'])
    const secrets = memorySecretBackend()
    const s = parseServer(FS_SERVER) as RegistryServer
    commitMcp(
      H,
      s,
      'package:0',
      { 'arg:0': '/tmp/x', 'env:FS_TOKEN': 'tok-123' },
      'fs-mcp',
      secrets
    )
    const file = readFileSync(join(libraryRoot(H), 'mcps', 'fs-mcp.json'), 'utf8')
    const bad: string[] = []
    if (file.includes('tok-123')) bad.push('plaintext secret in library')
    if (secrets.get('fs-mcp/env/FS_TOKEN') !== 'tok-123') bad.push('secret not in keychain')
    const m = readManifest(H).manifest.mcp['fs-mcp'] ?? {}
    if (m.claude === false || m.codex === false || m.opencode !== false)
      bad.push(`toggles ${JSON.stringify(m)}`)
    const o = readOrigins(H)['mcp:fs-mcp']
    if (!o || o.choice !== 'package:0' || o.ref !== '1.2.0') bad.push(`origin ${JSON.stringify(o)}`)
    check(
      'f1. MCP install: secret in Keychain only, only tools in use on, origin keeps option',
      !bad.length,
      bad.join('; ') || 'ok'
    )

    const next = structuredClone(FS_SERVER)
    next.server.version = '1.3.0'
    next.server.packages[0].version = '1.3.0'
    // Registry reordered its packages: matching is by type + identifier, not index
    next.server.packages.reverse()
    const f = fakeFetch({
      [`${REG}/servers/${encodeURIComponent('io.github.acme/fs-mcp')}/versions/latest`]: next
    })
    const u = await checkUpdates(f, H)
    const r = commitMcpUpdate(H, 'fs-mcp', parseServer(next) as RegistryServer)
    const def = JSON.parse(readFileSync(join(libraryRoot(H), 'mcps', 'fs-mcp.json'), 'utf8'))
    check(
      'g2. MCP update: version bump detected, only pin changes, secret ref and user args kept',
      u.updates.length === 1 &&
        r.changed &&
        JSON.stringify(def.args) === JSON.stringify(['-y', '@acme/fs-mcp@1.3.0', '/tmp/x']) &&
        def.env.FS_TOKEN === 'secret:fs-mcp/env/FS_TOKEN' &&
        secrets.get('fs-mcp/env/FS_TOKEN') === 'tok-123',
      JSON.stringify(def)
    )
  }

  // g4. OCI update: tag lives in the identifier; a vanished package is refused without bumping the version
  {
    const H = makeFixture('illithid-market-g4-')
    initLibrary(H)
    const s = parseServer(FS_SERVER) as RegistryServer
    commitMcp(
      H,
      s,
      'package:2',
      { 'var:host_dir': '/d', 'env:FS_TOKEN': '${FS_TOKEN}' },
      'fs-oci',
      memorySecretBackend()
    )
    const n2 = structuredClone(FS_SERVER)
    n2.server.version = '1.4.0'
    n2.server.packages[2].identifier = 'ghcr.io/acme/fs-mcp:1.4.0'
    const r = commitMcpUpdate(H, 'fs-oci', parseServer(n2) as RegistryServer)
    const def = JSON.parse(readFileSync(join(libraryRoot(H), 'mcps', 'fs-oci.json'), 'utf8'))
    const n3 = structuredClone(n2)
    n3.server.version = '1.5.0'
    n3.server.packages = n3.server.packages.filter((p) => p.registryType !== 'oci')
    let gone = ''
    try {
      commitMcpUpdate(H, 'fs-oci', parseServer(n3) as RegistryServer)
    } catch (e) {
      gone = e instanceof MarketError ? e.code : 'other'
    }
    check(
      'g4. OCI tag updated in place; package gone → refused, version not bumped',
      r.changed &&
        def.args.includes('ghcr.io/acme/fs-mcp:1.4.0') &&
        gone === 'unsupported' &&
        readOrigins(H)['mcp:fs-oci'].ref === '1.4.0',
      JSON.stringify(def.args)
    )
  }

  // g3. skill update: folder tree SHA drives it (other commits don't), old copy goes to library trash
  {
    const H = makeFixture('illithid-market-g-')
    initLibrary(H)
    const f1 = fakeFetch(skillRoutes(SHA1, 'd1'))
    commitSkill(H, await prepareSkill(f1, 'acme/skills', 'pdf'), 'pdf')
    const same = await checkUpdates(fakeFetch(skillRoutes(SHA2, 'd1')), H)
    const f3 = fakeFetch(
      skillRoutes(SHA2, 'd2', { [`${RAW}/${SHA2}/skills/pdf/SKILL.md`]: SKILL_MD + 'v2\n' })
    )
    const moved = await checkUpdates(f3, H)
    commitSkill(H, await prepareSkill(f3, 'acme/skills', 'pdf'), 'pdf', { update: true })
    const md = readFileSync(join(libraryRoot(H), 'skills', 'pdf', 'SKILL.md'), 'utf8')
    const trash = join(libraryRoot(H), '.trash')
    const trashed = existsSync(trash) && readdirSync(trash).length > 0
    check(
      'g3. skill update: unrelated commit no update, folder change → update, old copy in .trash',
      same.updates.length === 0 &&
        moved.updates.length === 1 &&
        md.endsWith('v2\n') &&
        trashed &&
        readOrigins(H)['skill:pdf'].ref === 'd2',
      `same ${same.updates.length} moved ${moved.updates.length} trashed ${trashed}`
    )
  }

  // p. ranking: skills.sh leaderboard parse, npm weekly downloads order, popular MCP list matched to the registry
  {
    const html =
      'x\\"source\\":\\"a/b\\",\\"skillId\\":\\"s1\\",\\"name\\":\\"s1\\",\\"installs\\":5,y "source":"c/d","skillId":"s2","name":"s2","installs":50 \\"source\\":\\"../x\\",\\"skillId\\":\\"s3\\",\\"name\\":\\"s3\\",\\"installs\\":9'
    const lb = parseLeaderboard(html)
    const H = makeFixture('illithid-market-p-')
    initLibrary(H)
    const f = fakeFetch({
      'https://skills.sh/': html,
      'https://api.npmjs.org/downloads/point/last-week/@acme/fs-mcp': { downloads: 10 },
      'https://api.npmjs.org/downloads/point/last-week/big-mcp': { downloads: 999 },
      'https://registry.npmjs.org/-/v1/search?text=mcp%20server&size=250': {
        objects: [
          { package: { name: 'big-mcp' }, downloads: { weekly: 999 } },
          { package: { name: '@acme/fs-mcp' }, downloads: { weekly: 10 } },
          { package: { name: 'nomatch' }, downloads: { weekly: 5000 } }
        ]
      },
      [`${REG}/servers?version=latest&limit=100&search=big-mcp`]: {
        servers: [
          {
            server: {
              name: 'io.github.z/big',
              description: '',
              version: '2',
              packages: [
                { registryType: 'npm', identifier: 'big-mcp', transport: { type: 'stdio' } }
              ]
            },
            _meta: meta()
          }
        ]
      },
      [`${REG}/servers?version=latest&limit=100&search=fs-mcp`]: { servers: [FS_SERVER] },
      [`${REG}/servers?version=latest&limit=100&search=nomatch`]: { servers: [] }
    })
    const pop = await popularSkills(f, H)
    const again = await popularSkills(f, H)
    const ranked = await rankServers(f, [
      toItem(parseServer(FS_SERVER)!),
      { ...toItem(parseServer(FS_SERVER)!), name: 'x/remote', npm: undefined },
      { ...toItem(parseServer(FS_SERVER)!), name: 'x/big', npm: 'big-mcp' }
    ])
    const popular = await collectPopularServers(f)
    check(
      'p. leaderboard parsed (escaped+plain, bad repo dropped) and cached, search ranked by npm downloads, popular MCP only registry matches',
      lb.map((x) => x.id).join() === 'c/d/s2,a/b/s1' &&
        pop.length === 2 &&
        again.length === 2 &&
        f.calls.filter((u) => u === 'https://skills.sh/').length === 1 &&
        ranked.map((x) => x.name).join() === 'x/big,io.github.acme/fs-mcp,x/remote' &&
        popular.map((x) => `${x.name}:${x.downloads}`).join() ===
          'io.github.z/big:999,io.github.acme/fs-mcp:10',
      JSON.stringify({
        lb: lb.map((x) => x.id),
        ranked: ranked.map((x) => x.name),
        popular: popular.map((x) => x.name)
      })
    )
  }

  // h. rate limit + disabled marketplace → no network
  {
    const f = fakeFetch({
      [`${API}/commits/HEAD`]: { status: 403, headers: { 'x-ratelimit-remaining': '0' } }
    })
    let code = ''
    try {
      await prepareSkill(f, 'acme/skills', 'pdf')
    } catch (e) {
      code = e instanceof MarketError ? e.code : 'other'
    }
    check('h1. GitHub 403 with remaining 0 → rateLimited', code === 'rateLimited', code)

    const H = makeFixture('illithid-market-h-')
    initLibrary(H)
    writeConfig(H, { version: 1, marketEnabled: false })
    const real = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('{}')
    }) as typeof fetch
    try {
      const { marketHandlers } = await import('../src/main/market')
      const h = marketHandlers(H, async (fn) => ({ ok: true, value: fn() }))
      const rs = await Promise.all([
        h.marketSearch('skill', 'pdf'),
        h.marketSearch('rule', ''),
        h.marketDetail('mcp', 'io.github.acme/fs-mcp'),
        h.marketInstall('rule', 'go', { name: 'go' }),
        h.marketUpdates()
      ])
      const allDisabled = rs.every((r) => 'ok' in r && !r.ok && r.code === 'disabled')
      check(
        'h2. marketEnabled=false → every handler refused, fetch never called',
        allDisabled && calls === 0,
        `calls ${calls}`
      )
    } finally {
      globalThis.fetch = real
    }
  }

  // h3. install refuses when the source moved on since the detail view (ref mismatch)
  {
    const H = makeFixture('illithid-market-h3-')
    initLibrary(H)
    const real = globalThis.fetch
    const f = fakeFetch({
      'https://awesome-copilot.github.com/data/instructions.json': {
        items: [
          {
            id: 'go',
            title: 'Go',
            path: 'instructions/go.instructions.md',
            lastUpdated: '2026-03-01'
          }
        ]
      },
      'https://raw.githubusercontent.com/github/awesome-copilot/main/instructions/go.instructions.md':
        '# Go\n'
    })
    globalThis.fetch = ((url: string) => f(url)) as typeof fetch
    try {
      const { marketHandlers } = await import('../src/main/market')
      const h = marketHandlers(H, async (fn) => ({ ok: true, value: fn() }))
      const stale = await h.marketInstall('rule', 'go', { name: 'go', ref: '2026-01-01' })
      const fresh = await h.marketInstall('rule', 'go', { name: 'go', ref: '2026-03-01' })
      const code = 'ok' in stale && !stale.ok ? stale.code : 'none'
      check(
        'h3. stale ref → changed, matching ref installs',
        code === 'changed' &&
          'ok' in fresh &&
          fresh.ok &&
          existsSync(join(libraryRoot(H), 'rules', 'go.md')),
        code
      )
    } finally {
      globalThis.fetch = real
    }
  }

  // h4. bulk install: skills from one repo share one HEAD+tree, installed/duplicate/needs-input skipped, one libWrite
  {
    const H = makeFixture('illithid-market-h4-')
    initLibrary(H)
    setToolsInUse(H, ['claude'])
    const SK2 = '---\nname: other\n---\nx\n'
    const routes = skillRoutes(SHA1, 'd1', {
      [`${RAW}/${SHA1}/skills/other/SKILL.md`]: SK2,
      [`${REG}/servers/${encodeURIComponent('io.github.acme/fs-mcp')}/versions/latest`]: FS_SERVER
    })
    const f = fakeFetch(routes)
    const real = globalThis.fetch
    globalThis.fetch = ((url: string) => f(url)) as typeof fetch
    let writes = 0
    try {
      const { marketHandlers } = await import('../src/main/market')
      const h = marketHandlers(H, async (fn) => {
        writes++
        return { ok: true, value: fn() }
      })
      const r1 = await h.marketInstallMany('skill', [
        'acme/skills/pdf',
        'acme/skills/other',
        'acme/skills/missing'
      ])
      const apiCalls = f.calls.filter((u) => u.startsWith('https://api.github.com')).length
      const r2 = await h.marketInstallMany('skill', ['acme/skills/pdf'])
      const r3 = await h.marketInstallMany('mcp', ['io.github.acme/fs-mcp'])
      const v1 = 'ok' in r1 && r1.ok ? r1.value : null
      const v2 = 'ok' in r2 && r2.ok ? r2.value : null
      const v3 = 'ok' in r3 && r3.ok ? r3.value : null
      check(
        'h4. bulk: shared repo tree (2 API calls), missing skipped, re-run skipped as installed, MCP needing input skipped',
        !!v1 &&
          v1.installed.map((x) => x.name).join() === 'pdf-tools,other' &&
          v1.skipped.map((x) => x.reason).join() === 'notFound' &&
          apiCalls === 2 &&
          writes === 3 &&
          !!v2 &&
          v2.skipped[0]?.reason === 'installed' &&
          !!v3 &&
          v3.installed.length === 0 &&
          v3.skipped[0]?.reason === 'needsInput',
        JSON.stringify({ v1, apiCalls, v2, v3 })
      )
    } finally {
      globalThis.fetch = real
    }
  }

  // j. update check: newer release only, drafts/pre-releases/bad tags ignored, brew vs DMG install
  {
    const { compareVersions, latestUpdate, installKind, RELEASES_API } =
      await import('../src/engine/update')
    const rel =
      (body: Record<string, unknown>): FetchFn =>
      async (url) =>
        url === RELEASES_API
          ? new Response(JSON.stringify(body), { status: 200 })
          : new Response('', { status: 404 })
    const newer = await latestUpdate(
      rel({ tag_name: 'v0.3.0', body: '## Notes', html_url: 'https://x/r' }),
      '0.2.8'
    )
    const same = await latestUpdate(rel({ tag_name: 'v0.2.8' }), '0.2.8')
    const draft = await latestUpdate(rel({ tag_name: 'v9.0.0', draft: true }), '0.2.8')
    const pre = await latestUpdate(rel({ tag_name: 'v9.0.0', prerelease: true }), '0.2.8')
    const bad = await latestUpdate(rel({ tag_name: 'nightly' }), '0.2.8')
    const order =
      compareVersions('0.10.0', '0.9.9') > 0 &&
      compareVersions('1.0.0', '1.0') === 0 &&
      compareVersions('0.2.8', '0.2.10') < 0
    const kinds =
      installKind((p) => p === '/opt/homebrew/Caskroom/illithid') + ',' + installKind(() => false)
    check(
      'j. update check: newer release with notes, same/draft/pre-release/bad tag ignored, numeric version order, brew vs DMG',
      newer?.version === '0.3.0' &&
        newer.notes === '## Notes' &&
        newer.url === 'https://x/r' &&
        !same &&
        !draft &&
        !pre &&
        !bad &&
        order &&
        kinds === 'brew,dmg',
      JSON.stringify({ newer, same, draft, pre, bad, order, kinds })
    )
  }

  // i. workspace zip carries market.json
  {
    const { WORKSPACE_ZIP_FILES } = await import('../src/engine/workspace')
    check(
      'i. market.json allowed in workspace zip',
      (WORKSPACE_ZIP_FILES as readonly string[]).includes('market.json'),
      ''
    )
  }
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
  for (const r of rows)
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}${r.ok ? '' : `\n      ${r.detail}`}`)
  const failed = rows.filter((r) => !r.ok).length
  console.log(`\n${rows.length - failed}/${rows.length} passed`)
  if (failed) process.exit(1)
}

void main()
