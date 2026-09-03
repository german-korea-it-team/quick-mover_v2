import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppSettings, SdCardSettings } from '../../shared/types'

const DEFAULT_SETTINGS: AppSettings = {
  backupFavoritePaths: [],
  verificationMode: 'fast',
  cardSettings: {}
}

function parseBackupFavoritePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const paths: string[] = []
  const keys = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const path = item.trim()
    const key = path.toLowerCase()
    if (!path || keys.has(key)) continue
    keys.add(key)
    paths.push(path)
    if (paths.length >= 100) break
  }
  return paths
}

function parseCardSettings(
  value: unknown,
  legacyBackupRoot: string | undefined,
  legacyCreateBackupFolder: boolean | undefined
): Record<string, SdCardSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, SdCardSettings>>((settings, [physicalDiskIdentifier, item]) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return settings
    const candidate = item as Record<string, unknown>
    const backupRoot = typeof candidate.backupRoot === 'string' ? candidate.backupRoot.trim() : legacyBackupRoot
    const createBackupFolder =
      typeof candidate.createBackupFolder === 'boolean' ? candidate.createBackupFolder : legacyCreateBackupFolder
    settings[physicalDiskIdentifier] = {
      ...(backupRoot ? { backupRoot } : {}),
      ...(createBackupFolder !== undefined ? { createBackupFolder } : {})
    }
    return settings
  }, {})
}

function parseSettings(value: unknown): AppSettings | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.verificationMode !== 'fast' && candidate.verificationMode !== 'full') {
    return undefined
  }
  const legacyBackupRoot = typeof candidate.backupRoot === 'string' ? candidate.backupRoot.trim() || undefined : undefined
  const legacyCreateBackupFolder =
    typeof candidate.createBackupFolder === 'boolean' ? candidate.createBackupFolder : undefined
  return {
    backupFavoritePaths: parseBackupFavoritePaths(candidate.backupFavoritePaths),
    verificationMode: candidate.verificationMode,
    cardSettings: parseCardSettings(candidate.cardSettings, legacyBackupRoot, legacyCreateBackupFolder)
  }
}

export class SettingsService {
  constructor(private readonly filePath: string) {}

  async get(): Promise<AppSettings> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      return parseSettings(parsed) ?? DEFAULT_SETTINGS
    } catch {
      return DEFAULT_SETTINGS
    }
  }

  async save(settings: AppSettings): Promise<void> {
    const parsed = parseSettings(settings)
    if (!parsed) throw new TypeError('Invalid settings')
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, JSON.stringify(parsed, null, 2), 'utf8')
    await rename(temporaryPath, this.filePath)
  }
}
