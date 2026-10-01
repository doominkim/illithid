/**
 * Official MCP registry (registry.modelcontextprotocol.io, v0.1). Search, detail and conversion of a server entry into
 * the library's McpServer shape. Only stdio packages (npm · pypi · oci) and streamable-http remotes are installable.
 * Smithery-hosted entries are hidden (they need a Smithery account key).
 */
import type { McpServer } from '../types'
import { getJson, isObj, MarketError, str, type FetchFn } from './http'

export const MCP_REGISTRY_API = 'https://registry.modelcontextprotocol.io/v0.1'
export const MCP_PAGE_SIZE = 30

export interface RegistryInput {
  name?: string
  description?: string
  value?: string
  valueHint?: string
  default?: string
  format?: string
  isRequired?: boolean
  isSecret?: boolean
  type?: string
  variables?: Record<string, RegistryInput>
  choices?: string[]
  placeholder?: string
}

export interface RegistryPackage {
  registryType: string
  identifier: string
  version?: string
  runtimeHint?: string
  transport?: { type?: string; url?: string }
  runtimeArguments?: RegistryInput[]
  packageArguments?: RegistryInput[]
  environmentVariables?: RegistryInput[]
}

export interface RegistryRemote {
  type: string
  url: string
  headers?: RegistryInput[]
  variables?: Record<string, RegistryInput>
}

export interface RegistryServer {
  name: string
  title?: string
  description: string
  version: string
  websiteUrl?: string
  repository?: { url?: string }
  packages: RegistryPackage[]
  remotes: RegistryRemote[]
  status: string
}

export type McpRunKind = 'npm' | 'pypi' | 'oci' | 'remote' | 'other'

export interface MarketMcpItem {
  name: string
  title?: string
  description: string
  version: string
  repo?: string
  website?: string
  kinds: McpRunKind[]
  installable: boolean
  /** First npm package (for download counts) */
  npm?: string
  /** npm weekly downloads, when known */
  downloads?: number
}

// ---------------------------------------------------------------- parsing

function input(v: unknown): RegistryInput | null {
  if (!isObj(v)) return null
  const vars: Record<string, RegistryInput> = {}
  if (isObj(v.variables))
    for (const [k, x] of Object.entries(v.variables)) {
      const i = input(x)
      if (i) vars[k] = i
    }
  return {
    name: str(v.name),
    description: str(v.description),
    value: str(v.value),
    valueHint: str(v.valueHint),
    default: v.default === undefined || v.default === null ? undefined : String(v.default),
    format: str(v.format),
    isRequired: v.isRequired === true,
    isSecret: v.isSecret === true,
    type: str(v.type),
    variables: Object.keys(vars).length ? vars : undefined,
    choices: Array.isArray(v.choices)
      ? v.choices.filter((c): c is string => typeof c === 'string')
      : undefined,
    placeholder: str(v.placeholder)
  }
}

function inputs(v: unknown): RegistryInput[] {
  return Array.isArray(v) ? v.map(input).filter((x): x is RegistryInput => !!x) : []
}

export function parseServer(entry: unknown): RegistryServer | null {
  if (!isObj(entry) || !isObj(entry.server)) return null
  const s = entry.server
  const name = str(s.name)
  if (!name) return null
  const meta = isObj(entry._meta)
    ? entry._meta['io.modelcontextprotocol.registry/official']
    : undefined
  const packages: RegistryPackage[] = []
  if (Array.isArray(s.packages))
    for (const p of s.packages) {
      if (!isObj(p) || !str(p.registryType) || !str(p.identifier)) continue
      packages.push({
        registryType: str(p.registryType)!,
        identifier: str(p.identifier)!,
        version: str(p.version),
        runtimeHint: str(p.runtimeHint),
        transport: isObj(p.transport)
          ? { type: str(p.transport.type), url: str(p.transport.url) }
          : undefined,
        runtimeArguments: inputs(p.runtimeArguments),
        packageArguments: inputs(p.packageArguments),
        environmentVariables: inputs(p.environmentVariables)
      })
    }
  const remotes: RegistryRemote[] = []
  if (Array.isArray(s.remotes))
    for (const r of s.remotes) {
      if (!isObj(r) || !str(r.type) || !str(r.url)) continue
      const vars: Record<string, RegistryInput> = {}
      if (isObj(r.variables))
        for (const [k, x] of Object.entries(r.variables)) {
          const i = input(x)
          if (i) vars[k] = i
        }
      remotes.push({
        type: str(r.type)!,
        url: str(r.url)!,
        headers: inputs(r.headers),
        variables: Object.keys(vars).length ? vars : undefined
      })
    }
  return {
    name,
    title: str(s.title),
    description: str(s.description) ?? '',
    version: str(s.version) ?? '',
    websiteUrl: str(s.websiteUrl),
    repository: isObj(s.repository) ? { url: str(s.repository.url) } : undefined,
    packages,
    remotes,
    status: (isObj(meta) && str(meta.status)) || 'active'
  }
}

