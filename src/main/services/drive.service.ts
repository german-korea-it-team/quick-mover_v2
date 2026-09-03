import type { RemovableDrive } from '../../shared/types'
import type { DrivePlatform } from '../platform/drive-platform'
import { SdManagerError } from './errors'

export class DriveService {
  constructor(private readonly platform: DrivePlatform) {}

  listDrives(): Promise<RemovableDrive[]> {
    return this.platform.listDrives()
  }

  inspectDrive(id: string): Promise<RemovableDrive> {
    return this.platform.inspectDrive(id)
  }

  async findCurrentPartition(selected: RemovableDrive): Promise<RemovableDrive> {
    const current = (await this.platform.listDrives()).find(
      (drive) =>
        drive.diskNumber === selected.diskNumber &&
        drive.partitionNumber === selected.partitionNumber &&
        drive.physicalDiskIdentifier === selected.physicalDiskIdentifier
    )
    if (!current) throw new SdManagerError('DRIVE_NOT_FOUND', '처리 중인 SD 카드를 다시 찾을 수 없습니다.')
    return current
  }

  assertSafeRemovableDrive(drive: RemovableDrive): void {
    if (!drive.removable) throw new SdManagerError('DRIVE_NOT_REMOVABLE', '이동식 장치로 확인되지 않아 작업을 중단했습니다.')
    if (drive.isSystem || drive.isBoot) throw new SdManagerError('PROTECTED_DRIVE', '시스템 또는 부팅 드라이브는 처리할 수 없습니다.')
    if (!drive.physicalDiskIdentifier || !drive.volumeIdentifier || drive.diskNumber < 0) {
      throw new SdManagerError('PROTECTED_DRIVE', '장치 식별 정보가 불완전하여 작업을 중단했습니다.')
    }
  }

  assertSameDrive(selected: RemovableDrive, current: RemovableDrive): void {
    const matches =
      selected.id === current.id &&
      selected.diskNumber === current.diskNumber &&
      selected.partitionNumber === current.partitionNumber &&
      selected.physicalDiskIdentifier === current.physicalDiskIdentifier &&
      selected.volumeIdentifier === current.volumeIdentifier
    if (!matches) throw new SdManagerError('DRIVE_IDENTITY_CHANGED', '선택 이후 장치 식별 정보가 변경되어 작업을 중단했습니다.')
  }

  async assertBackupDestinationIsDifferentDrive(drive: RemovableDrive, backupRoot: string): Promise<void> {
    const backupDiskId = await this.platform.getPhysicalDiskIdentifierForPath(backupRoot)
    if (backupDiskId && backupDiskId === drive.physicalDiskIdentifier) {
      throw new SdManagerError('BACKUP_DESTINATION_ON_SOURCE', '백업 경로가 SD 카드와 같은 디스크에 있습니다.')
    }
  }
}
