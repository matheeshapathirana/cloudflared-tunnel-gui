import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { UpdateStateSchema, type UpdateState } from '@shared/schemas'
import { AppErrorException } from '@shared/result'
import { UpdateManager, type UpdaterLike, type UpdateManagerDeps } from './UpdateManager'

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = false
  autoInstallOnAppQuit = true
  allowPrerelease = true
  allowDowngrade = true
  checkForUpdates = vi.fn<() => Promise<unknown>>(async () => undefined)
  quitAndInstall = vi.fn<(isSilent?: boolean, isForceRunAfter?: boolean) => void>()

  // Narrow EventEmitter's `any[]` listener to the `never[]` form UpdaterLike requires.
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }
}

describe('UpdateManager', () => {
  let updater: FakeUpdater
  let autoCheck: boolean
  let beforeInstall: ReturnType<typeof vi.fn<() => void>>

  const INITIAL_DELAY = 1000
  const INTERVAL = 60_000

  function create(overrides: Partial<UpdateManagerDeps> = {}): UpdateManager {
    return new UpdateManager({
      updater,
      currentVersion: '1.0.0',
      isPackaged: true,
      getAutoCheck: () => autoCheck,
      beforeInstall,
      initialDelayMs: INITIAL_DELAY,
      intervalMs: INTERVAL,
      ...overrides
    })
  }

  function collect(manager: UpdateManager): UpdateState[] {
    const states: UpdateState[] = []
    manager.on('state', (s: UpdateState) => states.push(s))
    return states
  }

  beforeEach(() => {
    vi.useFakeTimers()
    updater = new FakeUpdater()
    autoCheck = true
    beforeInstall = vi.fn<() => void>()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts idle with the current version', () => {
    const manager = create()
    expect(manager.getState()).toEqual({ currentVersion: '1.0.0', status: { state: 'idle' } })
  })

  it('start() configures the updater', () => {
    const manager = create()
    manager.start()
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
    manager.stop()
  })

  it('walks idle → checking → downloading → ready, emitting once per change', () => {
    const manager = create()
    const states = collect(manager)
    manager.start()

    updater.emit('checking-for-update')
    updater.emit('update-available', { version: '1.1.0' })
    updater.emit('download-progress', { percent: 41.6 })
    updater.emit('update-downloaded', { version: '1.1.0' })

    expect(states.map((s) => s.status)).toEqual([
      { state: 'checking' },
      { state: 'available', version: '1.1.0' },
      { state: 'downloading', version: '1.1.0', percent: 0 },
      { state: 'downloading', version: '1.1.0', percent: 42 },
      { state: 'ready', version: '1.1.0' }
    ])
    for (const s of states) {
      expect(UpdateStateSchema.safeParse(s).success).toBe(true)
      expect(s.currentVersion).toBe('1.0.0')
    }
    expect(manager.getState()).toEqual(states[states.length - 1])
    manager.stop()
  })

  it('does not emit duplicate identical consecutive states', () => {
    const manager = create()
    const states = collect(manager)
    manager.start()

    updater.emit('update-available', { version: '1.1.0' })
    updater.emit('download-progress', { percent: 10.2 })
    updater.emit('download-progress', { percent: 10.4 })

    expect(states.map((s) => s.status)).toEqual([
      { state: 'available', version: '1.1.0' },
      { state: 'downloading', version: '1.1.0', percent: 0 },
      { state: 'downloading', version: '1.1.0', percent: 10 }
    ])
    manager.stop()
  })

  it('update-not-available returns to idle with a checkedAt number', () => {
    const manager = create()
    manager.start()
    updater.emit('checking-for-update')
    updater.emit('update-not-available', { version: '1.0.0' })

    const status = manager.getState().status
    expect(status.state).toBe('idle')
    expect(status.state === 'idle' && typeof status.checkedAt).toBe('number')
    expect(UpdateStateSchema.safeParse(manager.getState()).success).toBe(true)
    manager.stop()
  })

  it('error becomes a state, not an exception', async () => {
    updater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'))
    const manager = create()
    manager.start()

    const state = await manager.check()
    expect(state.status.state).toBe('error')
    expect(state.status.state === 'error' && state.status.message.length).toBeGreaterThan(0)
    expect(UpdateStateSchema.safeParse(state).success).toBe(true)

    updater.emit('update-not-available', { version: '1.0.0' })
    expect(manager.getState().status.state).toBe('idle')
    manager.stop()
  })

  it('maps an error event to an error state', () => {
    const manager = create()
    manager.start()
    updater.emit('error', new Error('boom'))
    expect(manager.getState().status).toEqual({ state: 'error', message: 'boom' })
    manager.stop()
  })

  it('a 404 for latest.yml gives a friendly message', async () => {
    updater.checkForUpdates.mockRejectedValueOnce(
      new Error(
        'Cannot find latest.yml in the latest release artifacts (https://github.com/o/r/releases/download/v1/latest.yml): HttpError: 404\nstack...'
      )
    )
    const manager = create()
    manager.start()

    const state = await manager.check()
    expect(state.status).toEqual({ state: 'error', message: 'No update information found yet.' })
    manager.stop()
  })

  it.each([
    ['idle', () => undefined],
    ['checking', () => updater.emit('checking-for-update')],
    [
      'downloading',
      () => {
        updater.emit('update-available', { version: '1.1.0' })
        updater.emit('download-progress', { percent: 5 })
      }
    ]
  ])('install() in %s throws and does not quit', (_name, arrange) => {
    const manager = create()
    manager.start()
    arrange()

    let thrown: unknown
    try {
      manager.install()
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(AppErrorException)
    expect((thrown as AppErrorException).code).toBe('VALIDATION')
    expect(beforeInstall).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    manager.stop()
  })

  it('install() in ready calls beforeInstall then quitAndInstall(false, true) exactly once', () => {
    const manager = create()
    manager.start()
    updater.emit('update-downloaded', { version: '1.1.0' })

    const order: string[] = []
    beforeInstall.mockImplementation(() => order.push('before'))
    updater.quitAndInstall.mockImplementation(() => order.push('quit'))

    manager.install()
    manager.install()

    expect(order).toEqual(['before', 'quit'])
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    manager.stop()
  })

  it('check() during checking or downloading does not start a second check', async () => {
    let resolveCheck: (v: unknown) => void = () => undefined
    updater.checkForUpdates.mockImplementationOnce(
      () => new Promise((resolve) => (resolveCheck = resolve))
    )
    const manager = create()
    manager.start()

    const first = manager.check()
    updater.emit('checking-for-update')
    await manager.check()
    updater.emit('update-available', { version: '1.1.0' })
    updater.emit('download-progress', { percent: 3 })
    await manager.check()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)

    resolveCheck(undefined)
    await first
    manager.stop()
  })

  it('check() can run again after a check has settled', async () => {
    const manager = create()
    manager.start()
    await manager.check()
    await manager.check()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    manager.stop()
  })

  it('not packaged is inert', async () => {
    const manager = create({ isPackaged: false })
    manager.start()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY + INTERVAL * 3)

    expect(vi.getTimerCount()).toBe(0)
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.listenerCount('checking-for-update')).toBe(0)

    const state = await manager.check()
    expect(state.status).toEqual({ state: 'idle' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('scheduling: one check after the initial delay, then one per interval', async () => {
    const manager = create()
    manager.start()

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY - 1)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3)
    manager.stop()
  })

  it('scheduling: ticks do nothing when auto-check is off, but check() still works', async () => {
    autoCheck = false
    const manager = create()
    manager.start()

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY + INTERVAL * 2)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()

    await manager.check()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    manager.stop()
  })

  it('stop() clears timers and ignores later events', async () => {
    const manager = create()
    const states = collect(manager)
    manager.start()
    manager.stop()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY + INTERVAL * 2)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()

    updater.emit('update-downloaded', { version: '1.1.0' })
    expect(states).toEqual([])
    expect(manager.getState().status).toEqual({ state: 'idle' })
  })
})
