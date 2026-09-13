import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type OpenDialogOptions, type OpenDialogReturnValue } from 'electron'
import type { AppSettings, DetectBackupDateRequest, ProcessSdCardRequest } from '../../shared/types'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { DriveService } from '../services/drive.service'
import type { OperationService } from '../services/operation.service'
import type { SettingsService } from '../services/settings.service'
import type { BackupService } from '../services/backup.service'
import { SdManagerError, toOperationError } from '../services/errors'

export interface IpcDependencies {
  driveService: DriveService
  backupService: BackupService
  operationService: OperationService
  settingsService: SettingsService
}

function showOpenDialogForSender(event: IpcMainInvokeEvent, options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  const parent = BrowserWindow.fromWebContents(event.sender)
  if (!parent || parent.isDestroyed()) {
    throw new SdManagerError('INVALID_REQUEST', '선택 창을 열 애플리케이션 창을 찾을 수 없습니다.')
  }
  return dialog.showOpenDialog(parent, options)
}

export function registerIpc({ driveService, backupService, operationService, settingsService }: IpcDependencies): void {
  ipcMain.handle(IPC_CHANNELS.driveList, () => driveService.listDrives())
  ipcMain.handle(IPC_CHANNELS.backupChooseRoot, async (event, defaultPath?: string) => {
    const initialPath = typeof defaultPath === 'string' && defaultPath.trim() ? defaultPath.trim() : undefined
    const result = await showOpenDialogForSender(event, {
      ...(initialPath ? { defaultPath: initialPath } : {}),
      properties: ['openDirectory', 'createDirectory'],
      title: '백업 경로 선택'
    })
    return result.canceled ? undefined : result.filePaths[0]
  })
  ipcMain.handle(IPC_CHANNELS.backupChooseSourceFolder, async (event, driveId: string) => {
    if (typeof driveId !== 'string' || !driveId) {
      throw new SdManagerError('INVALID_REQUEST', '원본 폴더를 선택할 SD 카드를 지정하세요.')
    }
    const drive = await driveService.inspectDrive(driveId)
    driveService.assertSafeRemovableDrive(drive)
    const result = await showOpenDialogForSender(event, {
      defaultPath: drive.mountPath,
      properties: ['openDirectory'],
      title: `${drive.driveLetter} 드라이브에서 백업할 폴더 선택`
    })
    if (result.canceled || !result.filePaths[0]) return undefined
    return backupService.relativeSourceFolder(drive, result.filePaths[0])
  })
  ipcMain.handle(IPC_CHANNELS.backupChooseSourceFiles, async (event, driveId: string) => {
    if (typeof driveId !== 'string' || !driveId) {
      throw new SdManagerError('INVALID_REQUEST', '원본 파일을 선택할 SD 카드를 지정하세요.')
    }
    const drive = await driveService.inspectDrive(driveId)
    driveService.assertSafeRemovableDrive(drive)
    const result = await showOpenDialogForSender(event, {
      defaultPath: drive.mountPath,
      properties: ['openFile', 'multiSelections'],
      title: `${drive.driveLetter} 드라이브에서 백업할 파일 선택`
    })
    if (result.canceled || result.filePaths.length === 0) return undefined
    return backupService.relativeSourceFiles(drive, result.filePaths)
  })
  ipcMain.handle(IPC_CHANNELS.backupDetectDate, async (_event, request: DetectBackupDateRequest) => {
    try {
      if (!request || typeof request.driveId !== 'string' || !request.driveId) {
        throw new SdManagerError('INVALID_REQUEST', '날짜를 확인할 SD 카드를 지정하세요.')
      }
      const drive = await driveService.inspectDrive(request.driveId)
      driveService.assertSafeRemovableDrive(drive)
      await backupService.assertBackupSelectionAvailable(drive, request.backupSelection)
      return { success: true, detected: await backupService.detectBackupDate(drive, request.backupSelection) }
    } catch (error) {
      return { success: false, error: toOperationError(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.settingsGet, () => settingsService.get())
  ipcMain.handle(IPC_CHANNELS.settingsSave, (_event, settings: AppSettings) => settingsService.save(settings))
  ipcMain.handle(IPC_CHANNELS.operationStart, (_event, request: ProcessSdCardRequest) => operationService.start(request))
  ipcMain.handle(IPC_CHANNELS.operationCancel, (_event, operationId: string) => operationService.cancel(operationId))
  ipcMain.handle(IPC_CHANNELS.operationList, () => operationService.list())
}
