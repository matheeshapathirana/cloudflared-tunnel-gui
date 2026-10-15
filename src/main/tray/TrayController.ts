import fs from 'node:fs'
import { Menu, Tray, nativeImage } from 'electron'
import type { AppPage, Tunnel, TunnelStatus } from '../../shared/schemas'

export interface TrayControllerDeps {
  onOpen: () => void
  onNavigate: (page: AppPage) => void
  onQuit: () => void
  onToggleTunnel: (id: string, start: boolean) => void
  /** Quit and install the already-downloaded update. */
  onInstallUpdate: () => void
  /** PNG files for 100% (16px) and 200% (32px) display scaling. */
  iconPaths: { x1: string; x2: string }
}

export class TrayController {
  private tray: Tray | null = null
  private updateVersion: string | null = null
  private lastTunnels: Tunnel[] = []
  private lastStatuses = new Map<string, TunnelStatus>()

  constructor(private deps: TrayControllerDeps) {}

  private buildIcon(): Electron.NativeImage {
    const image = nativeImage.createFromPath(this.deps.iconPaths.x1)
    try {
      image.addRepresentation({
        scaleFactor: 2,
        buffer: fs.readFileSync(this.deps.iconPaths.x2)
      })
    } catch {
      // the 16px image alone still works; it is just softer on high-DPI displays
    }
    return image
  }

  public init(): void {
    if (this.tray) return

    try {
      this.tray = new Tray(this.buildIcon())
      this.tray.setToolTip('Cloudflared Tunnel GUI')
      // single click is how Windows tray apps usually reopen their window
      this.tray.on('click', () => {
        this.deps.onOpen()
      })
      this.tray.on('double-click', () => {
        this.deps.onOpen()
      })
      this.updateMenu(this.lastTunnels, this.lastStatuses)
    } catch {
      // In headless environments or during tests Tray might fail
      this.tray = null
    }
  }

  /** Show a "Restart to update" item for this version, or remove it with null. */
  public setUpdateReady(version: string | null): void {
    this.updateVersion = version
    this.updateMenu(this.lastTunnels, this.lastStatuses)
  }

  public updateMenu(tunnels: Tunnel[], statuses: Map<string, TunnelStatus>): void {
    this.lastTunnels = tunnels
    this.lastStatuses = statuses
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
          this.deps.onNavigate('quick-share')
        }
      },
      { type: 'separator' },
      {
        label: 'Open Cloudflared Tunnel GUI',
        click: () => {
          this.deps.onOpen()
        }
      },
      ...(this.updateVersion
        ? [
            {
              label: `Restart to update to v${this.updateVersion}`,
              click: () => {
                this.deps.onInstallUpdate()
              }
            }
          ]
        : []),
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
