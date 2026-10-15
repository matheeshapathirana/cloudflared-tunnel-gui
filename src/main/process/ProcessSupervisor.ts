import { EventEmitter } from 'node:events'
import child_process, { type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import type { Tunnel, TunnelStatus, BinaryStatus } from '../../shared/schemas'
import type { SettingsStore } from '../settings/SettingsStore'
import { AppErrorException } from '../../shared/result'

export async function defaultGetFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (typeof addr === 'object' && addr !== null) {
        const port = addr.port
        srv.close((err) => {
          if (err) reject(err)
          else resolve(port)
        })
      } else {
        srv.close(() => reject(new Error('Failed to obtain free port')))
      }
    })
  })
}

export async function defaultKillProcess(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      child_process.exec(`taskkill /PID ${pid} /T /F`, () => {
        resolve()
      })
    })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Process already gone
      }
    }
  }
}

export async function defaultIsProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    return (err as { code?: string }).code === 'EPERM'
  }
}

export interface ProcessSupervisorDeps {
  binaryManager: { status: () => Promise<BinaryStatus> }
  store: SettingsStore
  appDataPath: string
  getTunnelToken?: (tunnel: Tunnel) => Promise<string>
  spawn?: typeof child_process.spawn
  fetch?: typeof globalThis.fetch
  getFreePort?: () => Promise<number>
  killProcess?: (pid: number) => Promise<void>
  isProcessRunning?: (pid: number) => Promise<boolean>
  backoffDelays?: number[]
}

interface RunningTunnelInstance {
  tunnel: Tunnel
  child: ChildProcess
  metricsPort: number
  startTime: number
  pollTimer: NodeJS.Timeout | null
  backoffTimer: NodeJS.Timeout | null
  intentionalStop: boolean
  crashTimestamps: number[]
  quickUrl?: string
}

const MAX_LOG_LINES = 2000
const DEFAULT_BACKOFF_DELAYS = [1000, 2000, 5000, 15000, 30000]
const CRASH_WINDOW_MS = 10 * 60 * 1000 // 10 minutes

export class ProcessSupervisor extends EventEmitter {
  private instances = new Map<string, RunningTunnelInstance>()
  private logBuffers = new Map<string, string[]>()
  private statuses = new Map<string, TunnelStatus>()

  private spawnFn: typeof child_process.spawn
  private fetchFn: typeof globalThis.fetch
  private getFreePortFn: () => Promise<number>
  private killProcessFn: (pid: number) => Promise<void>
  private isProcessRunningFn: (pid: number) => Promise<boolean>
  private backoffDelays: number[]

  constructor(private deps: ProcessSupervisorDeps) {
    super()
    this.spawnFn = deps.spawn ?? child_process.spawn
    this.fetchFn = deps.fetch ?? globalThis.fetch
    this.getFreePortFn = deps.getFreePort ?? defaultGetFreePort
    this.killProcessFn = deps.killProcess ?? defaultKillProcess
    this.isProcessRunningFn = deps.isProcessRunning ?? defaultIsProcessRunning
    this.backoffDelays = deps.backoffDelays ?? DEFAULT_BACKOFF_DELAYS
  }

  public getStatus(id: string): TunnelStatus {
    return this.statuses.get(id) ?? { state: 'stopped' }
  }

  public getAllStatuses(): Map<string, TunnelStatus> {
    return new Map(this.statuses)
  }

  public getLogs(id: string, limit?: number): string[] {
    const logs = this.logBuffers.get(id) ?? []
    if (limit && limit > 0) {
      return logs.slice(-limit)
    }
    return [...logs]
  }

  private setStatus(id: string, status: TunnelStatus): void {
    this.statuses.set(id, status)
    this.emit('status', { id, status })
  }

  private appendLog(id: string, rawLine: string): void {
    const line = rawLine.trim()
    if (!line) return

    let buf = this.logBuffers.get(id)
    if (!buf) {
      buf = []
      this.logBuffers.set(id, buf)
    }
    buf.push(line)
    if (buf.length > MAX_LOG_LINES) {
      buf.shift()
    }
    this.emit('log', { id, line })
  }

