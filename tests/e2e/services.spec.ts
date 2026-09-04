import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from '@playwright/test'
import { BackupService } from '../../src/main/services/backup.service'
import { BlackBoxConfigService } from '../../src/main/services/black-box-config.service'
import { DriveService } from '../../src/main/services/drive.service'
import { FormatService } from '../../src/main/services/format.service'
import { LoggerService } from '../../src/main/services/logger.service'
import { OperationService } from '../../src/main/services/operation.service'
import { SdManagerError } from '../../src/main/services/errors'
import { buildPowerShellCommand } from '../../src/main/platform/windows/powershell'
import type { ProcessSdCardRequest, SdOperation } from '../../src/shared/types'
import { createMockDrive, MockDrivePlatform } from '../fixtures/mock-drive-platform'

async function waitForTerminal(operations: SdOperation[], expectedCount: number): Promise<void> {
  await expect
    .poll(() => operations.filter((operation) => ['completed', 'failed', 'cancelled'].includes(operation.state)).length)
    .toBe(expectedCount)
}

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'quick-mover-test-'))
  const source = join(root, 'source')
  const backupRoot = join(root, 'backup')
  const configRoot = join(root, 'b-box-config')
  await mkdir(join(source, 'DCIM'), { recursive: true })
  await mkdir(backupRoot)
  await mkdir(join(configRoot, 'Parameter'), { recursive: true })
  await mkdir(join(configRoot, 'Driving'), { recursive: true })
  await mkdir(join(configRoot, 'Event'), { recursive: true })
  await mkdir(join(configRoot, 'Manual'), { recursive: true })
  await mkdir(join(configRoot, 'Parking'), { recursive: true })
  await writeFile(join(configRoot, 'Driving', '.quick-mover-directory'), 'packaging marker')
  await writeFile(join(configRoot, 'Event', '.quick-mover-directory'), 'packaging marker')
  await writeFile(join(configRoot, 'Manual', '.quick-mover-directory'), 'packaging marker')
  await writeFile(join(configRoot, 'Parking', '.quick-mover-directory'), 'packaging marker')
  await writeFile(join(source, 'DCIM', 'video.dat'), Buffer.from('verified source data'))
  await writeFile(join(configRoot, 'Parameter', 'config.txt'), Buffer.from('blackbox config'))
  await writeFile(join(configRoot, 'Parameter', 'park_impact.ini'), Buffer.from('impact config'))
  const drive = createMockDrive({ mountPath: source })
  const platform = new MockDrivePlatform([drive])
  const driveService = new DriveService(platform)
  const backupService = new BackupService()
  const formatService = new FormatService(platform, driveService)
  const blackBoxConfigService = new BlackBoxConfigService(configRoot)
  const logger = new LoggerService(join(root, 'operations.jsonl'))
  const changes: SdOperation[] = []
  const operationService = new OperationService(driveService, backupService, formatService, blackBoxConfigService, logger, (operation) => {
    const index = changes.findIndex((item) => item.id === operation.id)
    if (index === -1) changes.push(operation)
    else changes[index] = operation
  })
  return {
    root,
    source,
    backupRoot,
    configRoot,
    drive,
    platform,
    driveService,
    backupService,
    formatService,
    blackBoxConfigService,
    logger,
    changes,
    operationService
  }
}

function request(driveId: string, backupRoot: string, profile: 'blackbox' | 'gps' = 'blackbox'): ProcessSdCardRequest {
  return {
    driveId,
    backupRoot,
    profile,
    backupTimeSlot: 'single',
    verificationMode: 'fast',
    createBackupFolder: true,
    backupDateMode: 'manual',
    backupDate: '2026-09-01'
  }
}

test('PowerShell 인자를 스크립트 블록의 $args로 안전하게 전달한다', () => {
  const command = buildPowerShellCommand('$letter = $args[0]', ['E', "black'box", ''])

  expect(command).toContain("$quickMoverArguments = @('E', 'black''box', '')")
  expect(command).toContain('& {')
  expect(command).toContain('$letter = $args[0]')
  expect(command).toContain('} @quickMoverArguments')
})

