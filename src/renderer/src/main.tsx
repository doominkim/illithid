import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import '@mantine/spotlight/styles.css'
import '@mantine/charts/styles.css'
import './styles.css'
import './i18n'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import App from './App'
import { TrayPopover } from './TrayPopover'
import { cssVariablesResolver, theme } from './theme'
import { configColorSchemeManager } from './lib/uiPrefs'

const colorSchemeManager = configColorSchemeManager()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      colorSchemeManager={colorSchemeManager}
      defaultColorScheme="auto"
    >
      {/* The menu bar popover loads the same page with #tray */}
      {window.location.hash === '#tray' ? (
        <TrayPopover />
      ) : (
        <>
          <Notifications position="bottom-right" />
          <App />
        </>
      )}
    </MantineProvider>
  </StrictMode>
)
