<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RemovableDrive, SdOperation } from '../../shared/types'
import { useSdManager } from './composables/useSdManager'

const {
  drives,
  operations,
  profiles,
  backupTimeSlots,
  backupSelections,
  settings,
  loadingDrives,
  activeDriveIds,
  error,
  refreshDrives,
  addBackupRootForDriveToFavorites,
  removeBackupFavorite,
  chooseBackupRootForDrive,
  selectBackupFavoriteForDrive,
  createBackupFolderForDrive,
  setCreateBackupFolderForDrive,
  chooseSourceFolder,
  chooseSourceFiles,
  clearBackupSelection,
  cardSettingsForDrive,
  folderSelectionForDrive,
  backupRootForDrive,
  formatVolumeLabelForDrive,
  folderFileFilterForDrive,
  setFolderFileFilterForDrive,
  includesSourceFolderForDrive,
  setIncludesSourceFolderForDrive,
  saveSettings,
  start,
  cancel
} = useSdManager()

const confirmationDrive = ref<RemovableDrive>()
const confirming = ref(false)
const selectiveDataLossConfirmed = ref(false)
const latestOperations = computed(() => [...operations.value].reverse())

const profileItems = [
  { title: '블랙박스', value: 'blackbox' },
  { title: 'GPS 로거', value: 'gps' }
]

const timeSlotItems = [
  { title: '단일', value: 'single' },
  { title: '주간', value: 'day' },
  { title: '야간', value: 'night' }
]

const verificationItems = [
  { title: '빠른 검증 (파일 수·크기)', value: 'fast' },
  { title: '전체 검증 (SHA-256)', value: 'full' }
]

const fileFilterItems = [
  { title: '모든 파일', value: 'all' },
  { title: 'MP4만', value: 'mp4' }
]

const TOOLTIP_LENGTH = {
  displayName: 14,
  formatLabel: 9,
  backupPath: 40,
  backupSelection: 40
} as const

