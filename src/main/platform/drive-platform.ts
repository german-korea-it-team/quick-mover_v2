import type { FormatOptions, FormatResult, RemovableDrive } from '../../shared/types'

export interface DrivePlatform {
  listDrives(): Promise<RemovableDrive[]>
  inspectDrive(id: string): Promise<RemovableDrive>
  getPhysicalDiskIdentifierForPath(targetPath: string): Promise<string | undefined>
  formatDrive(drive: RemovableDrive, options: FormatOptions): Promise<FormatResult>
}
