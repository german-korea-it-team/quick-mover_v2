# AGENTS.md

## 프로젝트 개요

이 프로젝트는 차량용 블랙박스와 GPS 로거에서 사용하는 SD 카드를 대량으로 처리하기 위한 Windows 데스크톱 유틸리티다.

주요 목적은 여러 장의 SD 카드가 한꺼번에 들어왔을 때 반복되는 수작업을 줄이는 것이다.

기본 작업 흐름은 다음과 같다.

1. 이동식 SD 카드를 감지한다.
2. 사용자가 장치 유형을 지정한다.
   - 블랙박스 SD 카드
   - GPS 로거 SD 카드
3. SD 카드의 모든 데이터를 지정된 경로로 백업한다.
4. 백업이 정상적으로 완료되었는지 검증한다.
5. SD 카드를 요구된 파일 시스템과 할당 단위 크기로 포맷한다.
6. 포맷 결과를 다시 검증한다.
7. 성공 또는 실패 상태를 명확하게 표시한다.

이 애플리케이션은 편의성보다 데이터 안전성을 우선한다.

잘못된 드라이브 포맷은 절대 허용하지 않는다.

---

# 기술 스택

반드시 아래 기술 스택을 사용한다.

- Electron
- Vue 3
- TypeScript
- Vuetify
- ESLint
- Playwright
- pnpm

필요한 경우 Node.js API를 사용할 수 있다.

패키지 관리자는 pnpm을 사용한다. 의존성 설치와 프로젝트 스크립트 실행에 npm 또는 yarn을 사용하지 않는다.

다음 기술로 임의 변경하지 않는다.

- React
- Nuxt
- Tailwind CSS
- Bootstrap
- Tauri

Electron 기반 데스크톱 애플리케이션으로 유지한다.

---

# 스킬

프로젝트 작업 시 다음 스킬을 적극적으로 적용한다.

- ponytail
- kill ai slop

`kill ai slop`은 UI와 코드 작성 전반에 적용한다.

다음과 같은 전형적인 AI 생성물 스타일을 피한다.

- 의미 없는 그라디언트
- 지나치게 둥근 카드
- 카드 안의 카드
- 필요 이상의 아이콘
- 불필요한 애니메이션
- 과도한 설명 문구
- 가짜 대시보드
- 의미 없는 통계 카드
- 필요 이상으로 복잡한 추상화

이 프로젝트는 실무용 Windows 유틸리티다.

화려함보다 다음을 우선한다.

- 명확성
- 빠른 작업
- 낮은 실수 가능성
- 상태 확인의 용이성
- 단순한 조작

---

# 대상 운영체제

주요 대상 운영체제는 다음과 같다.

```text
Windows 11
```

필요한 경우 Windows 전용 기능을 사용해도 된다.

단순히 크로스 플랫폼 호환성을 유지하기 위해 디스크 관련 기능의 신뢰성을 희생하지 않는다.

Windows 전용 디스크 작업은 반드시 별도의 서비스 계층으로 분리한다.

예시:

```text
Renderer
   ↓
Electron IPC
   ↓
Drive Service
   ↓
Windows Disk / Filesystem API
```

Vue 컴포넌트에서 직접 시스템 명령어를 실행하지 않는다.

---

# SD 카드 규격

## 블랙박스 SD 카드

포맷 규격:

```text
Filesystem: exFAT
Allocation Unit Size: 128 KB
```

128 KB는 다음과 같다.

```text
131072 bytes
```

운영체제 기본 할당 크기로 자동 대체하지 않는다.

포맷 이후 반드시 실제 파일 시스템과 할당 단위 크기를 검증한다.

---

## GPS 로거 SD 카드

포맷 규격:

```text
Filesystem: FAT32
Allocation Unit Size: Default
```

할당 단위 크기는 운영체제 기본값을 사용한다.

명시적인 요구사항 변경이 없는 한 임의의 클러스터 크기를 지정하지 않는다.

포맷 이후 실제 파일 시스템이 FAT32인지 검증한다.

---

# 핵심 작업 흐름

SD 카드 처리 과정은 명확한 상태 기반 흐름으로 구현한다.

가능하면 명시적인 state machine 또는 그와 동등한 구조를 사용한다.

권장 상태:

```text
idle
detecting
ready
queued
backup-preparing
backing-up
backup-verifying
formatting
format-verifying
completed
failed
```

