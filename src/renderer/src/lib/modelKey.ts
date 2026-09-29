import type { ModelKey } from '../../../shared/api'

/** Navigation select value for a model (Stats screen) */
export const modelKeyStr = (k: ModelKey): string => `${k.tool}|${k.model}|${k.effort}`

export function parseModelKey(s: string): ModelKey | null {
  const [tool, model, effort] = s.split('|')
  return tool && model ? { tool, model, effort: effort ?? '' } : null
}

/** `model · effort` (effort only for Codex) */
export const modelLabel = (k: ModelKey): string => (k.effort ? `${k.model} · ${k.effort}` : k.model)
