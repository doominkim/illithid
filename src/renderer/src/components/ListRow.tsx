import { Box, Group, Text, UnstyledButton } from '@mantine/core'

interface Props {
  /** Initial avatar or icon */
  avatar?: React.ReactNode
  title: string
  tags?: React.ReactNode
  subtitle?: React.ReactNode
  right?: React.ReactNode
  active?: boolean
  onClick?: () => void
  style?: React.CSSProperties
}

/** Initial avatar (accent tone) */
export function Initial({ text, size = 28 }: { text: string; size?: number }): React.JSX.Element {
  const ch = (text.trim()[0] ?? '?').toUpperCase()
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        background: 'var(--ac-accent-bg)',
        color: 'var(--ac-accent)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 600,
        fontSize: Math.round(size * 0.46),
        flexShrink: 0
      }}
    >
      {ch}
    </span>
  )
}

/** List row: avatar + title/tags + subtext + right slot */
export function ListRow({ avatar, title, tags, subtitle, right, active, onClick, style }: Props): React.JSX.Element {
  const body = (
    <>
      {avatar}
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Group gap={8} wrap="nowrap">
          <Text fw={600} size="md" truncate="end" style={{ minWidth: 0 }}>
            {title}
          </Text>
          {tags}
        </Group>
        {subtitle && (
          <Text size="sm" c="dimmed" truncate="end" mt={2}>
            {subtitle}
          </Text>
        )}
      </Box>
      {right && <Box style={{ flexShrink: 0 }}>{right}</Box>}
    </>
  )
  if (onClick)
    return (
      <UnstyledButton className="ac-row" data-active={active || undefined} onClick={onClick} style={style}>
        {body}
      </UnstyledButton>
    )
  return (
    <Box className="ac-row" style={style}>
      {body}
    </Box>
  )
}

/** Card grouping rows */
export function ListCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }): React.JSX.Element {
  return (
    <Box className="ac-card" style={{ overflow: 'hidden', ...style }}>
      {children}
    </Box>
  )
}