전체 작업을 하나의 거대한 async 함수로 구현하지 않는다.

각 단계는 renderer가 현재 상태를 알 수 있도록 해야 한다.

---

# 드라이브 감지

기본적으로 이동식 저장장치만 SD 카드 후보로 표시한다.

가능하면 다음 정보를 수집한다.

- Drive letter
- Volume label
- Filesystem
- Capacity
- Free space
- Used space
- Removable 여부
- Disk identifier
- Volume identifier
- Physical disk identifier

예시:

```ts
interface RemovableDrive {
  id: string
  diskNumber?: number
  driveLetter: string
  volumeLabel?: string
  filesystem?: string
  capacityBytes: number
  freeBytes: number
  removable: boolean
}
```

드라이브 문자만으로 장치를 식별하지 않는다.

잘못된 예:

```text
E:
F:
G:
```

드라이브 문자는 다음 상황에서 변경될 수 있다.

- SD 카드 재삽입
- 재부팅
- 포맷
- 다른 이동식 장치 연결
- Windows 자동 드라이브 문자 재할당

파괴적인 작업 직전에는 반드시 장치 정보를 다시 조회한다.

---

# 드라이브 식별 원칙

가능하면 안정적인 식별자를 사용한다.

예:

```text
Physical Disk ID
Volume ID
Device Path
Disk Number
```

포맷 직전에는 현재 장치가 사용자가 선택했던 장치와 동일한지 다시 검증한다.

다음과 같은 방식으로 장치를 선택하지 않는다.

```text
첫 번째 이동식 디스크
가장 최근에 연결된 디스크
C:가 아닌 첫 번째 디스크
E: 드라이브
```

이런 방식은 위험하다.

---

# 파괴적 작업 안전 규칙

포맷은 파괴적인 작업이다.

포맷 전에 반드시 다음 항목을 검증한다.

1. 선택된 장치가 현재 존재하는가.
2. 이동식 장치인가.
3. 작업 시작 시 선택했던 장치와 동일한 물리 디스크인가.
4. Windows 시스템 드라이브가 아닌가.
5. Boot Volume이 아닌가.
6. 백업 대상 드라이브가 아닌가.
7. 백업이 성공했는가.
8. 백업 검증이 성공했는가.
9. 장치 정보를 포맷 직전에 다시 조회했는가.
10. 사용자가 해당 카드의 처리 작업을 명시적으로 시작했는가.

장치 식별이 불확실하다면 작업하지 않는다.

```text
STOP
```

추측하지 않는다.

---

# 절대 포맷하면 안 되는 드라이브

다음 장치는 절대 포맷하지 않는다.

- Windows System Volume
- Boot Volume
- 일반 내부 SSD/HDD
- 애플리케이션이 실행 중인 시스템 드라이브
- 백업 대상 경로가 위치한 디스크
- 이동식 여부를 확실하게 판별할 수 없는 디스크
- 식별 정보가 변경된 디스크

장치가 애매하면 포맷하지 않는다.

---

# 백업

포맷 전에 반드시 전체 데이터를 백업한다.

백업 경로는 사용자가 설정할 수 있어야 한다.

기본 흐름:

```text
SD Card
   ↓
Configured Backup Root
```

권장 백업 폴더 구조:

```text
<backup-root>/
  <device-type>/
    <YYYY-MM-DD>/
      <timestamp>_<device-id>/
```

예:

```text
D:\SD_Backup\
  BlackBox\
    2026-09-01\
      20260901_103522_BLACKBOX01\
```

GPS:

```text
D:\SD_Backup\
  GPS\
    2026-09-01\
      20260901_103905_GPS01\
```

기존 백업 폴더를 덮어쓰지 않는다.

동일한 이름이 존재하면 고유한 이름을 만든다.

예:

```text
20260901_103522_BLACKBOX01
20260901_103522_BLACKBOX01_2
20260901_103522_BLACKBOX01_3
```

---

# 백업 복사 규칙

원본 디렉터리 구조를 그대로 유지한다.

원본 파일은 수정하지 않는다.

백업 후 수동으로 파일을 삭제하지 않는다.

원본 데이터 삭제는 포맷에 의해서만 발생해야 한다.

백업 중 오류가 발생하면 해당 카드의 작업을 즉시 실패 처리한다.

