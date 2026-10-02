// A tiny stdio MCP server for tests: lists a few tools (one more when FIXTURE_MODE=x); `hang` never answers
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
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: names.map((name) => ({ name, inputSchema: { type: 'object' } }))
  }))
  await server.connect(new StdioServerTransport())
}
