const SERVER_KEY_TOOLS = new Set(['claude', 'codex', 'gemini', 'grok', 'qwen'])

function mcpKey(name: string): string {
  // Keep this browser-safe normalization aligned with search/usage.mcpKey.
  return name.replace(/[^A-Za-z0-9_]/g, '_')
}

/** Resolve a normalized model-detail MCP usage name to one actual configured server. */
export function resolveMcpUsageServer(
  tool: string,
  loggedName: string,
  serverNames: readonly string[]
): string | undefined {
  if (!loggedName) return undefined
  const names = [...new Set(serverNames)].filter(Boolean)
  const key = mcpKey(loggedName)
  if (tool === 'opencode') {
    const rawKey = key.toLowerCase()
    const hasToolSuffix = (name: string): boolean => {
      const prefix = `${mcpKey(name).toLowerCase()}_`
      return rawKey.startsWith(prefix) && rawKey.length > prefix.length
    }
    // A whole-name server is also a collision: the stored name contains the tool, not just the server.
    const matches = names.filter(
      (name) => hasToolSuffix(name) || mcpKey(name).toLowerCase() === rawKey
    )
    return matches.length === 1 && hasToolSuffix(matches[0]) ? matches[0] : undefined
  }
  if (!SERVER_KEY_TOOLS.has(tool)) return undefined
  const matches = names.filter((name) => mcpKey(name) === key)
  return matches.length === 1 ? matches[0] : undefined
}
