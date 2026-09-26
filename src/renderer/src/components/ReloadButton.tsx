import { createContext, useContext } from 'react'
import { Button } from '@mantine/core'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** Reload (clear cache and rescan). Used by header action buttons */
export const ReloadContext = createContext<() => void>(() => {})

export function ReloadButton(): React.JSX.Element {
  const { t } = useTranslation()
  const reload = useContext(ReloadContext)
  return (
    <Button variant="default" size="xs" leftSection={<RefreshCw size={13} />} onClick={reload}>
      {t('common.reload')}
    </Button>
  )
}

/** Clear the cache so every screen reloads (after writes) */
export function useReload(): () => void {
  return useContext(ReloadContext)
}
