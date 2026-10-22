import { ApiError } from './api'

/** True when the install was refused only because the release publishes no SHA-256 checksum. */
export function needsChecksumConfirmation(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION') return false
  const details = err.details as { reason?: unknown } | undefined
  return details?.reason === 'NO_CHECKSUM'
}
