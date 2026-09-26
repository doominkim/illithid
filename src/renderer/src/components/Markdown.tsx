import { Typography } from '@mantine/core'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Raw HTML is not rendered (react-markdown default, no rehype-raw). Links open in a new window → external browser */
export function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <Typography>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </Typography>
  )
}
