import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import { registerIpc } from './ipc/register-ipc'
import { WindowsDrivePlatform } from './platform/windows/drive.windows'
import { BackupService } from './services/backup.service'
import { BlackBoxConfigService } from './services/black-box-config.service'
import { DriveService } from './services/drive.service'
import { FormatService } from './services/format.service'
import { LoggerService } from './services/logger.service'
import { OperationService } from './services/operation.service'
import { SettingsService } from './services/settings.service'

let mainWindow: BrowserWindow | undefined
let drivePoller: NodeJS.Timeout | undefined

if (process.platform === 'linux') app.disableHardwareAcceleration()

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#f4f5f7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const showFallback = setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) window.show()
  }, 3000)
  window.once('ready-to-show', () => {
    clearTimeout(showFallback)
    window.show()
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer] load failed (${code}): ${description} - ${url}`)
    if (!window.isDestroyed()) window.show()
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[preload] failed: ${preloadPath}`, error)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] process gone', details)
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const loadRenderer = process.env.ELECTRON_RENDERER_URL
    ? window.loadURL(process.env.ELECTRON_RENDERER_URL)
    : window.loadFile(join(__dirname, '../renderer/index.html'))
  void loadRenderer.catch((error: unknown) => {
    console.error('[renderer] unable to load application', error)
    if (!window.isDestroyed()) window.show()
  })
  return window
}

void app.whenReady().then(() => {
  const platform = new WindowsDrivePlatform()
  const driveService = new DriveService(platform)
  const settingsService = new SettingsService(join(app.getPath('userData'), 'settings.json'))
  const logger = new LoggerService(join(app.getPath('userData'), 'logs', 'operations.jsonl'))
  const backupService = new BackupService()
  const formatService = new FormatService(platform, driveService)
  const blackBoxConfigRoot = app.isPackaged
    ? join(process.resourcesPath, 'b-box-config')
    : join(app.getAppPath(), 'src', 'main', 'platform', 'windows', 'b-box-config')
  const blackBoxConfigService = new BlackBoxConfigService(blackBoxConfigRoot)
  const operationService = new OperationService(driveService, backupService, formatService, blackBoxConfigService, logger, (operation) => {
    mainWindow?.webContents.send(IPC_CHANNELS.operationChanged, operation)
  })

  registerIpc({ driveService, backupService, operationService, settingsService })
  mainWindow = createWindow()

  let previousDriveSignature = ''
  drivePoller = setInterval(() => {
    void driveService
      .listDrives()
      .then((drives) => {
        const signature = JSON.stringify(
          drives.map((drive) => [drive.id, drive.filesystem, drive.capacityBytes, drive.freeBytes])
        )
        if (signature !== previousDriveSignature) {
          previousDriveSignature = signature
          mainWindow?.webContents.send(IPC_CHANNELS.driveChanged, drives)
        }
      })
      .catch(() => undefined)
  }, 2000)
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (drivePoller) clearInterval(drivePoller)
})
