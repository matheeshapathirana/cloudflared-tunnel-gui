import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { ProcessSupervisor } from './ProcessSupervisor'
import { SettingsStore } from '../settings/SettingsStore'
import { createFakeCloudflaredServer } from './fakeCloudflared'
import type { Tunnel, BinaryStatus } from '../../shared/schemas'
import type { ChildProcess } from 'node:child_process'
import type http from 'node:http'

describe('ProcessSupervisor', () => {
  let tmpDir: string
  let store: SettingsStore
  let fakeBinary: { status: () => Promise<BinaryStatus> }
  let fakeServer: http.Server | null = null
  let fakePort: number

  const sampleQuickTunnel: Tunnel = {
    id: '123e4567-e89b-12d3-a456-426614174001',
    name: 'Quick Test',
    kind: 'quick',
    runMode: 'app',
    autoStart: false,
    quick: { target: 'http://localhost:3000' }
  }

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'supervisor-test-'))
    store = new SettingsStore(path.join(tmpDir, 'state.json'))
    await store.load()

    fakeBinary = {
      status: vi.fn(async () => ({
        found: true as const,
        path: 'C:\\fake\\cloudflared.exe',
        source: 'managed' as const,
        version: '2026.10.0',
        overrideInvalid: false
      }))
    }
  })

  afterEach(async () => {
    if (fakeServer) {
      await new Promise<void>((resolve) => fakeServer!.close(() => resolve()))
      fakeServer = null
    }
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true })
    } catch {
      // Ignore transient Windows file lock contention on temp dir
    }
  })

  function createMockChild(pid = 12345): ChildProcess & {
    emitStdout: (str: string) => void
    emitStderr: (str: string) => void
    emitClose: (code: number) => void
  } {
    const child = new EventEmitter() as unknown as ChildProcess & {
      pid?: number
      stdout?: EventEmitter
      stderr?: EventEmitter
      emitStdout: (str: string) => void
      emitStderr: (str: string) => void
      emitClose: (code: number) => void
    }

    child.pid = pid
    child.stdout = new EventEmitter() as unknown as import('node:stream').Readable
    child.stderr = new EventEmitter() as unknown as import('node:stream').Readable

    child.emitStdout = (str: string): void => {
      child.stdout?.emit('data', Buffer.from(str))
    }
    child.emitStderr = (str: string): void => {
      child.stderr?.emit('data', Buffer.from(str))
    }
    child.emitClose = (code: number): void => {
      Object.defineProperty(child, 'exitCode', { value: code, configurable: true, writable: true })
      child.emit('close', code)
    }

    return child as unknown as ChildProcess & {
      emitStdout: (str: string) => void
      emitStderr: (str: string) => void
      emitClose: (code: number) => void
    }
  }

  it('starts quick tunnel, collects logs, and updates status to connected', async () => {
    fakePort = 39821
    fakeServer = createFakeCloudflaredServer(fakePort, {
      readyConnections: 2,
      hostname: 'my-tunnel.trycloudflare.com'
    })
    await new Promise<void>((resolve) => fakeServer!.listen(fakePort, '127.0.0.1', () => resolve()))

    const mockChild = createMockChild(1111)
    const mockSpawn = vi.fn(() => mockChild)
    const killedPids: number[] = []

    const supervisor = new ProcessSupervisor({
      binaryManager: fakeBinary,
      store,
      appDataPath: tmpDir,
      spawn: mockSpawn as unknown as typeof import('node:child_process').spawn,
      getFreePort: vi.fn(async () => fakePort),
      killProcess: vi.fn(async (pid) => {
        killedPids.push(pid)
      })
    })

    const logEvents: string[] = []
    supervisor.on('log', ({ line }) => logEvents.push(line))

    await supervisor.start(sampleQuickTunnel)

    expect(supervisor.getStatus(sampleQuickTunnel.id).state).toBe('starting')
    expect(store.get().runningPids[sampleQuickTunnel.id]).toBe(1111)

    // Emit logs
    mockChild.emitStderr('{"level":"info","message":"Connecting to edge"}\n')
    expect(logEvents).toContain('{"level":"info","message":"Connecting to edge"}')
    expect(supervisor.getLogs(sampleQuickTunnel.id)).toEqual([
      '{"level":"info","message":"Connecting to edge"}'
    ])

    // Wait for poller to query fakeServer
    await new Promise((r) => setTimeout(r, 200))

    const status = supervisor.getStatus(sampleQuickTunnel.id)
    expect(status.state).toBe('connected')
    if (status.state === 'connected') {
      expect(status.connections).toBe(2)
      expect(status.quickUrl).toBe('https://my-tunnel.trycloudflare.com')
    }

    // Now test stop
    await supervisor.stop(sampleQuickTunnel.id)
    expect(killedPids).toContain(1111)
    expect(supervisor.getStatus(sampleQuickTunnel.id)).toEqual({ state: 'stopped' })
    expect(store.get().runningPids[sampleQuickTunnel.id]).toBeUndefined()
  })

  it('gives quick tunnels a non-empty config so ~/.cloudflared/config.yml is never used', async () => {
    const mockChild = createMockChild(1234)
    const mockSpawn = vi.fn(() => mockChild)
    const supervisor = new ProcessSupervisor({
      binaryManager: fakeBinary,
      store,
      appDataPath: tmpDir,
      spawn: mockSpawn as unknown as typeof import('node:child_process').spawn,
      getFreePort: vi.fn(async () => 40010),
      killProcess: vi.fn(async () => {})
    })

    await supervisor.start(sampleQuickTunnel)

    const [, args, options] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv }
    ]
    const configArg = args[args.indexOf('--config') + 1]
    expect(path.basename(configArg)).toBe('quick-tunnel-config.yml')
    // a zero-byte file makes cloudflared log "Configuration file ... was empty" as an error
    expect(await fs.promises.readFile(configArg, 'utf8')).toBe('no-autoupdate: true\n')
    expect(args).toContain('--url')
    expect(args).not.toContain('run')
    expect(options.env.TUNNEL_TOKEN).toBeUndefined()

    await supervisor.stop(sampleQuickTunnel.id)
  })

  it('handles crash and restarts with backoff up to crashed state on 5 failures', async () => {
    let callCount = 0
    const mockSpawn = vi.fn(() => {
      callCount++
      return createMockChild(2000 + callCount)
    })

    const supervisor = new ProcessSupervisor({
      binaryManager: fakeBinary,
      store,
      appDataPath: tmpDir,
      spawn: mockSpawn as unknown as typeof import('node:child_process').spawn,
      getFreePort: vi.fn(async () => 40001),
      killProcess: vi.fn(async () => {}),
      backoffDelays: [15, 15, 15, 15, 15]
    })

    await supervisor.start(sampleQuickTunnel)
    expect(callCount).toBe(1)

    for (let i = 1; i <= 5; i++) {
      const activeChild = mockSpawn.mock.results[i - 1].value as ReturnType<typeof createMockChild>
      activeChild.emitClose(1)
      if (i < 5) {
        await new Promise((r) => setTimeout(r, 60))
        expect(callCount).toBe(i + 1)
      }
    }

    const finalStatus = supervisor.getStatus(sampleQuickTunnel.id)
    expect(finalStatus.state).toBe('crashed')
    if (finalStatus.state === 'crashed') {
      expect(finalStatus.exitCode).toBe(1)
    }

    await supervisor.stopAll()
  })

  it('cleans up orphan processes on cleanupOrphans', async () => {
    await store.update((s) => {
      s.runningPids = {
        'old-tunnel-1': 8888,
        'old-tunnel-2': 9999
      }
    })

    const killed: number[] = []
    const supervisor = new ProcessSupervisor({
      binaryManager: fakeBinary,
      store,
      appDataPath: tmpDir,
      killProcess: vi.fn(async (pid) => {
        killed.push(pid)
      }),
      isProcessRunning: vi.fn(async (pid) => pid === 8888)
    })

    await supervisor.cleanupOrphans()

    expect(killed).toEqual([8888])
    expect(store.get().runningPids).toEqual({})
  })

  it('starts remote tunnel with TUNNEL_TOKEN in env', async () => {
    const sampleRemoteTunnel: Tunnel = {
      id: '223e4567-e89b-12d3-a456-426614174002',
      name: 'Remote Prod',
      kind: 'remote',
      cfTunnelId: 'cf-tunnel-prod-123',
      runMode: 'app',
      autoStart: false
    }

    const mockChild = createMockChild(3333)
    let spawnedEnv: NodeJS.ProcessEnv | undefined
    let spawnedArgs: string[] | undefined
    const mockSpawn = vi.fn((_cmd, args, options) => {
      spawnedArgs = args
      spawnedEnv = options?.env
      return mockChild
    })

    const getTunnelTokenMock = vi.fn(async () => 'mock-jwt-run-token')

    const supervisor = new ProcessSupervisor({
      binaryManager: fakeBinary,
      store,
      appDataPath: tmpDir,
      spawn: mockSpawn as unknown as typeof import('node:child_process').spawn,
      getFreePort: vi.fn(async () => 40002),
      getTunnelToken: getTunnelTokenMock,
      killProcess: vi.fn(async () => {})
    })

    await supervisor.start(sampleRemoteTunnel)

    expect(getTunnelTokenMock).toHaveBeenCalledWith(sampleRemoteTunnel)
    expect(spawnedArgs).toContain('run')
    expect(spawnedEnv?.TUNNEL_TOKEN).toBe('mock-jwt-run-token')
    expect(supervisor.getStatus(sampleRemoteTunnel.id).state).toBe('starting')
    expect(store.get().runningPids[sampleRemoteTunnel.id]).toBe(3333)

    await supervisor.stop(sampleRemoteTunnel.id)
  })
})
