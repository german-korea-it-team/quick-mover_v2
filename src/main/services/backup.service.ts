import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, lstat, mkdir, open, opendir, realpath, stat, utimes } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type {
  BackupDateMode,
  BackupSelection,
  BackupTimeSlot,
  DetectedBackupDate,
  OperationProgress,
  RemovableDrive,
  VerificationMode
} from '../../shared/types'
import { PROGRESS_EVENT_INTERVAL_MS } from '../../shared/constants'
import { SdManagerError } from './errors'
import { extractBackupDateFromFileName, isValidBackupDate } from '../../shared/backup-date'

interface SourceFile {
  sourceRelativePath: string
  destinationRelativePath: string
  size: number
  modifiedAt: Date
}

const WINDOWS_VOLUME_METADATA_DIRECTORY = 'system volume information'
const VIDEO_EXTENSIONS = new Set(['.mp4', '.avi', '.mov', '.mkv', '.mts', '.m2ts', '.ts', '.asf', '.wmv'])
const BLACKBOX_VIDEO_NAME_PATTERN = /^(?:19|20)\d{2}-\d{2}-\d{2}-\d{2}h-\d{2}m-\d{2}s_.+$/i

function backupDestinationRoot(
  backupRoot: string,
  createBackupFolder: boolean,
  timeSlot: BackupTimeSlot,
  backupDate: string | undefined
): string {
  const parent = createBackupFolder && backupDate ? join(backupRoot, backupDate) : backupRoot
  if (timeSlot === 'day') return join(parent, '1')
  if (timeSlot === 'night') return join(parent, '2')
  return parent
}

export interface BackupResult {
  destination: string
  files: SourceFile[]
  totalBytes: number
  selection?: BackupSelection
}

type ProgressListener = (progress: OperationProgress) => void

function isPathInsideRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target)
  return Boolean(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot)
}

function validateRelativeSourceFolder(relativePath: string): string {
  const normalized = normalize(relativePath.trim())
  if (!relativePath.trim() || normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) {
    throw new SdManagerError('INVALID_REQUEST', 'SD 카드 내부의 하위 폴더를 선택하세요.')
  }
  const firstSegment = normalized.split(sep)[0]?.toLowerCase()
  if (firstSegment === WINDOWS_VOLUME_METADATA_DIRECTORY) {
    throw new SdManagerError('INVALID_REQUEST', 'Windows 시스템 관리 폴더는 백업 대상으로 선택할 수 없습니다.')
  }
  return normalized
}

async function resolveSourceFolderFromRoot(cardRoot: string, relativePath: string): Promise<{ root: string; relativePath: string }> {
  try {
    const driveRoot = await realpath(cardRoot)
    const requested = resolve(driveRoot, validateRelativeSourceFolder(relativePath))
    const sourceRoot = await realpath(requested)
    const metadata = await stat(sourceRoot)
    if (!metadata.isDirectory() || !isPathInsideRoot(driveRoot, sourceRoot)) {
      throw new SdManagerError('INVALID_REQUEST', '선택한 폴더가 현재 SD 카드 내부에 있지 않습니다.')
    }
    const canonicalRelativePath = relative(driveRoot, sourceRoot)
    validateRelativeSourceFolder(canonicalRelativePath)
    return { root: sourceRoot, relativePath: canonicalRelativePath }
  } catch (error) {
    if (error instanceof SdManagerError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENODEV') {
      throw new SdManagerError('DEVICE_REMOVED', '선택한 백업 폴더를 찾을 수 없습니다.')
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new SdManagerError('PERMISSION_DENIED', '선택한 백업 폴더에 접근할 수 없습니다.')
    }
    throw new SdManagerError('BACKUP_FAILED', '선택한 백업 폴더를 확인하지 못했습니다.', error instanceof Error ? error.message : undefined)
  }
}

