import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import '@mantine/spotlight/styles.css'
import './styles.css'
import './i18n'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider, localStorageColorSchemeManager } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import App from './App'
import { cssVariablesResolver, theme } from './theme'
import { migrateStorageKey } from './lib/storage'

const COLOR_SCHEME_KEY = 'illithid-color-scheme'
migrateStorageKey(COLOR_SCHEME_KEY, ['harnesssync-color-scheme'])
const colorSchemeManager = localStorageColorSchemeManager({ key: COLOR_SCHEME_KEY })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      colorSchemeManager={colorSchemeManager}
      defaultColorScheme="auto"
    >
      <Notifications position="bottom-right" />
      <App />
    </MantineProvider>
  </StrictMode>
)
