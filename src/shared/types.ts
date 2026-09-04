export type DeviceProfile = 'blackbox' | 'gps'

export type VerificationMode = 'fast' | 'full'

export type BackupFileFilter = 'all' | 'mp4'

export type BackupTimeSlot = 'single' | 'day' | 'night'

export type BackupDateMode = 'auto' | 'manual'

export interface BackupFolderSelection {
  kind: 'folder'
  relativePath: string
  fileFilter: BackupFileFilter
  includeSourceFolder: boolean
}

export interface BackupFilesSelection {
  kind: 'files'
  relativePaths: string[]
}

export type BackupSelection = BackupFolderSelection | BackupFilesSelection

export type OperationState =
  | 'idle'
  | 'detecting'
  | 'ready'
  | 'queued'
  | 'backup-preparing'
  | 'backing-up'
  | 'backup-verifying'
  | 'formatting'
  | 'format-verifying'
  | 'installing-config'
  | 'config-verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type SdManagerErrorCode =
  | 'INVALID_REQUEST'
  | 'DRIVE_NOT_FOUND'
  | 'DRIVE_IDENTITY_CHANGED'
  | 'DRIVE_NOT_REMOVABLE'
  | 'PROTECTED_DRIVE'
  | 'BACKUP_DESTINATION_UNAVAILABLE'
  | 'BACKUP_DESTINATION_ON_SOURCE'
  | 'BACKUP_FAILED'
  | 'BACKUP_CANCELLED'
  | 'BACKUP_VERIFICATION_FAILED'
  | 'FORMAT_FAILED'
  | 'FORMAT_VERIFICATION_FAILED'
  | 'CONFIG_INSTALL_FAILED'
  | 'CONFIG_VERIFICATION_FAILED'
  | 'UNSUPPORTED_FILESYSTEM'
  | 'DEVICE_REMOVED'
  | 'PERMISSION_DENIED'
  | 'PLATFORM_UNSUPPORTED'
  | 'INTERNAL_ERROR'

export interface OperationError {
  code: SdManagerErrorCode
  message: string
  detail?: string
}

export interface RemovableDrive {
  id: string
  diskNumber: number
  partitionNumber: number
  driveLetter: string
  volumeLabel?: string
  filesystem?: string
  allocationUnitSize?: number
  capacityBytes: number
  freeBytes: number
  removable: boolean
  diskIdentifier: string
  volumeIdentifier: string
  physicalDiskIdentifier: string
  mountPath: string
  isSystem: boolean
  isBoot: boolean
}

export interface OperationProgress {
  processedFiles: number
  totalFiles: number
  copiedBytes: number
  totalBytes: number
  percent: number
  currentFile?: string
}

export interface SdOperation {
  id: string
  driveId: string
  driveLetter: string
  displayName?: string
  profile: DeviceProfile
  state: OperationState
  progress: OperationProgress
  backupDestination?: string
  startedAt?: string
  completedAt?: string
  error?: OperationError
}

export interface ProcessSdCardRequest {
  driveId: string
  displayName?: string
  formatVolumeLabel?: string
  profile: DeviceProfile
  backupTimeSlot: BackupTimeSlot
  backupRoot: string
  verificationMode: VerificationMode
  createBackupFolder: boolean
  backupDateMode: BackupDateMode
  backupDate?: string
  backupSelection?: BackupSelection
  selectiveBackupConfirmed?: boolean
}

export interface DetectBackupDateRequest {
  driveId: string
  backupSelection?: BackupSelection
}

export interface DetectedBackupDate {
  date: string
  sourceFile: string
}

export interface DetectBackupDateResult {
  success: boolean
  detected?: DetectedBackupDate
  error?: OperationError
}

export interface SdCardSettings {
  /** 앱에서만 사용하는 메모입니다. SD 카드의 볼륨 레이블이나 파일에는 적용되지 않습니다. */
  displayName?: string
  /** 포맷 완료 후 SD 카드에 적용할 볼륨 이름입니다. 비어 있으면 현재 볼륨 이름을 유지합니다. */
  formatVolumeLabel?: string
  /** 이 물리 SD 카드에 적용하는 백업 경로입니다. */
  backupRoot?: string
  /** 날짜 형식(yyyy-mm-dd)의 백업 폴더를 생성할지 여부입니다. */
  createBackupFolder?: boolean
  /** 상위 폴더 날짜를 영상 파일명에서 감지할지 직접 입력할지 결정합니다. */
  backupDateMode?: BackupDateMode
  profile?: DeviceProfile
  backupTimeSlot?: BackupTimeSlot
}

export interface SavedCardPreset {
  id: string
  name: string
  displayName?: string
  formatVolumeLabel?: string
  profile: DeviceProfile
  backupRoot: string
  createBackupFolder: boolean
  backupDateMode: BackupDateMode
  backupTimeSlot: BackupTimeSlot
  backupSelection?: BackupFolderSelection
}

export interface ProcessSdCardResult {
  success: boolean
  operationId?: string
  error?: OperationError
}

export interface CancelOperationResult {
  success: boolean
  error?: OperationError
}

export interface AppSettings {
  backupFavoritePaths: string[]
  verificationMode: VerificationMode
  cardSettings: Record<string, SdCardSettings>
  savedCardPresets: SavedCardPreset[]
}

export interface FormatOptions {
  filesystem: 'exFAT' | 'FAT32'
  allocationUnitSize?: 131072
  volumeLabel?: string
}

export interface FormatResult {
  filesystem: string
  allocationUnitSize?: number
}

export interface SdManagerApi {
  listDrives(): Promise<RemovableDrive[]>
  chooseBackupRoot(defaultPath?: string): Promise<string | undefined>
  chooseSourceFolder(driveId: string): Promise<string | undefined>
  chooseSourceFiles(driveId: string): Promise<string[] | undefined>
  detectBackupDate(request: DetectBackupDateRequest): Promise<DetectBackupDateResult>
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<void>
  startProcess(request: ProcessSdCardRequest): Promise<ProcessSdCardResult>
  cancelOperation(operationId: string): Promise<CancelOperationResult>
  getOperations(): Promise<SdOperation[]>
  onDrivesChanged(listener: (drives: RemovableDrive[]) => void): () => void
  onOperationChanged(listener: (operation: SdOperation) => void): () => void
}