async function relativeSourceFolderFromPath(cardRoot: string, selectedPath: string): Promise<string> {
  try {
    const driveRoot = await realpath(cardRoot)
    const sourceRoot = await realpath(selectedPath)
    const metadata = await stat(sourceRoot)
    if (!metadata.isDirectory() || !isPathInsideRoot(driveRoot, sourceRoot)) {
      throw new SdManagerError('INVALID_REQUEST', '선택한 폴더가 현재 SD 카드 내부에 있지 않습니다.')
    }
    return validateRelativeSourceFolder(relative(driveRoot, sourceRoot))
  } catch (error) {
    if (error instanceof SdManagerError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENODEV') {
      throw new SdManagerError('DEVICE_REMOVED', '선택한 백업 폴더를 찾을 수 없습니다.')
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new SdManagerError('PERMISSION_DENIED', '선택한 백업 폴더에 접근할 수 없습니다.')
    }
    throw new SdManagerError('BACKUP_FAILED', '선택한 백업 폴더를 확인하지 못했습니다.', error instanceof Error ? error.message : undefined)
  }
}

async function resolveSourceFileFromRoot(cardRoot: string, relativePath: string): Promise<{ absolutePath: string; relativePath: string }> {
  try {
    const driveRoot = await realpath(cardRoot)
    const requested = resolve(driveRoot, validateRelativeSourceFolder(relativePath))
    const requestedMetadata = await lstat(requested)
    if (requestedMetadata.isSymbolicLink()) {
      throw new SdManagerError('BACKUP_FAILED', '심볼릭 링크는 백업 파일로 선택할 수 없습니다.', relativePath)
    }
    const absolutePath = await realpath(requested)
    const metadata = await stat(absolutePath)
    if (!metadata.isFile() || !isPathInsideRoot(driveRoot, absolutePath)) {
      throw new SdManagerError('INVALID_REQUEST', '선택한 파일이 현재 SD 카드 내부에 있지 않습니다.')
    }
    const canonicalRelativePath = validateRelativeSourceFolder(relative(driveRoot, absolutePath))
    return { absolutePath, relativePath: canonicalRelativePath }
  } catch (error) {
    if (error instanceof SdManagerError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENODEV') {
      throw new SdManagerError('DEVICE_REMOVED', '선택한 백업 파일을 찾을 수 없습니다.')
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new SdManagerError('PERMISSION_DENIED', '선택한 백업 파일에 접근할 수 없습니다.')
    }
    throw new SdManagerError('BACKUP_FAILED', '선택한 백업 파일을 확인하지 못했습니다.', error instanceof Error ? error.message : undefined)
  }
}

async function relativeSourceFilesFromPaths(cardRoot: string, selectedPaths: string[]): Promise<string[]> {
  const driveRoot = await realpath(cardRoot)
  const relativePaths: string[] = []
  const selected = new Set<string>()
  for (const selectedPath of selectedPaths) {
    const relativePath = relative(driveRoot, selectedPath)
    const resolved = await resolveSourceFileFromRoot(driveRoot, relativePath)
    const key = resolved.relativePath.toLowerCase()
    if (!selected.has(key)) {
      selected.add(key)
      relativePaths.push(resolved.relativePath)
    }
  }
  if (relativePaths.length === 0) {
    throw new SdManagerError('INVALID_REQUEST', '백업할 파일을 하나 이상 선택하세요.')
  }
  return relativePaths
}

async function collectFiles(
  cardRoot: string,
  sourceRoot: string,
  signal: AbortSignal
): Promise<SourceFile[]> {
  const files: SourceFile[] = []

  async function walk(current: string): Promise<void> {
    if (signal.aborted) throw new SdManagerError('BACKUP_CANCELLED', '백업이 취소되었습니다.')
    const directory = await opendir(current)
    for await (const entry of directory) {
      if (current === cardRoot && entry.isDirectory() && entry.name.toLowerCase() === WINDOWS_VOLUME_METADATA_DIRECTORY) {
        continue
      }
      const absolutePath = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new SdManagerError('BACKUP_FAILED', '심볼릭 링크가 포함된 카드는 안전하게 백업할 수 없습니다.', absolutePath)
      }
      if (entry.isDirectory()) await walk(absolutePath)
      else if (entry.isFile()) {
        const metadata = await stat(absolutePath)
        const sourceRelativePath = relative(cardRoot, absolutePath)
        files.push({ sourceRelativePath, destinationRelativePath: sourceRelativePath, size: metadata.size, modifiedAt: metadata.mtime })
      }
    }
  }

  await walk(sourceRoot)
  return files
}

