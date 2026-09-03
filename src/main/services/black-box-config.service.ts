import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, opendir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { SdManagerError } from './errors'

interface ConfigFile {
  relativePath: string
  size: number
  hash: string
}

export interface BlackBoxConfigInstallResult {
  destinationRoot: string
  directories: string[]
  files: ConfigFile[]
}

interface BlackBoxConfigSource {
  directories: string[]
  files: ConfigFile[]
}

const EMPTY_DIRECTORY_MARKER = '.quick-mover-directory'

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

function resolveDestinationPath(destinationRoot: string, relativePath: string): string {
  const root = resolve(destinationRoot)
  const target = resolve(root, relativePath)
  const pathFromRoot = relative(root, target)
  if (!pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new SdManagerError('CONFIG_INSTALL_FAILED', '안전하지 않은 블랙박스 설정 파일 경로가 감지되었습니다.')
  }
  return target
}

export class BlackBoxConfigService {
  constructor(private readonly sourceRoot: string) {}

  async assertSourceAvailable(): Promise<void> {
    await this.collectSource()
  }

  async install(destinationRoot: string): Promise<BlackBoxConfigInstallResult> {
    const source = await this.collectSource()

    try {
      for (const directory of source.directories) {
        await mkdir(resolveDestinationPath(destinationRoot, directory), { recursive: true })
      }
      for (const file of source.files) {
        const sourcePath = join(this.sourceRoot, file.relativePath)
        const destinationPath = resolveDestinationPath(destinationRoot, file.relativePath)
        await mkdir(dirname(destinationPath), { recursive: true })
        await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL)
      }
    } catch (error) {
      if (error instanceof SdManagerError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENODEV') {
        throw new SdManagerError('DEVICE_REMOVED', '설정 파일 복사 중 SD 카드가 제거되었습니다.')
      }
      throw new SdManagerError(
        'CONFIG_INSTALL_FAILED',
        '블랙박스 설정 파일을 SD 카드에 복사하지 못했습니다.',
        error instanceof Error ? error.message : undefined
      )
    }

    return { destinationRoot, directories: source.directories, files: source.files }
  }

  async verify(result: BlackBoxConfigInstallResult): Promise<void> {
    for (const directory of result.directories) {
      const destinationPath = resolveDestinationPath(result.destinationRoot, directory)
      try {
        const metadata = await stat(destinationPath)
        if (!metadata.isDirectory()) throw new Error('Not a directory')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENODEV') {
          throw new SdManagerError('DEVICE_REMOVED', '설정 폴더 검증 중 SD 카드가 제거되었습니다.')
        }
        throw new SdManagerError(
          'CONFIG_VERIFICATION_FAILED',
          'SD 카드의 블랙박스 설정 폴더 검증에 실패했습니다.',
          `${directory}: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      }
    }
    for (const file of result.files) {
      const destinationPath = resolveDestinationPath(result.destinationRoot, file.relativePath)
      try {
        const metadata = await stat(destinationPath)
        if (!metadata.isFile() || metadata.size !== file.size) throw new Error('Size mismatch')
        if ((await hashFile(destinationPath)) !== file.hash) throw new Error('Hash mismatch')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENODEV') {
          throw new SdManagerError('DEVICE_REMOVED', '설정 파일 검증 중 SD 카드가 제거되었습니다.')
        }
        throw new SdManagerError(
          'CONFIG_VERIFICATION_FAILED',
          'SD 카드의 블랙박스 설정 파일 검증에 실패했습니다.',
          `${file.relativePath}: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      }
    }
  }

  private async collectSource(): Promise<BlackBoxConfigSource> {
    const directories: string[] = []
    const files: ConfigFile[] = []

    const walk = async (current: string): Promise<void> => {
      const directory = await opendir(current)
      for await (const entry of directory) {
        const absolutePath = join(current, entry.name)
        if (entry.isSymbolicLink()) {
          throw new SdManagerError(
            'CONFIG_INSTALL_FAILED',
            '블랙박스 설정 원본에 심볼릭 링크가 포함되어 있습니다.',
            relative(this.sourceRoot, absolutePath)
          )
        }
        if (entry.isDirectory()) {
          directories.push(relative(this.sourceRoot, absolutePath))
          await walk(absolutePath)
        } else if (entry.isFile() && entry.name !== EMPTY_DIRECTORY_MARKER) {
          const metadata = await stat(absolutePath)
          files.push({
            relativePath: relative(this.sourceRoot, absolutePath),
            size: metadata.size,
            hash: await hashFile(absolutePath)
          })
        }
      }
    }

    try {
      const metadata = await stat(this.sourceRoot)
      if (!metadata.isDirectory()) throw new Error('Not a directory')
      await walk(this.sourceRoot)
    } catch (error) {
      if (error instanceof SdManagerError) throw error
      throw new SdManagerError(
        'CONFIG_INSTALL_FAILED',
        '블랙박스 설정 원본 디렉터리를 읽을 수 없습니다.',
        error instanceof Error ? error.message : undefined
      )
    }

    if (files.length === 0) {
      throw new SdManagerError('CONFIG_INSTALL_FAILED', '블랙박스 설정 원본 디렉터리가 비어 있습니다.')
    }
    return { directories, files }
  }
}