  /**
   * Config file handed to quick tunnels so cloudflared never picks up ~/.cloudflared/config.yml
   * (which carries a named tunnel's ingress rules). It must not be empty: cloudflared logs
   * "Configuration file ... was empty" as an error for a zero-byte file.
   */
  private async ensureQuickConfig(): Promise<string> {
    const quickConfigPath = path.join(this.deps.appDataPath, 'quick-tunnel-config.yml')
    const content = 'no-autoupdate: true\n'
    try {
      await fs.promises.mkdir(this.deps.appDataPath, { recursive: true })
      const current = await fs.promises.readFile(quickConfigPath, 'utf8').catch(() => null)
      if (current !== content) {
        await fs.promises.writeFile(quickConfigPath, content, 'utf8')
      }
    } catch {
      // Ignore if write fails
    }
    return quickConfigPath
  }

  public async start(tunnel: Tunnel): Promise<void> {
    if (this.instances.has(tunnel.id)) {
      const current = this.getStatus(tunnel.id)
      const inst = this.instances.get(tunnel.id)
      const isDead = inst ? inst.child.exitCode !== null || inst.child.killed : true
      if (!isDead && current.state !== 'stopped' && current.state !== 'crashed') {
        throw new AppErrorException('INTERNAL', `Tunnel ${tunnel.id} is already running`)
      }
    }

    const binStatus = await this.deps.binaryManager.status()
    if (!binStatus.found) {
      throw new AppErrorException('BINARY_NOT_FOUND', 'cloudflared binary not found')
    }

    const metricsPort = await this.getFreePortFn()
    const args: string[] = [
      'tunnel',
      '--no-autoupdate',
      '--output',
      'json',
      '--metrics',
      `127.0.0.1:${metricsPort}`
    ]

    let runEnv: NodeJS.ProcessEnv = { ...process.env }

    if (tunnel.kind === 'quick') {
      if (!tunnel.quick?.target) {
        throw new AppErrorException('VALIDATION', 'Quick tunnel requires target')
      }
      args.push('--config', await this.ensureQuickConfig(), '--url', tunnel.quick.target)
    } else if (tunnel.kind === 'local') {
      if (!tunnel.local?.configPath) {
        throw new AppErrorException('VALIDATION', 'Local tunnel requires configPath')
      }
      args.push('--config', tunnel.local.configPath, 'run')
    } else if (tunnel.kind === 'remote') {
      if (!this.deps.getTunnelToken) {
        throw new AppErrorException('INTERNAL', 'getTunnelToken dependency not configured')
      }
      const runToken = await this.deps.getTunnelToken(tunnel)
      args.push('run')
      runEnv = { ...runEnv, TUNNEL_TOKEN: runToken }
    } else {
      args.push('run')
    }

    const child = this.spawnFn(binStatus.path, args, {
      windowsHide: true,
      env: runEnv
    })

    if (!child.pid) {
      throw new AppErrorException('INTERNAL', 'Failed to spawn cloudflared process')
    }

    const existingInstance = this.instances.get(tunnel.id)
    const crashTimestamps = existingInstance?.crashTimestamps ?? []

    const instance: RunningTunnelInstance = {
      tunnel,
      child,
      metricsPort,
      startTime: Date.now(),
      pollTimer: null,
      backoffTimer: null,
      intentionalStop: false,
      crashTimestamps,
      quickUrl: undefined
    }

    this.instances.set(tunnel.id, instance)
    this.setStatus(tunnel.id, { state: 'starting' })

    await this.deps.store.update((s) => {
      s.runningPids[tunnel.id] = child.pid!
    })

    this.attachStreams(tunnel.id, child)
    this.startPoller(tunnel.id)
  }