const stateLabels: Record<SdOperation['state'], string> = {
  idle: '대기',
  detecting: '감지 중',
  ready: '준비',
  queued: '대기열',
  'backup-preparing': '백업 준비',
  'backing-up': '백업 중',
  'backup-verifying': '백업 검증',
  formatting: '포맷 중',
  'format-verifying': '포맷 검증',
  'installing-config': '설정 복사',
  'config-verifying': '설정 검증',
  completed: '완료',
  failed: '실패',
  cancelled: '취소됨'
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`
}

function stateColor(state: SdOperation['state']): string {
  if (state === 'completed') return 'success'
  if (state === 'failed') return 'error'
  if (state === 'cancelled') return 'secondary'
  if (['formatting', 'format-verifying', 'installing-config', 'config-verifying'].includes(state)) return 'warning'
  return 'primary'
}

function operationForDrive(driveId: string): SdOperation | undefined {
  return latestOperations.value.find((operation) => operation.driveId === driveId)
}

function requestStart(drive: RemovableDrive): void {
  selectiveDataLossConfirmed.value = false
  confirmationDrive.value = drive
}

function closeConfirmation(): void {
  if (confirming.value) return
  confirmationDrive.value = undefined
  selectiveDataLossConfirmed.value = false
}

function hasLongText(value: string | undefined, maximumLength: number): boolean {
  return Boolean(value && value.length > maximumLength)
}

function truncateText(value: string, maximumLength: number): string {
  if (value.length < maximumLength) return value
  return `${value.slice(0, maximumLength - 3)}...`
}

function fileNameFromRelativePath(relativePath: string): string {
  return relativePath.split(/[\\/]/).pop() || relativePath
}

function sourceSelectionDisplay(drive: RemovableDrive): string {
  const selection = backupSelections[drive.id]
  if (!selection) return '전체 SD 카드'
  if (selection.kind === 'files') {
    const preview = selection.relativePaths.slice(0, 2).map(fileNameFromRelativePath).join(', ')
    const remainder = selection.relativePaths.length > 2 ? ` 외 ${selection.relativePaths.length - 2}개` : ''
    return `${selection.relativePaths.length}개 파일 · ${preview}${remainder}`
  }
  return `${drive.driveLetter}\\${selection.relativePath.replaceAll('/', '\\')}`
}

function sourceSelectionDetail(drive: RemovableDrive): string {
  const selection = backupSelections[drive.id]
  if (!selection) return '전체 SD 카드'
  if (selection.kind === 'folder') return sourceSelectionDisplay(drive)
  const paths = selection.relativePaths.slice(0, 30).map((path) => path.replaceAll('/', '\\'))
  if (selection.relativePaths.length > paths.length) paths.push(`외 ${selection.relativePaths.length - paths.length}개`)
  return `선택 파일 ${selection.relativePaths.length}개\n${paths.join('\n')}`
}

function fileFilterLabel(drive: RemovableDrive): string {
  return folderFileFilterForDrive(drive) === 'mp4' ? 'MP4만' : '모든 파일'
}

function selectedFileCount(drive: RemovableDrive): number {
  const selection = backupSelections[drive.id]
  return selection?.kind === 'files' ? selection.relativePaths.length : 0
}

function isBackupRootForDriveFavorite(drive: RemovableDrive): boolean {
  const current = backupRootForDrive(drive).trim().toLowerCase()
  return Boolean(current && settings.backupFavoritePaths.some((path) => path.toLowerCase() === current))
}

function timeSlotLabel(drive: RemovableDrive): string {
  const timeSlot = backupTimeSlots[drive.id] ?? 'single'
  return timeSlotItems.find((item) => item.value === timeSlot)?.title ?? '단일'
}

async function confirmStart(): Promise<void> {
  if (!confirmationDrive.value) return
  confirming.value = true
  const selection = backupSelections[confirmationDrive.value.id]
  if (selection && !selectiveDataLossConfirmed.value) return
  const started = await start(confirmationDrive.value, Boolean(selection && selectiveDataLossConfirmed.value))
  confirming.value = false
  if (started) closeConfirmation()
}
</script>

<template>
  <v-app>
    <v-app-bar density="compact" color="surface" elevation="1">
      <v-app-bar-title class="text-subtitle-1 font-weight-bold">
        Quick Mover
      </v-app-bar-title>
      <span class="text-caption text-medium-emphasis mr-4">SD 카드 백업 및 포맷</span>
    </v-app-bar>

    <v-main>
      <div class="workspace">
        <section class="settings-row" aria-labelledby="backup-heading">
          <div id="backup-heading" class="section-label">
            백업 설정
          </div>
          <v-select
            v-model="settings.verificationMode"
            :items="verificationItems"
            label="검증 방식"
            hide-details
            class="verification-select"
            @update:model-value="saveSettings"
          ></v-select>
        </section>

        <v-alert v-if="error" type="error" density="compact" variant="tonal" closable class="mb-3" @click:close="error = undefined">
          {{ error.message }}
        </v-alert>

        <section class="panel" aria-labelledby="drives-heading">
          <header class="panel-header">
            <div>
              <h2 id="drives-heading">
                연결된 SD 카드
              </h2>
              <span class="text-caption text-medium-emphasis">현재 PC에 연결된 이동식 디스크만 표시합니다.</span>
            </div>
            <v-btn size="small" variant="text" :loading="loadingDrives" prepend-icon="mdi-refresh" @click="refreshDrives">
              새로 고침
            </v-btn>
          </header>

          <v-table density="compact" class="drive-table">
            <thead>
              <tr>
                <th>카드</th>
                <th class="name-column">
                  메모
                </th>
                <th class="format-label-column">
                  볼륨 이름
                </th>
                <th>볼륨</th>
                <th>용량</th>
                <th class="backup-path-column">
                  백업 경로
                </th>
                <th class="backup-folder-column">
                  <div class="table-header-with-info">
                    <v-tooltip location="top" :open-delay="350" max-width="360">
                      <template #activator="{ props }">
                        <v-icon
                          v-bind="props"
                          icon="mdi-information-outline"
                          size="small"
                          aria-label="상위 폴더 생성 설명"
                        ></v-icon>
                      </template>
                      oooo년-oo월-oo일 폴더를 생성한 후, 해당 폴더의 내부에 백업합니다.
                    </v-tooltip>
                    <span>상위 폴더 생성</span>
                  </div>
                </th>
                <th class="source-scope-column">
                  백업 대상
                </th>
                <th class="profile-column">
                  종류
                </th>
                <th class="time-slot-column">
                  <div class="table-header-with-info">
                    <v-tooltip location="top" :open-delay="350" max-width="420">
                      <template #activator="{ props }">
                        <v-icon
                          v-bind="props"
                          icon="mdi-information-outline"
                          size="small"
                          aria-label="시간대 설명"
                        ></v-icon>
                      </template>
                      <div>단일: 아무 폴더도 생성하지 않고 백업합니다.</div>
                      <div>주간: 1 폴더 생성 후 해당 폴더 내부에 백업합니다.</div>
                      <div>야간: 2 폴더 생성 후 해당 폴더 내부에 백업합니다.</div>
                    </v-tooltip>
                    <span>시간대</span>
                  </div>
                </th>
                <th>상태</th>
                <th class="action-column">
                  작업
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="drives.length === 0">
                <td colspan="12" class="empty-row">
                  연결된 이동식 SD 카드가 없습니다.
                </td>
              </tr>
              <tr v-for="drive in drives" :key="drive.id" :data-testid="`drive-${drive.driveLetter}`">
                <td class="font-weight-bold">
                  {{ drive.driveLetter }}
                </td>
                <td>
                  <div class="truncate-field">
                    <v-text-field
                      v-model="cardSettingsForDrive(drive).displayName"
                      label="메모"
                      density="compact"
                      hide-details
                      maxlength="80"
                      :disabled="activeDriveIds.has(drive.id)"
                      :data-testid="`display-name-${drive.driveLetter}`"
                      @change="saveSettings"
                    ></v-text-field>
                    <v-tooltip
                      v-if="hasLongText(cardSettingsForDrive(drive).displayName, TOOLTIP_LENGTH.displayName)"
                      activator="parent"
                      location="top"
                      :open-delay="350"
                      max-width="360"
                    >
                      {{ cardSettingsForDrive(drive).displayName }}
                    </v-tooltip>
                  </div>
                </td>
                <td>
                  <div class="truncate-field">
                    <v-text-field
                      v-model="cardSettingsForDrive(drive).formatVolumeLabel"
                      label="비우면 현재 이름 유지"
                      density="compact"
                      hide-details
                      maxlength="11"
                      :disabled="activeDriveIds.has(drive.id)"
                      :data-testid="`format-label-${drive.driveLetter}`"
                      @change="saveSettings"
                    ></v-text-field>
                    <v-tooltip
                      v-if="hasLongText(cardSettingsForDrive(drive).formatVolumeLabel, TOOLTIP_LENGTH.formatLabel)"
                      activator="parent"
                      location="top"
                      :open-delay="350"
                      max-width="260"
                    >
                      {{ cardSettingsForDrive(drive).formatVolumeLabel }}
                    </v-tooltip>
                  </div>
                </td>
                <td>{{ drive.volumeLabel || '이름 없음' }}</td>
                <td>
                  {{ formatBytes(drive.capacityBytes) }}
                  <span class="text-caption text-medium-emphasis">{{ drive.filesystem || '알 수 없음' }}</span>
                </td>
                <td>
                  <div class="drive-backup-path">
                    <span class="path-value">
                      {{ truncateText(backupRootForDrive(drive) || '백업 경로 필요', TOOLTIP_LENGTH.backupPath) }}
                      <v-tooltip
                        v-if="backupRootForDrive(drive).length >= TOOLTIP_LENGTH.backupPath"
                        activator="parent"
                        location="top"
                        :open-delay="350"
                        max-width="480"
                      >
                        {{ backupRootForDrive(drive) }}
                      </v-tooltip>
                    </span>
                    <v-btn
                      size="x-small"
                      variant="text"
                      :disabled="activeDriveIds.has(drive.id)"
                      :data-testid="`choose-drive-backup-${drive.driveLetter}`"
                      @click="chooseBackupRootForDrive(drive)"
                    >
                      변경
                    </v-btn>
                    <v-menu location="bottom end">
                      <template #activator="{ props }">
                        <v-btn
                          v-bind="props"
                          size="x-small"
                          variant="text"
                          icon="mdi-star-outline"
                          aria-label="즐겨찾기 백업 경로 선택"
                          :disabled="activeDriveIds.has(drive.id)"
                          :data-testid="`drive-backup-favorites-${drive.driveLetter}`"
                        ></v-btn>
                      </template>
                      <v-card class="favorite-menu" rounded="sm" min-width="360" max-width="480">
                        <v-card-title class="favorite-menu-header text-body-2 font-weight-bold">
                          백업 경로 즐겨찾기
                          <v-spacer></v-spacer>
                          <v-btn
                            size="small"
                            variant="text"
                            prepend-icon="mdi-star-plus-outline"
                            :disabled="!backupRootForDrive(drive) || isBackupRootForDriveFavorite(drive)"
                            :data-testid="`add-backup-favorite-${drive.driveLetter}`"
                            @click="addBackupRootForDriveToFavorites(drive)"
                          >
                            현재 경로 추가
                          </v-btn>
                        </v-card-title>
                        <v-divider></v-divider>
                        <div v-if="settings.backupFavoritePaths.length === 0" class="favorite-empty text-caption text-medium-emphasis">
                          저장된 경로가 없습니다.
                        </div>
                        <v-list v-else density="compact">
                          <v-list-item
                            v-for="path in settings.backupFavoritePaths"
                            :key="path"
                            :title="path"
                            @click="selectBackupFavoriteForDrive(drive, path)"
                          >
                            <template #append>
                              <v-btn
                                size="x-small"
                                variant="text"
                                icon="mdi-close"
                                :aria-label="`${path} 즐겨찾기 삭제`"
                                @click.stop="removeBackupFavorite(path)"
                              ></v-btn>
                            </template>
                          </v-list-item>
                        </v-list>
                      </v-card>
                    </v-menu>
                  </div>
                </td>
                <td>
                  <v-switch
                    :model-value="createBackupFolderForDrive(drive)"
                    aria-label="폴더 생성"
                    color="primary"
                    density="compact"
                    hide-details
                    :disabled="activeDriveIds.has(drive.id)"
                    :data-testid="`create-backup-folder-${drive.driveLetter}`"
                    @update:model-value="setCreateBackupFolderForDrive(drive, $event)"
                  ></v-switch>
                </td>
                <td>
                  <div class="source-scope">
                    <span class="path-value">
                      {{ truncateText(sourceSelectionDisplay(drive), TOOLTIP_LENGTH.backupSelection) }}
                      <v-tooltip
                        v-if="sourceSelectionDisplay(drive).length >= TOOLTIP_LENGTH.backupSelection"
                        activator="parent"
                        location="top"
                        :open-delay="350"
                        max-width="480"
                      >
                        <span class="tooltip-detail">{{ sourceSelectionDetail(drive) }}</span>
                      </v-tooltip>
                    </span>
                    <v-btn
                      size="x-small"
                      variant="text"
                      :disabled="activeDriveIds.has(drive.id)"
                      :data-testid="`choose-source-${drive.driveLetter}`"
                      @click="chooseSourceFolder(drive)"
                    >
                      폴더
                    </v-btn>
                    <v-btn
                      size="x-small"
                      variant="text"
                      :disabled="activeDriveIds.has(drive.id)"
                      :data-testid="`choose-source-files-${drive.driveLetter}`"
                      @click="chooseSourceFiles(drive)"
                    >
                      파일
                    </v-btn>
                    <v-btn
                      v-if="backupSelections[drive.id]"
                      size="x-small"
                      variant="text"
                      :disabled="activeDriveIds.has(drive.id)"
                      :data-testid="`use-full-source-${drive.driveLetter}`"
                      @click="clearBackupSelection(drive)"
                    >
                      전체
                    </v-btn>
                  </div>
                  <v-select
                    v-if="folderSelectionForDrive(drive)"
                    :model-value="folderFileFilterForDrive(drive)"
                    :items="fileFilterItems"
                    density="compact"
                    hide-details
                    aria-label="백업 파일 범위"
                    :disabled="activeDriveIds.has(drive.id)"
                    :data-testid="`source-filter-${drive.driveLetter}`"
                    @update:model-value="setFolderFileFilterForDrive(drive, $event)"
                  ></v-select>
                  <v-checkbox
                    v-if="folderSelectionForDrive(drive)"
                    :model-value="includesSourceFolderForDrive(drive)"
                    label="선택 폴더 포함"
                    density="compact"
                    hide-details
                    :disabled="activeDriveIds.has(drive.id)"
                    :data-testid="`include-source-folder-${drive.driveLetter}`"
                    @update:model-value="setIncludesSourceFolderForDrive(drive, $event)"
                  ></v-checkbox>
                </td>
                <td>
                  <v-select
                    v-model="profiles[drive.id]"
                    :items="profileItems"
                    hide-details
                    aria-label="카드 종류"
                    :disabled="activeDriveIds.has(drive.id)"
                  ></v-select>
                </td>
                <td>
                  <v-select
                    v-model="backupTimeSlots[drive.id]"
                    :items="timeSlotItems"
                    hide-details
                    aria-label="시간대"
                    :disabled="activeDriveIds.has(drive.id)"
                    :data-testid="`time-slot-${drive.driveLetter}`"
                  ></v-select>
                </td>
                <td>
                  <v-chip v-if="operationForDrive(drive.id)" size="small" :color="stateColor(operationForDrive(drive.id)!.state)" variant="tonal">
                    {{ stateLabels[operationForDrive(drive.id)!.state] }}
                  </v-chip>
                  <v-chip v-else size="small" color="secondary" variant="tonal">
                    준비
                  </v-chip>
                </td>
                <td class="text-right">
                  <v-btn
                    size="small"
                    color="primary"
                    :disabled="activeDriveIds.has(drive.id) || !backupRootForDrive(drive)"
                    :data-testid="`start-${drive.driveLetter}`"
                    @click="requestStart(drive)"
                  >
                    시작
                  </v-btn>
                </td>
              </tr>
            </tbody>
          </v-table>
        </section>

        <section class="panel" aria-labelledby="operations-heading">
          <header class="panel-header">
            <div>
              <h2 id="operations-heading">
                작업 Queue
              </h2>
              <span class="text-caption text-medium-emphasis">오래 걸리더라도 기다려주세요.. 🥹</span>
            </div>
          </header>

          <v-table density="compact" class="operation-table">
            <thead>
              <tr>
                <th>드라이브</th>
                <th>종류</th>
                <th>단계</th>
                <th class="progress-column">
                  진행
                </th>
                <th>현재 파일 / 결과</th>
                <th class="action-column"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="latestOperations.length === 0">
                <td colspan="6" class="empty-row">
                  등록된 작업이 없습니다.
                </td>
              </tr>
              <tr v-for="operation in latestOperations" :key="operation.id" :data-testid="`operation-${operation.driveLetter}`">
                <td class="font-weight-bold">
                  {{ operation.displayName || operation.driveLetter }}
                  <span v-if="operation.displayName" class="text-caption text-medium-emphasis">({{ operation.driveLetter }})</span>
                </td>
                <td>{{ operation.profile === 'blackbox' ? '블랙박스' : 'GPS 로거' }}</td>
                <td>
                  <v-chip size="small" :color="stateColor(operation.state)" variant="tonal">
                    {{ stateLabels[operation.state] }}
                  </v-chip>
                </td>
                <td>
                  <div class="progress-cell">
                    <v-progress-linear :model-value="operation.progress.percent" height="8" rounded="0"></v-progress-linear>
                    <span>{{ operation.progress.percent }}%</span>
                  </div>
                </td>
                <td class="result-cell">
                  <span v-if="operation.error" class="text-error">{{ operation.error.message }}</span>
                  <span v-else-if="['formatting', 'format-verifying', 'installing-config', 'config-verifying'].includes(operation.state)">
                    처리 중입니다. SD 카드를 제거하지 마세요.
                  </span>
                  <span v-else-if="operation.backupDestination && operation.state === 'completed'">{{ operation.backupDestination }}</span>
                  <span v-else>{{ operation.progress.currentFile || '-' }}</span>
                </td>
                <td class="text-right">
                  <v-btn
                    v-if="['queued', 'backup-preparing', 'backing-up'].includes(operation.state)"
                    size="small"
                    variant="text"
                    color="error"
                    @click="cancel(operation.id)"
                  >
                    취소
                  </v-btn>
                </td>
              </tr>
            </tbody>
          </v-table>
        </section>
      </div>
    </v-main>

    <v-dialog :model-value="Boolean(confirmationDrive)" max-width="480" persistent>
      <v-card rounded="sm">
        <v-card-title class="text-subtitle-1 font-weight-bold">
          SD 카드 처리 시작
        </v-card-title>
        <v-card-text v-if="confirmationDrive">
          <template v-if="backupSelections[confirmationDrive.id]">
            <v-alert type="warning" density="compact" variant="tonal" class="mb-3">
              선택하지 않은 파일과 폴더는 백업되지 않으며 포맷 후 삭제됩니다.
            </v-alert>
            <p class="mb-1">
              백업 대상: <strong>{{ sourceSelectionDisplay(confirmationDrive) }}</strong>
            </p>
            <p v-if="folderSelectionForDrive(confirmationDrive)" class="text-body-2 mb-2">
              파일 범위: <strong>{{ fileFilterLabel(confirmationDrive) }}</strong> · 하위 폴더 포함 ·
              선택 폴더 이름 <strong>{{ includesSourceFolderForDrive(confirmationDrive) ? '포함' : '제외' }}</strong>
            </p>
            <p v-else class="text-body-2 mb-2">
              선택 파일 <strong>{{ selectedFileCount(confirmationDrive) }}개</strong>를
              백업 작업 폴더 바로 아래에 복사합니다.
            </p>
            <v-checkbox
              v-model="selectiveDataLossConfirmed"
              label="선택하지 않은 데이터가 삭제되는 것을 확인했습니다."
              color="error"
              density="compact"
              hide-details
              data-testid="selective-data-loss-confirmation"
            ></v-checkbox>
          </template>
          <p v-else class="mb-2">
            <strong>{{ confirmationDrive.driveLetter }}</strong> 드라이브의 모든 데이터를 백업하고 검증한 뒤 포맷합니다.
          </p>
          <p class="text-body-2">
            포맷 규격:
            <strong v-if="profiles[confirmationDrive.id] === 'blackbox'">exFAT / 128 KB</strong>
            <strong v-else>FAT32 / Windows 기본 할당 단위</strong>
          </p>
          <p class="text-body-2 mt-2">
            백업 검증에 실패하거나 장치 식별 정보가 달라지면 포맷하지 않습니다.
          </p>
          <p class="text-body-2 mt-2">
            백업 위치:
            <strong>{{ backupRootForDrive(confirmationDrive) }}</strong>
          </p>
          <p class="text-body-2">
            시간대:
            <strong>{{ timeSlotLabel(confirmationDrive) }}</strong>
            <span v-if="backupTimeSlots[confirmationDrive.id] === 'day'">
              {{ createBackupFolderForDrive(confirmationDrive) ? ' · yyyy-mm-dd/1 폴더 사용' : ' · 백업 경로의 1 폴더 사용' }}
            </span>
            <span v-else-if="backupTimeSlots[confirmationDrive.id] === 'night'">
              {{ createBackupFolderForDrive(confirmationDrive) ? ' · yyyy-mm-dd/2 폴더 사용' : ' · 백업 경로의 2 폴더 사용' }}
            </span>
            <span v-else> · 별도 시간대 폴더 없음</span>
          </p>
          <p class="text-body-2">
            포맷 후 볼륨 이름:
            <strong>{{ formatVolumeLabelForDrive(confirmationDrive) || confirmationDrive.volumeLabel || '이름 없음' }}</strong>
          </p>
          <p class="text-body-2">
            {{ createBackupFolderForDrive(confirmationDrive) ? '날짜별 폴더: yyyy-mm-dd' : '날짜별 폴더: 생성 안 함' }}
          </p>
          <p class="text-caption text-medium-emphasis mt-2">
            메모는 목록과 작업 기록에만 사용됩니다. SD 카드의 볼륨 이름, 파일, 포맷 설정은 변경하지 않습니다.
          </p>
        </v-card-text>
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn :disabled="confirming" @click="closeConfirmation">
            취소
          </v-btn>
          <v-btn
            :color="backupSelections[confirmationDrive?.id ?? ''] ? 'error' : 'primary'"
            :loading="confirming"
            :disabled="Boolean(backupSelections[confirmationDrive?.id ?? '']) && !selectiveDataLossConfirmed"
            data-testid="confirm-start"
            @click="confirmStart"
          >
            백업 및 포맷 시작
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-app>
</template>
