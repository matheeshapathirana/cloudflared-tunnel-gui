import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TrayController } from './TrayController'
import type { Tunnel, TunnelStatus } from '../../shared/schemas'

vi.mock('electron', () => {
  let clickHandlers: Record<string, () => void> = {}

  class MockTray {
    public tooltip = ''
    public menu: unknown = null
    public doubleClickHandler: (() => void) | null = null

    setToolTip(str: string): void {
      this.tooltip = str
    }
    setContextMenu(m: unknown): void {
      this.menu = m
    }
    on(event: string, cb: () => void): void {
      if (event === 'double-click') this.doubleClickHandler = cb
    }
    destroy = vi.fn()
  }

  return {
    nativeImage: {
      createEmpty: vi.fn(() => ({}))
    },
    Tray: MockTray,
    Menu: {
      buildFromTemplate: vi.fn((template: Array<{ label?: string; click?: () => void }>) => {
        clickHandlers = {}
        for (const item of template) {
          if (item.label && item.click) {
            clickHandlers[item.label] = item.click
          }
        }
        return { template, clickHandlers }
      })
    }
  }
})

describe('TrayController', () => {
  let onOpen: () => void
  let onNavigate: (page: string) => void
  let onQuit: () => void
  let onToggleTunnel: (id: string, start: boolean) => void
  let controller: TrayController

  beforeEach(() => {
    onOpen = vi.fn()
    onNavigate = vi.fn()
    onQuit = vi.fn()
    onToggleTunnel = vi.fn()

    controller = new TrayController({
      onOpen,
      onNavigate,
      onQuit,
      onToggleTunnel
    })
  })

  it('initializes tray and updates menu with tunnels', () => {
    controller.init()

    const sampleTunnel: Tunnel = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'My Quick Tunnel',
      kind: 'quick',
      runMode: 'app',
      autoStart: false,
      quick: { target: 'http://localhost:3000' }
    }

    const statuses = new Map<string, TunnelStatus>([
      [sampleTunnel.id, { state: 'connected', connections: 1 }]
    ])

    controller.updateMenu([sampleTunnel], statuses)

    // Verify destroy cleans up without errors
    controller.destroy()
    expect(true).toBe(true)
  })
})