/** Entries that need an account elsewhere (Smithery-hosted) */
export function isHiddenServer(s: RegistryServer): boolean {
  if (s.name.startsWith('ai.smithery/')) return true
  return s.remotes.some((r) => {
    try {
      return new URL(r.url.replace(/\{[^}]*\}/g, 'x')).host === 'server.smithery.ai'
    } catch {
      return false
    }
  })
}

function runKind(p: RegistryPackage): McpRunKind {
  return p.registryType === 'npm' || p.registryType === 'pypi' || p.registryType === 'oci'
    ? p.registryType
    : 'other'
}

export function toItem(s: RegistryServer): MarketMcpItem {
  const kinds = new Set<McpRunKind>(s.packages.map(runKind))
  if (s.remotes.length) kinds.add('remote')
  return {
    name: s.name,
    title: s.title,
    description: s.description,
    version: s.version,
    repo: s.repository?.url,
    website: s.websiteUrl,
    kinds: [...kinds],
    installable: installChoices(s).some((c) => c.supported),
    npm: s.packages.find((p) => p.registryType === 'npm')?.identifier
  }
}

// ---------------------------------------------------------------- network

export async function searchServers(
  fetchFn: FetchFn,
  q: string,
  cursor?: string,
  limit = MCP_PAGE_SIZE
): Promise<{ items: MarketMcpItem[]; nextCursor?: string }> {
  const params = new URLSearchParams({
    version: 'latest',
    limit: String(Math.min(Math.max(limit, 1), 100))
  })
  const query = String(q ?? '').trim()
  if (query) params.set('search', query)
  if (cursor) params.set('cursor', cursor)
  const body = await getJson(fetchFn, `${MCP_REGISTRY_API}/servers?${params}`)
  if (!isObj(body) || !Array.isArray(body.servers))
    throw new MarketError('invalid', 'unexpected registry response')
  const items: MarketMcpItem[] = []
  for (const e of body.servers) {
    const s = parseServer(e)
    if (!s || s.status !== 'active' || isHiddenServer(s)) continue
    items.push(toItem(s))
  }
  const next = isObj(body.metadata) ? str(body.metadata.nextCursor) : undefined
  return { items, nextCursor: next || undefined }
}

export const SERVER_NAME_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

export async function serverDetail(fetchFn: FetchFn, name: string): Promise<RegistryServer> {
  if (typeof name !== 'string' || !SERVER_NAME_RE.test(name))
    throw new MarketError('invalid', 'invalid server name')
  const body = await getJson(
    fetchFn,
    `${MCP_REGISTRY_API}/servers/${encodeURIComponent(name)}/versions/latest`
  )
  const s = parseServer(body)
  if (!s) throw new MarketError('invalid', 'unexpected registry response')
  return s
}

// ---------------------------------------------------------------- install choices

export interface InputSpec {
  /** Stable key used by the install form (`env:NAME`, `header:NAME`, `arg:<i>`, `rt:<i>`, `var:NAME`) */
  key: string
  label: string
  description?: string
  required: boolean
  secret: boolean
  default?: string
  choices?: string[]
  format?: string
}

export interface InstallChoice {
  /** `package:<i>` or `remote:<i>` */
  id: string
  kind: McpRunKind
  /** npm/pypi/oci identifier or remote URL */
  label: string
  supported: boolean
  /** Why it can't be installed here: unknown package type / transport, or a secret that would land in args or the URL */
  reason?: 'kind' | 'transport' | 'secretInArgs'
  inputs: InputSpec[]
}

const COMMAND: Record<string, string> = { npm: 'npx', pypi: 'uvx', oci: 'docker' }
const TEMPLATE_RE = /\{([A-Za-z0-9_.-]+)\}/g

function templateVars(s: string | undefined): string[] {
  return s ? [...s.matchAll(TEMPLATE_RE)].map((m) => m[1]) : []
}

function varSpecs(
  names: string[],
  defs: Record<string, RegistryInput> | undefined,
  seen: Set<string>
): InputSpec[] {
  const out: InputSpec[] = []
  for (const n of names) {
    if (seen.has(n)) continue
    seen.add(n)
    const d = defs?.[n]
    out.push({
      key: `var:${n}`,
      label: n,
      description: d?.description,
      required: d ? d.isRequired !== false || !d.default : true,
      secret: !!d?.isSecret,
      default: d?.default,
      choices: d?.choices,
      format: d?.format
    })
  }
  return out
}

