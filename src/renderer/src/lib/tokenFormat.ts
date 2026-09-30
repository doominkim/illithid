/** Compact token counts; sorting always uses the original numeric value. */
export function formatTokens(n: number, locale = 'en'): string {
  const units = [
    { size: 1e9, suffix: 'B' },
    { size: 1e6, suffix: 'M' },
    { size: 1e3, suffix: 'K' }
  ]
  const unit = units.find(({ size }) => Math.abs(n) >= size)
  return unit
    ? `${(n / unit.size).toLocaleString(locale, { maximumFractionDigits: 2 })}${unit.suffix}`
    : Math.round(n).toLocaleString(locale)
}
