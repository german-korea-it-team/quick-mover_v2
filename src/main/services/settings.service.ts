import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppSettings, BackupFolderSelection, SavedCardPreset, SdCardSettings } from '../../shared/types'

const DEFAULT_SETTINGS: AppSettings = {
  backupFavoritePaths: [],
  verificationMode: 'fast',
  cardSettings: {},
  savedCardPresets: []
}

function optionalDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const displayName = value.trim()
  return displayName && displayName.length <= 80 ? displayName : undefined
}

function parseBackupFolderSelection(value: unknown): BackupFolderSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (
    candidate.kind !== 'folder' ||
    typeof candidate.relativePath !== 'string' ||
    !candidate.relativePath.trim() ||
    typeof candidate.includeSourceFolder !== 'boolean'
  ) {
    return undefined
  }
  return {
    kind: 'folder',
    relativePath: candidate.relativePath.trim(),
    includeSourceFolder: candidate.includeSourceFolder
  }
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
    const displayName = optionalDisplayName(candidate.displayName)
    settings[physicalDiskIdentifier] = {
      ...(displayName ? { displayName } : {}),
      ...(backupRoot ? { backupRoot } : {}),
      ...(createBackupFolder !== undefined ? { createBackupFolder } : {}),
      ...(candidate.backupDateMode === 'auto' || candidate.backupDateMode === 'manual'
        ? { backupDateMode: candidate.backupDateMode }
        : {}),
      ...(candidate.profile === 'blackbox' || candidate.profile === 'gps' ? { profile: candidate.profile } : {}),
      ...(candidate.backupTimeSlot === 'single' || candidate.backupTimeSlot === 'day' || candidate.backupTimeSlot === 'night'
        ? { backupTimeSlot: candidate.backupTimeSlot }
        : {})
    }
    return settings
  }, {})
}

function parseSavedCardPresets(value: unknown): SavedCardPreset[] {
  if (!Array.isArray(value)) return []
  const presets: SavedCardPreset[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const candidate = item as Record<string, unknown>
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
    const backupRoot = typeof candidate.backupRoot === 'string' ? candidate.backupRoot.trim() : ''
    const nameKey = name.toLowerCase()
    if (
      !id ||
      id.length > 100 ||
      !name ||
      name.length > 80 ||
      !backupRoot ||
      ids.has(id) ||
      names.has(nameKey) ||
      (candidate.profile !== 'blackbox' && candidate.profile !== 'gps') ||
      typeof candidate.createBackupFolder !== 'boolean' ||
      (candidate.backupDateMode !== 'auto' && candidate.backupDateMode !== 'manual') ||
      (candidate.backupTimeSlot !== 'single' && candidate.backupTimeSlot !== 'day' && candidate.backupTimeSlot !== 'night')
    ) {
      continue
    }
    ids.add(id)
    names.add(nameKey)
    const backupSelection = parseBackupFolderSelection(candidate.backupSelection)
    const displayName = optionalDisplayName(candidate.displayName)
    presets.push({
      id,
      name,
      ...(displayName ? { displayName } : {}),
      profile: candidate.profile,
      backupRoot,
      createBackupFolder: candidate.createBackupFolder,
      backupDateMode: candidate.backupDateMode,
      backupTimeSlot: candidate.backupTimeSlot,
      ...(backupSelection ? { backupSelection } : {})
    })
    if (presets.length >= 100) break
  }
  return presets
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
    cardSettings: parseCardSettings(candidate.cardSettings, legacyBackupRoot, legacyCreateBackupFolder),
    savedCardPresets: parseSavedCardPresets(candidate.savedCardPresets)
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