  private attachStreams(id: string, child: ChildProcess): void {
    let stdoutRemaining = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = stdoutRemaining + chunk.toString()
      const lines = text.split(/\r?\n/)
      stdoutRemaining = lines.pop() ?? ''
      for (const line of lines) {
        this.appendLog(id, line)
      }
    })

    let stderrRemaining = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = stderrRemaining + chunk.toString()
      const lines = text.split(/\r?\n/)
      stderrRemaining = lines.pop() ?? ''
      for (const line of lines) {
        this.appendLog(id, line)
      }
    })

    child.on('close', (code) => {
      this.handleProcessExit(id, code)
    })
  }

  private startPoller(id: string): void {
    const instance = this.instances.get(id)
    if (!instance) return

    const poll = async (): Promise<void> => {
      const inst = this.instances.get(id)
      if (!inst || inst.intentionalStop) return

      try {
        const readyRes = await this.fetchFn(`http://127.0.0.1:${inst.metricsPort}/ready`)
        if (readyRes.ok) {
          const data = (await readyRes.json()) as { readyConnections?: number }
          const connections = data.readyConnections ?? 0

          if (connections >= 1) {
            if (inst.tunnel.kind === 'quick' && !inst.quickUrl) {
              try {
                const qtRes = await this.fetchFn(`http://127.0.0.1:${inst.metricsPort}/quicktunnel`)
                if (qtRes.ok) {
                  const qtData = (await qtRes.json()) as { hostname?: string }
                  if (qtData.hostname) {
                    inst.quickUrl = `https://${qtData.hostname}`
                  }
                }
              } catch {
                // Ignore quicktunnel poll error
              }
            }

            this.setStatus(id, {
              state: 'connected',
              connections,
              quickUrl: inst.quickUrl
            })
            return
          }
        }

        const elapsed = Date.now() - inst.startTime
        if (elapsed > 30000) {
          this.setStatus(id, {
            state: 'degraded',
            reason: 'Process alive but metrics endpoint reporting 0 connections'
          })
        } else {
          this.setStatus(id, { state: 'starting' })
        }
      } catch {
        const elapsed = Date.now() - inst.startTime
        if (elapsed > 30000) {
          this.setStatus(id, {
            state: 'degraded',
            reason: 'Cannot connect to metrics port'
          })
        } else {
          this.setStatus(id, { state: 'starting' })
        }
      }
    }

    void poll()
    instance.pollTimer = setInterval(() => {
      void poll()
    }, 2000)
  }

  private handleProcessExit(id: string, code: number | null): void {
    const instance = this.instances.get(id)
    if (!instance) return

    if (instance.pollTimer) {
      clearInterval(instance.pollTimer)
      instance.pollTimer = null
    }

    if (instance.intentionalStop) {
      this.setStatus(id, { state: 'stopped' })
      this.instances.delete(id)
      return
    }

    void this.deps.store
      .update((s) => {
        delete s.runningPids[id]
      })
      .catch(() => {})

    const now = Date.now()
    instance.crashTimestamps = instance.crashTimestamps.filter((t) => now - t <= CRASH_WINDOW_MS)
    instance.crashTimestamps.push(now)

    if (instance.crashTimestamps.length >= 5) {
      const lastLines = this.getLogs(id, 50)
      this.setStatus(id, { state: 'crashed', exitCode: code, lastLines })
      this.instances.delete(id)
      return
    }

    const backoffIndex = Math.min(
      instance.crashTimestamps.length - 1,
      this.backoffDelays.length - 1
    )
    const delay = this.backoffDelays[backoffIndex]

    this.setStatus(id, { state: 'starting' })

    instance.backoffTimer = setTimeout(() => {
      void this.start(instance.tunnel).catch((err) => {
        console.error('Restart failed with error:', err)
      })
    }, delay)
  }

  public async stop(id: string): Promise<void> {
    const instance = this.instances.get(id)
    if (!instance) {
      this.setStatus(id, { state: 'stopped' })
      return
    }

    instance.intentionalStop = true
    if (instance.pollTimer) {
      clearInterval(instance.pollTimer)
      instance.pollTimer = null
    }
    if (instance.backoffTimer) {
      clearTimeout(instance.backoffTimer)
      instance.backoffTimer = null
    }

    const pid = instance.child.pid
    if (pid) {
      await this.killProcessFn(pid)
    }

    await this.deps.store.update((s) => {
      delete s.runningPids[id]
    })

    this.setStatus(id, { state: 'stopped' })
    this.instances.delete(id)
  }

  public async stopAll(): Promise<void> {
    const ids = Array.from(this.instances.keys())
    for (const id of ids) {
      await this.stop(id)
    }
  }

  public async cleanupOrphans(): Promise<void> {
    const pids = { ...this.deps.store.get().runningPids }
    const entries = Object.entries(pids)

    for (const [, pid] of entries) {
      const isAlive = await this.isProcessRunningFn(pid)
      if (isAlive) {
        await this.killProcessFn(pid)
      }
    }

    await this.deps.store.update((s) => {
      s.runningPids = {}
    })
  }
}
