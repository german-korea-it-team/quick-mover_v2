import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface AuditEvent {
  event: string
  operationId?: string
  driveId?: string
  diskIdentifier?: string
  driveLetter?: string
  displayName?: string
  profile?: string
  backupTimeSlot?: string
  backupDestination?: string
  backupSourceFolder?: string
  backupFileFilter?: string
  backupSelectedFileCount?: number
  selectiveBackupConfirmed?: boolean
  filesystem?: string
  allocationUnitSize?: number
  volumeLabel?: string
  result?: string
  errorCode?: string
}

export class LoggerService {
  constructor(private readonly logPath: string) {}

  async write(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true })
    await appendFile(this.logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, 'utf8')
  }
}
