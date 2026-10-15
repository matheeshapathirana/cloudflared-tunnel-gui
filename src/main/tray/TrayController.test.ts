import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tunnel, TunnelStatus } from '../../shared/schemas'

type MenuItem = { label?: string; type?: string; checked?: boolean; click?: () => void }

const electron = vi.hoisted(() => {
  const state = {
    trayArgs: [] as unknown[],
    handlers: {} as Record<string, () => void>,
    template: [] as MenuItem[],
    failTray: false,
    destroyed: 0,
    tooltip: '',
    image: { isEmpty: () => false, reps: [] as unknown[], path: '' }
  }
  return state
})

vi.mock('electron', () => {
  class MockTray {
    constructor(image: unknown) {
      if (electron.failTray) throw new Error('no tray in this environment')
      electron.trayArgs.push(image)
    }
    setToolTip(text: string): void {
      electron.tooltip = text
    }
    setContextMenu = vi.fn()
    on(event: string, cb: () => void): void {
      electron.handlers[event] = cb
    }
    destroy(): void {
      electron.destroyed++
    }
  }
  return {
    nativeImage: {
      createFromPath: vi.fn((p: string) => {
        electron.image.path = p
        return {
          isEmpty: () => electron.image.isEmpty(),
          addRepresentation: (rep: unknown) => electron.image.reps.push(rep)
        }
      })
    },
    Tray: MockTray,
    Menu: {
      buildFromTemplate: vi.fn((template: MenuItem[]) => {
        electron.template = template
        return { template }
      })
    }
  }
})

import { TrayController } from './TrayController'

const resources = path.resolve(__dirname, '../../../resources')
const iconPaths = {
  x1: path.join(resources, 'tray-16.png'),
  x2: path.join(resources, 'tray-32.png')
}

const tunnel = (id: string, name: string): Tunnel => ({
  id,
  name,
  kind: 'quick',
  runMode: 'app',
  autoStart: false,
  quick: { target: 'http://localhost:3000' }
})

const item = (label: RegExp | string): MenuItem => {
  const found = electron.template.find((i) =>
    typeof label === 'string' ? i.label === label : label.test(i.label ?? '')
  )
  if (!found) throw new Error(`no menu item ${String(label)}`)
  return found
}

describe('TrayController', () => {
  const onOpen = vi.fn()
  const onNavigate = vi.fn()
  const onQuit = vi.fn()
  const onToggleTunnel = vi.fn()
  let controller: TrayController

  beforeEach(() => {
    vi.clearAllMocks()
    electron.trayArgs = []
    electron.handlers = {}
    electron.template = []
    electron.failTray = false
    electron.destroyed = 0
    electron.tooltip = ''
    electron.image = { isEmpty: () => false, reps: [], path: '' }
    controller = new TrayController({ onOpen, onNavigate, onQuit, onToggleTunnel, iconPaths })
  })

  it('shows the real app icon, with a 2x version for high-DPI displays', () => {
    controller.init()
    expect(electron.trayArgs).toHaveLength(1)
    expect(electron.image.path).toBe(iconPaths.x1)
    expect(electron.image.reps).toEqual([{ scaleFactor: 2, buffer: fs.readFileSync(iconPaths.x2) }])
    expect(electron.tooltip).toBe('Cloudflared Tunnel GUI')
  })

  it('ships tray icon files that exist and have the right dimensions', () => {
    const size = (file: string): [number, number] => {
      const png = fs.readFileSync(file)
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a') // PNG signature
      return [png.readUInt32BE(16), png.readUInt32BE(20)] // IHDR width, height
    }
    expect(size(iconPaths.x1)).toEqual([16, 16])
    expect(size(iconPaths.x2)).toEqual([32, 32])
  })

  it('still works with just the 1x icon if the 2x file is missing', () => {
    controller = new TrayController({
      onOpen,
      onNavigate,
      onQuit,
      onToggleTunnel,
      iconPaths: { x1: iconPaths.x1, x2: path.join(resources, 'does-not-exist.png') }
    })
    controller.init()
    expect(electron.trayArgs).toHaveLength(1)
    expect(electron.image.reps).toEqual([])
  })

  it('opens the window on click and double-click', () => {
    controller.init()
    electron.handlers['click']()
    electron.handlers['double-click']()
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it('"Quick share…" goes to the Quick share page', () => {
    controller.init()
    item('Quick share…').click!()
    expect(onNavigate).toHaveBeenCalledWith('quick-share')
  })

  it('lists tunnels with their state and toggles them', () => {
    controller.init()
    const running = tunnel('11111111-1111-4111-8111-111111111111', 'Running one')
    const stopped = tunnel('22222222-2222-4222-8222-222222222222', 'Stopped one')
    controller.updateMenu(
      [running, stopped],
      new Map<string, TunnelStatus>([[running.id, { state: 'connected', connections: 1 }]])
    )

    const runningItem = item(/Running one/)
    const stoppedItem = item(/Stopped one/)
    expect(runningItem).toMatchObject({ type: 'checkbox', checked: true })
    expect(runningItem.label).toContain('connected')
    expect(stoppedItem).toMatchObject({ type: 'checkbox', checked: false })

    runningItem.click!() // running -> stop
    stoppedItem.click!() // stopped -> start
    expect(onToggleTunnel).toHaveBeenNthCalledWith(1, running.id, false)
    expect(onToggleTunnel).toHaveBeenNthCalledWith(2, stopped.id, true)
  })

  it('has Open and Quit entries', () => {
    controller.init()
    item('Open Cloudflared Tunnel GUI').click!()
    item('Quit').click!()
    expect(onOpen).toHaveBeenCalledOnce()
    expect(onQuit).toHaveBeenCalledOnce()
  })

  it('does not throw when the tray cannot be created, and destroy cleans up', () => {
    electron.failTray = true
    expect(() => controller.init()).not.toThrow()
    expect(() => controller.updateMenu([], new Map())).not.toThrow()

    electron.failTray = false
    controller.init()
    controller.destroy()
    expect(electron.destroyed).toBe(1)
  })
})
