import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type {
  AppSettings,
  BackupFileFilter,
  BackupFolderSelection,
  BackupSelection,
  BackupTimeSlot,
  DeviceProfile,
  OperationError,
  ProcessSdCardRequest,
  RemovableDrive,
  SdCardSettings,
  SdOperation
} from '../../../shared/types'
import { normalizeVolumeLabel } from '../../../shared/volume-label'

export function useSdManager() {
  const drives = ref<RemovableDrive[]>([])
  const operations = ref<SdOperation[]>([])
  const profiles = reactive<Record<string, DeviceProfile>>({})
  const backupTimeSlots = reactive<Record<string, BackupTimeSlot>>({})
  const backupSelections = reactive<Record<string, BackupSelection | undefined>>({})
  const settings = reactive<AppSettings>({
    backupFavoritePaths: [],
    verificationMode: 'fast',
    cardSettings: {}
  })
  const loadingDrives = ref(false)
  const error = ref<OperationError>()

  const activeDriveIds = computed(
    () =>
      new Set(
        operations.value
          .filter((operation) => !['completed', 'failed', 'cancelled'].includes(operation.state))
          .map((operation) => operation.driveId)
      )
  )

  function applyDrives(nextDrives: RemovableDrive[]): void {
    const existingDriveIds = new Set(drives.value.map((drive) => drive.id))
    drives.value = nextDrives
    for (const drive of nextDrives) {
      const cardSettings = (settings.cardSettings[drive.physicalDiskIdentifier] ??= {})
      if (!existingDriveIds.has(drive.id)) {
        const filesystem = drive.filesystem?.toUpperCase()
        if (filesystem === 'FAT32') profiles[drive.id] = 'gps'
        else if (filesystem === 'EXFAT') profiles[drive.id] = 'blackbox'
        else profiles[drive.id] ??= 'blackbox'
        backupTimeSlots[drive.id] = 'single'
        delete cardSettings.displayName
        delete cardSettings.formatVolumeLabel
      } else {
        profiles[drive.id] ??= 'blackbox'
        backupTimeSlots[drive.id] ??= 'single'
      }
    }
  }

  function cardSettingsForDrive(drive: RemovableDrive): SdCardSettings {
    return (settings.cardSettings[drive.physicalDiskIdentifier] ??= {})
  }

  function backupRootForDrive(drive: RemovableDrive): string {
    return cardSettingsForDrive(drive).backupRoot || ''
  }

  function createBackupFolderForDrive(drive: RemovableDrive): boolean {
    return cardSettingsForDrive(drive).createBackupFolder ?? true
  }

  function displayNameForDrive(drive: RemovableDrive): string {
    return cardSettingsForDrive(drive).displayName || ''
  }

  function formatVolumeLabelForDrive(drive: RemovableDrive): string | undefined {
    const label = normalizeVolumeLabel(cardSettingsForDrive(drive).formatVolumeLabel ?? '')
    return label || undefined
  }

  function settingsSnapshot(): AppSettings {
    return {
      backupFavoritePaths: [...settings.backupFavoritePaths],
      verificationMode: settings.verificationMode,
      cardSettings: Object.fromEntries(
        Object.entries(settings.cardSettings).map(([physicalDiskIdentifier, cardSettings]) => [
          physicalDiskIdentifier,
          {
            ...(cardSettings.backupRoot !== undefined ? { backupRoot: cardSettings.backupRoot } : {}),
            createBackupFolder: cardSettings.createBackupFolder ?? true
          }
        ])
      )
    }
  }

  function applyOperation(nextOperation: SdOperation): void {
    const index = operations.value.findIndex((operation) => operation.id === nextOperation.id)
    if (index === -1) operations.value.push(nextOperation)
    else operations.value[index] = nextOperation
    if (nextOperation.state === 'completed') delete backupSelections[nextOperation.driveId]
  }

  async function refreshDrives(): Promise<void> {
    loadingDrives.value = true
    error.value = undefined
    try {
      applyDrives(await window.sdManager.listDrives())
    } catch {
      error.value = { code: 'INTERNAL_ERROR', message: '드라이브 목록을 불러오지 못했습니다.' }
    } finally {
      loadingDrives.value = false
    }
  }

  async function addBackupRootForDriveToFavorites(drive: RemovableDrive): Promise<void> {
    const path = backupRootForDrive(drive).trim()
    if (!path || settings.backupFavoritePaths.some((favorite) => favorite.toLowerCase() === path.toLowerCase())) return
    settings.backupFavoritePaths.push(path)
    await saveSettings()
  }

  async function removeBackupFavorite(path: string): Promise<void> {
    const key = path.toLowerCase()
    settings.backupFavoritePaths = settings.backupFavoritePaths.filter((favorite) => favorite.toLowerCase() !== key)
    await saveSettings()
  }

  async function chooseBackupRootForDrive(drive: RemovableDrive): Promise<void> {
    const selected = await window.sdManager.chooseBackupRoot(backupRootForDrive(drive) || undefined)
    if (!selected) return
    cardSettingsForDrive(drive).backupRoot = selected
    await saveSettings()
  }

  async function selectBackupFavoriteForDrive(drive: RemovableDrive, path: string): Promise<void> {
    cardSettingsForDrive(drive).backupRoot = path
    await saveSettings()
  }

  async function setCreateBackupFolderForDrive(drive: RemovableDrive, value: unknown): Promise<void> {
    if (typeof value !== 'boolean') return
    cardSettingsForDrive(drive).createBackupFolder = value
    await saveSettings()
  }

  async function chooseSourceFolder(drive: RemovableDrive): Promise<void> {
    error.value = undefined
    try {
      const relativePath = await window.sdManager.chooseSourceFolder(drive.id)
      if (!relativePath) return
      backupSelections[drive.id] = { kind: 'folder', relativePath, fileFilter: 'all', includeSourceFolder: false }
    } catch {
      error.value = { code: 'INVALID_REQUEST', message: '선택한 폴더를 이 SD 카드의 백업 대상으로 사용할 수 없습니다.' }
    }
  }

  async function chooseSourceFiles(drive: RemovableDrive): Promise<void> {
    error.value = undefined
    try {
      const relativePaths = await window.sdManager.chooseSourceFiles(drive.id)
      if (!relativePaths?.length) return
      backupSelections[drive.id] = { kind: 'files', relativePaths }
    } catch {
      error.value = { code: 'INVALID_REQUEST', message: '선택한 파일을 이 SD 카드의 백업 대상으로 사용할 수 없습니다.' }
    }
  }

  function clearBackupSelection(drive: RemovableDrive): void {
    delete backupSelections[drive.id]
  }

  function folderSelectionForDrive(drive: RemovableDrive): BackupFolderSelection | undefined {
    const selection = backupSelections[drive.id]
    return selection?.kind === 'folder' ? selection : undefined
  }

  function folderFileFilterForDrive(drive: RemovableDrive): BackupFileFilter {
    return folderSelectionForDrive(drive)?.fileFilter ?? 'all'
  }

  function setFolderFileFilterForDrive(drive: RemovableDrive, value: unknown): void {
    const selection = folderSelectionForDrive(drive)
    if (selection && (value === 'all' || value === 'mp4')) selection.fileFilter = value
  }

  function includesSourceFolderForDrive(drive: RemovableDrive): boolean {
    return folderSelectionForDrive(drive)?.includeSourceFolder ?? false
  }

  function setIncludesSourceFolderForDrive(drive: RemovableDrive, value: unknown): void {
    const selection = folderSelectionForDrive(drive)
    if (selection && typeof value === 'boolean') selection.includeSourceFolder = value
  }

  async function saveSettings(): Promise<void> {
    try {
      await window.sdManager.saveSettings(settingsSnapshot())
    } catch {
      error.value = { code: 'INTERNAL_ERROR', message: '설정을 저장하지 못했습니다.' }
    }
  }

  async function start(drive: RemovableDrive, selectiveBackupConfirmed = false): Promise<boolean> {
    error.value = undefined
    const backupSelection = backupSelections[drive.id]
    const request: ProcessSdCardRequest = {
      driveId: drive.id,
      displayName: displayNameForDrive(drive) || undefined,
      formatVolumeLabel: formatVolumeLabelForDrive(drive),
      profile: profiles[drive.id] ?? 'blackbox',
      backupTimeSlot: backupTimeSlots[drive.id] ?? 'single',
      backupRoot: backupRootForDrive(drive),
      verificationMode: settings.verificationMode,
      createBackupFolder: createBackupFolderForDrive(drive),
      ...(backupSelection?.kind === 'folder'
        ? {
            backupSelection: {
              kind: 'folder',
              relativePath: backupSelection.relativePath,
              fileFilter: backupSelection.fileFilter,
              includeSourceFolder: backupSelection.includeSourceFolder
            },
            selectiveBackupConfirmed
          }
        : backupSelection?.kind === 'files'
          ? {
              backupSelection: {
                kind: 'files',
                relativePaths: [...backupSelection.relativePaths]
              },
              selectiveBackupConfirmed
            }
          : {})
    }
    const result = await window.sdManager.startProcess(request)
    if (!result.success) {
      error.value = result.error
      return false
    }
    return true
  }

  async function cancel(operationId: string): Promise<void> {
    const result = await window.sdManager.cancelOperation(operationId)
    if (!result.success) error.value = result.error
  }

  let removeDriveListener: (() => void) | undefined
  let removeOperationListener: (() => void) | undefined

  onMounted(async () => {
    removeDriveListener = window.sdManager.onDrivesChanged(applyDrives)
    removeOperationListener = window.sdManager.onOperationChanged(applyOperation)
    const [storedSettings, storedOperations] = await Promise.all([
      window.sdManager.getSettings(),
      window.sdManager.getOperations()
    ])
    Object.assign(settings, storedSettings, { cardSettings: storedSettings.cardSettings ?? {} })
    operations.value = storedOperations
    await refreshDrives()
  })

  onUnmounted(() => {
    removeDriveListener?.()
    removeOperationListener?.()
  })

  return {
    drives,
    operations,
    profiles,
    backupTimeSlots,
    backupSelections,
    settings,
    loadingDrives,
    activeDriveIds,
    error,
    refreshDrives,
    addBackupRootForDriveToFavorites,
    removeBackupFavorite,
    chooseBackupRootForDrive,
    selectBackupFavoriteForDrive,
    createBackupFolderForDrive,
    setCreateBackupFolderForDrive,
    chooseSourceFolder,
    chooseSourceFiles,
    clearBackupSelection,
    cardSettingsForDrive,
    backupRootForDrive,
    displayNameForDrive,
    formatVolumeLabelForDrive,
    folderSelectionForDrive,
    folderFileFilterForDrive,
    setFolderFileFilterForDrive,
    includesSourceFolderForDrive,
    setIncludesSourceFolderForDrive,
    saveSettings,
    start,
    cancel
  }
}