/** Inputs for a list of arguments: fixed values take none, templates take their variables, the rest take one value */
function argSpecs(args: RegistryInput[], prefix: 'arg' | 'rt', seen: Set<string>): InputSpec[] {
  const out: InputSpec[] = []
  args.forEach((a, i) => {
    if (a.value !== undefined) {
      out.push(...varSpecs(templateVars(a.value), a.variables, seen))
      return
    }
    out.push({
      key: `${prefix}:${i}`,
      label: a.name ?? a.valueHint ?? `argument ${i + 1}`,
      description: a.description,
      required: !!a.isRequired,
      secret: !!a.isSecret,
      default: a.default,
      choices: a.choices,
      format: a.format
    })
  })
  return out
}

/** Env inputs: fixed values take none, templates take their variables, the rest take one value */
function envSpecs(envs: RegistryInput[], seen: Set<string>): InputSpec[] {
  const out: InputSpec[] = []
  for (const e of envs) {
    if (!e.name) continue
    if (e.value !== undefined) {
      out.push(
        ...varSpecs(templateVars(e.value), e.variables, seen).map((v) => ({
          ...v,
          secret: v.secret || !!e.isSecret
        }))
      )
      continue
    }
    out.push({
      key: `env:${e.name}`,
      label: e.name,
      description: e.description,
      required: !!e.isRequired,
      secret: !!e.isSecret,
      default: e.default,
      choices: e.choices,
      format: e.format
    })
  }
  return out
}

export function installChoices(s: RegistryServer): InstallChoice[] {
  const out: InstallChoice[] = []
  s.packages.forEach((p, i) => {
    const kind = runKind(p)
    const stdio = !p.transport?.type || p.transport.type === 'stdio'
    if (kind === 'other' || !stdio) {
      out.push({
        id: `package:${i}`,
        kind,
        label: p.identifier,
        supported: false,
        reason: kind === 'other' ? 'kind' : 'transport',
        inputs: []
      })
      return
    }
    const seen = new Set<string>()
    const argInputs = [
      ...argSpecs(p.runtimeArguments ?? [], 'rt', seen),
      ...argSpecs(p.packageArguments ?? [], 'arg', seen)
    ]
    const specs = [...argInputs, ...envSpecs(p.environmentVariables ?? [], seen)]
    // Only env and headers move to the Keychain; a secret in args would be written to the library in plain text
    const secretInArgs = argInputs.some((x) => x.secret)
    out.push({
      id: `package:${i}`,
      kind,
      label: p.identifier,
      supported: !secretInArgs,
      reason: secretInArgs ? 'secretInArgs' : undefined,
      inputs: specs
    })
  })
  s.remotes.forEach((r, i) => {
    const seen = new Set<string>()
    const urlInputs = varSpecs(templateVars(r.url), r.variables, seen)
    const specs: InputSpec[] = [...urlInputs]
    for (const h of r.headers ?? []) {
      if (!h.name) continue
      if (h.value !== undefined && templateVars(h.value).length) {
        specs.push(
          ...varSpecs(templateVars(h.value), h.variables, seen).map((v) => ({
            ...v,
            secret: v.secret || !!h.isSecret
          }))
        )
      } else if (h.value === undefined) {
        specs.push({
          key: `header:${h.name}`,
          label: h.name,
          description: h.description,
          required: !!h.isRequired,
          secret: !!h.isSecret,
          default: h.default
        })
      }
    }
    const secretInUrl = urlInputs.some((x) => x.secret)
    const http = r.type === 'streamable-http'
    out.push({
      id: `remote:${i}`,
      kind: 'remote',
      label: r.url,
      supported: http && !secretInUrl,
      reason: !http ? 'transport' : secretInUrl ? 'secretInArgs' : undefined,
      inputs: specs
    })
  })
  const order: McpRunKind[] = ['npm', 'pypi', 'oci', 'remote', 'other']
  return out.sort(
    (a, b) =>
      Number(b.supported) - Number(a.supported) || order.indexOf(a.kind) - order.indexOf(b.kind)
  )
}

// ---------------------------------------------------------------- conversion

function need(
  values: Record<string, string>,
  spec: { key: string; required: boolean; default?: string; label: string }
): string | undefined {
  const v = values[spec.key]
  const val = v !== undefined && v !== '' ? v : spec.default
  if ((val === undefined || val === '') && spec.required)
    throw new MarketError('invalid', `missing value: ${spec.label}`)
  return val === '' ? undefined : val
}

function fill(
  template: string,
  values: Record<string, string>,
  defs: Record<string, RegistryInput> | undefined,
  encode = false
): string {
  return template.replace(TEMPLATE_RE, (_m, n: string) => {
    const d = defs?.[n]
    const v = need(values, { key: `var:${n}`, required: true, default: d?.default, label: n }) ?? ''
    return encode ? encodeURIComponent(v) : v
  })
}

