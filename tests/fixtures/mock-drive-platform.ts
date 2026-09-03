import type { DrivePlatform } from '../../src/main/platform/drive-platform'
import type { FormatOptions, FormatResult, RemovableDrive } from '../../src/shared/types'
import { SdManagerError } from '../../src/main/services/errors'

export class MockDrivePlatform implements DrivePlatform {
  readonly formatRequests: Array<{ drive: RemovableDrive; options: FormatOptions }> = []
  backupDiskIdentifier = 'BACKUP-DISK'
  formatError?: SdManagerError
  formattedFilesystem?: string
  formattedAllocationUnitSize?: number

  constructor(public drives: RemovableDrive[]) {}

  async listDrives(): Promise<RemovableDrive[]> {
    return this.drives.map((drive) => structuredClone(drive))
  }

  async inspectDrive(id: string): Promise<RemovableDrive> {
    const drive = this.drives.find((candidate) => candidate.id === id)
    if (!drive) throw new SdManagerError('DRIVE_NOT_FOUND', 'Mock drive not found')
    return structuredClone(drive)
  }

  async getPhysicalDiskIdentifierForPath(): Promise<string | undefined> {
    return this.backupDiskIdentifier
  }

  async formatDrive(drive: RemovableDrive, options: FormatOptions): Promise<FormatResult> {
    this.formatRequests.push({ drive: structuredClone(drive), options: structuredClone(options) })
    if (this.formatError) throw this.formatError
    const current = this.drives.find((candidate) => candidate.id === drive.id)
    if (!current) throw new SdManagerError('DRIVE_NOT_FOUND', 'Mock drive removed during format')
    current.filesystem = this.formattedFilesystem ?? options.filesystem
    current.allocationUnitSize = this.formattedAllocationUnitSize ?? options.allocationUnitSize ?? 32768
    current.volumeLabel = options.volumeLabel ?? current.volumeLabel
    current.volumeIdentifier = `${current.volumeIdentifier}-formatted`
    current.id = `${current.id}-formatted`
    return { filesystem: current.filesystem, allocationUnitSize: current.allocationUnitSize }
  }
}

export function createMockDrive(overrides: Partial<RemovableDrive> = {}): RemovableDrive {
  return {
    id: 'PHYSICAL-1::VOLUME-1::1',
    diskNumber: 4,
    partitionNumber: 1,
    driveLetter: 'E:',
    volumeLabel: 'SD_CARD',
    filesystem: 'FAT32',
    allocationUnitSize: 32768,
    capacityBytes: 32 * 1024 ** 3,
    freeBytes: 16 * 1024 ** 3,
    removable: true,
    diskIdentifier: 'PHYSICAL-1|SERIAL-1',
    volumeIdentifier: 'VOLUME-1',
    physicalDiskIdentifier: 'PHYSICAL-1',
    mountPath: '/tmp/quick-mover-placeholder',
    isSystem: false,
    isBoot: false,
    ...overrides
  }
}
