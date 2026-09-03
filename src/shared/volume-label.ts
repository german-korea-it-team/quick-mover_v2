export const VOLUME_LABEL_MAX_LENGTH = 11

const INVALID_VOLUME_LABEL_CHARACTERS = /[\\/:*?"<>|]/

export function normalizeVolumeLabel(value: string): string {
  return value.trim()
}

export function validateVolumeLabel(value: string): string | undefined {
  const normalized = normalizeVolumeLabel(value)
  if (!normalized) return undefined
  if (normalized.length > VOLUME_LABEL_MAX_LENGTH) return `볼륨 이름은 최대 ${VOLUME_LABEL_MAX_LENGTH}자까지 입력할 수 있습니다.`
  if (INVALID_VOLUME_LABEL_CHARACTERS.test(normalized) || [...normalized].some((character) => character.charCodeAt(0) < 32)) {
    return '볼륨 이름에 사용할 수 없는 문자가 포함되어 있습니다.'
  }
  return undefined
}
