// A tiny stdio MCP server for tests: lists a few tools (one more when FIXTURE_MODE=x); `hang` never answers
import { existsSync, writeFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

if (process.argv.includes('hang')) {
  setInterval(() => {}, 1000)
} else {
  const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
  const names = [
    'get_task',
    'delete_task',
    ...(process.env.FIXTURE_MODE === 'x' ? ['from_env'] : [])
  ]
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const wait = process.env.FIXTURE_WAIT_PATH
    if (wait) {
      writeFileSync(`${wait}.started`, '')
      while (!existsSync(`${wait}.release`)) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) }
  })
  await server.connect(new StdioServerTransport())
}
