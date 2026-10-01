import { TargetError, type TargetDef } from '../types'
import { blockBody, outsideBlock, removeBlockMulti, sha256, spliceBlockMulti } from '../text'
import {
  blockRuleNames,
  buildRulesBlockBody,
  MD_BEGIN,
  MD_END,
  MD_HEADER,
  MD_MARKERS
} from './codexAgents'

/** Gemini edits GEMINI.md itself (memory tool, file edits), so the block says where its own notes belong */
export const GEMINI_MD_HEADER =
  MD_HEADER + '\nManaged by Illithid; add your own notes outside this block.'

/** The block must be absent or one well-formed pair — otherwise where the app region ends can't be told apart from user text */
function checkMarkers(text: string): void {
  const count = (m: string): number => text.split(m).length - 1
  const b = count(MD_BEGIN)
  const e = count(MD_END)
  if (b === 0 && e === 0) return
  if (b === 1 && e === 1 && text.indexOf(MD_BEGIN) < text.indexOf(MD_END)) return
  throw new TargetError(
    'Illithid marker block is broken (missing, repeated or out-of-order markers) — fix the markers in GEMINI.md; not written'
  )
}

/** The block differs from what the app last wrote (applied = its recorded region hash) */
export function blockEdited(text: string, applied: string | undefined): boolean {
  const body = blockBody(text, MD_BEGIN, MD_END)
  return body !== null && applied !== undefined && sha256(body) !== applied
}

/**
 * ~/.gemini/GEMINI.md — rules/*.md + memory/MEMORY.md inlined inside the markers (like Codex AGENTS.md).
 * GEMINI.md @imports are limited to ~/.gemini, so library files can't be referenced. Text outside the markers
 * (Gemini's memory tool appends there) is kept byte for byte.
 */
export const geminiRules: TargetDef = {
  id: 'geminiRules',
  tool: 'gemini',
  rel: '.gemini/GEMINI.md',
  optional: false,
  createIfInUse: true,
  region: (text) => blockBody(text, MD_BEGIN, MD_END),
  build(before, ctx) {
    const { sources } = ctx
    checkMarkers(before)
    if (!blockRuleNames(sources, 'gemini').length && sources.memoryIndex === null) {
      const after = removeBlockMulti(before, [MD_MARKERS])
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
      [],
      buildRulesBlockBody(sources, 'gemini', GEMINI_MD_HEADER, ctx.home)
    )
    const outside = outsideBlock(after, MD_BEGIN, MD_END).trim()
    const notes = [`kept outside markers: ${outside.length} chars (Gemini-only text)`]
    if (blockEdited(before, ctx.applied?.geminiRules) && after !== before)
      notes.push(
        'block was edited outside Illithid since the last apply (e.g. by Gemini) — the previous block is backed up to backups/deleted before it is replaced'
      )
    return { after, notes }
  }
}
