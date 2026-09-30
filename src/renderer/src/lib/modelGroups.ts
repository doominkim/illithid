import type { ModelSummary } from '../../../shared/api'
export const normalizedId = (id: string): string =>
  id
    .split('/')
    .pop()!
    .replace(/-\d{8}$/, '')
export const tokenTotal = (m: ModelSummary): number =>
  m.tokens.input +
  m.tokens.cacheRead +
  m.tokens.cacheWrite +
  m.tokens.output +
  (m.tool === 'opencode' ? m.tokens.reasoning : 0)
export function modelGroups(
  models: ModelSummary[]
): {
  model: string
  children: ModelSummary[]
  first: string
  last: string
  requests: number
  tokens: number
  cost: number | null
  tools: string[]
}[] {
  const groups = new Map<string, ModelSummary[]>()
  for (const m of models) {
    const id = normalizedId(m.model)
    const list = groups.get(id) ?? []
    list.push(m)
    groups.set(id, list)
  }
  return [...groups].map(([model, children]) => ({
    model,
    children,
    first: children.map((m) => m.first).sort()[0],
    last: children
      .map((m) => m.last)
      .sort()
      .at(-1)!,
    requests: children.reduce((a, m) => a + m.requests, 0),
    tokens: children.reduce((a, m) => a + tokenTotal(m), 0),
    cost: children.some((m) => m.pricing?.total == null)
      ? null
      : children.reduce((a, m) => a + m.pricing!.total!, 0),
    tools: [...new Set(children.map((m) => m.tool))]
  }))
}
