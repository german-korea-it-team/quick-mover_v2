import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RemovableDrive } from '../../src/shared/types'
import { createMockDrive } from '../fixtures/mock-drive-platform'

const appUrl = process.env.QUICK_MOVER_FILE_TEST
  ? pathToFileURL(resolve('out/renderer/index.html')).href
  : '/'

for (const picker of ['choose-drive-backup', 'choose-source', 'choose-source-files']) {
  for (const modal of ['load-settings', 'save-settings']) {
    test(`${picker} 선택 후 ${modal} 모달을 닫고 다시 연다`, async ({ page }) => {
      await installApiMock(page, [createMockDrive()])
      await page.goto(appUrl)
      await page.getByTestId(`${picker}-E:`).click()
      const opener = page.getByTestId(`${modal}-E:`)
      const dialog = page.getByRole('dialog')
      await opener.click()
      await expect(dialog).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await opener.click()
      await expect(dialog).toBeVisible()
      await page.locator('.v-overlay__scrim').click({ position: { x: 5, y: 5 } })
      await expect(dialog).toBeHidden()
      await opener.click()
      await expect(dialog).toBeVisible()
    })
  }
}

async function installApiMock(page: Page, drives: RemovableDrive[]): Promise<void> {
  await page.addInitScript((initialDrives) => {
    let currentDrives = initialDrives
    let operations: Array<Record<string, unknown>> = []
    let lastRequest: Record<string, unknown> | undefined
    const driveListeners: Array<(value: typeof initialDrives) => void> = []
    const operationListeners: Array<(value: Record<string, unknown>) => void> = []
    const settings = {
      backupFavoritePaths: [],
      verificationMode: 'fast' as const,
      cardSettings: Object.fromEntries(
        initialDrives.map((drive) => [
          drive.physicalDiskIdentifier,
          { backupRoot: 'D:\\SD_Backup', createBackupFolder: true, backupDateMode: 'auto' as const, profile: 'blackbox' as const }
        ])
      ),
      savedCardPresets: []
    }

    Object.defineProperty(window, 'sdManager', {
      value: {
        listDrives: async () => currentDrives,
        chooseBackupRoot: async () => 'D:\\Selected_Backup',
        chooseSourceFolder: async () => 'Driving',
        chooseSourceFiles: async () => ['Driving/front.mp4', 'Driving/rear.mp4'],
        detectBackupDate: async (request: unknown) => {
          structuredClone(request)
          return {
            success: true,
            detected: { date: '2026-09-01', sourceFile: 'Driving/(2026-09-01) front.mp4' }
          }
        },
        getSettings: async () => settings,
        saveSettings: async (next: typeof settings) => Object.assign(settings, structuredClone(next)),
        getOperations: async () => operations,
        startProcess: async (request: { driveId: string; profile: string; displayName?: string }) => {
          lastRequest = structuredClone(request)
          const drive = currentDrives.find((candidate) => candidate.id === request.driveId)
          if (!drive) return { success: false, error: { code: 'DRIVE_NOT_FOUND', message: 'SD 카드를 찾을 수 없습니다.' } }
          const operation = {
            id: `operation-${operations.length + 1}`,
            driveId: drive.id,
            driveLetter: drive.driveLetter,
            displayName: request.displayName,
            profile: request.profile,
            state: 'queued',
            progress: { processedFiles: 0, totalFiles: 0, copiedBytes: 0, totalBytes: 0, percent: 0 }
          }
          operations = [...operations, operation]
          operationListeners.forEach((listener) => listener(operation))
          return { success: true, operationId: operation.id }
        },
        cancelOperation: async () => ({ success: true }),
        onDrivesChanged: (listener: (value: typeof initialDrives) => void) => {
          driveListeners.push(listener)
          return () => undefined
        },
        onOperationChanged: (listener: (value: Record<string, unknown>) => void) => {
          operationListeners.push(listener)
          return () => undefined
        }
      }
    })
    Object.defineProperty(window, '__quickMoverTest', {
      value: {
        setDrives(next: typeof initialDrives) {
          currentDrives = next
          driveListeners.forEach((listener) => listener(next))
        },
        updateOperation(next: Record<string, unknown>) {
          operations = operations.map((operation) => (operation.id === next.id ? next : operation))
          operationListeners.forEach((listener) => listener(next))
        },
        getLastRequest() {
          return lastRequest
        }
      }
    })
  }, drives)
}

