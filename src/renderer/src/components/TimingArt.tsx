/**
 * Line drawings for the hook timing tiles (40×40, currentColor). Before/after pairs share a subject: "before" is an arrow
 * meeting a gate in front of it, "after" is a check behind it. The arrow, gate and check are drawn heavier so the pair reads apart
 */
import type { ReactNode } from 'react'

export type TimingArtId =
  | 'prompt'
  | 'stop'
  | 'edit-before'
  | 'edit-after'
  | 'shell-before'
  | 'shell-after'
  | 'all-before'
  | 'all-after'
  | 'notification'
  | 'session-start'
  | 'session-end'

const MARK = 2

const bubble = (
  <>
    <path d="M9 11h14a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-9l-5 4v-4a4 4 0 0 1-4-4v-8a4 4 0 0 1 4-4z" />
    <path d="M10 17h12M10 21h7" />
  </>
)
const file = (
  <>
    <path d="M3 10a1 1 0 0 1 1-1h8l5 5v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
    <path d="M12 9v5h5" />
    <path d="M6 19h8M6 23h8M6 27h5" />
  </>
)
const terminal = (
  <>
    <rect x="0.75" y="11" width="17" height="18" rx="2.5" />
    <path d="M0.75 15h17" />
    <path d="M4.5 19.5L7 22l-2.5 2.5M10 24.5h4" />
  </>
)
const stack = (
  <>
    <path d="M9 11l8 4.5-8 4.5-8-4.5z" />
    <path d="M1 20l8 4.5 8-4.5M1 24.5l8 4.5 8-4.5" />
  </>
)
const gate = <path d="M4 20h6M7.5 17.5L10 20l-2.5 2.5M13 13v14" strokeWidth={MARK} />
const check = <path d="M26 20l3 3 6-6.5" strokeWidth={MARK} />

const before = (subject: ReactNode, x: number): ReactNode => (
  <>
    {gate}
    <g transform={`translate(${x} 0)`}>{subject}</g>
  </>
)
const after = (subject: ReactNode, x: number): ReactNode => (
  <>
    <g transform={`translate(${x} 0)`}>{subject}</g>
    {check}
  </>
)

const ART: Readonly<Record<TimingArtId, ReactNode>> = {
  prompt: (
    <>
      {bubble}
      <path d="M30 10l5-5M31 5h4v4" strokeWidth={MARK} />
    </>
  ),
  stop: (
    <>
      {bubble}
      <path d="M29.5 8l2.5 2.5 5-5.5" strokeWidth={MARK} />
    </>
  ),
  'edit-before': before(file, 14.5),
  'edit-after': after(file, 5.5),
  'shell-before': before(terminal, 16.75),
  'shell-after': after(terminal, 4.75),
  'all-before': before(stack, 16.5),
  'all-after': after(stack, 5.5),
  notification: (
    <>
      <path d="M20 7v2" />
      <path d="M20 9a6.5 6.5 0 0 0-6.5 6.5v5L11 25h18l-2.5-4.5v-5A6.5 6.5 0 0 0 20 9z" />
      <path d="M17.5 28.5a2.5 2.5 0 0 0 5 0" />
    </>
  ),
  'session-start': (
    <>
      <circle cx="20" cy="20" r="12" />
      <path d="M17.5 15.5v9l7-4.5z" />
    </>
  ),
  'session-end': (
    <>
      <circle cx="20" cy="20" r="12" />
      <rect x="16" y="16" width="8" height="8" rx="1.5" />
    </>
  )
}

export function TimingArt({
  id,
  size = 44
}: {
  id: TimingArtId
  size?: number
}): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden focusable="false">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ART[id]}
      </g>
    </svg>
  )
}
