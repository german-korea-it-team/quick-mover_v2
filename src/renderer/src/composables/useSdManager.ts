import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type {
  AppSettings,
  BackupDateMode,
  BackupFileFilter,
  BackupFolderSelection,
  BackupSelection,
  BackupTimeSlot,
  DetectedBackupDate,
  DeviceProfile,
  OperationError,
  ProcessSdCardRequest,
  RemovableDrive,
  SavedCardPreset,
  SdCardSettings,
  SdOperation
} from '../../../shared/types'
import { isValidBackupDate } from '../../../shared/backup-date'
import { normalizeVolumeLabel } from '../../../shared/volume-label'

export type BackupFolderMode = 'none' | BackupDateMode

export function useSdManager() {
  const drives = ref<RemovableDrive[]>([])
  const operations = ref<SdOperation[]>([])
  const profiles = reactive<Record<string, DeviceProfile | undefined>>({})
  const backupTimeSlots = reactive<Record<string, BackupTimeSlot>>({})
  const backupSelections = reactive<Record<string, BackupSelection | undefined>>({})
  const manualBackupDates = reactive<Record<string, string>>({})
  const detectedBackupDates = reactive<Record<string, DetectedBackupDate | undefined>>({})
  const detectingDateDriveId = ref<string>()
  const settings = reactive<AppSettings>({
    backupFavoritePaths: [],
    verificationMode: 'fast',
    cardSettings: {},
    savedCardPresets: []
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
        profiles[drive.id] = cardSettings.profile
        backupTimeSlots[drive.id] = cardSettings.backupTimeSlot ?? 'single'
        delete manualBackupDates[drive.id]
        delete detectedBackupDates[drive.id]
      } else {
        profiles[drive.id] ??= cardSettings.profile
        backupTimeSlots[drive.id] ??= cardSettings.backupTimeSlot ?? 'single'
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

  function backupDateModeForDrive(drive: RemovableDrive): BackupDateMode {
    return cardSettingsForDrive(drive).backupDateMode ?? 'auto'
  }

  function backupFolderModeForDrive(drive: RemovableDrive): BackupFolderMode {
    return createBackupFolderForDrive(drive) ? backupDateModeForDrive(drive) : 'none'
  }

  function backupDateForDrive(drive: RemovableDrive): string | undefined {
    if (!createBackupFolderForDrive(drive)) return undefined
    return backupDateModeForDrive(drive) === 'manual'
      ? manualBackupDates[drive.id]
      : detectedBackupDates[drive.id]?.date
  }

  function displayNameForDrive(drive: RemovableDrive): string {
    return cardSettingsForDrive(drive).displayName || ''
  }

  function formatVolumeLabelForDrive(drive: RemovableDrive): string | undefined {
    const label = normalizeVolumeLabel(cardSettingsForDrive(drive).formatVolumeLabel ?? '')
    return label || undefined
  }

  function cloneFolderSelection(selection: BackupFolderSelection): BackupFolderSelection {
    return {
      kind: 'folder',
      relativePath: selection.relativePath,
      fileFilter: selection.fileFilter,
      includeSourceFolder: selection.includeSourceFolder
    }
  }

  function clonePreset(preset: SavedCardPreset): SavedCardPreset {
    return {
      ...preset,
      ...(preset.backupSelection ? { backupSelection: cloneFolderSelection(preset.backupSelection) } : {})
    }
  }

  function settingsSnapshot(): AppSettings {
    return {
      backupFavoritePaths: [...settings.backupFavoritePaths],
      verificationMode: settings.verificationMode,
      cardSettings: Object.fromEntries(
        Object.entries(settings.cardSettings).map(([physicalDiskIdentifier, cardSettings]) => [
          physicalDiskIdentifier,
          {
            ...(cardSettings.displayName !== undefined ? { displayName: cardSettings.displayName } : {}),
            ...(cardSettings.formatVolumeLabel !== undefined ? { formatVolumeLabel: cardSettings.formatVolumeLabel } : {}),
            ...(cardSettings.backupRoot !== undefined ? { backupRoot: cardSettings.backupRoot } : {}),
            createBackupFolder: cardSettings.createBackupFolder ?? true,
            backupDateMode: cardSettings.backupDateMode ?? 'auto',
            ...(cardSettings.profile ? { profile: cardSettings.profile } : {}),
            backupTimeSlot: cardSettings.backupTimeSlot ?? 'single'
          }
        ])
      ),
      savedCardPresets: settings.savedCardPresets.map(clonePreset)
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

  async function setBackupFolderModeForDrive(drive: RemovableDrive, value: unknown): Promise<void> {
    if (value !== 'none' && value !== 'auto' && value !== 'manual') return
    const cardSettings = cardSettingsForDrive(drive)
    cardSettings.createBackupFolder = value !== 'none'
    if (value !== 'none') cardSettings.backupDateMode = value
    delete detectedBackupDates[drive.id]
    if (value !== 'manual') delete manualBackupDates[drive.id]
    await saveSettings()
  }

  function setManualBackupDateForDrive(drive: RemovableDrive, value: unknown): void {
    manualBackupDates[drive.id] = typeof value === 'string' ? value : ''
  }

  async function setProfileForDrive(drive: RemovableDrive, value: unknown): Promise<void> {
    if (value !== 'blackbox' && value !== 'gps') return
    profiles[drive.id] = value
    cardSettingsForDrive(drive).profile = value
    await saveSettings()
  }

  async function setBackupTimeSlotForDrive(drive: RemovableDrive, value: unknown): Promise<void> {
    if (value !== 'single' && value !== 'day' && value !== 'night') return
    backupTimeSlots[drive.id] = value
    cardSettingsForDrive(drive).backupTimeSlot = value
    await saveSettings()
  }

  async function chooseSourceFolder(drive: RemovableDrive): Promise<void> {
    error.value = undefined
    try {
      const relativePath = await window.sdManager.chooseSourceFolder(drive.id)
      if (!relativePath) return
      backupSelections[drive.id] = { kind: 'folder', relativePath, fileFilter: 'all', includeSourceFolder: false }
      delete detectedBackupDates[drive.id]
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
      delete detectedBackupDates[drive.id]
    } catch {
      error.value = { code: 'INVALID_REQUEST', message: '선택한 파일을 이 SD 카드의 백업 대상으로 사용할 수 없습니다.' }
    }
  }

  function clearBackupSelection(drive: RemovableDrive): void {
    delete backupSelections[drive.id]
    delete detectedBackupDates[drive.id]
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
    if (selection && (value === 'all' || value === 'mp4')) {
      selection.fileFilter = value
      delete detectedBackupDates[drive.id]
    }
  }

  function includesSourceFolderForDrive(drive: RemovableDrive): boolean {
    return folderSelectionForDrive(drive)?.includeSourceFolder ?? false
  }

  function setIncludesSourceFolderForDrive(drive: RemovableDrive, value: unknown): void {
    const selection = folderSelectionForDrive(drive)
    if (selection && typeof value === 'boolean') selection.includeSourceFolder = value
  }

  async function saveCardPreset(drive: RemovableDrive, name: string): Promise<boolean> {
    const profile = profiles[drive.id]
    const normalizedName = name.trim()
    if (!normalizedName || normalizedName.length > 80) {
      error.value = { code: 'INVALID_REQUEST', message: '저장 설정 이름을 1~80자로 입력하세요.' }
      return false
    }
    if (!profile || !backupRootForDrive(drive)) {
      error.value = { code: 'INVALID_REQUEST', message: '카드 종류와 백업 경로를 설정한 후 저장하세요.' }
      return false
    }
    const existingIndex = settings.savedCardPresets.findIndex(
      (preset) => preset.name.toLowerCase() === normalizedName.toLowerCase()
    )
    const folderSelection = folderSelectionForDrive(drive)
    const preset: SavedCardPreset = {
      id: existingIndex >= 0 ? settings.savedCardPresets[existingIndex]!.id : crypto.randomUUID(),
      name: normalizedName,
      ...(displayNameForDrive(drive) ? { displayName: displayNameForDrive(drive) } : {}),
      ...(formatVolumeLabelForDrive(drive) ? { formatVolumeLabel: formatVolumeLabelForDrive(drive) } : {}),
      profile,
      backupRoot: backupRootForDrive(drive),
      createBackupFolder: createBackupFolderForDrive(drive),
      backupDateMode: backupDateModeForDrive(drive),
      backupTimeSlot: backupTimeSlots[drive.id] ?? 'single',
      ...(folderSelection ? { backupSelection: cloneFolderSelection(folderSelection) } : {})
    }
    if (existingIndex >= 0) settings.savedCardPresets[existingIndex] = preset
    else settings.savedCardPresets.push(preset)
    await saveSettings()
    return !error.value
  }

  async function loadCardPreset(drive: RemovableDrive, preset: SavedCardPreset): Promise<void> {
    const cardSettings = cardSettingsForDrive(drive)
    cardSettings.displayName = preset.displayName
    cardSettings.formatVolumeLabel = preset.formatVolumeLabel
    cardSettings.backupRoot = preset.backupRoot
    cardSettings.createBackupFolder = preset.createBackupFolder
    cardSettings.backupDateMode = preset.backupDateMode
    cardSettings.profile = preset.profile
    cardSettings.backupTimeSlot = preset.backupTimeSlot
    profiles[drive.id] = preset.profile
    backupTimeSlots[drive.id] = preset.backupTimeSlot
    if (preset.backupSelection) backupSelections[drive.id] = cloneFolderSelection(preset.backupSelection)
    else delete backupSelections[drive.id]
    delete manualBackupDates[drive.id]
    delete detectedBackupDates[drive.id]
    await saveSettings()
  }

  async function removeCardPreset(presetId: string): Promise<void> {
    settings.savedCardPresets = settings.savedCardPresets.filter((preset) => preset.id !== presetId)
    await saveSettings()
  }

  async function saveSettings(): Promise<void> {
    error.value = undefined
    try {
      await window.sdManager.saveSettings(settingsSnapshot())
    } catch {
      error.value = { code: 'INTERNAL_ERROR', message: '설정을 저장하지 못했습니다.' }
    }
  }

  async function prepareStart(drive: RemovableDrive): Promise<boolean> {
    error.value = undefined
    if (!profiles[drive.id]) {
      error.value = { code: 'INVALID_REQUEST', message: '카드 종류를 선택하세요.' }
      return false
    }
    if (!createBackupFolderForDrive(drive)) return true
    if (backupDateModeForDrive(drive) === 'manual') {
      if (!isValidBackupDate(manualBackupDates[drive.id] ?? '')) {
        error.value = { code: 'INVALID_REQUEST', message: '상위 폴더에 사용할 날짜를 직접 선택하세요.' }
        return false
      }
      return true
    }
    detectingDateDriveId.value = drive.id
    try {
      const result = await window.sdManager.detectBackupDate({
        driveId: drive.id,
        ...(backupSelections[drive.id] ? { backupSelection: backupSelections[drive.id] } : {})
      })
      if (!result.success || !result.detected) {
        error.value = result.error ?? { code: 'BACKUP_FAILED', message: '첫 번째 영상 파일에서 날짜를 확인하지 못했습니다.' }
        return false
      }
      detectedBackupDates[drive.id] = result.detected
      return true
    } catch {
      error.value = { code: 'INTERNAL_ERROR', message: '첫 번째 영상 파일의 날짜를 확인하지 못했습니다.' }
      return false
    } finally {
      detectingDateDriveId.value = undefined
    }
  }

  async function start(drive: RemovableDrive, selectiveBackupConfirmed = false): Promise<boolean> {
    error.value = undefined
    const profile = profiles[drive.id]
    if (!profile) {
      error.value = { code: 'INVALID_REQUEST', message: '카드 종류를 선택하세요.' }
      return false
    }
    const backupSelection = backupSelections[drive.id]
    const request: ProcessSdCardRequest = {
      driveId: drive.id,
      displayName: displayNameForDrive(drive) || undefined,
      formatVolumeLabel: formatVolumeLabelForDrive(drive),
      profile,
      backupTimeSlot: backupTimeSlots[drive.id] ?? 'single',
      backupRoot: backupRootForDrive(drive),
      verificationMode: settings.verificationMode,
      createBackupFolder: createBackupFolderForDrive(drive),
      backupDateMode: backupDateModeForDrive(drive),
      backupDate: backupDateForDrive(drive),
      ...(backupSelection?.kind === 'folder'
        ? {
            backupSelection: cloneFolderSelection(backupSelection),
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
    Object.assign(settings, storedSettings, {
      cardSettings: storedSettings.cardSettings ?? {},
      savedCardPresets: storedSettings.savedCardPresets ?? []
    })
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
    manualBackupDates,
    detectedBackupDates,
    detectingDateDriveId,
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
    backupDateModeForDrive,
    backupFolderModeForDrive,
    backupDateForDrive,
    setBackupFolderModeForDrive,
    setManualBackupDateForDrive,
    setProfileForDrive,
    setBackupTimeSlotForDrive,
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
    saveCardPreset,
    loadCardPreset,
    removeCardPreset,
    saveSettings,
    prepareStart,
    start,
    cancel
  }
}
