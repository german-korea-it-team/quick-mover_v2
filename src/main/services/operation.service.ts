import { randomUUID } from 'node:crypto'
import type {
  BackupSelection,
  CancelOperationResult,
  ProcessSdCardRequest,
  ProcessSdCardResult,
  RemovableDrive,
  SdOperation
} from '../../shared/types'
import { BackupService } from './backup.service'
import { DriveService } from './drive.service'
import { SdManagerError, toOperationError } from './errors'
import { FormatService } from './format.service'
import { LoggerService } from './logger.service'
import { normalizeVolumeLabel, validateVolumeLabel } from '../../shared/volume-label'
import { BlackBoxConfigService } from './black-box-config.service'

interface QueueItem {
  operationId: string
  request: ProcessSdCardRequest
  selectedDrive: RemovableDrive
}

type OperationListener = (operation: SdOperation) => void

function initialProgress() {
  return { processedFiles: 0, totalFiles: 0, copiedBytes: 0, totalBytes: 0, percent: 0 }
}

function normalizeBackupSelection(selection: BackupSelection | undefined): BackupSelection | undefined {
  if (!selection) return undefined
  if (selection.kind === 'folder') {
    return {
      kind: 'folder',
      relativePath: selection.relativePath.trim(),
      fileFilter: selection.fileFilter,
      includeSourceFolder: selection.includeSourceFolder
    }
  }
  return {
    kind: 'files',
    relativePaths: selection.relativePaths.map((relativePath) => relativePath.trim())
  }
}

function validateRequest(request: ProcessSdCardRequest): void {
  if (!request || typeof request.driveId !== 'string' || request.driveId.length === 0) {
    throw new SdManagerError('INVALID_REQUEST', '처리할 SD 카드를 선택하세요.')
  }
  if (request.displayName !== undefined && (typeof request.displayName !== 'string' || request.displayName.length > 80)) {
    throw new SdManagerError('INVALID_REQUEST', '메모가 올바르지 않습니다.')
  }
  if (
    request.formatVolumeLabel !== undefined &&
    (typeof request.formatVolumeLabel !== 'string' || validateVolumeLabel(request.formatVolumeLabel))
  ) {
    throw new SdManagerError('INVALID_REQUEST', '볼륨 이름이 올바르지 않습니다.')
  }
  if (request.profile !== 'blackbox' && request.profile !== 'gps') {
    throw new SdManagerError('INVALID_REQUEST', '올바른 카드 종류를 선택하세요.')
  }
  if (!['single', 'day', 'night'].includes(request.backupTimeSlot)) {
    throw new SdManagerError('INVALID_REQUEST', '올바른 시간대를 선택하세요.')
  }
  if (typeof request.backupRoot !== 'string' || request.backupRoot.trim().length === 0) {
    throw new SdManagerError('BACKUP_DESTINATION_UNAVAILABLE', '백업 경로를 선택하세요.')
  }
  if (request.verificationMode !== 'fast' && request.verificationMode !== 'full') {
    throw new SdManagerError('INVALID_REQUEST', '올바른 백업 검증 모드를 선택하세요.')
  }
  if (typeof request.createBackupFolder !== 'boolean') {
    throw new SdManagerError('INVALID_REQUEST', '백업 폴더 생성 옵션이 올바르지 않습니다.')
  }
  if (request.backupSelection !== undefined) {
    if (!request.backupSelection || typeof request.backupSelection !== 'object') {
      throw new SdManagerError('INVALID_REQUEST', '선택 백업 범위가 올바르지 않습니다.')
    }
    if (request.backupSelection.kind === 'folder') {
      if (
        typeof request.backupSelection.relativePath !== 'string' ||
        request.backupSelection.relativePath.trim().length === 0 ||
        (request.backupSelection.fileFilter !== 'all' && request.backupSelection.fileFilter !== 'mp4') ||
        typeof request.backupSelection.includeSourceFolder !== 'boolean'
      ) {
        throw new SdManagerError('INVALID_REQUEST', '선택한 백업 폴더 범위가 올바르지 않습니다.')
      }
    } else if (
      request.backupSelection.kind !== 'files' ||
      !Array.isArray(request.backupSelection.relativePaths) ||
      request.backupSelection.relativePaths.length === 0 ||
      request.backupSelection.relativePaths.length > 10_000 ||
      request.backupSelection.relativePaths.some((relativePath) => typeof relativePath !== 'string' || !relativePath.trim())
    ) {
      throw new SdManagerError('INVALID_REQUEST', '선택한 백업 파일 범위가 올바르지 않습니다.')
    }
    if (request.selectiveBackupConfirmed !== true) {
      throw new SdManagerError('INVALID_REQUEST', '백업 제외 데이터 삭제에 동의해야 선택 백업을 시작할 수 있습니다.')
    }
  } else if (request.selectiveBackupConfirmed === true) {
    throw new SdManagerError('INVALID_REQUEST', '선택 백업 동의 정보와 백업 범위가 일치하지 않습니다.')
  }
}