test('SD 카드가 없으면 빈 상태를 표시한다', async ({ page }) => {
  await installApiMock(page, [])
  await page.goto(appUrl)
  await expect(page.getByText('연결된 이동식 SD 카드가 없습니다.')).toBeVisible()
})

test('여러 SD 카드를 표시하고 각 카드의 프로필을 선택한다', async ({ page }) => {
  const drives = [
    createMockDrive(),
    createMockDrive({
      id: 'PHYSICAL-2::VOLUME-2::1',
      physicalDiskIdentifier: 'PHYSICAL-2',
      volumeIdentifier: 'VOLUME-2',
      driveLetter: 'F:',
      volumeLabel: 'GPS_CARD'
    })
  ]
  await installApiMock(page, drives)
  await page.goto(appUrl)
  await expect(page.getByTestId('drive-E:')).toBeVisible()
  await expect(page.getByTestId('drive-F:')).toBeVisible()
  await page.getByTestId('drive-F:').getByLabel('카드 종류').press('ArrowDown')
  await page.getByRole('option', { name: 'GPS 로거' }).click()
  await expect(page.getByTestId('drive-F:').getByText('GPS 로거')).toBeVisible()
})

test('사용자 확인 후 작업을 큐에 등록하고 포맷 단계에서 취소를 숨긴다', async ({ page }) => {
  const drive = createMockDrive()
  await installApiMock(page, [drive])
  await page.goto(appUrl)
  await page.getByTestId('start-E:').click()
  await expect(page.getByText('E: 드라이브의 모든 데이터를')).toBeVisible()
  await page.getByTestId('confirm-start').click()
  const row = page.getByTestId('operation-E:')
  await expect(row.getByText('대기열')).toBeVisible()

  await page.evaluate(() => {
    const harness = (window as unknown as { __quickMoverTest: { updateOperation(value: Record<string, unknown>): void } }).__quickMoverTest
    harness.updateOperation({
      id: 'operation-1',
      driveId: 'PHYSICAL-1::VOLUME-1::1',
      driveLetter: 'E:',
      profile: 'blackbox',
      state: 'formatting',
      progress: { processedFiles: 2, totalFiles: 2, copiedBytes: 100, totalBytes: 100, percent: 100 }
    })
  })
  await expect(row.getByText('포맷 중')).toBeVisible()
  await expect(row.getByText('처리 중입니다. SD 카드를 제거하지 마세요.')).toBeVisible()
  await expect(row.getByRole('button', { name: '취소' })).toHaveCount(0)
})

test('탐색기에서 선택한 폴더의 MP4만 백업하려면 제외 데이터 삭제 동의가 필요하다', async ({ page }) => {
  await installApiMock(page, [createMockDrive()])
  await page.goto(appUrl)
  const driveRow = page.getByTestId('drive-E:')

  await driveRow.getByTestId('choose-source-E:').click()
  await expect(driveRow.getByText('E:\\Driving')).toBeVisible()
  await expect(driveRow.getByTestId('include-source-folder-E:').getByRole('checkbox')).not.toBeChecked()
  await driveRow.getByLabel('백업 파일 범위').press('ArrowDown')
  await page.getByRole('option', { name: 'MP4만' }).click()

  await page.getByTestId('start-E:').click()
  await expect(page.getByText('선택하지 않은 파일과 폴더는 백업되지 않으며 포맷 후 삭제됩니다.')).toBeVisible()
  await expect(page.getByTestId('confirm-start')).toBeDisabled()
  await page.getByTestId('selective-data-loss-confirmation').getByRole('checkbox').check()
  await expect(page.getByTestId('confirm-start')).toBeEnabled()
  await page.getByTestId('confirm-start').click()

  const lastRequest = await page.evaluate(() => {
    const harness = (window as unknown as {
      __quickMoverTest: { getLastRequest(): Record<string, unknown> | undefined }
    }).__quickMoverTest
    return harness.getLastRequest()
  })
  expect(lastRequest).toMatchObject({
    backupSelection: { kind: 'folder', relativePath: 'Driving', fileFilter: 'mp4', includeSourceFolder: false },
    selectiveBackupConfirmed: true
  })
})