test('블랙박스는 백업 검증 후 exFAT 128 KB로 포맷하고 검증한다', async () => {
  const harness = await createHarness()
  try {
    const result = await harness.operationService.start(request(harness.drive.id, harness.backupRoot))
    expect(result.success).toBe(true)
    await waitForTerminal(harness.changes, 1)
    expect(harness.changes[0]?.state).toBe('completed')
    expect(harness.platform.formatRequests).toHaveLength(1)
    expect(harness.platform.formatRequests[0]?.options).toEqual({ filesystem: 'exFAT', allocationUnitSize: 131072, volumeLabel: 'SD_CARD' })
    expect(await readFile(join(harness.source, 'Parameter', 'config.txt'), 'utf8')).toBe('blackbox config')
    expect(await readFile(join(harness.source, 'Parameter', 'park_impact.ini'), 'utf8')).toBe('impact config')
    for (const directory of ['Driving', 'Event', 'Manual', 'Parking']) {
      expect((await stat(join(harness.source, directory))).isDirectory()).toBe(true)
      await expect(stat(join(harness.source, directory, '.quick-mover-directory'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('System Volume Information은 사용자 백업에 포함하지 않는다', async () => {
  const harness = await createHarness()
  try {
    const systemVolumeInformation = join(harness.source, 'System Volume Information')
    await mkdir(systemVolumeInformation)
    await writeFile(join(systemVolumeInformation, 'IndexerVolumeGuid'), 'Windows metadata')

    await harness.operationService.start(request(harness.drive.id, harness.backupRoot, 'gps'))
    await waitForTerminal(harness.changes, 1)

    expect(harness.changes[0]?.state).toBe('completed')
    const backupDestination = harness.changes[0]?.backupDestination
    expect(backupDestination).toBeTruthy()
    await expect(stat(join(backupDestination!, 'System Volume Information'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(backupDestination!, 'DCIM', 'video.dat'), 'utf8')).toBe('verified source data')
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('선택한 Driving 폴더 이름은 제외하고 MP4 파일의 하위 구조를 유지해 백업한다', async () => {
  const harness = await createHarness()
  try {
    await mkdir(join(harness.source, 'Driving', 'Event'), { recursive: true })
    await mkdir(join(harness.source, 'Other'), { recursive: true })
    await writeFile(join(harness.source, 'Driving', 'front.mp4'), 'front video')
    await writeFile(join(harness.source, 'Driving', 'Event', 'impact.MP4'), 'impact video')
    await writeFile(join(harness.source, 'Driving', 'notes.txt'), 'not selected')
    await writeFile(join(harness.source, 'Other', 'outside.mp4'), 'outside selection')
    const selectiveRequest = request(harness.drive.id, harness.backupRoot, 'gps')
    selectiveRequest.backupSelection = { kind: 'folder', relativePath: 'Driving', fileFilter: 'mp4', includeSourceFolder: false }
    selectiveRequest.selectiveBackupConfirmed = true

    await harness.operationService.start(selectiveRequest)
    await waitForTerminal(harness.changes, 1)

    expect(harness.changes[0]?.state).toBe('completed')
    const destination = harness.changes[0]?.backupDestination
    expect(await readFile(join(destination!, 'front.mp4'), 'utf8')).toBe('front video')
    expect(await readFile(join(destination!, 'Event', 'impact.MP4'), 'utf8')).toBe('impact video')
    await expect(stat(join(destination!, 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(destination!, 'Other', 'outside.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(harness.platform.formatRequests).toHaveLength(1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('선택 폴더 이름 포함 옵션을 켜면 Driving 폴더부터 백업한다', async () => {
  const harness = await createHarness()
  try {
    await mkdir(join(harness.source, 'Driving'))
    await writeFile(join(harness.source, 'Driving', 'front.mp4'), 'front video')
    const selectiveRequest = request(harness.drive.id, harness.backupRoot, 'gps')
    selectiveRequest.backupSelection = { kind: 'folder', relativePath: 'Driving', fileFilter: 'mp4', includeSourceFolder: true }
    selectiveRequest.selectiveBackupConfirmed = true

    await harness.operationService.start(selectiveRequest)
    await waitForTerminal(harness.changes, 1)

    expect(harness.changes[0]?.state).toBe('completed')
    const destination = harness.changes[0]?.backupDestination
    expect(await readFile(join(destination!, 'Driving', 'front.mp4'), 'utf8')).toBe('front video')
    expect(harness.platform.formatRequests).toHaveLength(1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('탐색기에서 선택한 여러 파일만 백업 작업 폴더 바로 아래에 복사한다', async () => {
  const harness = await createHarness()
  try {
    await mkdir(join(harness.source, 'Driving'))
    await writeFile(join(harness.source, 'Driving', 'front.mp4'), 'front video')
    await writeFile(join(harness.source, 'Driving', 'rear.mp4'), 'rear video')
    await writeFile(join(harness.source, 'Driving', 'not-selected.mp4'), 'not selected')
    const selectiveRequest = request(harness.drive.id, harness.backupRoot, 'gps')
    selectiveRequest.backupSelection = {
      kind: 'files',
      relativePaths: [join('Driving', 'front.mp4'), join('Driving', 'rear.mp4')]
    }
    selectiveRequest.selectiveBackupConfirmed = true

    await harness.operationService.start(selectiveRequest)
    await waitForTerminal(harness.changes, 1)

    expect(harness.changes[0]?.state).toBe('completed')
    const destination = harness.changes[0]?.backupDestination
    expect(await readFile(join(destination!, 'front.mp4'), 'utf8')).toBe('front video')
    expect(await readFile(join(destination!, 'rear.mp4'), 'utf8')).toBe('rear video')
    await expect(stat(join(destination!, 'not-selected.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(harness.platform.formatRequests).toHaveLength(1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('선택 백업은 제외 데이터 삭제 동의 없이 시작할 수 없다', async () => {
  const harness = await createHarness()
  try {
    await mkdir(join(harness.source, 'Driving'))
    await writeFile(join(harness.source, 'Driving', 'front.mp4'), 'front video')
    const selectiveRequest = request(harness.drive.id, harness.backupRoot, 'gps')
    selectiveRequest.backupSelection = { kind: 'folder', relativePath: 'Driving', fileFilter: 'mp4', includeSourceFolder: false }

    const result = await harness.operationService.start(selectiveRequest)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_REQUEST')
    expect(harness.platform.formatRequests).toHaveLength(0)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('SD 카드 밖을 가리키는 선택 백업 경로를 거부한다', async () => {
  const harness = await createHarness()
  try {
    const selectiveRequest = request(harness.drive.id, harness.backupRoot, 'gps')
    selectiveRequest.backupSelection = { kind: 'folder', relativePath: '..', fileFilter: 'all', includeSourceFolder: false }
    selectiveRequest.selectiveBackupConfirmed = true

    const result = await harness.operationService.start(selectiveRequest)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_REQUEST')
    expect(harness.platform.formatRequests).toHaveLength(0)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('선택한 폴더에 조건과 일치하는 파일이 없으면 포맷하지 않는다', async () => {
  const harness = await createHarness()
  try {
    await mkdir(join(harness.source, 'Driving'))
    await writeFile(join(harness.source, 'Driving', 'notes.txt'), 'not an mp4')
    const selectiveRequest = request(harness.drive.id, harness.backupRoot, 'gps')
    selectiveRequest.backupSelection = { kind: 'folder', relativePath: 'Driving', fileFilter: 'mp4', includeSourceFolder: false }
    selectiveRequest.selectiveBackupConfirmed = true

    await harness.operationService.start(selectiveRequest)
    await waitForTerminal(harness.changes, 1)

    expect(harness.changes[0]?.error?.code).toBe('BACKUP_FAILED')
    expect(harness.platform.formatRequests).toHaveLength(0)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('GPS는 FAT32와 Windows 기본 할당 단위를 요청한다', async () => {
  const harness = await createHarness()
  try {
    await harness.operationService.start(request(harness.drive.id, harness.backupRoot, 'gps'))
    await waitForTerminal(harness.changes, 1)
    expect(harness.changes[0]?.state).toBe('completed')
    expect(harness.platform.formatRequests[0]?.options.filesystem).toBe('FAT32')
    expect(harness.platform.formatRequests[0]?.options.allocationUnitSize).toBeUndefined()
    expect(harness.platform.formatRequests[0]?.options.volumeLabel).toBe('SD_CARD')
    await expect(readFile(join(harness.source, 'Parameter', 'config.txt'), 'utf8')).rejects.toThrow()
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('사용자 지정 카드 이름을 포맷 옵션으로 전달하고 검증한다', async () => {
  const harness = await createHarness()
  try {
    const customRequest = request(harness.drive.id, harness.backupRoot)
    customRequest.formatVolumeLabel = 'CAR-12'
    await harness.operationService.start(customRequest)
    await waitForTerminal(harness.changes, 1)
    expect(harness.changes[0]?.state).toBe('completed')
    expect(harness.platform.formatRequests[0]?.options.volumeLabel).toBe('CAR-12')
    expect(harness.platform.drives[0]?.volumeLabel).toBe('CAR-12')
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('고정·시스템·백업 대상과 동일한 드라이브를 거부한다', async () => {
  const harness = await createHarness()
  try {
    harness.drive.removable = false
    let result = await harness.operationService.start(request(harness.drive.id, harness.backupRoot))
    expect(result.error?.code).toBe('DRIVE_NOT_REMOVABLE')

    harness.drive.removable = true
    harness.drive.isSystem = true
    result = await harness.operationService.start(request(harness.drive.id, harness.backupRoot))
    expect(result.error?.code).toBe('PROTECTED_DRIVE')

    harness.drive.isSystem = false
    harness.platform.backupDiskIdentifier = harness.drive.physicalDiskIdentifier
    result = await harness.operationService.start(request(harness.drive.id, harness.backupRoot))
    expect(result.error?.code).toBe('BACKUP_DESTINATION_ON_SOURCE')
    expect(harness.platform.formatRequests).toHaveLength(0)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('백업 검증 실패 시 포맷하지 않는다', async () => {
  const harness = await createHarness()
  try {
    class FailingVerificationBackupService extends BackupService {
      override async verify(): Promise<void> {
        throw new SdManagerError('BACKUP_VERIFICATION_FAILED', '검증 실패')
      }
    }
    const operationService = new OperationService(
      harness.driveService,
      new FailingVerificationBackupService(),
      harness.formatService,
      harness.blackBoxConfigService,
      harness.logger,
      (operation) => {
        const index = harness.changes.findIndex((item) => item.id === operation.id)
        if (index === -1) harness.changes.push(operation)
        else harness.changes[index] = operation
      }
    )
    await operationService.start(request(harness.drive.id, harness.backupRoot))
    await waitForTerminal(harness.changes, 1)
    expect(harness.changes[0]?.error?.code).toBe('BACKUP_VERIFICATION_FAILED')
    expect(harness.platform.formatRequests).toHaveLength(0)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('블랙박스 설정 원본이 없으면 작업 시작과 포맷을 거부한다', async () => {
  const harness = await createHarness()
  try {
    const operationService = new OperationService(
      harness.driveService,
      harness.backupService,
      harness.formatService,
      new BlackBoxConfigService(join(harness.root, 'missing-config')),
      harness.logger,
      (operation) => {
        const index = harness.changes.findIndex((item) => item.id === operation.id)
        if (index === -1) harness.changes.push(operation)
        else harness.changes[index] = operation
      }
    )
    const result = await operationService.start(request(harness.drive.id, harness.backupRoot))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('CONFIG_INSTALL_FAILED')
    expect(harness.changes).toHaveLength(0)
    expect(harness.platform.formatRequests).toHaveLength(0)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('포맷 직전 장치 ID 변경을 감지하고 포맷하지 않는다', async () => {
  const harness = await createHarness()
  try {
    let inspections = 0
    const originalInspect = harness.platform.inspectDrive.bind(harness.platform)
    harness.platform.inspectDrive = async (id: string) => {
      inspections += 1
      const inspected = await originalInspect(id)
      if (inspections >= 4) inspected.physicalDiskIdentifier = 'REPLACED-DISK'
      return inspected
    }
    await harness.operationService.start(request(harness.drive.id, harness.backupRoot))
    await waitForTerminal(harness.changes, 1)
    expect(harness.changes[0]?.error?.code).toBe('DRIVE_IDENTITY_CHANGED')
    expect(harness.platform.formatRequests).toHaveLength(0)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('블랙박스 포맷 후 128 KB 할당 단위가 아니면 실패한다', async () => {
  const harness = await createHarness()
  try {
    harness.platform.formattedAllocationUnitSize = 65536
    await harness.operationService.start(request(harness.drive.id, harness.backupRoot))
    await waitForTerminal(harness.changes, 1)
    expect(harness.changes[0]?.error?.code).toBe('FORMAT_VERIFICATION_FAILED')
    expect(harness.changes[0]?.state).toBe('failed')
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('GPS 포맷 결과가 FAT32가 아니면 대체하지 않고 실패한다', async () => {
  const harness = await createHarness()
  try {
    harness.platform.formattedFilesystem = 'exFAT'
    await harness.operationService.start(request(harness.drive.id, harness.backupRoot, 'gps'))
    await waitForTerminal(harness.changes, 1)
    expect(harness.changes[0]?.error?.code).toBe('FORMAT_VERIFICATION_FAILED')
    expect(harness.platform.formatRequests).toHaveLength(1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('Windows 포맷 실패를 성공으로 표시하지 않는다', async () => {
  const harness = await createHarness()
  try {
    harness.platform.formatError = new SdManagerError('FORMAT_FAILED', 'FAT32 포맷 제한')
    await harness.operationService.start(request(harness.drive.id, harness.backupRoot, 'gps'))
    await waitForTerminal(harness.changes, 1)
    expect(harness.changes[0]?.error?.code).toBe('FORMAT_FAILED')
    expect(harness.changes[0]?.state).toBe('failed')
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('백업 준비 중 장치가 제거되면 DEVICE_REMOVED로 실패하고 포맷하지 않는다', async () => {
  const harness = await createHarness()
  try {
    harness.drive.mountPath = join(harness.root, 'removed-card')
    await harness.operationService.start(request(harness.drive.id, harness.backupRoot))
    await waitForTerminal(harness.changes, 1)
    expect(harness.changes[0]?.error?.code).toBe('DEVICE_REMOVED')
    expect(harness.platform.formatRequests).toHaveLength(0)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('백업 폴더 생성 시 yyyy-mm-dd 폴더 하나만 만든다', async () => {
  const harness = await createHarness()
  try {
    await harness.operationService.start(request(harness.drive.id, harness.backupRoot))
    await waitForTerminal(harness.changes, 1)
    expect(harness.changes[0]?.state).toBe('completed')
    const destination = harness.changes[0]?.backupDestination ?? ''
    expect(basename(destination)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(dirname(destination)).toBe(harness.backupRoot)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('주간 백업은 yyyy-mm-dd 폴더 안의 1 폴더를 사용한다', async () => {
  const harness = await createHarness()
  try {
    const dayRequest = request(harness.drive.id, harness.backupRoot)
    dayRequest.backupTimeSlot = 'day'
    await harness.operationService.start(dayRequest)
    await waitForTerminal(harness.changes, 1)
    const destination = harness.changes[0]?.backupDestination ?? ''
    expect(basename(destination)).toBe('1')
    expect(basename(dirname(destination))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(dirname(dirname(destination))).toBe(harness.backupRoot)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('폴더 생성 없이 백업 경로에 원본 내부 파일을 바로 복사한다', async () => {
  const harness = await createHarness()
  try {
    const directRequest = request(harness.drive.id, harness.backupRoot)
    directRequest.createBackupFolder = false
    await harness.operationService.start(directRequest)
    await waitForTerminal(harness.changes, 1)
    expect(harness.changes[0]?.state).toBe('completed')
    expect(harness.changes[0]?.backupDestination).toBe(harness.backupRoot)
    expect(await readFile(join(harness.backupRoot, 'DCIM', 'video.dat'), 'utf8')).toBe('verified source data')
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('폴더 없는 복사에서 같은 이름이 있으면 _1, _2를 붙이고 기존 파일을 보존한다', async () => {
  const harness = await createHarness()
  try {
    await mkdir(join(harness.backupRoot, 'DCIM'))
    const existingPath = join(harness.backupRoot, 'DCIM', 'video.dat')
    const existingSuffixPath = join(harness.backupRoot, 'DCIM', 'video_1.dat')
    await writeFile(existingPath, 'existing backup')
    await writeFile(existingSuffixPath, 'existing suffix backup')
    const directRequest = request(harness.drive.id, harness.backupRoot)
    directRequest.createBackupFolder = false
    await harness.operationService.start(directRequest)
    await waitForTerminal(harness.changes, 1)
    expect(harness.changes[0]?.state).toBe('completed')
    expect(await readFile(existingPath, 'utf8')).toBe('existing backup')
    expect(await readFile(existingSuffixPath, 'utf8')).toBe('existing suffix backup')
    expect(await readFile(join(harness.backupRoot, 'DCIM', 'video_2.dat'), 'utf8')).toBe('verified source data')
    expect(harness.platform.formatRequests).toHaveLength(1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('FIFO에서 한 작업이 실패해도 다음 카드를 처리한다', async () => {
  const harness = await createHarness()
  try {
    const missingDrive = createMockDrive({
      id: 'PHYSICAL-2::VOLUME-2::1',
      physicalDiskIdentifier: 'PHYSICAL-2',
      diskIdentifier: 'PHYSICAL-2|SERIAL-2',
      volumeIdentifier: 'VOLUME-2',
      diskNumber: 5,
      driveLetter: 'F:',
      mountPath: join(harness.root, 'missing')
    })
    harness.platform.drives.unshift(missingDrive)
    await harness.operationService.start(request(missingDrive.id, harness.backupRoot))
    await harness.operationService.start(request(harness.drive.id, harness.backupRoot, 'gps'))
    await waitForTerminal(harness.changes, 2)
    expect(harness.changes.find((operation) => operation.driveLetter === 'F:')?.state).toBe('failed')
    expect(harness.changes.find((operation) => operation.driveLetter === 'E:')?.state).toBe('completed')
    expect(harness.platform.formatRequests).toHaveLength(1)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})
