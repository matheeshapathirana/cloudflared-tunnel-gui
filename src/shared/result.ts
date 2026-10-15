export type ErrorCode =
  'VALIDATION' | 'NOT_FOUND' | 'UNKNOWN_COMMAND' | 'INTERNAL' | 'BINARY_NOT_FOUND' | 'UNAUTHORIZED'

export type AppError = {
  code: ErrorCode
  message: string
  details?: unknown
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }

export class AppErrorException extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message)
    this.name = 'AppErrorException'
    Object.setPrototypeOf(this, AppErrorException.prototype)
  }
}