export class OperationService {
  private readonly operations = new Map<string, SdOperation>()
  private readonly queue: QueueItem[] = []
  private readonly abortControllers = new Map<string, AbortController>()
  private draining = false

  constructor(
    private readonly driveService: DriveService,
    private readonly backupService: BackupService,
    private readonly formatService: FormatService,
    private readonly blackBoxConfigService: BlackBoxConfigService,
    private readonly logger: LoggerService,
    private readonly onChanged: OperationListener
  ) {}

  list(): SdOperation[] {
    return [...this.operations.values()].map((operation) => structuredClone(operation))
  }

  async start(request: ProcessSdCardRequest): Promise<ProcessSdCardResult> {
    try {
      validateRequest(request)
      const existing = [...this.operations.values()].find(
        (operation) => operation.driveId === request.driveId && !['completed', 'failed', 'cancelled'].includes(operation.state)
      )
      if (existing) throw new SdManagerError('INVALID_REQUEST', '이 SD 카드는 이미 처리 대기 중이거나 처리 중입니다.')

      const selectedDrive = await this.driveService.inspectDrive(request.driveId)
      this.driveService.assertSafeRemovableDrive(selectedDrive)
      if (request.profile === 'blackbox') await this.blackBoxConfigService.assertSourceAvailable()
      await this.backupService.assertBackupRootAvailable(request.backupRoot)
      this.backupService.assertBackupRootOutsideSource(selectedDrive.mountPath, request.backupRoot)
      await this.driveService.assertBackupDestinationIsDifferentDrive(selectedDrive, request.backupRoot)
      await this.backupService.assertBackupSelectionAvailable(selectedDrive, request.backupSelection)

      const operationId = randomUUID()
      const operation: SdOperation = {
        id: operationId,
        driveId: selectedDrive.id,
        driveLetter: selectedDrive.driveLetter,
        ...(request.displayName?.trim() ? { displayName: request.displayName.trim() } : {}),
        profile: request.profile,
        state: 'queued',
        progress: initialProgress()
      }
      await this.logger.write({
        event: 'OPERATION_QUEUED',
        operationId,
        driveId: selectedDrive.id,
        diskIdentifier: selectedDrive.diskIdentifier,
        driveLetter: selectedDrive.driveLetter,
        displayName: request.displayName?.trim() || undefined,
        profile: request.profile,
        backupTimeSlot: request.backupTimeSlot,
        backupSourceFolder: request.backupSelection?.kind === 'folder' ? request.backupSelection.relativePath : undefined,
        backupFileFilter: request.backupSelection?.kind === 'folder' ? request.backupSelection.fileFilter : undefined,
        backupSelectedFileCount: request.backupSelection?.kind === 'files' ? request.backupSelection.relativePaths.length : undefined,
        selectiveBackupConfirmed: request.backupSelection ? true : undefined
      })
      this.operations.set(operationId, operation)
      const backupSelection = normalizeBackupSelection(request.backupSelection)
      this.queue.push({
        operationId,
        request: {
          ...request,
          backupRoot: request.backupRoot.trim(),
          ...(backupSelection
            ? {
                backupSelection,
                selectiveBackupConfirmed: true
              }
            : {}),
          ...(request.formatVolumeLabel ? { formatVolumeLabel: normalizeVolumeLabel(request.formatVolumeLabel) } : {})
        },
        selectedDrive
      })
      this.publish(operation)
      void this.drainQueue()
      return { success: true, operationId }
    } catch (error) {
      return { success: false, error: toOperationError(error) }
    }
  }