async function collectSelectedFiles(cardRoot: string, relativePaths: string[]): Promise<SourceFile[]> {
  const files: SourceFile[] = []
  const selected = new Set<string>()
  for (const relativePath of relativePaths) {
    const resolved = await resolveSourceFileFromRoot(cardRoot, relativePath)
    const key = resolved.relativePath.toLowerCase()
    if (selected.has(key)) continue
    selected.add(key)
    const metadata = await stat(resolved.absolutePath)
    files.push({
      sourceRelativePath: resolved.relativePath,
      destinationRelativePath: basename(resolved.relativePath),
      size: metadata.size,
      modifiedAt: metadata.mtime
    })
  }
  return files
}

async function collectBackupSource(
  drive: RemovableDrive,
  backupSelection: BackupSelection | undefined,
  signal: AbortSignal
): Promise<{ files: SourceFile[]; selection?: BackupSelection }> {
  try {
    const cardRoot = await realpath(drive.mountPath)
    if (!backupSelection) {
      return { files: await collectFiles(cardRoot, cardRoot, signal) }
    }
    if (backupSelection.kind === 'folder') {
      const selectedSource = await resolveSourceFolderFromRoot(cardRoot, backupSelection.relativePath)
      const selection: BackupSelection = {
        kind: 'folder',
        relativePath: selectedSource.relativePath,
        includeSourceFolder: backupSelection.includeSourceFolder
      }
      let files = await collectFiles(cardRoot, selectedSource.root, signal)
      if (!backupSelection.includeSourceFolder) {
        files = files.map((file) => ({
          ...file,
          destinationRelativePath: relative(selectedSource.root, join(cardRoot, file.sourceRelativePath))
        }))
      }
      return { files, selection }
    }
    const files = await collectSelectedFiles(cardRoot, backupSelection.relativePaths)
    return {
      files,
      selection: { kind: 'files', relativePaths: files.map((file) => file.sourceRelativePath) }
    }
  } catch (error) {
    if (error instanceof SdManagerError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SdManagerError('DEVICE_REMOVED', '백업 준비 중 SD 카드가 제거되었습니다.')
    }
    throw new SdManagerError('BACKUP_FAILED', '백업할 파일 목록을 읽지 못했습니다.', error instanceof Error ? error.message : undefined)
  }
}

function detectDateFromFirstVideo(files: SourceFile[]): DetectedBackupDate {
  const firstVideo = [...files]
    .sort((left, right) => left.sourceRelativePath.localeCompare(right.sourceRelativePath, 'en', { numeric: true, sensitivity: 'base' }))
    .find((file) => {
      const fileName = basename(file.sourceRelativePath)
      return VIDEO_EXTENSIONS.has(extname(fileName).toLowerCase()) || BLACKBOX_VIDEO_NAME_PATTERN.test(fileName)
    })
  if (!firstVideo) {
    throw new SdManagerError('BACKUP_FAILED', '백업 대상에서 날짜를 확인할 영상 파일을 찾지 못했습니다. 날짜를 직접 선택하세요.')
  }
  const date = extractBackupDateFromFileName(basename(firstVideo.sourceRelativePath))
  if (!date) {
    throw new SdManagerError(
      'BACKUP_FAILED',
      '첫 번째 영상 파일명에서 YYYY-MM-DD 날짜를 찾지 못했습니다. 날짜를 직접 선택하세요.',
      firstVideo.sourceRelativePath
    )
  }
  return { date, sourceFile: firstVideo.sourceRelativePath }
}

