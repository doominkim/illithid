/**
 * "Load all tools": asks a library MCP server for its tool list (MCP initialize → tools/list) with the official SDK client.
 * The connection is the one the tools get on sync: stdio runs the server's command with its env, http sends its headers;
 * secrets come from the Keychain and are never logged (the server's stderr is ignored). Only the tool names come back, and
 * fetchMcpTools keeps them with the server (its meta key `_.tools`), never in what a tool gets.
 * The renderer asks before a stdio server is run. A server that doesn't answer stops at the time limit (its process is ended)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { readMcpServer, setMcpKnownTools, type Env, type McpServer } from '../engine'
import { renderHttpHeaders, renderValue } from '../engine/targets/mcpRender'
import type { SecretBackend } from '../engine/secrets'
import {
  advanceWorkspaceRevision,
  assertWorkspaceCurrent,
  captureWorkspace
} from './workspaceGuard'

export class McpToolsError extends Error {
  constructor(
    public code: 'timeout' | 'unreachable',
    message: string
  ) {
    super(message)
  }
}

interface Opts {
  env: Env
  secrets?: SecretBackend
  timeoutMs?: number
}

function transports(def: McpServer, env: Env, secrets?: SecretBackend): (() => Transport)[] {
  if (def.transport === 'stdio') {
    const literal = (v: string): string => renderValue(v, 'literal', env, secrets)
    const childEnv = Object.fromEntries(
      Object.entries(def.env ?? {}).map(([k, v]) => [k, literal(v)])
    )
    return [
      () =>
        new StdioClientTransport({
          command: literal(def.command ?? ''),
          args: (def.args ?? []).map(literal),
          // The shell's PATH (Finder launches get a short one) and the server's own env
          env: { ...(env.PATH ? { PATH: env.PATH } : {}), ...childEnv },
          stderr: 'ignore'
        })
    ]
  }
  const url = new URL(String(def.url ?? ''))
  const headers = renderHttpHeaders(def, 'literal', env, secrets)
  return [
    () => new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
    // Older servers speak SSE only
    () => new SSEClientTransport(url, { requestInit: { headers } })
  ]
}

async function listWith(make: () => Transport, timeoutMs: number): Promise<string[]> {
  const client = new Client({ name: 'illithid', version: '1.0.0' })
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new McpToolsError('timeout', `no answer in ${timeoutMs / 1000}s`)),
      timeoutMs
    )
  })
  try {
    const run = async (): Promise<string[]> => {
      await client.connect(make())
      const names: string[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : {})
        names.push(...page.tools.map((t) => t.name))
        cursor = page.nextCursor
      } while (cursor)
      return names
    }
    return await Promise.race([run(), timeout])
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => {})
  }
}

/** The server's tool names, sorted */
export async function listMcpTools(home: string, name: string, opts: Opts): Promise<string[]> {
  const def = readMcpServer(home, name)
  const timeoutMs = opts.timeoutMs ?? 20_000
  let last: unknown
  for (const make of transports(def, opts.env, opts.secrets)) {
    try {
      return [...new Set(await listWith(make, timeoutMs))].sort()
    } catch (e) {
      if (e instanceof McpToolsError) throw e
      last = e
    }
  }
  throw new McpToolsError('unreachable', (last as Error)?.message ?? 'could not reach the server')
}

/** Fetch the tool list and keep the names with the server */
export async function fetchMcpTools(home: string, name: string, opts: Opts): Promise<string[]> {
  const origin = captureWorkspace(home)
  const definition = JSON.stringify(readMcpServer(home, name))
  const tools = await listMcpTools(home, name, opts)
  assertWorkspaceCurrent(home, origin, false)
  if (JSON.stringify(readMcpServer(home, name)) !== definition)
    throw Object.assign(new Error('The MCP server changed while loading its tools. Try again.'), {
      code: 'changed'
    })
  setMcpKnownTools(home, name, tools)
  advanceWorkspaceRevision()
  return tools
}
