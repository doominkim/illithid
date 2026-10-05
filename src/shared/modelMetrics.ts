/** Metrics actually collected by the current transcript readers. */
export interface ModelMetricSupport {
  requests: boolean
  turns: boolean
  tokens: boolean
  interrupts: boolean
  errors: boolean
}

export function modelMetricSupport(tool: string): ModelMetricSupport {
  const measured = tool === 'claude' || tool === 'codex' || tool === 'opencode'
  return {
    requests: measured,
    turns: measured,
    tokens: measured,
    interrupts: tool === 'claude' || tool === 'codex',
    errors: measured
  }
}
