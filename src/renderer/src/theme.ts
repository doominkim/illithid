import { createTheme, type CSSVariablesResolver, type MantineColorsTuple } from '@mantine/core'

/**
 * ui-spec tokens. accent is exposed as a Mantine palette (10 shades), the rest as --ac-* CSS variables.
 * primaryShade is shade 6 (#059669) in light and shade 5 (#10B981) in dark.
 */
const accent: MantineColorsTuple = [
  '#ECFDF5',
  '#D1FAE5',
  '#A7F3D0',
  '#6EE7B7',
  '#34D399',
  '#10B981',
  '#059669',
  '#047857',
  '#065F46',
  '#064E3B'
]

/** Map dark surfaces, borders, and text onto the Mantine dark palette slots (0 text … 7 body) */
const dark: MantineColorsTuple = [
  '#F4F4F5',
  '#D4D4D8',
  '#8E8E96',
  '#6B6B75',
  '#222229',
  '#1E1E28',
  '#131317',
  '#0C0C0F',
  '#0F0F13',
  '#0A0A0D'
]

export const theme = createTheme({
  primaryColor: 'accent',
  primaryShade: { light: 6, dark: 5 },
  colors: { accent, dark },
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif',
  fontFamilyMonospace:
    '"SF Mono", ui-monospace, Menlo, Monaco, "Cascadia Mono", "Roboto Mono", monospace',
  fontSizes: { xs: '11px', sm: '12px', md: '13px', lg: '14px', xl: '17px' },
  lineHeights: { xs: '1.4', sm: '1.45', md: '1.5', lg: '1.5', xl: '1.4' },
  radius: { xs: '4px', sm: '6px', md: '8px', lg: '12px', xl: '16px' },
  defaultRadius: 'md',
  headings: {
    fontWeight: '600',
    sizes: {
      h1: { fontSize: '28px', lineHeight: '1.2' },
      h2: { fontSize: '17px', lineHeight: '1.3' },
      h3: { fontSize: '14px', lineHeight: '1.4' },
      h4: { fontSize: '13px', lineHeight: '1.4' },
      h5: { fontSize: '12px', lineHeight: '1.4' },
      h6: { fontSize: '12px', lineHeight: '1.4' }
    }
  },
  shadows: {
    xs: 'var(--ac-shadow-card)',
    sm: 'var(--ac-shadow-card)',
    md: 'var(--ac-shadow-card-hover)'
  },
  components: {
    Paper: {
      defaultProps: { radius: 'lg' },
      styles: { root: { backgroundColor: 'var(--ac-surface)' } }
    },
    Card: { defaultProps: { radius: 'lg', padding: 'md' } },
    Button: { defaultProps: { radius: 'md', size: 'sm' } },
    ActionIcon: { defaultProps: { radius: 'md' } },
    Badge: { defaultProps: { radius: 'xl' }, styles: { root: { textTransform: 'none' } } },
    TextInput: { defaultProps: { radius: 'md', size: 'sm' } },
    Select: { defaultProps: { radius: 'md', size: 'sm' } },
    SegmentedControl: { defaultProps: { radius: 'md', size: 'sm' } },
    Tabs: { defaultProps: { radius: 'md' } },
    Tooltip: { defaultProps: { withArrow: false, fz: 'xs' } }
  }
})

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    '--mantine-color-body': '#FAFAFA',
    '--mantine-color-text': '#18181B',
    '--mantine-color-dimmed': '#71717A',
    '--mantine-color-default-border': '#D4D4D8',
    '--mantine-color-anchor': '#059669',
    '--ac-bg': '#FAFAFA',
    '--ac-sidebar-bg': '#F4F4F5',
    '--ac-surface': '#FFFFFF',
    '--ac-surface-hover': '#F4F4F5',
    '--ac-surface-active': '#E4E4E7',
    '--ac-border': '#D4D4D8',
    '--ac-border-subtle': '#E4E4E7',
    '--ac-text': '#18181B',
    '--ac-text-2': '#27272A',
    '--ac-text-muted': '#71717A',
    '--ac-accent': '#059669',
    '--ac-accent-bg': 'rgba(5,150,105,.08)',
    '--ac-danger': '#DC2626',
    '--ac-warning': '#D97706',
    '--ac-shadow-card': '0 1px 2px rgba(24,24,27,.04)',
    '--ac-shadow-card-hover': '0 4px 12px rgba(24,24,27,.07)'
  },
  dark: {
    '--mantine-color-body': '#0C0C0F',
    '--mantine-color-text': '#F4F4F5',
    '--mantine-color-dimmed': '#8E8E96',
    '--mantine-color-default-border': '#222229',
    '--mantine-color-anchor': '#10B981',
    '--ac-bg': '#0C0C0F',
    '--ac-sidebar-bg': '#0F0F13',
    '--ac-surface': '#131317',
    '--ac-surface-hover': '#17171E',
    '--ac-surface-active': '#1E1E28',
    '--ac-border': '#222229',
    '--ac-border-subtle': '#1C1C22',
    '--ac-text': '#F4F4F5',
    '--ac-text-2': '#D4D4D8',
    '--ac-text-muted': '#8E8E96',
    '--ac-accent': '#10B981',
    '--ac-accent-bg': 'rgba(16,185,129,.08)',
    '--ac-danger': '#EF4444',
    '--ac-warning': '#F59E0B',
    '--ac-shadow-card': '0 1px 2px rgba(0,0,0,.3)',
    '--ac-shadow-card-hover': '0 4px 14px rgba(0,0,0,.45)'
  }
})