async function getMetadataIfPresent(targetPath: string) {
  try {
    return await stat(targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function addNumericSuffix(relativePath: string, suffix: number): string {
  const extension = extname(relativePath)
  const fileName = basename(relativePath, extension)
  return join(dirname(relativePath), `${fileName}_${suffix}${extension}`)
}

async function assignAvailableDestinationPaths(destination: string, files: SourceFile[]): Promise<SourceFile[]> {
  const root = resolve(destination)
  const reservedPaths = new Set<string>()
  const assignedFiles: SourceFile[] = []
  for (const file of files) {
    const originalTargetPath = resolve(destination, file.destinationRelativePath)
    if (!isPathInsideRoot(root, originalTargetPath)) {
      throw new SdManagerError('BACKUP_DESTINATION_UNAVAILABLE', '안전하지 않은 백업 대상 경로가 감지되었습니다.')
    }
    let parent = dirname(originalTargetPath)
    while (parent !== root) {
      const metadata = await getMetadataIfPresent(parent)
      if (metadata && !metadata.isDirectory()) {
        throw new SdManagerError(
          'BACKUP_DESTINATION_UNAVAILABLE',
          '백업 경로의 기존 파일과 원본 폴더 구조가 충돌합니다.',
          relative(root, parent)
        )
      }
      const nextParent = dirname(parent)
      if (nextParent === parent) break
      parent = nextParent
    }
    let assigned = false
    for (let suffix = 0; suffix <= 9999; suffix += 1) {
      const destinationRelativePath = suffix === 0
        ? file.destinationRelativePath
        : addNumericSuffix(file.destinationRelativePath, suffix)
      const targetPath = resolve(destination, destinationRelativePath)
      const key = targetPath.toLowerCase()
      if (reservedPaths.has(key) || await getMetadataIfPresent(targetPath)) continue
      reservedPaths.add(key)
      assignedFiles.push({ ...file, destinationRelativePath })
      assigned = true
      break
    }
    if (!assigned) {
      throw new SdManagerError('BACKUP_DESTINATION_UNAVAILABLE', '중복되지 않는 백업 파일 이름을 만들 수 없습니다.')
    }
  }
  return assignedFiles
}

// wx로 파일 생성을 선점합니다. 다른 백업이 먼저 만들었으면 새 이름으로 재시도합니다.
async function openAvailableDestination(destination: string, relativePath: string, signal: AbortSignal) {
  for (let suffix = 0; suffix <= 9999; suffix += 1) {
    if (signal.aborted) throw new SdManagerError('BACKUP_CANCELLED', '백업이 취소되었습니다.')
    const destinationRelativePath = suffix === 0 ? relativePath : addNumericSuffix(relativePath, suffix)
    const targetPath = join(destination, destinationRelativePath)
    try {
      const handle = await open(targetPath, 'wx')
      return { handle, targetPath, destinationRelativePath }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new SdManagerError('BACKUP_FAILED', '중복되지 않는 백업 파일 이름을 만들 수 없습니다.')
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

export class BackupService {
  async detectBackupDate(drive: RemovableDrive, selection: BackupSelection | undefined): Promise<DetectedBackupDate> {
    const source = await collectBackupSource(drive, selection, new AbortController().signal)
    return detectDateFromFirstVideo(source.files)
  }

  async relativeSourceFolder(drive: RemovableDrive, selectedPath: string): Promise<string> {
    return relativeSourceFolderFromPath(drive.mountPath, selectedPath)
  }

  async relativeSourceFiles(drive: RemovableDrive, selectedPaths: string[]): Promise<string[]> {
    return relativeSourceFilesFromPaths(drive.mountPath, selectedPaths)
  }

  async assertBackupSelectionAvailable(drive: RemovableDrive, selection: BackupSelection | undefined): Promise<void> {
    if (!selection) return
    if (selection.kind === 'folder') {
      if (typeof selection.includeSourceFolder !== 'boolean') {
        throw new SdManagerError('INVALID_REQUEST', '선택 폴더 포함 옵션이 올바르지 않습니다.')
      }
      await resolveSourceFolderFromRoot(drive.mountPath, selection.relativePath)
      return
    }
    if (selection.kind !== 'files' || selection.relativePaths.length === 0) {
      throw new SdManagerError('INVALID_REQUEST', '백업할 파일을 하나 이상 선택하세요.')
    }
    await collectSelectedFiles(drive.mountPath, selection.relativePaths)
  }

  async assertBackupRootAvailable(backupRoot: string): Promise<void> {
    try {
      const metadata = await stat(backupRoot)
      if (!metadata.isDirectory()) throw new Error('Not a directory')
      await access(backupRoot, constants.W_OK)
    } catch (error) {
      throw new SdManagerError(
        'BACKUP_DESTINATION_UNAVAILABLE',
        '백업 경로에 접근하거나 쓸 수 없습니다.',
        error instanceof Error ? error.message : undefined
      )
    }
  }

  assertBackupRootOutsideSource(sourceRoot: string, backupRoot: string): void {
    const source = resolve(sourceRoot)
    const target = resolve(backupRoot)
    if (target === source || isPathInsideRoot(source, target)) {
      throw new SdManagerError('BACKUP_DESTINATION_ON_SOURCE', '백업 경로를 SD 카드 내부로 지정할 수 없습니다.')
    }
  }

  async backup(
    drive: RemovableDrive,
    backupRoot: string,
    backupTimeSlot: BackupTimeSlot,
    createBackupFolder: boolean,
    backupDateMode: BackupDateMode,
    requestedBackupDate: string | undefined,
    backupSelection: BackupSelection | undefined,
    signal: AbortSignal,
    onProgress: ProgressListener
  ): Promise<BackupResult> {
    this.assertBackupRootOutsideSource(drive.mountPath, backupRoot)
    await this.assertBackupRootAvailable(backupRoot)
    const source = await collectBackupSource(drive, backupSelection, signal)
    let { files } = source
    const { selection } = source
    if (selection && files.length === 0) {
      throw new SdManagerError('BACKUP_FAILED', '선택한 백업 대상에 파일이 없습니다. SD 카드는 포맷하지 않습니다.')
    }
    let backupDate: string | undefined
    if (createBackupFolder) {
      if (backupDateMode === 'manual') {
        if (!requestedBackupDate || !isValidBackupDate(requestedBackupDate)) {
          throw new SdManagerError('INVALID_REQUEST', '상위 폴더에 사용할 날짜를 직접 선택하세요.')
        }
        backupDate = requestedBackupDate
      } else {
        const detected = detectDateFromFirstVideo(files)
        if (requestedBackupDate && requestedBackupDate !== detected.date) {
          throw new SdManagerError('BACKUP_FAILED', '확인 후 첫 번째 영상 파일의 날짜가 변경되었습니다. 날짜를 다시 확인하세요.')
        }
        backupDate = detected.date
      }
    }
    const destinationRoot = backupDestinationRoot(backupRoot, createBackupFolder, backupTimeSlot, backupDate)
    if (destinationRoot !== backupRoot) {
      try {
        await mkdir(destinationRoot, { recursive: true })
      } catch (error) {
        throw new SdManagerError(
          'BACKUP_DESTINATION_UNAVAILABLE',
          '백업 폴더를 만들 수 없습니다.',
          error instanceof Error ? error.message : undefined
        )
      }
    }
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    const destination = destinationRoot
    files = await assignAvailableDestinationPaths(destination, files)
    let copiedBytes = 0
    let processedFiles = 0
    let lastProgressAt = 0

    const publish = (currentFile?: string, force = false): void => {
      const now = Date.now()
      if (!force && now - lastProgressAt < PROGRESS_EVENT_INTERVAL_MS) return
      lastProgressAt = now
      onProgress({
        processedFiles,
        totalFiles: files.length,
        copiedBytes,
        totalBytes,
        percent: totalBytes === 0 ? (processedFiles === files.length ? 100 : 0) : Math.min(100, Math.round((copiedBytes / totalBytes) * 100)),
        ...(currentFile ? { currentFile } : {})
      })
    }

    publish(undefined, true)
    for (const file of files) {
      if (signal.aborted) throw new SdManagerError('BACKUP_CANCELLED', '백업이 취소되었습니다.')
      const sourcePath = join(drive.mountPath, file.sourceRelativePath)
      try {
        await mkdir(dirname(join(destination, file.destinationRelativePath)), { recursive: true })
        const target = await openAvailableDestination(destination, file.destinationRelativePath, signal)
        file.destinationRelativePath = target.destinationRelativePath
        try {
          const source = createReadStream(sourcePath)
          source.on('data', (chunk: string | Buffer) => {
            copiedBytes += Buffer.byteLength(chunk)
            publish(file.sourceRelativePath)
          })
          await pipeline(source, target.handle.createWriteStream(), { signal })
          await utimes(target.targetPath, file.modifiedAt, file.modifiedAt)
        } finally {
          await target.handle.close()
        }
      } catch (error) {
        if (signal.aborted) throw new SdManagerError('BACKUP_CANCELLED', '백업이 취소되었습니다.')
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new SdManagerError('DEVICE_REMOVED', '백업 중 SD 카드가 제거되었습니다.')
        }
        throw new SdManagerError('BACKUP_FAILED', '파일 백업 중 오류가 발생했습니다.', error instanceof Error ? error.message : undefined)
      }
      processedFiles += 1
      publish(file.sourceRelativePath, true)
    }

    return { destination, files, totalBytes, ...(selection ? { selection } : {}) }
  }

  async verify(sourceRoot: string, backup: BackupResult, mode: VerificationMode): Promise<void> {
    try {
      const cardRoot = await realpath(sourceRoot)
      let currentFiles: SourceFile[]
      if (!backup.selection) {
        currentFiles = await collectFiles(cardRoot, cardRoot, new AbortController().signal)
      } else if (backup.selection.kind === 'folder') {
        const selectedSource = await resolveSourceFolderFromRoot(cardRoot, backup.selection.relativePath)
        currentFiles = await collectFiles(
          cardRoot,
          selectedSource.root,
          new AbortController().signal
        )
      } else {
        currentFiles = await collectSelectedFiles(cardRoot, backup.selection.relativePaths)
      }
      const expectedFiles = new Map(backup.files.map((file) => [file.sourceRelativePath, file.size]))
      const sourceSnapshotMatches =
        currentFiles.length === backup.files.length &&
        currentFiles.every((file) => expectedFiles.get(file.sourceRelativePath) === file.size)
      if (!sourceSnapshotMatches) {
        throw new Error('Source file list or size changed')
      }
    } catch (error) {
      if (error instanceof SdManagerError && ['DEVICE_REMOVED', 'PERMISSION_DENIED'].includes(error.code)) throw error
      throw new SdManagerError(
        'BACKUP_VERIFICATION_FAILED',
        '백업 중 원본 파일 목록 또는 크기가 변경되었습니다. SD 카드는 포맷하지 않습니다.',
        error instanceof Error ? error.message : undefined
      )
    }

    let verifiedBytes = 0
    for (const file of backup.files) {
      const sourcePath = join(sourceRoot, file.sourceRelativePath)
      const targetPath = join(backup.destination, file.destinationRelativePath)
      try {
        const target = await stat(targetPath)
        if (!target.isFile() || target.size !== file.size) throw new Error('Size mismatch')
        verifiedBytes += target.size
        if (mode === 'full') {
          const [sourceHash, targetHash] = await Promise.all([hashFile(sourcePath), hashFile(targetPath)])
          if (sourceHash !== targetHash) throw new Error('Hash mismatch')
        }
      } catch (error) {
        throw new SdManagerError(
          'BACKUP_VERIFICATION_FAILED',
          '백업 검증에 실패했습니다. SD 카드는 포맷하지 않습니다.',
          `${file.destinationRelativePath}: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      }
    }
    if (verifiedBytes !== backup.totalBytes) {
      throw new SdManagerError('BACKUP_VERIFICATION_FAILED', '백업 파일 크기 합계가 원본과 일치하지 않습니다.')
    }
  }
}