UI에서 가능하면 다음 정보를 제공한다.

- 현재 처리 중인 파일
- 처리한 파일 수
- 전체 파일 수
- 복사한 바이트
- 전체 바이트
- 진행률
- 현재 단계
- 에러 메시지

파일 하나를 처리할 때마다 IPC 이벤트를 보내 UI를 과도하게 갱신하지 않는다.

필요한 경우 진행률 이벤트를 throttle한다.

---

# 백업 검증

복사 명령이 성공했다는 이유만으로 백업이 완전하다고 판단하지 않는다.

최소 검증 항목:

- 대상 파일 존재 여부
- 파일 개수
- 파일 크기

권장 검증 모드:

```text
Fast Verification
- 파일 수 비교
- 파일 크기 비교

Full Verification
- Hash 비교
```

모든 대용량 파일을 기본적으로 hash 검증하지 않아도 된다.

성능을 지나치게 희생하지 않는다.

다만 향후 full verification을 추가할 수 있도록 구조를 설계한다.

백업 검증 실패 시 포맷으로 진행하지 않는다.

---

# 포맷 처리

포맷 관련 기능은 Electron Main Process 또는 전용 backend service에서 수행한다.

Renderer에서 직접 다음을 실행하지 않는다.

```text
PowerShell
cmd.exe
diskpart
format
Format-Volume
```

Renderer의 역할:

```text
UI
상태 표시
사용자 입력
IPC 요청
```

Main Process의 역할:

```text
드라이브 확인
백업
백업 검증
장치 식별 검증
포맷
포맷 검증
로그
```

---

# Windows 포맷 구현

Windows에서 제공하는 안전한 방식 중 적절한 방법을 사용한다.

가능한 방법:

- PowerShell Storage Cmdlet
- Windows API
- Windows 시스템 명령

명령어 문자열을 직접 이어붙이지 않는다.

나쁜 예:

```ts
exec(`format ${drive} ${userInput}`)
```

가능하면 구조화된 인자를 사용한다.

예:

```ts
spawn(command, args, {
  shell: false
})
```

외부 입력값은 반드시 검증한다.

---

# 블랙박스 포맷 검증

블랙박스 SD 카드 포맷 이후 다음 조건을 반드시 검증한다.

```text
Filesystem === exFAT
AllocationUnitSize === 131072
```

포맷 명령의 exit code가 0이라는 이유만으로 성공 처리하지 않는다.

실제 파일 시스템 정보를 조회한 후 성공 처리한다.

---

# GPS 포맷 검증

GPS SD 카드 포맷 이후 다음 조건을 검증한다.

```text
Filesystem === FAT32
```

Allocation Unit Size는 Windows 기본값을 사용한다.

---

# FAT32 주의사항

Windows는 FAT32 포맷에서 볼륨 크기 제한이 발생할 수 있다.

Windows 또는 사용 중인 API가 해당 볼륨을 FAT32로 포맷하지 못하는 경우:

- 작업을 중단한다.
- 백업 데이터는 유지한다.
- 사용자가 이해할 수 있는 오류를 표시한다.
- 임의로 exFAT로 대체하지 않는다.

잘못된 예:

```text
FAT32 실패
→ 자동 exFAT 포맷
```

이 동작은 금지한다.

---

# Electron 구조

Main / Preload / Renderer 역할을 명확히 분리한다.

권장 구조:

```text
src/
  main/
    index.ts
    ipc/
    services/
      drive.service.ts
      backup.service.ts
      format.service.ts
      operation.service.ts
    platform/
      windows/
        drive.windows.ts
        format.windows.ts

  preload/
    index.ts

  renderer/
    src/
      App.vue
      components/
      views/
      composables/
      stores/
      types/

  shared/
    ipc/
    types/
    constants/
```

Vue 컴포넌트에서 직접 다음 API를 import하지 않는다.

```text
fs
child_process
PowerShell
Windows Disk API
```

---

# Electron 보안

Electron의 보안 설정을 유지한다.

필수:

```ts
contextIsolation: true
nodeIntegration: false
```

Preload에서는 필요한 기능만 노출한다.

나쁜 예:

```ts
contextBridge.exposeInMainWorld('node', {
  exec,
  fs
})
```

좋은 예:

```ts
contextBridge.exposeInMainWorld('sdManager', {
  listDrives,
  inspectDrive,
  startProcess,
  cancelBackup,
  getOperationStatus
})
```

