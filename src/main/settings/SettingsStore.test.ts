import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SettingsStore } from './SettingsStore'
import { defaultAppState } from '@shared/schemas'
import { AppErrorException } from '@shared/result'

describe('SettingsStore', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'settings-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true })
  })

  it('missing file gives defaults', async () => {
    const filePath = path.join(tempDir, 'state.json')
    const store = new SettingsStore(filePath)
    const state = await store.load()

    expect(state).toEqual(defaultAppState())
    expect(store.get()).toEqual(defaultAppState())
  })

  it('corrupt file is renamed and defaults are used', async () => {
    const filePath = path.join(tempDir, 'state.json')
    await fs.promises.writeFile(filePath, '{"version": 999, "invalid": true}', 'utf8')

    const store = new SettingsStore(filePath)
    const state = await store.load()

    expect(state).toEqual(defaultAppState())
    expect(store.get()).toEqual(defaultAppState())

    const files = await fs.promises.readdir(tempDir)
    const corruptFile = files.find((f) => f.startsWith('state.json.corrupt-'))
    expect(corruptFile).toBeDefined()
  })

  it('corrupt JSON syntax is renamed and defaults are used', async () => {
    const filePath = path.join(tempDir, 'state.json')
    await fs.promises.writeFile(filePath, '{ not valid json', 'utf8')

    const store = new SettingsStore(filePath)
    const state = await store.load()

    expect(state).toEqual(defaultAppState())
    expect(store.get()).toEqual(defaultAppState())

    const files = await fs.promises.readdir(tempDir)
    const corruptFile = files.find((f) => f.startsWith('state.json.corrupt-'))
    expect(corruptFile).toBeDefined()
  })

  it('update persists and fresh instance reloads it', async () => {
    const filePath = path.join(tempDir, 'state.json')
    const store1 = new SettingsStore(filePath)
    await store1.load()

    await store1.update((draft) => {
      draft.recentQuickTargets.push('http://localhost:3000')
      draft.startup.launchAtLogin = true
    })

    const store2 = new SettingsStore(filePath)
    const loaded = await store2.load()

    expect(loaded.recentQuickTargets).toEqual(['http://localhost:3000'])
    expect(loaded.startup.launchAtLogin).toBe(true)
  })

  it('10 concurrent updates appending to recentQuickTargets all land', async () => {
    const filePath = path.join(tempDir, 'state.json')
    const store = new SettingsStore(filePath)
    await store.load()

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.update((draft) => {
          draft.recentQuickTargets.push(`target-${i}`)
        })
      )
    )

    const state = store.get()
    expect(state.recentQuickTargets).toHaveLength(10)
    for (let i = 0; i < 10; i++) {
      expect(state.recentQuickTargets).toContain(`target-${i}`)
    }

    const reloaded = new SettingsStore(filePath)
    const reloadedState = await reloaded.load()
    expect(reloadedState.recentQuickTargets).toHaveLength(10)
  })

  it('invalid update is rejected and file on disk is unchanged', async () => {
    const filePath = path.join(tempDir, 'state.json')
    const store = new SettingsStore(filePath)
    await store.load()

    await store.update((draft) => {
      draft.recentQuickTargets = ['initial']
    })

    const contentBefore = await fs.promises.readFile(filePath, 'utf8')

    await expect(
      store.update((draft) => {
        // Violate schema by setting invalid version
        ;(draft as unknown as Record<string, unknown>).version = 999
      })
    ).rejects.toThrow(AppErrorException)

    const contentAfter = await fs.promises.readFile(filePath, 'utf8')
    expect(contentAfter).toBe(contentBefore)
    expect(store.get().recentQuickTargets).toEqual(['initial'])
  })
})
