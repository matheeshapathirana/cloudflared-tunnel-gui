import { describe, expect, it } from 'vitest'
import type { UpdateState, UpdateStatus } from '@shared/schemas'
import { describeUpdate } from './updateText'

const state = (status: UpdateStatus): UpdateState => ({ currentVersion: '1.0.0', status })

describe('describeUpdate', () => {
  it('describes idle without a check time', () => {
    expect(describeUpdate(state({ state: 'idle' }))).toBe('Up to date')
  })

  it('includes the check time when idle with checkedAt', () => {
    const text = describeUpdate(state({ state: 'idle', checkedAt: Date.now() }))
    expect(text.startsWith('Up to date · checked ')).toBe(true)
    expect(text).toMatch(/^Up to date · checked \d{2}:\d{2}$/)
  })

  it('describes checking', () => {
    expect(describeUpdate(state({ state: 'checking' }))).toBe('Checking for updates…')
  })

  it('describes available', () => {
    expect(describeUpdate(state({ state: 'available', version: '1.2.0' }))).toBe(
      'Update 1.2.0 found'
    )
  })

  it('describes downloading with percent', () => {
    expect(describeUpdate(state({ state: 'downloading', version: '1.2.0', percent: 42 }))).toBe(
      'Downloading 1.2.0 (42%)'
    )
  })

  it('describes ready', () => {
    expect(describeUpdate(state({ state: 'ready', version: '1.2.0' }))).toBe(
      '1.2.0 is ready to install'
    )
  })

  it('describes error with the message', () => {
    expect(describeUpdate(state({ state: 'error', message: 'offline' }))).toBe(
      "Couldn't check for updates: offline"
    )
  })
})
