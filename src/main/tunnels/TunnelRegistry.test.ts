import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SettingsStore } from '../settings/SettingsStore'
import { TunnelRegistry } from './TunnelRegistry'
import { AppErrorException } from '@shared/result'
import { z } from 'zod'

describe('TunnelRegistry', () => {
  let tempDir: string
  let store: SettingsStore
  let registry: TunnelRegistry

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'registry-test-'))
    const filePath = path.join(tempDir, 'state.json')
    store = new SettingsStore(filePath)
    await store.load()
    registry = new TunnelRegistry(store)
  })

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true })
  })

  it('add assigns uuid and adds tunnel', async () => {
    const tunnel = await registry.add({
      name: 'Test Tunnel',
      kind: 'quick',
      runMode: 'app',
      autoStart: false,
      quick: { target: 'http://localhost:8080' }
    })

    expect(z.string().uuid().safeParse(tunnel.id).success).toBe(true)
    expect(tunnel.name).toBe('Test Tunnel')
    expect(registry.list()).toEqual([tunnel])
    expect(registry.get(tunnel.id)).toEqual(tunnel)
  })

  it('update modifies fields', async () => {
    const tunnel = await registry.add({
      name: 'Initial Name',
      kind: 'quick',
      runMode: 'app',
      autoStart: false,
      quick: { target: 'http://localhost:8080' }
    })

    const updated = await registry.update(tunnel.id, {
      name: 'Updated Name',
      autoStart: true
    })

    expect(updated.id).toBe(tunnel.id)
    expect(updated.name).toBe('Updated Name')
    expect(updated.autoStart).toBe(true)
    expect(registry.get(tunnel.id).name).toBe('Updated Name')
    expect(registry.get(tunnel.id).autoStart).toBe(true)
  })

  it('remove deletes tunnel', async () => {
    const tunnel = await registry.add({
      name: 'To Delete',
      kind: 'quick',
      runMode: 'app',
      autoStart: false,
      quick: { target: 'http://localhost:8080' }
    })

    expect(registry.list()).toHaveLength(1)
    await registry.remove(tunnel.id)
    expect(registry.list()).toHaveLength(0)

    expect(() => registry.get(tunnel.id)).toThrow(AppErrorException)
  })

  it('throws NOT_FOUND error on unknown id', async () => {
    const unknownId = '11111111-2222-3333-4444-555555555555'

    expect(() => registry.get(unknownId)).toThrow(AppErrorException)
    try {
      registry.get(unknownId)
    } catch (err) {
      expect((err as AppErrorException).code).toBe('NOT_FOUND')
    }

    await expect(registry.update(unknownId, { name: 'New' })).rejects.toThrow(AppErrorException)
    try {
      await registry.update(unknownId, { name: 'New' })
    } catch (err) {
      expect((err as AppErrorException).code).toBe('NOT_FOUND')
    }

    await expect(registry.remove(unknownId)).rejects.toThrow(AppErrorException)
    try {
      await registry.remove(unknownId)
    } catch (err) {
      expect((err as AppErrorException).code).toBe('NOT_FOUND')
    }
  })

  it("'changed' event fires with full list", async () => {
    const changedListener = vi.fn()
    registry.on('changed', changedListener)

    const t1 = await registry.add({
      name: 'T1',
      kind: 'quick',
      runMode: 'app',
      autoStart: false,
      quick: { target: 'http://localhost:3000' }
    })

    expect(changedListener).toHaveBeenCalledTimes(1)
    expect(changedListener).toHaveBeenLastCalledWith([t1])

    const t2 = await registry.add({
      name: 'T2',
      kind: 'quick',
      runMode: 'app',
      autoStart: false,
      quick: { target: 'http://localhost:4000' }
    })

    expect(changedListener).toHaveBeenCalledTimes(2)
    expect(changedListener).toHaveBeenLastCalledWith([t1, t2])

    await registry.update(t1.id, { name: 'T1 Renamed' })
    expect(changedListener).toHaveBeenCalledTimes(3)
    expect(changedListener).toHaveBeenLastCalledWith([{ ...t1, name: 'T1 Renamed' }, t2])

    await registry.remove(t1.id)
    expect(changedListener).toHaveBeenCalledTimes(4)
    expect(changedListener).toHaveBeenLastCalledWith([t2])
  })

  it('changes persist through store and reload', async () => {
    const t = await registry.add({
      name: 'Persisted Tunnel',
      kind: 'quick',
      runMode: 'app',
      autoStart: true,
      quick: { target: 'http://localhost:5000' }
    })

    const freshStore = new SettingsStore(store.filePath)
    const freshState = await freshStore.load()
    expect(freshState.tunnels).toEqual([t])

    const freshRegistry = new TunnelRegistry(freshStore)
    expect(freshRegistry.get(t.id)).toEqual(t)
  })
})
