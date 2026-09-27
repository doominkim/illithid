import { isEnabled } from '../manifest'
import { blockBodyMulti, outsideBlockMulti, removeBlockMulti, spliceBlockMulti, type MarkerPair } from '../text'
import type { Sources, TargetDef } from '../types'

/** App marker (M7d). The library location is left out of the text (config.libraryPath can change it) */
export const MD_BEGIN = '<!-- BEGIN illithid — DO NOT EDIT: generated from the Illithid library -->'
export const MD_END = '<!-- END illithid -->'
/** Earlier app marker with a Korean header (before the English rewrite). Escaped to match byte-for-byte */
export const LEGACY_KO_MD_BEGIN =
  '<!-- BEGIN illithid — DO NOT EDIT: Illithid \uB77C\uC774\uBE0C\uB7EC\uB9AC\uC5D0\uC11C \uC0DD\uC131\uB428 -->'
/** Previous system (sync.mjs) marker. If present, the block is recognized and replaced with the app marker block */
export const LEGACY_MD_BEGIN = '<!-- BEGIN agents-sync — DO NOT EDIT: ~/.agents \uC5D0\uC11C \uC0DD\uC131\uB428 -->'
export const LEGACY_MD_END = '<!-- END agents-sync -->'
/** Previous app name (harnesssync) marker */
export const LEGACY_HS_MD_BEGIN =
  '<!-- BEGIN harnesssync — DO NOT EDIT: HarnessSync \uB77C\uC774\uBE0C\uB7EC\uB9AC\uC5D0\uC11C \uC0DD\uC131\uB428 -->'
export const LEGACY_HS_MD_END = '<!-- END harnesssync -->'
/** Previous app name (agent-console) marker */
export const LEGACY_APP_MD_BEGIN =
  '<!-- BEGIN agent-console — DO NOT EDIT: agent-console \uB77C\uC774\uBE0C\uB7EC\uB9AC\uC5D0\uC11C \uC0DD\uC131\uB428 -->'
export const LEGACY_APP_MD_END = '<!-- END agent-console -->'

export const MD_MARKERS: MarkerPair = [MD_BEGIN, MD_END]
export const LEGACY_MD_MARKERS: readonly MarkerPair[] = [
  [LEGACY_KO_MD_BEGIN, MD_END],
  [LEGACY_HS_MD_BEGIN, LEGACY_HS_MD_END],
  [LEGACY_APP_MD_BEGIN, LEGACY_APP_MD_END],
  [LEGACY_MD_BEGIN, LEGACY_MD_END]
]
const ALL_MD_MARKERS: readonly MarkerPair[] = [MD_MARKERS, ...LEGACY_MD_MARKERS]

/** First paragraph of the block (notice) */
export const MD_HEADER =
  'This block is generated from `rules/*.md` and `memory/MEMORY.md` in the Illithid library.\n' +
  'To change it, edit the library and apply from Illithid.'

/** Rule names enabled for Codex (all if there is no manifest) */
export function codexRuleNames(sources: Sources): string[] {
  return sources.rules.filter((x) => isEnabled(sources.manifest, 'rules', x.name, 'codex')).map((x) => x.name)
}

export function buildCodexAgentsBody(sources: Sources): string {
  const parts = [MD_HEADER]
  // Skip rules disabled for codex (all included if there is no manifest)
  for (const r of sources.rules.filter((x) =>
    isEnabled(sources.manifest, 'rules', x.name, 'codex')
  )) {
    parts.push(`<!-- rules/${r.name} -->\n` + r.text.trim())
  }
  if (sources.memoryIndex !== null) {
    parts.push('<!-- memory/MEMORY.md -->\n' + sources.memoryIndex.trim())
  }
  return parts.join('\n\n---\n\n')
}

/** 1. ~/.codex/AGENTS.md — rules/*.md + memory/MEMORY.md concat (inside the markers only) */
export const codexAgents: TargetDef = {
  id: 'codexAgents',
  tool: 'codex',
  rel: '.codex/AGENTS.md',
  optional: true,
  region: (text) => blockBodyMulti(text, ALL_MD_MARKERS),
  build(before, { sources }) {
    // With no rules or memory to write, don't create a block and remove any previously written one
    if (!codexRuleNames(sources).length && sources.memoryIndex === null) {
      const after = removeBlockMulti(before, ALL_MD_MARKERS)
      return {
        after,
        notes: [after === before ? '0 rules/memory — block not written' : '0 rules/memory — previous block removed']
      }
    }
    const after = spliceBlockMulti(
      before,
      MD_MARKERS,
      LEGACY_MD_MARKERS,
      buildCodexAgentsBody(sources)
    )
    const outside = outsideBlockMulti(after, ALL_MD_MARKERS).trim()
    const notes = [`kept outside markers: ${outside.length} chars (Codex-only text)`]
    if (blockBodyMulti(before, LEGACY_MD_MARKERS) !== null)
      notes.push('legacy marker block → replaced with app marker')
    return { after, notes }
  }
}
