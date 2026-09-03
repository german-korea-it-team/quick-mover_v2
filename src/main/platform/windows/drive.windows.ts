import { win32 } from 'node:path'
import type { FormatOptions, FormatResult, RemovableDrive } from '../../../shared/types'
import { SdManagerError } from '../../services/errors'
import type { DrivePlatform } from '../drive-platform'
import { runPowerShell } from './powershell'

interface PowerShellDrive {
  DiskNumber: number
  PartitionNumber: number
  DriveLetter: string
  VolumeLabel?: string
  Filesystem?: string
  AllocationUnitSize?: number
  CapacityBytes: number
  FreeBytes: number
  Removable: boolean
  DiskIdentifier: string
  VolumeIdentifier: string
  PhysicalDiskIdentifier: string
  IsSystem: boolean
  IsBoot: boolean
}

const LIST_DRIVES_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$items = @()
Get-Partition | Where-Object DriveLetter | ForEach-Object {
  $partition = $_
  $disk = Get-Disk -Number $partition.DiskNumber
  $volume = Get-Volume -DriveLetter $partition.DriveLetter
  $logical = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $partition.DriveLetter + ":'")
  $winVolume = Get-CimInstance Win32_Volume -Filter ("DriveLetter='" + $partition.DriveLetter + ":'")
  $physicalId = [string]$disk.UniqueId
  $volumeId = [string]$winVolume.DeviceID
  $isRemovable = ($logical.DriveType -eq 2) -or ($disk.BusType -eq 'SD')
  if ($isRemovable -and $physicalId -and $volumeId) {
    $items += [pscustomobject]@{
      DiskNumber = [int]$disk.Number
      PartitionNumber = [int]$partition.PartitionNumber
      DriveLetter = ([string]$partition.DriveLetter).ToUpper() + ':'
      VolumeLabel = [string]$volume.FileSystemLabel
      Filesystem = [string]$volume.FileSystem
      AllocationUnitSize = [long]$winVolume.BlockSize
      CapacityBytes = [long]$volume.Size
      FreeBytes = [long]$volume.SizeRemaining
      Removable = $true
      DiskIdentifier = $physicalId + '|' + [string]$disk.SerialNumber
      VolumeIdentifier = $volumeId
      PhysicalDiskIdentifier = $physicalId
      IsSystem = [bool]($disk.IsSystem -or $partition.IsSystem)
      IsBoot = [bool]($disk.IsBoot -or $partition.IsBoot)
    }
  }
}
@($items) | ConvertTo-Json -Compress -Depth 4
`

const FORMAT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$letter = $args[0]
$filesystem = $args[1]
$allocation = $args[2]
$volumeLabel = $args[3]
if ($letter -notmatch '^[A-Z]$') { throw 'Invalid drive letter' }
if ($filesystem -notin @('exFAT', 'FAT32')) { throw 'Invalid filesystem' }
$params = @{ DriveLetter = $letter; FileSystem = $filesystem; Confirm = $false; Force = $true }
if ($allocation) { $params.AllocationUnitSize = [uint32]$allocation }
if ($volumeLabel) { $params.NewFileSystemLabel = $volumeLabel }
Format-Volume @params | Out-Null
$volume = Get-Volume -DriveLetter $letter
$winVolume = Get-CimInstance Win32_Volume -Filter ("DriveLetter='" + $letter + ":'")
try {
  $svi = Join-Path ($letter + ':\') 'System Volume Information'
  if (Test-Path -LiteralPath $svi -ErrorAction SilentlyContinue) {
    (Get-Item -LiteralPath $svi -Force -ErrorAction Stop).Attributes = 'Hidden,System,Directory'
  }
} catch {
  # 속성 설정 실패 무시
}
[pscustomobject]@{
  Filesystem = [string]$volume.FileSystem
  AllocationUnitSize = [long]$winVolume.BlockSize
} | ConvertTo-Json -Compress
`

function arrayFromJson<T>(output: string): T[] {
  const parsed: unknown = JSON.parse(output || '[]')
  return Array.isArray(parsed) ? (parsed as T[]) : [parsed as T]
}

function mapDrive(value: PowerShellDrive): RemovableDrive {
  const id = `${value.PhysicalDiskIdentifier}::${value.VolumeIdentifier}::${value.PartitionNumber}`
  return {
    id,
    diskNumber: value.DiskNumber,
    partitionNumber: value.PartitionNumber,
    driveLetter: value.DriveLetter,
    volumeLabel: value.VolumeLabel || undefined,
    filesystem: value.Filesystem || undefined,
    allocationUnitSize: value.AllocationUnitSize || undefined,
    capacityBytes: value.CapacityBytes,
    freeBytes: value.FreeBytes,
    removable: value.Removable,
    diskIdentifier: value.DiskIdentifier,
    volumeIdentifier: value.VolumeIdentifier,
    physicalDiskIdentifier: value.PhysicalDiskIdentifier,
    mountPath: `${value.DriveLetter}\\`,
    isSystem: value.IsSystem,
    isBoot: value.IsBoot
  }
}

export class WindowsDrivePlatform implements DrivePlatform {
  async listDrives(): Promise<RemovableDrive[]> {
    if (process.platform !== 'win32') return []
    return arrayFromJson<PowerShellDrive>(await runPowerShell(LIST_DRIVES_SCRIPT)).map(mapDrive)
  }

  async inspectDrive(id: string): Promise<RemovableDrive> {
    const drive = (await this.listDrives()).find((candidate) => candidate.id === id)
    if (!drive) throw new SdManagerError('DRIVE_NOT_FOUND', '선택한 SD 카드를 찾을 수 없습니다.')
    return drive
  }

  async getPhysicalDiskIdentifierForPath(targetPath: string): Promise<string | undefined> {
    const root = win32.parse(targetPath).root
    const driveLetter = root.slice(0, 2).toUpperCase()
    if (!/^[A-Z]:$/.test(driveLetter)) return undefined
    const drive = (await this.listDrives()).find((candidate) => candidate.driveLetter === driveLetter)
    if (drive) return drive.physicalDiskIdentifier
    const script = String.raw`
$letter = $args[0]
$partition = Get-Partition -DriveLetter $letter -ErrorAction Stop
$disk = Get-Disk -Number $partition.DiskNumber -ErrorAction Stop
[string]$disk.UniqueId
`
    return (await runPowerShell(script, [driveLetter[0] ?? ''])).trim() || undefined
  }

  async formatDrive(drive: RemovableDrive, options: FormatOptions): Promise<FormatResult> {
    const letter = drive.driveLetter[0]
    if (!letter || !/^[A-Z]$/.test(letter)) throw new SdManagerError('FORMAT_FAILED', '드라이브 문자가 유효하지 않습니다.')
    const output = await runPowerShell(FORMAT_SCRIPT, [
      letter,
      options.filesystem,
      options.allocationUnitSize?.toString() ?? '',
      options.volumeLabel ?? ''
    ])
    const parsed = JSON.parse(output) as { Filesystem: string; AllocationUnitSize?: number }
    return { filesystem: parsed.Filesystem, allocationUnitSize: parsed.AllocationUnitSize }
  }
}
