import { Badge, Box, Group, Stack, Text, Title } from '@mantine/core'

interface HeaderProps {
  title: React.ReactNode
  count?: number
  subtitle?: React.ReactNode
  /** Right-side actions (reload etc.) */
  actions?: React.ReactNode
}

/** Page header: 17px title + count badge + subtext, thin bottom border */
export function PageHeader({ title, count, subtitle, actions }: HeaderProps): React.JSX.Element {
  return (
    <Box pb="sm" mb="md" style={{ borderBottom: '1px solid var(--ac-border-subtle)' }}>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Group gap="xs" wrap="nowrap">
            <Title order={2}>{title}</Title>
            {count !== undefined && (
              <Badge variant="default" size="md" fw={600} c="var(--ac-text-muted)">
                {count}
              </Badge>
            )}
          </Group>
          {subtitle && (
            <Text size="md" c="dimmed" lineClamp={1}>
              {subtitle}
            </Text>
          )}
        </Stack>
        {actions && (
          <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
            {actions}
          </Group>
        )}
      </Group>
    </Box>
  )
}

/** Responsive toolbar: keep each control intact while wrapping groups. */
export function Toolbar({
  left,
  right
}: {
  left?: React.ReactNode
  right?: React.ReactNode
}): React.JSX.Element {
  return (
    <Group className="ac-toolbar" justify="space-between" wrap="wrap" mb="sm" gap="sm">
      <Group gap="sm" wrap="wrap" style={{ flex: '1 1 320px', minWidth: 0 }}>
        {left}
      </Group>
      {right && (
        <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0, marginLeft: 'auto' }}>
          {right}
        </Group>
      )}
    </Group>
  )
}

/** 12px uppercase section title */
export function SectionTitle({
  children,
  right
}: {
  children: React.ReactNode
  right?: React.ReactNode
}): React.JSX.Element {
  return (
    <Group justify="space-between" wrap="nowrap" mb={8} mt={4}>
      <span className="ac-section">{children}</span>
      {right}
    </Group>
  )
}
