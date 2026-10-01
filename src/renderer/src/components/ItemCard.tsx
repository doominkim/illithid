import { Box, Checkbox, Group, Text } from '@mantine/core'

interface Props {
  name: string
  description?: string
  /** Top-right bulk toggle (all tools). Indeterminate if only some are on. Display-only disabled without onSwitch */
  switchChecked?: boolean
  switchIndeterminate?: boolean
  onSwitch?: (v: boolean) => void
  /** Bottom left */
  footerLeft?: React.ReactNode
  /** Bottom right (tool pills) */
  footerRight?: React.ReactNode
  /** Badge next to the title */
  badges?: React.ReactNode
  selected?: boolean
  onClick?: () => void
  testId?: string
}

/** Library card: top (name, switch) / one-line description / divider / footer */
export function ItemCard({
  name,
  description,
  switchChecked,
  switchIndeterminate,
  onSwitch,
  footerLeft,
  footerRight,
  badges,
  selected,
  onClick,
  testId
}: Props): React.JSX.Element {
  const sw =
    switchChecked !== undefined ? (
      <Checkbox
        size="sm"
        radius="sm"
        checked={switchChecked}
        indeterminate={!!switchIndeterminate && !switchChecked}
        disabled={!onSwitch}
        onChange={(e) => onSwitch?.(e.currentTarget.checked)}
        onClick={(e) => e.stopPropagation()}
        data-testid="card-all-toggle"
      />
    ) : null
  return (
    <Box
      /* mantine-NavLink-root is an unstyled static class. scripts/screens.ts uses it to pick the first item */
      className="ac-card mantine-NavLink-root"
      data-clickable={onClick ? true : undefined}
      data-selected={selected || undefined}
      data-card={testId ?? name}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onClick()
        }
      }}
      style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
    >
      <Box p="md" pb="sm" style={{ flex: 1 }}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
            <Text fw={600} size="lg" truncate="end" style={{ minWidth: 0 }}>
              {name}
            </Text>
            {badges}
          </Group>
          {sw}
        </Group>
        <Text size="md" c="dimmed" mt={6} lineClamp={1} style={{ minHeight: 20 }}>
          {description || ' '}
        </Text>
      </Box>
      {(footerLeft || footerRight) && (
        <Group
          justify="space-between"
          wrap="nowrap"
          px="md"
          py={10}
          style={{ borderTop: '1px solid var(--ac-border-subtle)' }}
        >
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0, overflow: 'hidden' }}>
            {footerLeft}
          </Group>
          <Box style={{ flexShrink: 0 }}>{footerRight}</Box>
        </Group>
      )}
    </Box>
  )
}

/** 3-column card grid (2 or 1 columns when narrow) */
export function CardGrid({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Box
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: 14
      }}
    >
      {children}
    </Box>
  )
}
