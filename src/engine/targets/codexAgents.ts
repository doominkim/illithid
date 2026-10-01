import { tilde } from '../agents'
import { isEnabled } from '../manifest'
import {
  blockBodyMulti,
  outsideBlockMulti,
  removeBlockMulti,
  spliceBlockMulti,
  type MarkerPair
} from '../text'
import type { ToolId } from '../toolIds'
import type { Sources, TargetDef } from '../types'

/** App marker (M7d). The library location is left out of the text (config.libraryPath can change it) */
export const MD_BEGIN = '<!-- BEGIN illithid — DO NOT EDIT: generated from the Illithid library -->'
export const MD_END = '<!-- END illithid -->'
/** Earlier app marker with a Korean header (before the English rewrite). Escaped to match byte-for-byte */
export const LEGACY_KO_MD_BEGIN =
  '<!-- BEGIN illithid — DO NOT EDIT: Illithid \uB77C\uC774\uBE0C\uB7EC\uB9AC\uC5D0\uC11C \uC0DD\uC131\uB428 -->'
/** Previous system (sync.mjs) marker. If present, the block is recognized and replaced with the app marker block */
export const LEGACY_MD_BEGIN =
  '<!-- BEGIN agents-sync — DO NOT EDIT: ~/.agents \uC5D0\uC11C \uC0DD\uC131\uB428 -->'
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
export const ALL_MD_MARKERS: readonly MarkerPair[] = [MD_MARKERS, ...LEGACY_MD_MARKERS]

/** First paragraph of the block (notice) */
export const MD_HEADER =
  'This block is generated from `rules/*.md` and `memory/MEMORY.md` in the Illithid library.\n' +
  'To change it, edit the library and apply from Illithid.'

/** Rule names enabled for the tool (all if there is no manifest) */
export function blockRuleNames(sources: Sources, tool: ToolId): string[] {
  return sources.rules
    .filter((x) => isEnabled(sources.manifest, 'rules', x.name, tool))
    .map((x) => x.name)
}

/** Rule names enabled for Codex (all if there is no manifest) */
export function codexRuleNames(sources: Sources): string[] {
  return blockRuleNames(sources, 'codex')
}

/** Where to edit instead (library root in ~ form when home is known): agents asked to change a rule edit the source */
export function blockSourceLine(sources: Sources, home?: string): string {
  const root = home ? tilde(home, sources.agentsDir) : sources.agentsDir
  return `Edit the sources, not this block: \`${root}/rules/<name>.md\` and \`${root}/memory/MEMORY.md\`. Edits here are replaced on the next sync.`
}

/** Marker block body for tools that get rules inlined (Codex AGENTS.md, Gemini GEMINI.md) */
export function buildRulesBlockBody(
  sources: Sources,
  tool: ToolId,
  header = MD_HEADER,
  home?: string
): string {
  const parts = [`${header}\n${blockSourceLine(sources, home)}`]
  // Skip rules disabled for the tool (all included if there is no manifest)
  for (const r of sources.rules.filter((x) => isEnabled(sources.manifest, 'rules', x.name, tool))) {
    parts.push(`<!-- rules/${r.name} -->\n` + r.text.trim())
  }
  if (sources.memoryIndex !== null) {
    parts.push('<!-- memory/MEMORY.md -->\n' + sources.memoryIndex.trim())
  }
  return parts.join('\n\n---\n\n')
}

export function buildCodexAgentsBody(sources: Sources, home?: string): string {
  return buildRulesBlockBody(sources, 'codex', MD_HEADER, home)
}

/** Rule and memory names inside a marker block (current or legacy markers) */
export function rulesBlockItems(text: string): { rules: string[]; memory: boolean } {
  const body = blockBodyMulti(text, ALL_MD_MARKERS) ?? ''
  const rules = [...body.matchAll(/^<!-- rules\/(.+?) -->$/gm)].map((m) => m[1])
  return { rules, memory: /^<!-- memory\/MEMORY\.md -->$/m.test(body) }
}

/** 1. ~/.codex/AGENTS.md — rules/*.md + memory/MEMORY.md concat (inside the markers only) */
export const codexAgents: TargetDef = {
  id: 'codexAgents',
  tool: 'codex',
  rel: '.codex/AGENTS.md',
  optional: true,
  region: (text) => blockBodyMulti(text, ALL_MD_MARKERS),
  build(before, { sources, home }) {
    // With no rules or memory to write, don't create a block and remove any previously written one
    if (!codexRuleNames(sources).length && sources.memoryIndex === null) {
      const after = removeBlockMulti(before, ALL_MD_MARKERS)
      return {
        after,
        notes: [
          after === before
            ? '0 rules/memory — block not written'
            : '0 rules/memory — previous block removed'
        ]
      }
    }
    const after = spliceBlockMulti(
      before,
      MD_MARKERS,
      LEGACY_MD_MARKERS,
      buildCodexAgentsBody(sources, home)
    )
    const outside = outsideBlockMulti(after, ALL_MD_MARKERS).trim()
    const notes = [`kept outside markers: ${outside.length} chars (Codex-only text)`]
    if (blockBodyMulti(before, LEGACY_MD_MARKERS) !== null)
      notes.push('legacy marker block → replaced with app marker')
    return { after, notes }
  }
}
