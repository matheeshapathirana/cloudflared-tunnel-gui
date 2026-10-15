import { EventEmitter } from 'node:events'
import type { UpdateState, UpdateStatus } from '@shared/schemas'
import { AppErrorException } from '@shared/result'

/** The subset of electron-updater's AppUpdater that UpdateManager relies on. */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  on(event: string, listener: (...args: never[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateManagerDeps {
  updater: UpdaterLike
  currentVersion: string
  isPackaged: boolean
  getAutoCheck: () => boolean
  /** Optional hook that runs right before quitAndInstall. */
  beforeInstall?: () => void
  initialDelayMs?: number
  intervalMs?: number
}

const DEFAULT_INITIAL_DELAY_MS = 30_000
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_MESSAGE_LENGTH = 160

/**
 * With autoDownload on, electron-updater's checkForUpdates() resolves with a downloadPromise that
 * rejects when the download fails (after it has already emitted 'error'). Nothing awaits it, so it
 * would surface as an unhandled rejection; the 'error' event is what drives our state.
 */
function swallowDownloadRejection(result: unknown): void {
  if (typeof result !== 'object' || result === null) return
  const { downloadPromise } = result as { downloadPromise?: Promise<unknown> | null }
  if (downloadPromise && typeof downloadPromise.catch === 'function') {
    downloadPromise.catch(() => undefined)
  }
}

/** Turns an updater error into a short, user-facing message (no stacks or URLs for known cases). */
function toErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/Cannot find latest\.yml|404/.test(raw)) return 'No update information found yet.'
  const firstLine = raw.split('\n')[0].trim()
  return firstLine ? firstLine.slice(0, MAX_MESSAGE_LENGTH) : 'Update check failed.'
}

export class UpdateManager extends EventEmitter {
  private status: UpdateStatus = { state: 'idle' }
  private version = ''
  private inFlight: Promise<void> | null = null
  private subscribed = false
  private stopped = false
  private installing = false
  private initialTimer: NodeJS.Timeout | null = null
  private intervalTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: UpdateManagerDeps) {
    super()
  }

  getState(): UpdateState {
    return { currentVersion: this.deps.currentVersion, status: this.status }
  }

  start(): void {
    if (!this.deps.isPackaged) return
    this.stopped = false

    const { updater } = this.deps
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false
    updater.allowDowngrade = false

    this.subscribe()
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
  }

  async check(): Promise<UpdateState> {
    if (!this.deps.isPackaged) return this.getState()
    const { state } = this.status
    if (this.inFlight || state === 'checking' || state === 'downloading' || state === 'ready') {
      return this.getState()
    }

    this.inFlight = this.deps.updater
      .checkForUpdates()
      .then(swallowDownloadRejection)
      .catch((err: unknown) => this.setStatus({ state: 'error', message: toErrorMessage(err) }))
      .finally(() => {
        this.inFlight = null
      })
    await this.inFlight
    return this.getState()
  }

  install(): void {
    if (this.status.state !== 'ready') {
      throw new AppErrorException('VALIDATION', 'No update is ready to install.')
    }
    if (this.installing) return
    this.installing = true
    try {
      this.deps.beforeInstall?.()
      this.deps.updater.quitAndInstall(false, true)
    } catch (err) {
      this.installing = false
      throw err
    }
  }

  private subscribe(): void {
    if (this.subscribed) return
    this.subscribed = true
    const { updater } = this.deps

    updater.on('checking-for-update', () => this.setStatus({ state: 'checking' }))
    updater.on('update-available', (info: { version: string }) => {
      this.version = info.version
      this.setStatus({ state: 'available', version: info.version })
      this.setStatus({ state: 'downloading', version: info.version, percent: 0 })
    })
    updater.on('download-progress', (progress: { percent: number }) =>
      this.setStatus({
        state: 'downloading',
        version: this.version,
        percent: Math.round(progress.percent)
      })
    )
    updater.on('update-downloaded', (info: { version: string }) => {
      this.version = info.version
      this.setStatus({ state: 'ready', version: info.version })
    })
    updater.on('update-not-available', () =>
      this.setStatus({ state: 'idle', checkedAt: Date.now() })
    )
    updater.on('error', (err: Error) => {
      // quitAndInstall never throws on failure: it emits 'error' and does not quit, so allow a retry.
      this.installing = false
      this.setStatus({ state: 'error', message: toErrorMessage(err) })
    })
  }

  private schedule(): void {
    this.clearTimers()
    const { initialDelayMs = DEFAULT_INITIAL_DELAY_MS, intervalMs = DEFAULT_INTERVAL_MS } =
      this.deps
    const tick = (): void => {
      if (this.deps.getAutoCheck()) void this.check()
    }
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null
      tick()
      this.intervalTimer = setInterval(tick, intervalMs)
    }, initialDelayMs)
  }

  private clearTimers(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.initialTimer = null
    this.intervalTimer = null
  }

  /** Applies a status and emits 'state' only when it actually changed. */
  private setStatus(next: UpdateStatus): void {
    if (this.stopped) return
    if (JSON.stringify(next) === JSON.stringify(this.status)) return
    this.status = next
    this.emit('state', this.getState())
  }
}