Renderer에 임의 명령 실행 기능을 노출하지 않는다.

---

# IPC

IPC는 명확한 타입을 사용한다.

예:

```ts
interface ProcessSdCardRequest {
  driveId: string
  profile: 'blackbox' | 'gps'
  backupRoot: string
}
```

결과:

```ts
interface ProcessSdCardResult {
  success: boolean
  operationId: string
  error?: {
    code: string
    message: string
  }
}
```

IPC channel은 의미가 명확해야 한다.

좋은 예:

```text
drive:list
drive:inspect
backup:start
backup:cancel
format:start
operation:status
```

나쁜 예:

```text
execute
run-command
do-action
handler
process
```

---

# TypeScript

TypeScript strict mode를 사용한다.

가능하면 `any`를 사용하지 않는다.

외부 API 응답처럼 타입을 알 수 없는 경우:

```ts
unknown
```

을 사용하고 검증한다.

다음 타입을 공통 영역에 정의한다.

- Drive
- DeviceProfile
- OperationState
- OperationError
- IPC request
- IPC response
- Progress event

Main과 Renderer에 동일한 interface를 중복 작성하지 않는다.

---

# Vue

Vue 3 Composition API를 사용한다.

기본 형식:

```vue
<script setup lang="ts">
```

Renderer에서는 composable을 적극 사용한다.

예:

```text
useDrives()
useSdProcessing()
useAppSettings()
useOperations()
```

단, 시스템 비즈니스 로직을 composable 안에 넣지 않는다.

Composable의 역할:

```text
UI 상태 관리
IPC 호출
상태 조합
```

Main service의 역할:

```text
파일 시스템
드라이브
백업
포맷
검증
```

---

# Vuetify

UI 컴포넌트는 Vuetify를 사용한다.

이 프로그램은 마케팅 페이지가 아니다.

Windows 운영 도구에 가까운 UI를 지향한다.

우선순위:

1. 현재 연결된 SD 카드
2. 카드 종류
3. 용량
4. 백업 경로
5. 현재 상태
6. 진행률
7. 작업 시작
8. 성공/실패 여부

여러 SD 카드는 table 또는 list 형태로 보여주는 것을 우선한다.

예:

```text
┌───────────────────────────────────────────────┐
│ SD Card Manager                               │
├───────────────────────────────────────────────┤
│ 백업 경로: D:\SD_Backup             [변경]   │
├───────────────────────────────────────────────┤
│ 드라이브 │ 종류      │ 용량 │ 상태 │ 작업   │
│ E:       │ 블랙박스  │128GB │ 준비 │ 처리   │
│ F:       │ GPS       │ 32GB │ 준비 │ 처리   │
├───────────────────────────────────────────────┤
│ 현재 작업                                     │
│ E:\ 백업 중...                          67%   │
│ ███████████████████░░░░░░                     │
└───────────────────────────────────────────────┘
```

---

# AI스러운 UI 금지

다음과 같은 UI는 만들지 않는다.

- 화면 대부분을 차지하는 Welcome 화면
- 의미 없는 hero section
- 지나치게 큰 제목
- 가짜 KPI 카드
- Today / Productivity / Performance 카드
- 의미 없는 그래프
- 무의미한 gradient
- 과도한 glassmorphism
- 모든 요소를 card로 감싸기
- 지나치게 넓은 spacing

업무 도구답게 컴팩트하게 설계한다.

---

# 다중 SD 카드 처리

이 프로그램의 핵심 목적은 여러 장의 SD 카드를 빠르게 처리하는 것이다.

따라서 여러 장의 SD 카드를 queue에 넣을 수 있어야 한다.

기본 흐름:

```text
Queued
  ↓
Backing Up
  ↓
Verifying
  ↓
Formatting
  ↓
Verifying Format
  ↓
Completed
```

카드마다 독립적인 작업 상태를 가진다.

예:

```ts
interface SdOperation {
  id: string
  driveId: string
  profile: DeviceProfile
  state: OperationState
  progress: number
  startedAt?: string
  completedAt?: string
  error?: OperationError
}
```

전체 애플리케이션 상태를 하나의 boolean로 처리하지 않는다.

나쁜 예:

```ts
const loading = ref(false)
```

---

# 동시 처리

