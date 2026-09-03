import type { OperationError, SdManagerErrorCode } from '../../shared/types'

export class SdManagerError extends Error {
  readonly code: SdManagerErrorCode
  readonly detail?: string

  constructor(code: SdManagerErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'SdManagerError'
    this.code = code
    this.detail = detail
  }

  toOperationError(): OperationError {
    return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) }
  }
}

export function toOperationError(error: unknown): OperationError {
  if (error instanceof SdManagerError) return error.toOperationError()
  if (error instanceof Error) {
    return { code: 'INTERNAL_ERROR', message: '예기치 않은 오류가 발생했습니다.', detail: error.message }
  }
  return { code: 'INTERNAL_ERROR', message: '예기치 않은 오류가 발생했습니다.' }
}
