import { useContext } from 'react'
import { Button } from '@mantine/core'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ReloadContext } from '../lib/reload'

export function ReloadButton(): React.JSX.Element {
  const { t } = useTranslation()
  const reload = useContext(ReloadContext)
  return (
    <Button variant="default" size="xs" leftSection={<RefreshCw size={13} />} onClick={reload}>
      {t('common.reload')}
    </Button>
  )
}
