import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { CHANNELS, type Api } from '../shared/api'

// The invoke channel list is defined by CHANNELS in shared/api.ts. Events are onSyncEvent, onSearchIndexEvent and onBackupCleanupEvent (main -> renderer)
const api = {
  ...Object.fromEntries(
    CHANNELS.map((ch) => [ch, (...args: unknown[]) => ipcRenderer.invoke(`api:${ch}`, ...args)])
  ),
  onSyncEvent: (cb: (s: unknown) => void): (() => void) => {
    const listener = (_e: unknown, s: unknown): void => cb(s)
    ipcRenderer.on('api:syncEvent', listener)
    return () => {
      ipcRenderer.removeListener('api:syncEvent', listener)
    }
  },
  onSearchIndexEvent: (cb: (s: unknown) => void): (() => void) => {
    const listener = (_e: unknown, s: unknown): void => cb(s)
    ipcRenderer.on('api:searchIndexEvent', listener)
    return () => {
      ipcRenderer.removeListener('api:searchIndexEvent', listener)
    }
  },
  onBackupCleanupEvent: (cb: (r: unknown) => void): (() => void) => {
    const listener = (_e: unknown, r: unknown): void => cb(r)
    ipcRenderer.on('api:backupCleanupEvent', listener)
    return () => {
      ipcRenderer.removeListener('api:backupCleanupEvent', listener)
    }
  }
} as unknown as Api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
