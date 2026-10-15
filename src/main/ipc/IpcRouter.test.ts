import { describe, it, expect, vi } from 'vitest'
import { IpcRouter } from './IpcRouter'
import { AppErrorException } from '@shared/result'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

describe('IpcRouter', () => {
  it('unknown command returns UNKNOWN_COMMAND', async () => {
    const router = new IpcRouter()

    const res1 = await router.dispatch('nonexistent.command', {})
    expect(res1).toEqual({
      ok: false,
      error: {
        code: 'UNKNOWN_COMMAND',
        message: 'Unknown command: nonexistent.command'
      }
    })

    const res2 = await router.dispatch(12345, null)
    expect(res2).toEqual({
      ok: false,
      error: {
        code: 'UNKNOWN_COMMAND',
        message: 'Unknown command: 12345'
      }
    })

    const res3 = await router.dispatch(null, undefined)
    expect(res3).toEqual({
      ok: false,
      error: {
        code: 'UNKNOWN_COMMAND',
        message: 'Unknown command: null'
      }
    })
  })

  it('validation error returns VALIDATION with zod details', async () => {
    const router = new IpcRouter()
    router.register('tunnels.rename', async () => {
      throw new Error('should not be called')
    })

    // invalid UUID and empty name
    const res = await router.dispatch('tunnels.rename', {
      id: 'not-a-uuid',
      name: '   '
    })

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('VALIDATION')
      expect(res.error.message).toBe('Validation failed')
      expect(Array.isArray(res.error.details)).toBe(true)
      expect((res.error.details as unknown[]).length).toBeGreaterThan(0)
    }
  })

  it('success returns ok: true with data', async () => {
    const router = new IpcRouter()
    const mockTunnels = [
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'my-tunnel',
        kind: 'quick' as const,
        runMode: 'app' as const,
        autoStart: false,
        quick: { target: 'http://localhost:3000' }
      }
    ]

    router.register('tunnels.list', async () => {
      return mockTunnels
    })

    const res = await router.dispatch('tunnels.list', undefined)
    expect(res).toEqual({
      ok: true,
      data: mockTunnels
    })
  })

  it('AppErrorException maps to its code and message', async () => {
    const router = new IpcRouter()
    router.register('tunnels.delete', async () => {
      throw new AppErrorException('NOT_FOUND', 'Tunnel not found', { extra: 42 })
    })

    const res = await router.dispatch('tunnels.delete', {
      id: '123e4567-e89b-12d3-a456-426614174000'
    })

    expect(res).toEqual({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Tunnel not found',
        details: { extra: 42 }
      }
    })
  })

  it('generic error maps to INTERNAL with message only (no stack)', async () => {
    const router = new IpcRouter()
    router.register('binary.status', async () => {
      throw new Error('Disk IO failure')
    })

    const res = await router.dispatch('binary.status', undefined)
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'Disk IO failure'
      }
    })
    // Ensure no stack leak
    expect((res as { error?: { stack?: unknown } }).error?.stack).toBeUndefined()
  })

  it('untrusted sender is rejected in attach', async () => {
    const router = new IpcRouter()
    let invokeHandler: ((event: unknown, msg: unknown) => Promise<unknown>) | undefined

    const mockIpcMain: Pick<IpcMain, 'handle'> = {
      handle: vi.fn((_channel: string, handler: unknown) => {
        invokeHandler = handler as (event: unknown, msg: unknown) => Promise<unknown>
      })
    }

    const isTrustedSender = vi.fn((event: IpcMainInvokeEvent) => {
      return (event as unknown as { isTrusted?: boolean }).isTrusted === true
    })

    router.attach(mockIpcMain, isTrustedSender)

    expect(mockIpcMain.handle).toHaveBeenCalledWith('ipc:invoke', expect.any(Function))
    expect(invokeHandler).toBeDefined()

    // 1. Untrusted sender
    const untrustedEvent = { isTrusted: false } as unknown as IpcMainInvokeEvent
    const untrustedRes = await invokeHandler!(untrustedEvent, {
      name: 'tunnels.list',
      input: undefined
    })

    expect(untrustedRes).toEqual({
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'untrusted sender'
      }
    })

    // 2. Trusted sender
    router.register('tunnels.list', async () => [])
    const trustedEvent = { isTrusted: true } as unknown as IpcMainInvokeEvent
    const trustedRes = await invokeHandler!(trustedEvent, {
      name: 'tunnels.list',
      input: undefined
    })

    expect(trustedRes).toEqual({
      ok: true,
      data: []
    })
  })
})