여러 카드를 동시에 처리할 수 있다고 해서 무조건 병렬 처리하지 않는다.

SD 카드 여러 장을 동시에 복사하면 다음 문제가 발생할 수 있다.

- Disk I/O contention
- USB Controller 병목
- 진행률 혼란
- 장치 오식별 위험 증가

MVP 기본값:

```text
Queue Type: FIFO
Concurrency: 1
```

향후 설정으로 concurrency를 변경할 수 있도록 구조만 열어둔다.

포맷 작업을 동시에 여러 개 실행하지 않는다.

---

# 작업 취소

백업 단계에서는 가능하면 취소 기능을 지원한다.

포맷 단계에서는 안전한 취소가 보장되지 않는다면 취소 버튼을 제공하지 않는다.

예:

```text
백업 중
[취소 가능]

포맷 중
[취소 불가]

"포맷 중입니다. SD 카드를 제거하지 마세요."
```

실제로 중단할 수 없는 작업에 가짜 Cancel 버튼을 만들지 않는다.

---

# SD 카드 제거 처리

작업 중 SD 카드가 제거될 수 있다.

각 단계별로 안전하게 처리한다.

## Idle

드라이브 목록에서 제거한다.

## Backup

현재 작업을 중단하고 `failed` 처리한다.

## Verification

검증을 중단하고 `failed` 처리한다.

## Formatting

Critical Error로 처리한다.

성공으로 표시하지 않는다.

## Completed

드라이브 목록을 정상 갱신한다.

SD 카드 제거 때문에 Electron 프로세스가 crash하면 안 된다.

---

# 오류 처리

명확한 error code를 정의한다.

예:

```ts
type SdManagerErrorCode =
  | 'DRIVE_NOT_FOUND'
  | 'DRIVE_IDENTITY_CHANGED'
  | 'DRIVE_NOT_REMOVABLE'
  | 'PROTECTED_DRIVE'
  | 'BACKUP_DESTINATION_UNAVAILABLE'
  | 'BACKUP_FAILED'
  | 'BACKUP_VERIFICATION_FAILED'
  | 'FORMAT_FAILED'
  | 'FORMAT_VERIFICATION_FAILED'
  | 'UNSUPPORTED_FILESYSTEM'
  | 'DEVICE_REMOVED'
  | 'PERMISSION_DENIED'
```

사용자에게 raw stack trace를 그대로 표시하지 않는다.

사용자용 메시지와 개발자용 로그를 구분한다.

---

# 로그

중요 작업은 로그를 남긴다.

기록 대상:

- Disk identifier
- Drive letter
- Device profile
- Backup destination
- 작업 시작 시간
- 백업 결과
- 검증 결과
- 포맷 파라미터
- 포맷 결과
- 에러 코드

특히 포맷 직전 실제 대상 disk identifier를 기록한다.

예:

```text
2026-09-01 11:32:17
FORMAT_START
diskId=USBSTOR\...
drive=E:
profile=blackbox
filesystem=exFAT
allocationUnit=131072
```

파일 내용 자체는 로그에 기록하지 않는다.

---

# 설정

다음 설정은 저장할 수 있다.

```text
backup destination
verification mode
queue behavior
window preferences
```

드라이브 문자를 영구적인 장치 ID로 저장하지 않는다.

---

# UX 원칙

이 프로그램의 이상적인 사용 흐름은 다음과 같다.

```text
SD 카드 삽입
→ 종류 선택
→ 작업 시작
→ 자동 백업
→ 자동 검증
→ 자동 포맷
→ 완료
→ SD 카드 제거
→ 다음 카드
```

사용자가 각 카드의 현재 상태를 한눈에 알 수 있어야 한다.

상태 문구는 짧게 사용한다.

```text
Ready
Queued
Backing up
Verifying
Formatting
Completed
Failed
```

불필요하게 친근하거나 AI스러운 문구를 사용하지 않는다.

나쁜 예:

```text
당신의 SD 카드 여정을 시작해볼까요?
```

좋은 예:

```text
처리 준비 완료
```

파괴적인 작업에 대해서는 명확하게 표시한다.

```text
E: 드라이브를 포맷합니다.
백업 검증이 완료되었습니다.
```

---

# 사용자 확인

사용자가 카드 처리 작업을 명시적으로 시작해야 한다.

