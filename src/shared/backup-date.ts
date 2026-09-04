const BACKUP_DATE_PATTERN = /(?:^|\D)((?:19|20)\d{2})-(\d{2})-(\d{2})(?!\d)/

export function isValidBackupDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function extractBackupDateFromFileName(fileName: string): string | undefined {
  const match = BACKUP_DATE_PATTERN.exec(fileName)
  if (!match) return undefined
  const value = `${match[1]}-${match[2]}-${match[3]}`
  return isValidBackupDate(value) ? value : undefined
}
