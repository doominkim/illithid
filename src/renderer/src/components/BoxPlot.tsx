import type { Dist } from '../../../shared/api'

/** Log scale so long tails (hours, 100K tokens) stay readable next to typical values */
function logScale(min: number, max: number): (v: number) => number {
  const lo = Math.log10(Math.max(1, min) + 1)
  const hi = Math.log10(Math.max(1, max) + 1)
  const span = hi - lo || 1
  return (v) => Math.min(1, Math.max(0, (Math.log10(Math.max(0, v) + 1) - lo) / span))
}

interface Props {
  d: Dist
  /** Axis domain shared by rows that are compared */
  domain: [number, number]
  /** Second model in a side-by-side view: hatched box */
  hatch?: boolean
  height?: number
}

/** One-line box plot: whisker min–max, box p25–p75, median line, mean dot, p90 tick */
export function BoxPlot({ d, domain, hatch, height = 18 }: Props): React.JSX.Element {
  const x = logScale(domain[0], domain[1])
  const pct = (v: number): string => `${(x(v) * 100).toFixed(2)}%`
  const mid = height / 2
  const box = height * 0.62
  const fill = hatch ? 'url(#ac-hatch)' : 'var(--ac-accent-bg)'
  const stroke = hatch ? 'var(--ac-text)' : 'var(--ac-accent)'
  return (
    <svg width="100%" height={height} role="img" aria-hidden="true" style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <pattern id="ac-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" fill="var(--ac-surface)" />
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--ac-text-muted)" strokeWidth="2" />
        </pattern>
      </defs>
      <line x1={pct(d.min)} x2={pct(d.max)} y1={mid} y2={mid} stroke="var(--ac-text-muted)" strokeWidth="1" />
      <line x1={pct(d.min)} x2={pct(d.min)} y1={mid - 4} y2={mid + 4} stroke="var(--ac-text-muted)" strokeWidth="1" />
      <line x1={pct(d.max)} x2={pct(d.max)} y1={mid - 4} y2={mid + 4} stroke="var(--ac-text-muted)" strokeWidth="1" />
      <rect
        x={pct(d.p25)}
        y={mid - box / 2}
        width={`${Math.max(0.4, (x(d.p75) - x(d.p25)) * 100).toFixed(2)}%`}
        height={box}
        rx="2"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      <line x1={pct(d.median)} x2={pct(d.median)} y1={mid - box / 2} y2={mid + box / 2} stroke="var(--ac-text)" strokeWidth="2" />
      <line x1={pct(d.p90)} x2={pct(d.p90)} y1={mid - 5} y2={mid + 5} stroke="var(--ac-text)" strokeWidth="1.5" />
      <circle cx={pct(d.mean)} cy={mid} r="2.5" fill="var(--ac-text)" />
    </svg>
  )
}
