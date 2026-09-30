export function tickStep(span: number): number {
  const raw = Math.max(span, 1e-9) / 5
  const power = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 2.5, 5, 10].find((n) => n * power >= raw)! * power
}
export function axisTicks(min: number, max: number): number[] {
  const step = tickStep(max - min)
  const ticks: number[] = []
  for (let i = Math.ceil(min / step); i * step <= max + step * 1e-8; i++)
    ticks.push(Number((i * step).toPrecision(12)))
  return ticks
}
export function placeLabels<T extends { px: number; py: number; w: number }>(
  points: T[]
): (T & { lx: number; ly: number })[] {
  const boxes: { x: number; y: number; w: number }[] = []
  return [...points]
    .sort((a, b) => a.px - b.px || a.py - b.py)
    .map((p) => {
      const candidates: { x: number; y: number; score: number }[] = []
      for (let dy = -24; dy >= -340; dy -= 22) {
        for (const dx of [0, -24, 24, -60, 60, -120, 120, -200, 200, -320, 320, -500, 500]) {
          const x = Math.max(72, Math.min(968 - p.w, p.px - p.w / 2 + dx))
          const y = Math.max(24, p.py + dy)
          candidates.push({ x, y, score: Math.hypot(x + p.w / 2 - p.px, y + 8 - p.py) })
        }
      }
      for (let y = 24; y <= 362; y += 22)
        for (let x = 72; x + p.w <= 968; x += 20)
          candidates.push({ x, y, score: Math.hypot(x + p.w / 2 - p.px, y + 8 - p.py) + 20 })
      candidates.sort((a, b) => a.score - b.score)
      const c =
        candidates.find(
          (c) =>
            !boxes.some(
              (b) => c.x < b.x + b.w + 6 && c.x + p.w + 6 > b.x && c.y < b.y + 20 && c.y + 20 > b.y
            ) &&
            !points.some(
              (n) =>
                Math.abs(n.px - (c.x + p.w / 2)) < p.w / 2 + 7 && Math.abs(n.py - (c.y + 6)) < 14
            )
        ) ?? candidates[0]
      boxes.push({ x: c.x, y: c.y, w: p.w })
      return { ...p, lx: c.x + p.w / 2, ly: c.y }
    })
}