/** Optional template (header or env) with every variable left empty: skip it */
function emptyOptional(
  template: string,
  isRequired: boolean | undefined,
  choice: InstallChoice,
  values: Record<string, string>
): boolean {
  if (isRequired) return false
  const specs = templateVars(template).map((n) => choice.inputs.find((x) => x.key === `var:${n}`))
  return specs.every((sp) => !sp || (!values[sp.key] && !sp.default))
}

function renderArgs(
  args: RegistryInput[],
  prefix: 'arg' | 'rt',
  values: Record<string, string>
): string[] {
  const out: string[] = []
  args.forEach((a, i) => {
    const named = a.type === 'named' && a.name
    const val =
      a.value !== undefined
        ? fill(a.value, values, a.variables)
        : need(values, {
            key: `${prefix}:${i}`,
            required: !!a.isRequired,
            default: a.default,
            label: a.name ?? `argument ${i + 1}`
          })
    if (named) {
      if (a.format === 'boolean' && a.value === undefined) {
        if (val === 'true') out.push(a.name!)
        return
      }
      if (val === undefined) return
      out.push(a.name!, val)
    } else if (val !== undefined) out.push(val)
  })
  return out
}

/** Package reference with the version pinned (`latest` or none = unpinned) */
export function packageRef(p: RegistryPackage): string {
  const v = p.version && p.version !== 'latest' ? p.version : undefined
  if (p.registryType === 'npm') return v ? `${p.identifier}@${v}` : p.identifier
  if (p.registryType === 'pypi') return v ? `${p.identifier}@${v}` : p.identifier
  return p.identifier
}

/** Build the library server definition. Secret values stay plaintext here — upsertMcpServer moves them to the Keychain */
export function toMcpServer(
  s: RegistryServer,
  choiceId: string,
  values: Record<string, string> = {}
): McpServer {
  const choice = installChoices(s).find((c) => c.id === choiceId)
  if (!choice) throw new MarketError('invalid', 'unknown install option')
  if (!choice.supported)
    throw new MarketError('unsupported', 'this install option is not supported')
  const [type, idx] = choiceId.split(':')
  if (type === 'package') {
    const p = s.packages[Number(idx)]
    const env: Record<string, string> = {}
    for (const e of p.environmentVariables ?? []) {
      if (!e.name) continue
      if (e.value !== undefined) {
        // Fixed values are part of the server's contract; templates are filled from their variables
        if (!templateVars(e.value).length) env[e.name] = e.value
        else if (!emptyOptional(e.value, e.isRequired, choice, values))
          env[e.name] = fill(e.value, values, e.variables)
        continue
      }
      const spec = choice.inputs.find((x) => x.key === `env:${e.name}`)!
      // Optional variables the user left empty are omitted: the server applies its own default
      const typed = values[spec.key]
      const v =
        typed !== undefined && typed !== '' ? typed : spec.required ? need(values, spec) : undefined
      if (v !== undefined) env[e.name] = v
    }
    const rt = renderArgs(p.runtimeArguments ?? [], 'rt', values)
    const pkg = renderArgs(p.packageArguments ?? [], 'arg', values)
    let args: string[]
    if (p.registryType === 'npm') args = [...(rt.length ? rt : ['-y']), packageRef(p), ...pkg]
    else if (p.registryType === 'pypi') args = [...rt, packageRef(p), ...pkg]
    else
      args = [
        'run',
        '-i',
        '--rm',
        ...rt,
        ...Object.keys(env).flatMap((k) => ['-e', k]),
        p.identifier,
        ...pkg
      ]
    const def: McpServer = { transport: 'stdio', command: COMMAND[p.registryType], args }
    if (Object.keys(env).length) def.env = env
    return def
  }
  const r = s.remotes[Number(idx)]
  const headers: Record<string, string> = {}
  for (const h of r.headers ?? []) {
    if (!h.name) continue
    if (h.value !== undefined) {
      const vars = templateVars(h.value)
      if (!vars.length) {
        headers[h.name] = h.value
        continue
      }
      if (emptyOptional(h.value, h.isRequired, choice, values)) continue
      headers[h.name] = fill(h.value, values, { ...r.variables, ...h.variables })
    } else {
      const v = need(
        values,
        choice.inputs.find((x) => x.key === `header:${h.name}`)!
      )
      if (v !== undefined) headers[h.name] = v
    }
  }
  const def: McpServer = { transport: 'http', url: fill(r.url, values, r.variables, true) }
  if (Object.keys(headers).length) def.headers = headers
  return def
}

/** Library name suggestion from the registry name (`io.github.foo/bar-mcp` → `bar-mcp`) */
export function suggestMcpName(registryName: string): string {
  const last = registryName.split('/').pop() ?? registryName
  const n = last
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)
  return n || 'server'
}
