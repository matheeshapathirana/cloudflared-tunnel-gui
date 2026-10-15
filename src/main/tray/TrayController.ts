import { Menu, Tray, nativeImage } from 'electron'
import type { Tunnel, TunnelStatus } from '../../shared/schemas'

export interface TrayControllerDeps {
  onOpen: () => void
  onNavigate: (page: string) => void
  onQuit: () => void
  onToggleTunnel: (id: string, start: boolean) => void
}

export class TrayController {
  private tray: Tray | null = null

  constructor(private deps: TrayControllerDeps) {}

  public init(): void {
    if (this.tray) return

    // 16x16 transparent or basic fallback icon
    const icon = nativeImage.createEmpty()
    try {
      this.tray = new Tray(icon)
      this.tray.setToolTip('Cloudflared Tunnel GUI')
      this.tray.on('double-click', () => {
        this.deps.onOpen()
      })
      this.updateMenu([], new Map())
    } catch {
      // In headless environments or during tests Tray might fail
      this.tray = null
    }
  }

  public updateMenu(tunnels: Tunnel[], statuses: Map<string, TunnelStatus>): void {
    if (!this.tray) return

    const menuItems: Electron.MenuItemConstructorOptions[] = []

    if (tunnels.length > 0) {
      menuItems.push({ label: 'Tunnels', enabled: false })
      for (const tunnel of tunnels) {
        const status = statuses.get(tunnel.id) ?? { state: 'stopped' }
        const isRunning = status.state === 'connected' || status.state === 'starting'
        const dot = status.state === 'connected' ? '● ' : status.state === 'starting' ? '◐ ' : '○ '
        menuItems.push({
          label: `${dot}${tunnel.name} (${status.state})`,
          type: 'checkbox',
          checked: isRunning,
          click: () => {
            this.deps.onToggleTunnel(tunnel.id, !isRunning)
          }
        })
      }
      menuItems.push({ type: 'separator' })
    }

    menuItems.push(
      {
        label: 'Quick share…',
        click: () => {
          this.deps.onNavigate('quick')
          this.deps.onOpen()
        }
      },
      { type: 'separator' },
      {
        label: 'Open Cloudflared Tunnel GUI',
        click: () => {
          this.deps.onOpen()
        }
      },
      {
        label: 'Quit',
        click: () => {
          this.deps.onQuit()
        }
      }
    )

    const contextMenu = Menu.buildFromTemplate(menuItems)
    this.tray.setContextMenu(contextMenu)
  }

  public destroy(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }
}
