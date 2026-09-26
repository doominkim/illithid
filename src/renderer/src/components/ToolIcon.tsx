import claudeSvg from '@lobehub/icons-static-svg/icons/claude-color.svg?raw'
import codexSvg from '@lobehub/icons-static-svg/icons/openai.svg?raw'
import cursorSvg from '@lobehub/icons-static-svg/icons/cursor.svg?raw'
import opencodeSvg from '@lobehub/icons-static-svg/icons/opencode.svg?raw'
import type { ToolId } from '../../../shared/api'

/** Tools with icons: sync target tools + cursor for artifact attribution */
export type IconToolId = ToolId | 'cursor'

/** Real tool logos (@lobehub/icons-static-svg). Monochrome logos use currentColor and follow the theme text color */
const SVG: Record<IconToolId, string> = {
  claude: claudeSvg,
  codex: codexSvg,
  opencode: opencodeSvg,
  cursor: cursorSvg
}

/** Fit the package SVG 1em size to the parent box */
const fit = (svg: string): string =>
  svg
    .replace(/\swidth="1em"/, ' width="100%"')
    .replace(/\sheight="1em"/, ' height="100%"')
    // <title> shows as a browser tooltip on hover; remove it
    .replace(/<title>[\s\S]*?<\/title>/g, '')

const MARKUP: Record<IconToolId, { __html: string }> = {
  claude: { __html: fit(SVG.claude) },
  codex: { __html: fit(SVG.codex) },
  opencode: { __html: fit(SVG.opencode) },
  cursor: { __html: fit(SVG.cursor) }
}

export function ToolIcon({
  tool,
  size = 18,
  className,
  ...rest
}: { tool: IconToolId; size?: number; className?: string } & Record<`data-${string}`, unknown>): React.JSX.Element {
  return (
    <span
      className={className}
      role="img"
      aria-label={tool}
      style={{
        display: 'inline-flex',
        width: size,
        height: size,
        color: 'var(--mantine-color-text)',
        flexShrink: 0
      }}
      dangerouslySetInnerHTML={MARKUP[tool]}
      {...rest}
    />
  )
}
