import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings, ProcessSdCardRequest, RemovableDrive, SdManagerApi, SdOperation } from '../shared/types'
import { IPC_CHANNELS } from '../shared/ipc'

const api: SdManagerApi = {
  listDrives: () => ipcRenderer.invoke(IPC_CHANNELS.driveList),
  chooseBackupRoot: (defaultPath?: string) => ipcRenderer.invoke(IPC_CHANNELS.backupChooseRoot, defaultPath),
  chooseSourceFolder: (driveId: string) => ipcRenderer.invoke(IPC_CHANNELS.backupChooseSourceFolder, driveId),
  chooseSourceFiles: (driveId: string) => ipcRenderer.invoke(IPC_CHANNELS.backupChooseSourceFiles, driveId),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke(IPC_CHANNELS.settingsSave, settings),
  startProcess: (request: ProcessSdCardRequest) => ipcRenderer.invoke(IPC_CHANNELS.operationStart, request),
  cancelOperation: (operationId: string) => ipcRenderer.invoke(IPC_CHANNELS.operationCancel, operationId),
  getOperations: () => ipcRenderer.invoke(IPC_CHANNELS.operationList),
  onDrivesChanged: (listener: (drives: RemovableDrive[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, drives: RemovableDrive[]): void => listener(drives)
    ipcRenderer.on(IPC_CHANNELS.driveChanged, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.driveChanged, handler)
  },
  onOperationChanged: (listener: (operation: SdOperation) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, operation: SdOperation): void => listener(operation)
    ipcRenderer.on(IPC_CHANNELS.operationChanged, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.operationChanged, handler)
  }
}

contextBridge.exposeInMainWorld('sdManager', api)