  cancel(operationId: string): CancelOperationResult {
    const operation = this.operations.get(operationId)
    if (!operation) return { success: false, error: { code: 'INVALID_REQUEST', message: '작업을 찾을 수 없습니다.' } }
    if (!['queued', 'backup-preparing', 'backing-up'].includes(operation.state)) {
      return { success: false, error: { code: 'INVALID_REQUEST', message: '현재 단계에서는 안전하게 취소할 수 없습니다.' } }
    }
    if (operation.state === 'queued') {
      operation.state = 'cancelled'
      operation.completedAt = new Date().toISOString()
      this.publish(operation)
    } else {
      this.abortControllers.get(operationId)?.abort()
    }
    return { success: true }
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      let item = this.queue.shift()
      while (item) {
        const operation = this.operations.get(item.operationId)
        if (operation?.state !== 'cancelled') await this.runOperation(item)
        item = this.queue.shift()
      }
    } finally {
      this.draining = false
    }
  }

  private async runOperation(item: QueueItem): Promise<void> {
    const operation = this.operations.get(item.operationId)
    if (!operation) return
    const abortController = new AbortController()
    this.abortControllers.set(operation.id, abortController)
    operation.startedAt = new Date().toISOString()

    try {
      this.setState(operation, 'backup-preparing')
      const currentBeforeBackup = await this.driveService.inspectDrive(item.selectedDrive.id)
      this.driveService.assertSafeRemovableDrive(currentBeforeBackup)
      this.driveService.assertSameDrive(item.selectedDrive, currentBeforeBackup)

      this.setState(operation, 'backing-up')
      const backup = await this.backupService.backup(
        currentBeforeBackup,
        item.request.backupRoot,
        item.request.backupTimeSlot,
        item.request.createBackupFolder,
        item.request.backupSelection,
        abortController.signal,
        (progress) => {
          operation.progress = progress
          this.publish(operation)
        }
      )
      operation.backupDestination = backup.destination
      await this.logger.write({
        event: 'BACKUP_COMPLETE',
        operationId: operation.id,
        diskIdentifier: item.selectedDrive.diskIdentifier,
        backupDestination: backup.destination,
        result: 'success'
      })

      this.setState(operation, 'backup-verifying')
      const currentBeforeVerification = await this.driveService.inspectDrive(item.selectedDrive.id)
      this.driveService.assertSameDrive(item.selectedDrive, currentBeforeVerification)
      await this.backupService.verify(currentBeforeVerification.mountPath, backup, item.request.verificationMode)
      await this.logger.write({ event: 'BACKUP_VERIFICATION_COMPLETE', operationId: operation.id, result: 'success' })

      this.setState(operation, 'formatting')
      const formattedDrive = await this.formatService.formatAndVerify(
        item.selectedDrive,
        item.request.profile,
        item.request.backupRoot,
        item.request.formatVolumeLabel,
        async (current, options) => {
          await this.logger.write({
            event: 'FORMAT_START',
            operationId: operation.id,
            driveId: current.id,
            diskIdentifier: current.diskIdentifier,
            driveLetter: current.driveLetter,
            displayName: operation.displayName,
            profile: item.request.profile,
            filesystem: options.filesystem,
            allocationUnitSize: options.allocationUnitSize,
            volumeLabel: options.volumeLabel
          })
        },
        () => this.setState(operation, 'format-verifying')
      )

      if (item.request.profile === 'blackbox') {
        this.setState(operation, 'installing-config')
        const currentBeforeConfig = await this.driveService.findCurrentPartition(item.selectedDrive)
        this.driveService.assertSafeRemovableDrive(currentBeforeConfig)
        if (currentBeforeConfig.physicalDiskIdentifier !== formattedDrive.physicalDiskIdentifier) {
          throw new SdManagerError('DRIVE_IDENTITY_CHANGED', '설정 파일 복사 전 장치 식별 정보가 변경되었습니다.')
        }
        const configInstall = await this.blackBoxConfigService.install(currentBeforeConfig.mountPath)
        await this.logger.write({
          event: 'BLACKBOX_CONFIG_INSTALLED',
          operationId: operation.id,
          diskIdentifier: currentBeforeConfig.diskIdentifier,
          result: 'success'
        })

        this.setState(operation, 'config-verifying')
        await this.blackBoxConfigService.verify(configInstall)
        await this.logger.write({
          event: 'BLACKBOX_CONFIG_VERIFICATION_COMPLETE',
          operationId: operation.id,
          result: 'success'
        })
      }

      operation.state = 'completed'
      operation.progress.percent = 100
      operation.completedAt = new Date().toISOString()
      await this.logger.write({ event: 'OPERATION_COMPLETE', operationId: operation.id, result: 'success' })
      this.publish(operation)
    } catch (error) {
      const operationError = toOperationError(error)
      if (operationError.code === 'DRIVE_NOT_FOUND') {
        operationError.code = 'DEVICE_REMOVED'
        operationError.message = '작업 중 SD 카드가 제거되었습니다.'
      }
      operation.state = operationError.code === 'BACKUP_CANCELLED' ? 'cancelled' : 'failed'
      operation.error = operationError
      operation.completedAt = new Date().toISOString()
      await this.logger
        .write({ event: 'OPERATION_FAILED', operationId: operation.id, result: 'failed', errorCode: operationError.code })
        .catch(() => undefined)
      this.publish(operation)
    } finally {
      this.abortControllers.delete(operation.id)
    }
  }

  private setState(operation: SdOperation, state: SdOperation['state']): void {
    operation.state = state
    this.publish(operation)
  }

  private publish(operation: SdOperation): void {
    this.onChanged(structuredClone(operation))
  }
}
