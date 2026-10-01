/** Search snippet: wrap marks ranges in <mark> */
export function Snippet({
  text,
  marks
}: {
  text: string
  marks: [number, number][]
}): React.JSX.Element {
  const parts: React.ReactNode[] = []
  let at = 0
  marks.forEach(([a, b], i) => {
    if (a < at) return
    if (a > at) parts.push(text.slice(at, a))
    parts.push(<mark key={i}>{text.slice(a, b)}</mark>)
    at = b
  })
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}