test('탐색기에서 선택한 여러 파일만 백업 대상으로 전달한다', async ({ page }) => {
  await installApiMock(page, [createMockDrive()])
  await page.goto(appUrl)
  const driveRow = page.getByTestId('drive-E:')

  await driveRow.getByTestId('choose-source-files-E:').click()
  await expect(driveRow.getByText(/2개 파일 · front\.mp4, rear\.mp4/)).toBeVisible()
  await expect(driveRow.getByLabel('백업 파일 범위')).toHaveCount(0)

  await page.getByTestId('start-E:').click()
  await expect(page.getByText('선택 파일 2개')).toBeVisible()
  await page.getByTestId('selective-data-loss-confirmation').getByRole('checkbox').check()
  await expect(page.getByTestId('confirm-start')).toBeEnabled()
  await page.getByTestId('confirm-start').click()

  const lastRequest = await page.evaluate(() => {
    const harness = (window as unknown as {
      __quickMoverTest: { getLastRequest(): Record<string, unknown> | undefined }
    }).__quickMoverTest
    return harness.getLastRequest()
  })
  expect(lastRequest).toMatchObject({
    backupSelection: { kind: 'files', relativePaths: ['Driving/front.mp4', 'Driving/rear.mp4'] },
    selectiveBackupConfirmed: true
  })
})

test('작업 중 SD 카드가 제거되면 목록에서 제거한다', async ({ page }) => {
  await installApiMock(page, [createMockDrive()])
  await page.goto(appUrl)
  await expect(page.getByTestId('drive-E:')).toBeVisible()
  await page.evaluate(() => {
    const harness = (window as unknown as { __quickMoverTest: { setDrives(value: never[]): void } }).__quickMoverTest
    harness.setDrives([])
  })
  await expect(page.getByTestId('drive-E:')).toHaveCount(0)
  await expect(page.getByText('연결된 이동식 SD 카드가 없습니다.')).toBeVisible()
})

test('날짜별 백업 폴더 생성 여부를 설정한다', async ({ page }) => {
  await installApiMock(page, [createMockDrive()])
  await page.goto(appUrl)
  await page.getByTestId('backup-folder-mode-E:').click()
  await page.getByRole('option', { name: '생성 안 함' }).click()
})

test('카드별 백업 경로와 앱 전용 표시 이름을 설정한다', async ({ page }) => {
  await installApiMock(page, [createMockDrive()])
  await page.goto(appUrl)
  const driveRow = page.getByTestId('drive-E:')

  await driveRow.getByTestId('display-name-E:').locator('input').fill('차량 12번')
  await driveRow.getByTestId('display-name-E:').locator('input').press('Tab')
  await driveRow.getByTestId('format-label-E:').locator('input').fill('CAR-12')
  await driveRow.getByTestId('format-label-E:').locator('input').press('Tab')
  await driveRow.getByTestId('choose-drive-backup-E:').click()
  await expect(driveRow.getByText('D:\\Selected_Backup')).toBeVisible()
  await expect(page.getByText('설정을 저장하지 못했습니다.')).toHaveCount(0)

  await driveRow.getByTestId('start-E:').click()
  await expect(page.getByRole('dialog').getByText('D:\\Selected_Backup')).toBeVisible()
  await expect(page.getByText('포맷 후 볼륨 이름:')).toBeVisible()
  await expect(page.getByText('CAR-12')).toBeVisible()
  await page.getByTestId('confirm-start').click()
  await expect(page.getByTestId('operation-E:').getByText('차량 12번')).toBeVisible()
})
