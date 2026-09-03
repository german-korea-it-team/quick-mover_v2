import { FORMAT_OPTIONS } from '../../shared/constants'
import type { DeviceProfile, FormatOptions, RemovableDrive } from '../../shared/types'
import type { DrivePlatform } from '../platform/drive-platform'
import { DriveService } from './drive.service'
import { SdManagerError } from './errors'

export class FormatService {
  constructor(
    private readonly platform: DrivePlatform,
    private readonly driveService: DriveService
  ) {}

  async formatAndVerify(
    selected: RemovableDrive,
    profile: DeviceProfile,
    backupRoot: string,
    formatVolumeLabel: string | undefined,
    beforeFormat: (current: RemovableDrive, options: FormatOptions) => Promise<void>,
    afterFormat: () => void
  ): Promise<RemovableDrive> {
    const current = await this.driveService.inspectDrive(selected.id)
    this.driveService.assertSafeRemovableDrive(current)
    this.driveService.assertSameDrive(selected, current)
    await this.driveService.assertBackupDestinationIsDifferentDrive(current, backupRoot)

    const volumeLabel = formatVolumeLabel || current.volumeLabel
    const options: FormatOptions = {
      ...FORMAT_OPTIONS[profile],
      ...(volumeLabel ? { volumeLabel } : {})
    }
    await beforeFormat(current, options)
    await this.platform.formatDrive(current, options)
    afterFormat()

    const formatted = await this.driveService.findCurrentPartition(selected)
    this.driveService.assertSafeRemovableDrive(formatted)
    if (formatted.physicalDiskIdentifier !== selected.physicalDiskIdentifier) {
      throw new SdManagerError('DRIVE_IDENTITY_CHANGED', '포맷 후 장치 식별 정보가 변경되었습니다.')
    }
    if (formatted.filesystem?.toUpperCase() !== options.filesystem.toUpperCase()) {
      throw new SdManagerError('FORMAT_VERIFICATION_FAILED', `포맷 결과가 ${options.filesystem} 파일 시스템이 아닙니다.`)
    }
    if (options.volumeLabel && formatted.volumeLabel?.toUpperCase() !== options.volumeLabel.toUpperCase()) {
      throw new SdManagerError('FORMAT_VERIFICATION_FAILED', '포맷 후 볼륨 이름이 요청한 값과 다릅니다.')
    }
    if (profile === 'blackbox' && formatted.allocationUnitSize !== 131072) {
      throw new SdManagerError('FORMAT_VERIFICATION_FAILED', '블랙박스 SD 카드의 할당 단위가 128 KB가 아닙니다.')
    }
    return formatted
  }
}
