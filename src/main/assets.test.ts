import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ isPackaged: false }))
vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return electron.isPackaged
    }
  }
}))

import { resourcePath } from './assets'

describe('resourcePath', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

  afterEach(() => {
    if (original) Object.defineProperty(process, 'resourcesPath', original)
    else delete (process as { resourcesPath?: string }).resourcesPath
    electron.isPackaged = false
  })

  it('reads from the repository in development', () => {
    electron.isPackaged = false
    const file = resourcePath('tray-16.png')
    expect(path.basename(path.dirname(file))).toBe('resources')
    expect(fs.existsSync(file)).toBe(true)
  })

  it('reads the loose files next to the app when packaged, not from inside app.asar', () => {
    electron.isPackaged = true
    Object.defineProperty(process, 'resourcesPath', {
      value: 'C:\\Program Files\\App\\resources',
      configurable: true
    })
    const file = resourcePath('tray-16.png')
    expect(file).toBe(path.join('C:\\Program Files\\App\\resources', 'resources', 'tray-16.png'))
    expect(file).not.toContain('app.asar')
  })

  it('every icon the app asks for exists in the resources folder that gets packaged', () => {
    electron.isPackaged = false
    for (const name of ['icon.png', 'tray-16.png', 'tray-32.png']) {
      expect(fs.existsSync(resourcePath(name)), name).toBe(true)
    }
  })
})
