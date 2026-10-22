import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { needsChecksumConfirmation } from './binaryInstall'

describe('needsChecksumConfirmation', () => {
  it('is true for the missing-checksum refusal', () => {
    const err = new ApiError('VALIDATION', 'No SHA-256 checksum found', { reason: 'NO_CHECKSUM' })
    expect(needsChecksumConfirmation(err)).toBe(true)
  })

  it('is false for a failed checksum comparison', () => {
    const err = new ApiError('VALIDATION', 'Checksum verification failed: expected a, got b')
    expect(needsChecksumConfirmation(err)).toBe(false)
  })

  it('is false for other errors and non-errors', () => {
    expect(needsChecksumConfirmation(new ApiError('INTERNAL', 'boom'))).toBe(false)
    expect(needsChecksumConfirmation(new Error('boom'))).toBe(false)
    expect(needsChecksumConfirmation(null)).toBe(false)
  })
})
