export const IPC_CHANNELS = {
  driveList: 'drive:list',
  driveChanged: 'drive:changed',
  backupChooseRoot: 'backup:choose-root',
  backupChooseSourceFolder: 'backup:choose-source-folder',
  backupChooseSourceFiles: 'backup:choose-source-files',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  operationStart: 'operation:start',
  operationCancel: 'operation:cancel',
  operationList: 'operation:list',
  operationChanged: 'operation:changed'
} as const
