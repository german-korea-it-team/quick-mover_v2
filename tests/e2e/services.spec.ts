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
    expect(harness.platform.formatRequests[0]?.options).toEqual({ filesystem: 'exFAT', allocationUnitSize: 131072 })
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

test('선택한 폴더 이름은 제외하고 모든 파일의 하위 구조를 유지해 백업한다', async () => {
  const harness = await createHarness()
  try {
    await mkdir(join(harness.source, 'Driving', 'Event'), { recursive: true })
    await mkdir(join(harness.source, 'Other'), { recursive: true })
    await writeFile(join(harness.source, 'Driving', 'front.mp4'), 'front video')
    await writeFile(join(harness.source, 'Driving', 'Event', 'impact.MP4'), 'impact video')
    await writeFile(join(harness.source, 'Driving', 'notes.txt'), 'folder notes')
    await writeFile(join(harness.source, 'Other', 'outside.mp4'), 'outside selection')
    const selectiveRequest = request(harness.drive.id, harness.backupRoot, 'gps')
    selectiveRequest.backupSelection = { kind: 'folder', relativePath: 'Driving', includeSourceFolder: false }
    selectiveRequest.selectiveBackupConfirmed = true

    await harness.operationService.start(selectiveRequest)
    await waitForTerminal(harness.changes, 1)

    expect(harness.changes[0]?.state).toBe('completed')
    const destination = harness.changes[0]?.backupDestination
    expect(await readFile(join(destination!, 'front.mp4'), 'utf8')).toBe('front video')
    expect(await readFile(join(destination!, 'Event', 'impact.MP4'), 'utf8')).toBe('impact video')
    expect(await readFile(join(destination!, 'notes.txt'), 'utf8')).toBe('folder notes')
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
    selectiveRequest.backupSelection = { kind: 'folder', relativePath: 'Driving', includeSourceFolder: true }
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
    selectiveRequest.backupSelection = { kind: 'folder', relativePath: 'Driving', includeSourceFolder: false }

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
    selectiveRequest.backupSelection = { kind: 'folder', relativePath: '..', includeSourceFolder: false }
    selectiveRequest.selectiveBackupConfirmed = true

    const result = await harness.operationService.start(selectiveRequest)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_REQUEST')
    expect(harness.platform.formatRequests).toHaveLength(0)
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('선택한 폴더가 비어 있으면 포맷하지 않는다', async () => {
  const harness = await createHarness()
  try {
    await mkdir(join(harness.source, 'Driving'))
    const selectiveRequest = request(harness.drive.id, harness.backupRoot, 'gps')
    selectiveRequest.backupSelection = { kind: 'folder', relativePath: 'Driving', includeSourceFolder: false }
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
    expect(harness.platform.formatRequests[0]?.options).toEqual({ filesystem: 'FAT32' })
    await expect(readFile(join(harness.source, 'Parameter', 'config.txt'), 'utf8')).rejects.toThrow()
  } finally {
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('이전 버전의 볼륨 이름 요청을 포맷에 반영하지 않는다', async () => {
  const harness = await createHarness()
  try {
    const customRequest = request(harness.drive.id, harness.backupRoot)
    Object.assign(customRequest, { formatVolumeLabel: 'CAR-12' })
    await harness.operationService.start(customRequest)
    await waitForTerminal(harness.changes, 1)
    expect(harness.changes[0]?.state).toBe('completed')
    expect(harness.platform.formatRequests[0]?.options).toEqual({ filesystem: 'exFAT', allocationUnitSize: 131072 })
    expect(harness.platform.drives[0]?.volumeLabel).toBeUndefined()
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

test('선택 폴더의 첫 확장자 없는 영상 파일명에서 백업 날짜를 감지한다', async () => {
  const harness = await createHarness()
  try {
    const drivingFolder = join(harness.source, 'Driving')
    const videoName = '2026-09-01-16h-06m-40s_R_normal'
    await mkdir(drivingFolder)
    await writeFile(join(drivingFolder, videoName), 'blackbox video')
    const autoDateRequest = request(harness.drive.id, harness.backupRoot, 'gps')
    autoDateRequest.backupDateMode = 'auto'
    delete autoDateRequest.backupDate
    autoDateRequest.backupSelection = {
      kind: 'folder',
      relativePath: 'Driving',
      includeSourceFolder: false
    }
    autoDateRequest.selectiveBackupConfirmed = true

    await harness.operationService.start(autoDateRequest)
    await waitForTerminal(harness.changes, 1)

    expect(harness.changes[0]?.state).toBe('completed')
    expect(harness.changes[0]?.backupDestination).toBe(join(harness.backupRoot, '2026-09-01'))
    expect(await readFile(join(harness.backupRoot, '2026-09-01', videoName), 'utf8')).toBe('blackbox video')
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

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function addCard(harness: Awaited<ReturnType<typeof createHarness>>, number: number) {
  const mountPath = join(harness.root, `source-${number}`)
  await mkdir(join(mountPath, 'DCIM'), { recursive: true })
  await writeFile(join(mountPath, 'DCIM', 'video.dat'), `card ${number} data`)
  const drive = createMockDrive({
    id: `PHYSICAL-${number}::VOLUME-${number}::1`,
    physicalDiskIdentifier: `PHYSICAL-${number}`,
    diskIdentifier: `PHYSICAL-${number}|SERIAL-${number}`,
    volumeIdentifier: `VOLUME-${number}`,
    diskNumber: number + 3,
    driveLetter: `${String.fromCharCode(68 + number)}:`,
    mountPath
  })
  harness.platform.drives.push(drive)
  return drive
}

test('백업은 최대 2개, FIFO로 시작하고 포맷 검증 중에도 다음 백업을 진행한다', async () => {
  const harness = await createHarness()
  const gates = [deferred(), deferred(), deferred(), deferred()]
  const formatGate = deferred()
  try {
    const cards = structuredClone([harness.drive, await addCard(harness, 2), await addCard(harness, 3), await addCard(harness, 4)])
    const started: string[] = []
    let active = 0
    let peak = 0
    const backup = harness.backupService.backup.bind(harness.backupService)
    harness.backupService.backup = async (...args) => {
      started.push(args[0].id)
      peak = Math.max(peak, ++active)
      try {
        await gates[cards.findIndex((card) => card.id === args[0].id)]!.promise
        return await backup(...args)
      } finally { active -= 1 }
    }
    const findPartition = harness.driveService.findCurrentPartition.bind(harness.driveService)
    harness.driveService.findCurrentPartition = async (selected) => {
      if (selected.id === cards[0]!.id) await formatGate.promise
      return findPartition(selected)
    }
    for (const card of cards) expect((await harness.operationService.start(request(card.id, harness.backupRoot, 'gps'))).success).toBe(true)
    await expect.poll(() => started.length).toBe(2)
    expect(started).toEqual(cards.slice(0, 2).map((card) => card.id))
    expect(harness.changes.slice(2).map((operation) => operation.state)).toEqual(['queued', 'queued'])
    gates[0]!.release()
    await expect.poll(() => harness.changes[0]?.state).toBe('format-verifying')
    await expect.poll(() => started.length).toBe(3)
    gates[1]!.release()
    await expect.poll(() => harness.changes[1]?.state).toBe('format-queued')
    await expect.poll(() => started.length).toBe(4)
    gates[2]!.release()
    gates[3]!.release()
    await expect.poll(() => harness.changes.filter((operation) => operation.state === 'format-queued').length).toBe(3)
    expect(harness.platform.formatRequests).toHaveLength(1)
    expect(started).toEqual(cards.map((card) => card.id))
    expect(peak).toBe(2)
    formatGate.release()
    await waitForTerminal(harness.changes, 4)
    expect(harness.changes.every((operation) => operation.state === 'completed')).toBe(true)
    expect(harness.platform.formatRequests).toHaveLength(4)
  } finally {
    gates.forEach((gate) => gate.release())
    formatGate.release()
    await waitForTerminal(harness.changes, harness.changes.length)
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('동시 백업의 동일 파일명 충돌에도 서로 다른 내용을 보존하고 전체 검증한다', async () => {
  const harness = await createHarness()
  try {
    const second = await addCard(harness, 2)
    const results = await Promise.all([harness.drive, second].map((card) =>
      harness.backupService.backup(card, harness.backupRoot, 'single', false, 'auto', undefined, undefined, new AbortController().signal, () => undefined)
    ))
    expect(new Set(results.map((result) => result.files[0]?.destinationRelativePath)).size).toBe(2)
    for (const [index, result] of results.entries()) {
      const card = [harness.drive, second][index]!
      await harness.backupService.verify(card.mountPath, result, 'full')
      expect(await readFile(join(result.destination, result.files[0]!.destinationRelativePath), 'utf8'))
        .toBe(index === 0 ? 'verified source data' : 'card 2 data')
    }
  } finally { await rm(harness.root, { recursive: true, force: true }) }
})

test('파일명 선택 직후 다른 작업이 생성한 파일을 덮어쓰지 않고 새 이름으로 복사한다', async () => {
  const harness = await createHarness()
  try {
    // 첫 진행 이벤트는 파일명 선택 후, 복사 파일을 열기 전에 전달됩니다.
    const { writeFileSync, mkdirSync } = await import('node:fs')
    let injected = false
    const result = await harness.backupService.backup(
      harness.drive, harness.backupRoot, 'single', false, 'auto', undefined, undefined,
      new AbortController().signal, () => {
        if (injected) return
        injected = true
        mkdirSync(join(harness.backupRoot, 'DCIM'), { recursive: true })
        writeFileSync(join(harness.backupRoot, 'DCIM', 'video.dat'), 'other backup', { flag: 'wx' })
      }
    )
    await harness.backupService.verify(harness.source, result, 'full')
    expect(await readFile(join(harness.backupRoot, 'DCIM', 'video.dat'), 'utf8')).toBe('other backup')
    expect(await readFile(join(harness.backupRoot, 'DCIM', 'video_1.dat'), 'utf8')).toBe('verified source data')
  } finally { await rm(harness.root, { recursive: true, force: true }) }
})

for (const failure of ['cancel', 'verify'] as const) {
  test(`병렬 백업 하나의 ${failure} 이후 다음 카드를 처리하고 해당 카드는 포맷하지 않는다`, async () => {
    const harness = await createHarness()
    const gate = deferred()
    try {
      const second = await addCard(harness, 2)
      const third = await addCard(harness, 3)
      const backup = harness.backupService.backup.bind(harness.backupService)
      harness.backupService.backup = async (...args) => {
        await gate.promise
        return backup(...args)
      }
      if (failure === 'verify') {
        const verify = harness.backupService.verify.bind(harness.backupService)
        harness.backupService.verify = async (...args) => {
          if (args[0] === harness.source) throw new SdManagerError('BACKUP_VERIFICATION_FAILED', '검증 실패')
          return verify(...args)
        }
      }
      const first = await harness.operationService.start(request(harness.drive.id, harness.backupRoot, 'gps'))
      await harness.operationService.start(request(second.id, harness.backupRoot, 'gps'))
      await harness.operationService.start(request(third.id, harness.backupRoot, 'gps'))
      await expect.poll(() => harness.changes.filter((operation) => operation.state === 'backing-up').length).toBe(2)
      if (failure === 'cancel') expect(harness.operationService.cancel(first.operationId!).success).toBe(true)
      gate.release()
      await waitForTerminal(harness.changes, 3)
      expect(harness.changes[0]?.state).toBe(failure === 'cancel' ? 'cancelled' : 'failed')
      expect(harness.changes.slice(1).every((operation) => operation.state === 'completed')).toBe(true)
      expect(harness.platform.formatRequests.map((item) => item.drive.id)).not.toContain(harness.drive.id)
      expect(harness.platform.formatRequests).toHaveLength(2)
    } finally {
      gate.release()
      await waitForTerminal(harness.changes, harness.changes.length)
      await rm(harness.root, { recursive: true, force: true })
    }
  })
}

for (const failure of ['identity', 'removed', 'format'] as const) {
  test(`포맷 대기 중 ${failure} 오류가 발생해도 다음 카드가 처리된다`, async () => {
    const harness = await createHarness()
    const gate = deferred()
    try {
      const second = await addCard(harness, 2)
      const third = await addCard(harness, 3)
      const format = harness.platform.formatDrive.bind(harness.platform)
      harness.platform.formatDrive = async (drive, options) => {
        if (drive.id === harness.drive.id) await gate.promise
        if (failure === 'format' && drive.id === second.id) throw new SdManagerError('FORMAT_FAILED', '포맷 실패')
        return format(drive, options)
      }
      await harness.operationService.start(request(harness.drive.id, harness.backupRoot, 'gps'))
      await expect.poll(() => harness.changes[0]?.state).toBe('formatting')
      await harness.operationService.start(request(second.id, harness.backupRoot, 'gps'))
      await expect.poll(() => harness.changes[1]?.state).toBe('format-queued')
      await harness.operationService.start(request(third.id, harness.backupRoot, 'gps'))
      await expect.poll(() => harness.changes[2]?.state).toBe('format-queued')
      expect(harness.operationService.cancel(harness.changes[0]!.id).success).toBe(false)
      if (failure === 'identity') second.volumeIdentifier = 'REPLACED-VOLUME'
      if (failure === 'removed') harness.platform.drives = harness.platform.drives.filter((drive) => drive.id !== second.id)
      gate.release()
      await waitForTerminal(harness.changes, 3)
      expect(harness.changes.map((operation) => operation.state)).toEqual(['completed', 'failed', 'completed'])
      expect(harness.changes[1]?.error?.code).toBe({ identity: 'DRIVE_IDENTITY_CHANGED', removed: 'DEVICE_REMOVED', format: 'FORMAT_FAILED' }[failure])
      expect(harness.platform.formatRequests.map((item) => item.drive.id)).not.toContain(second.id)
    } finally {
      gate.release()
      await waitForTerminal(harness.changes, harness.changes.length)
      await rm(harness.root, { recursive: true, force: true })
    }
  })
}

test('동시 시작 요청에서 동일 물리 디스크의 중복 등록을 거부한다', async () => {
  const harness = await createHarness()
  const gate = deferred()
  try {
    const backup = harness.backupService.backup.bind(harness.backupService)
    harness.backupService.backup = async (...args) => { await gate.promise; return backup(...args) }
    const partition = createMockDrive({ ...harness.drive, id: 'same-disk-partition-2', partitionNumber: 2, volumeIdentifier: 'VOLUME-2' })
    harness.platform.drives.push(partition)
    const results = await Promise.all([harness.drive, partition].map((card) =>
      harness.operationService.start(request(card.id, harness.backupRoot, 'gps'))
    ))
    expect(results.filter((result) => result.success)).toHaveLength(1)
    expect(results.find((result) => !result.success)?.error?.code).toBe('INVALID_REQUEST')
    gate.release()
    await waitForTerminal(harness.changes, 1)
    expect(harness.platform.formatRequests).toHaveLength(1)
  } finally {
    gate.release()
    await waitForTerminal(harness.changes, harness.changes.length)
    await rm(harness.root, { recursive: true, force: true })
  }
})

test('대기 중 취소한 카드는 건너뛰고 같은 카드를 다시 등록할 수 있다', async () => {
  const harness = await createHarness()
  const gate = deferred()
  try {
    const second = await addCard(harness, 2)
    const third = await addCard(harness, 3)
    const backup = harness.backupService.backup.bind(harness.backupService)
    harness.backupService.backup = async (...args) => { await gate.promise; return backup(...args) }
    for (const card of [harness.drive, second, third]) {
      await harness.operationService.start(request(card.id, harness.backupRoot, 'gps'))
    }
    expect(harness.changes[2]?.state).toBe('queued')
    expect(harness.operationService.cancel(harness.changes[2]!.id).success).toBe(true)
    expect((await harness.operationService.start(request(third.id, harness.backupRoot, 'gps'))).success).toBe(true)
    gate.release()
    await waitForTerminal(harness.changes, 4)
    expect(harness.changes.map((operation) => operation.state)).toEqual(['completed', 'completed', 'cancelled', 'completed'])
    expect(harness.platform.formatRequests).toHaveLength(3)
  } finally {
    gate.release()
    await waitForTerminal(harness.changes, harness.changes.length)
    await rm(harness.root, { recursive: true, force: true })
  }
})

for (const destinationOn of ['existing-source', 'new-source'] as const) {
  test(`다른 작업의 백업 대상과 처리 카드가 겹치면 시작을 거부한다: ${destinationOn}`, async () => {
    const harness = await createHarness()
    const gate = deferred()
    try {
      const second = await addCard(harness, 2)
      const backup = harness.backupService.backup.bind(harness.backupService)
      harness.backupService.backup = async (...args) => { await gate.promise; return backup(...args) }
      harness.platform.getPhysicalDiskIdentifierForPath = async (targetPath?: string) => {
        if (destinationOn === 'existing-source' && targetPath === harness.source) return harness.drive.physicalDiskIdentifier
        if (destinationOn === 'new-source' && targetPath === harness.backupRoot) return second.physicalDiskIdentifier
        return 'BACKUP-DISK'
      }
      expect((await harness.operationService.start(request(harness.drive.id, harness.backupRoot, 'gps'))).success).toBe(true)
      const result = await harness.operationService.start(request(second.id, destinationOn === 'existing-source' ? harness.source : harness.backupRoot, 'gps'))
      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('BACKUP_DESTINATION_ON_SOURCE')
      gate.release()
      await waitForTerminal(harness.changes, 1)
      expect(harness.changes[0]?.state).toBe('completed')
      expect(harness.platform.formatRequests).toHaveLength(1)
    } finally {
      gate.release()
      await waitForTerminal(harness.changes, harness.changes.length)
      await rm(harness.root, { recursive: true, force: true })
    }
  })
}
