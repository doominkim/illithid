/** YYYY-MM-DD HH:mm (local time) */
export function fmtTime(iso: string | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Engine paths are absolute. Infer home from known paths (<home>/.claude/settings.json etc.) and shorten it to ~ */
export function homeFrom(path: string, suffix: string): string | null {
  return path.endsWith(suffix) ? path.slice(0, -suffix.length) : null
}

export function tildeWith(home: string | null, p: string | undefined): string {
  if (!p) return ''
  if (!home) return p
  return p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
}

export function includesCI(hay: string | undefined, needle: string): boolean {
  return !!hay && hay.toLowerCase().includes(needle)
}

/** Relative time ("5 min ago"). Localized wording comes from i18n keys rel.* */
export function relTime(iso: string | undefined, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (!iso) return '-'
  const d = new Date(iso).getTime()
  if (Number.isNaN(d)) return '-'
  const s = Math.max(0, Math.round((Date.now() - d) / 1000))
  if (s < 60) return t('rel.now')
  const m = Math.round(s / 60)
  if (m < 60) return t('rel.minutes', { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('rel.hours', { n: h })
  const days = Math.round(h / 24)
  if (days < 30) return t('rel.days', { n: days })
  return fmtTime(iso).slice(0, 10)
}

/** Clean up session titles: strip tags, newlines, extra whitespace */
export function cleanTitle(s: string | undefined): string {
  if (!s) return ''
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