작업 시작 이후에는 다음 흐름을 자동으로 진행할 수 있다.

```text
Backup
→ Verify
→ Format
→ Verify Format
```

각 단계마다 확인 창을 반복해서 띄우지 않는다.

단, 다음 상황에서는 자동 진행하지 않는다.

- Drive identity 변경
- Backup 검증 실패
- Device removal
- Backup destination 문제
- Protected drive 감지

---

# ESLint

모든 코드는 ESLint를 통과해야 한다.

완료 전 반드시 실행한다.

```bash
pnpm lint
```

또는 프로젝트에서 사용하는 동등한 명령을 실행한다.

단순히 오류를 숨기기 위해 다음을 남발하지 않는다.

```ts
// eslint-disable
```

필요하다면 이유를 명확히 남긴다.

---

# Playwright

E2E 테스트는 Playwright를 사용한다.

자동화 테스트에서 실제 디스크 포맷을 수행하지 않는다.

OS 및 디스크 관련 기능은 mock 가능하도록 구현한다.

최소 테스트 항목:

## 드라이브 감지

```text
SD 카드 없음
SD 카드 1개
SD 카드 여러 개
SD 카드 제거
고정 디스크 제외
```

## 백업

```text
백업 성공
백업 경로 없음
백업 경로 쓰기 실패
복사 실패
SD 카드 제거
백업 검증 실패
```

## 블랙박스 포맷

```text
exFAT 요청
Allocation Unit 131072 요청
포맷 실패
포맷 후 filesystem 검증 실패
Allocation Unit 검증 실패
```

## GPS 포맷

```text
FAT32 요청
Default allocation 요청
포맷 실패
포맷 검증 실패
```

## 안전성

```text
System Drive 포맷 거부
Fixed Disk 포맷 거부
Backup Drive 포맷 거부
Drive Identity 변경 감지
Backup 완료 전 포맷 거부
Backup Verification 실패 후 포맷 거부
```

## Queue

```text
여러 장 queue 등록
FIFO 처리
한 작업 실패 후 다음 작업 정상 처리
각 카드의 상태 독립성
```

---

# 테스트 가능한 구조

시스템 기능은 interface를 이용해 분리한다.

예:

```ts
interface DrivePlatform {
  listDrives(): Promise<RemovableDrive[]>

  inspectDrive(
    id: string
  ): Promise<RemovableDrive>

  formatDrive(
    id: string,
    options: FormatOptions
  ): Promise<FormatResult>
}
```

실제 Windows 구현:

```text
WindowsDrivePlatform
```

테스트 구현:

```text
MockDrivePlatform
```

Playwright 테스트는 `MockDrivePlatform`을 사용한다.

---

# 테스트에서 절대 하지 말 것

테스트 코드에서 실제 디스크를 대상으로 다음 명령을 실행하지 않는다.

```text
format E:
Format-Volume
diskpart clean
Clear-Disk
Remove-Partition
```

개발자 PC와 CI 환경의 저장장치를 손상시킬 가능성이 있는 테스트는 작성하지 않는다.

---

# 코드 스타일

읽기 쉽고 명시적인 코드를 우선한다.

좋은 예:

```ts
const drive = await driveService.inspectDrive(request.driveId)

assertRemovableDrive(drive)
assertNotProtectedDrive(drive)
assertSameDrive(selectedDrive, drive)

await formatService.formatBlackBoxSdCard(drive)
```

불필요하게 축약하거나 영리하게 작성하지 않는다.

나쁜 예:

```ts
await d.f((await d.g(id)).x ? p[id].f : p[id].g)
```

파괴적 작업을 수행하는 함수는 이름만 보고도 동작을 알 수 있어야 한다.

좋은 예:

```text
verifyDriveIdentityBeforeFormat
formatBlackBoxSdCard
formatGpsSdCard
verifyFormattedFilesystem
```

나쁜 예:

```text
run
execute
handle
process
doStuff
```

---

# 의존성 정책

의존성은 최소화한다.

새 패키지를 추가하기 전에 다음을 확인한다.

1. Node.js 또는 Electron 기본 기능으로 해결 가능한가.
2. 프로젝트에 이미 비슷한 기능이 있는가.
3. 패키지가 유지보수되고 있는가.
4. 실제로 필요한가.
5. 보안 리스크가 없는가.

