import type { DeviceProfile, FormatOptions } from './types'

export const FORMAT_OPTIONS: Record<DeviceProfile, FormatOptions> = {
  blackbox: { filesystem: 'exFAT', allocationUnitSize: 131072 },
  gps: { filesystem: 'FAT32' }
}

export const PROGRESS_EVENT_INTERVAL_MS = 150

// 백업 검증까지 슬롯을 유지하고, 포맷은 별도 대기열에서 순차 실행합니다.
export const BACKUP_CONCURRENCY = 2
