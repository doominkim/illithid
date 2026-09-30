import type { ModelKey, ModelSummary } from '../../../shared/api'

export const seriesKey = (m: ModelKey): string => `${m.tool}|${m.model}`
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export const effortOrder = (effort: string): number => {
  const i = EFFORTS.indexOf(effort)
  return i < 0 ? EFFORTS.length : i
}
export const providerColor = (model: string): string =>
  /claude/i.test(model)
    ? '#D97757'
    : /gemini/i.test(model)
      ? '#4285F4'
      : /^(?:[^/]+\/)?(?:gpt-|o[134](?:-|$))/.test(model)
        ? '#10A37F'
        : 'var(--ac-text-muted)'
export const providerText = (model: string): string =>
  /claude/i.test(model)
    ? '#b85c3f'
    : /gemini/i.test(model)
      ? '#3367d6'
      : providerColor(model) === '#10A37F'
        ? '#168568'
        : 'var(--ac-text-muted)'

export function chartRows(models: ModelSummary[]): (ModelSummary & { x: number; y: number })[] {
  return models.flatMap((m) => {
    const cost = m.pricing
    const y = m.median.responseSec
    return m.requests >= 30 &&
      cost?.perRequest !== null &&
      cost?.perRequest !== undefined &&
      Number.isFinite(cost.perRequest) &&
      y !== null &&
      Number.isFinite(y) &&
      y >= 0
      ? [{ ...m, x: cost.perRequest, y }]
      : []
  })
}

export const usd = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? '—'
    : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 4 : 2 })}`