몇 줄의 코드를 줄이기 위해 무분별하게 dependency를 추가하지 않는다.

---

# 구현 우선순위

요구사항이 충돌하면 다음 우선순위를 따른다.

```text
1. 잘못된 드라이브 포맷 방지
2. 원본 데이터 보호
3. 백업 무결성
4. 정확한 포맷 규격
5. 이동식 장치 오류 대응
6. 사용자에게 명확한 상태 제공
7. 처리 속도
8. UI 디자인
```

안전성을 위해 필요하다면 작업 속도가 조금 느려져도 된다.

---

# MVP 범위

최초 버전에는 다음 기능을 포함한다.

- 이동식 SD 카드 감지
- 여러 SD 카드 표시
- 블랙박스 / GPS 프로필 선택
- 백업 경로 설정
- 전체 파일 백업
- 백업 검증
- 블랙박스 SD 포맷
  - exFAT
  - 128 KB allocation unit
- GPS SD 포맷
  - FAT32
  - default allocation unit
- 포맷 검증
- 작업 진행률
- Queue
- 성공/실패 표시
- 로그

초기 버전에서는 다음 기능을 추가하지 않는다.

- Cloud Sync
- 사용자 계정
- 원격 제어
- 웹 서버
- 데이터베이스 서버
- Analytics
- AI 기반 SD 카드 자동 분류
- 복잡한 인증 시스템
- 불필요한 auto-update 구조

필요성이 생기면 이후에 추가한다.

---

# Definition of Done

기능은 다음 조건을 모두 만족해야 완료로 본다.

1. TypeScript compile 성공
2. ESLint 통과
3. 관련 Playwright 테스트 통과
4. 자동 테스트에서 실제 디스크를 조작하지 않음
5. Drive identity 검증 유지
6. 백업 검증 유지
7. 실패 상태가 UI에 표시됨
8. 관련 없는 파일을 불필요하게 수정하지 않음
9. production 코드에 placeholder/mock 구현이 남아있지 않음
10. 테스트를 실행하지 않았다면 실행했다고 말하지 않음

개발환경과 검증 명령은 pnpm을 기준으로 유지한다.

포맷 기능은 추가로 다음을 검증한다.

## Black Box

```text
Filesystem: exFAT
Allocation Unit Size: 131072
```

## GPS

```text
Filesystem: FAT32
Allocation Unit Size: Default
```

---

# Agent 행동 규칙

이 저장소를 수정하는 Agent는 다음 규칙을 따른다.

- 기존 코드 구조를 먼저 확인한다.
- 기존 convention을 우선 사용한다.
- 필요한 최소 범위만 수정한다.
- 관련 없는 파일을 리팩터링하지 않는다.
- 기술 스택을 임의로 변경하지 않는다.
- Electron의 보안 설정을 약화시키지 않는다.
- Renderer에 Node.js 권한을 노출하지 않는다.
- Drive letter만으로 포맷 대상을 식별하지 않는다.
- 확인되지 않은 디스크를 자동 포맷하지 않는다.
- 백업 검증을 생략하지 않는다.
- 오류를 숨기지 않는다.
- 가짜 progress를 만들지 않는다.
- 실행하지 않은 테스트를 통과했다고 말하지 않는다.
- 실제 검증하지 않은 포맷 결과를 성공이라고 말하지 않는다.
- Windows 전용 코드는 platform 계층으로 격리한다.
- 파괴적 작업은 이해하기 쉽고 감사 가능한 코드를 사용한다.
- 지나치게 복잡한 추상화를 만들지 않는다.
- 필요 없는 기능을 추가하지 않는다.

파괴적인 디스크 작업에서 확신이 없다면 항상 fail closed 한다.

```text
작업하지 않는다.
오류를 반환한다.
사용자의 확인 또는 문제 해결을 요구한다.
```

절대 추측해서 포맷하지 않는다.

---

# 최종 원칙

이 프로그램에서 가장 중요한 것은 속도가 아니다.

가장 중요한 것은 다음이다.

```text
잘못된 디스크를 절대 포맷하지 않는 것.
```

그 다음은:

```text
백업 데이터를 신뢰할 수 있는 것.
```

그리고 마지막으로:

```text
여러 SD 카드를 사람이 반복 작업하는 것보다 훨씬 편하게 처리하는 것.
```

모든 설계와 구현 판단은 이 우선순위를 따른다.
