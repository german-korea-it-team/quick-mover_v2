import type { DeviceProfile, FormatOptions } from './types'

export const FORMAT_OPTIONS: Record<DeviceProfile, FormatOptions> = {
  blackbox: { filesystem: 'exFAT', allocationUnitSize: 131072 },
  gps: { filesystem: 'FAT32' }
}

export const PROGRESS_EVENT_INTERVAL_MS = 150
