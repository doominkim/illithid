import { ElectronAPI } from '@electron-toolkit/preload'
import type { Api } from '../shared/api'

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
