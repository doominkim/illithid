import { useEffect, type RefObject } from 'react'

const NAME = 'ac-search'

/**
 * Highlight every case-insensitive occurrence of q in the rendered text under ref (CSS Custom Highlight API; the DOM is not changed)
 * and scroll the first one into view. Matches split across elements (e.g. partly bold) are not found. Re-runs when deps change
 */
export function useTextHighlight(
  ref: RefObject<HTMLElement | null>,
  q: string,
  deps: unknown[]
): void {
  const needle = q.trim().toLowerCase()
  useEffect(() => {
    const root = ref.current
    if (!root || !needle || typeof CSS === 'undefined' || !('highlights' in CSS)) return
    const ranges: Range[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.nodeValue ?? '').toLowerCase()
      for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
        const r = new Range()
        r.setStart(n, i)
        r.setEnd(n, i + needle.length)
        ranges.push(r)
      }
    }
    if (!ranges.length) return
    CSS.highlights.set(NAME, new Highlight(...ranges))
    ranges[0].startContainer.parentElement?.scrollIntoView({ block: 'center' })
    return () => {
      CSS.highlights.delete(NAME)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, needle, ...deps])
}
