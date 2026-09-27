import {
  blockBodyMulti,
  normalizeEntry,
  outsideBlockMulti,
  spliceBlockMulti,
  type MarkerPair
} from '../text'
import type { Allowlist, TargetDef } from '../types'

/** App marker (M7d) */
export const RULES_BEGIN =
  '# BEGIN illithid permissions — DO NOT EDIT: generated from library permissions.json'
export const RULES_END = '# END illithid permissions'
/** Earlier app marker with a Korean header (before the English rewrite). Escaped to match byte-for-byte */
export const LEGACY_KO_RULES_BEGIN =
  '# BEGIN illithid permissions — DO NOT EDIT: \uB77C\uC774\uBE0C\uB7EC\uB9AC permissions.json \uC5D0\uC11C \uC0DD\uC131\uB428'
/** Previous app name (harnesssync) marker */
export const LEGACY_HS_RULES_BEGIN =
  '# BEGIN harnesssync permissions — DO NOT EDIT: \uB77C\uC774\uBE0C\uB7EC\uB9AC permissions.json \uC5D0\uC11C \uC0DD\uC131\uB428'
export const LEGACY_HS_RULES_END = '# END harnesssync permissions'
/** Previous app name (agent-console) marker */
export const LEGACY_APP_RULES_BEGIN =
  '# BEGIN agent-console permissions — DO NOT EDIT: \uB77C\uC774\uBE0C\uB7EC\uB9AC permissions.json \uC5D0\uC11C \uC0DD\uC131\uB428'
export const LEGACY_APP_RULES_END = '# END agent-console permissions'
/** Previous system (sync.mjs) marker */
export const LEGACY_RULES_BEGIN =
  '# BEGIN agents-sync — DO NOT EDIT: ~/.agents/sync/allowlist.json \uC5D0\uC11C \uC0DD\uC131\uB428'
export const LEGACY_RULES_END = '# END agents-sync'

export const RULES_MARKERS: MarkerPair = [RULES_BEGIN, RULES_END]
export const LEGACY_RULES_MARKERS: readonly MarkerPair[] = [
  [LEGACY_KO_RULES_BEGIN, RULES_END],
  [LEGACY_HS_RULES_BEGIN, LEGACY_HS_RULES_END],
  [LEGACY_APP_RULES_BEGIN, LEGACY_APP_RULES_END],
  [LEGACY_RULES_BEGIN, LEGACY_RULES_END]
]
const ALL_RULES_MARKERS: readonly MarkerPair[] = [RULES_MARKERS, ...LEGACY_RULES_MARKERS]

export function toPrefixRule(argv: string[]): string {
  return `prefix_rule(pattern=[${argv.map((a) => JSON.stringify(a)).join(', ')}], decision="allow")`
}

export function buildCodexRulesBody(
  allowlist: Allowlist,
  currentText: string
): { body: string; skipped: { argv: string[]; line: string }[] } {
  // If the same rule already exists outside the markers (the area the runtime appends to), don't duplicate it in the block.
  const outside = outsideBlockMulti(currentText, ALL_RULES_MARKERS)
  const kept: { argv: string[]; line: string }[] = []
  const skipped: { argv: string[]; line: string }[] = []
  for (const entry of allowlist.bash) {
    const { argv } = normalizeEntry(entry)
    const line = toPrefixRule(argv)
    ;(outside.includes(line) ? skipped : kept).push({ argv, line })
  }
  const body = kept.length
    ? kept.map((r) => r.line).join('\n')
    : '# (all entries already exist elsewhere in this file)'
  return { body, skipped }
}

/** 2. ~/.codex/rules/default.rules — allowlist.bash → prefix_rule (inside the markers only; duplicates outside the markers are skipped) */
export const codexRules: TargetDef = {
  id: 'codexRules',
  tool: 'codex',
  rel: '.codex/rules/default.rules',
  optional: true,
  region: (text) => blockBodyMulti(text, ALL_RULES_MARKERS),
  build(before, { sources }) {
    if (!sources.hasPermissions) {
      return {
        after: before,
        notes: ['library has no permissions.json — this target is left untouched']
      }
    }
    const { body, skipped } = buildCodexRulesBody(sources.allowlist, before)
    const after = spliceBlockMulti(before, RULES_MARKERS, LEGACY_RULES_MARKERS, body)
    const outsideLines = outsideBlockMulti(after, ALL_RULES_MARKERS)
      .split('\n')
      .filter((l) => l.trim()).length
    const notes = [`kept outside markers: ${outsideLines} lines (hand-written rules appended by the runtime)`]
    if (skipped.length) notes.push(`skipped duplicates: ${skipped.length} (already outside the markers)`)
    if (blockBodyMulti(before, LEGACY_RULES_MARKERS) !== null)
      notes.push('legacy marker block → replaced with app marker')
    return { after, notes }
  }
}
