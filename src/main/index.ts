import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { EVENT_CHANNEL } from '@shared/ipc'
import { resourcePath } from './assets'
import { createMainWindow, isTrustedSender } from './window'
import { IpcRouter } from './ipc/IpcRouter'
import { registerCommands } from './ipc/registerCommands'
import { SettingsStore } from './settings/SettingsStore'
import { TunnelRegistry } from './tunnels/TunnelRegistry'
import { createDefaultBinaryManager } from './binary/BinaryManager'
import { ProcessSupervisor } from './process/ProcessSupervisor'
import { TrayController } from './tray/TrayController'
import { LocalConfigStore } from './config/LocalConfigStore'
import { SecretStore } from './security/SecretStore'
import { CloudflareApi } from './api/CloudflareApi'
import { ServiceManager } from './services/ServiceManager'
import { ImportService } from './import/ImportService'
import { UpdateManager } from './update/UpdateManager'

// Set userData path before app ready
app.setPath('userData', join(app.getPath('appData'), 'CloudflaredTunnelGUI'))

const stateFile = join(app.getPath('userData'), 'state.json')

let mainWindow: BrowserWindow | null = null
let trayController: TrayController | null = null
let isQuitting = false

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // Wire dependencies
  const store = new SettingsStore(stateFile)
  const registry = new TunnelRegistry(store)
  const binaryManager = createDefaultBinaryManager(() => store.get().binary.overridePath)
  const secretStore = new SecretStore(join(app.getPath('userData'), 'token.enc'))
  const cloudflareApi = new CloudflareApi()

  const supervisor = new ProcessSupervisor({
    binaryManager,
    store,
    appDataPath: app.getPath('userData'),
    getTunnelToken: async (tunnel) => {
      const token = await secretStore.getToken()
      if (!token) {
        throw new Error('Cloudflare API token not configured')
      }
      const accountId = store.get().account?.accountId
      if (!accountId) {
        throw new Error('Cloudflare account ID not configured')
      }
      if (!tunnel.cfTunnelId) {
        throw new Error('Tunnel is missing cfTunnelId')
      }
      return cloudflareApi.getTunnelToken(token, accountId, tunnel.cfTunnelId)
    }
  })

  const localConfigStore = new LocalConfigStore({
    binaryManager
  })

  const serviceManager = new ServiceManager({
    binaryManager
  })

  const importService = new ImportService({
    registry,
    store,
    serviceManager,
    localConfigStore,
    cloudflareApi,
    secretStore
  })

  const updateManager = new UpdateManager({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    getAutoCheck: () => store.get().updates.autoCheck,
    beforeInstall: () => {
      isQuitting = true
    }
  })

  const readyUpdateVersion = (): string | null => {
    const { status } = updateManager.getState()
    return status.state === 'ready' ? status.version : null
  }

  const router = new IpcRouter()
  registerCommands(router, {
    registry,
    binaryManager,
    store,
    supervisor,
    localConfigStore,
    secretStore,
    cloudflareApi,
    serviceManager,
    importService,
    appVersion: app.getVersion(),
    updateManager,
    quitApp: () => {
      isQuitting = true
      app.quit()
    },
    setLoginSettings: (settings) => {
      app.setLoginItemSettings(settings)
    },
    applyTheme: (theme) => {
      nativeTheme.themeSource = theme
    },
    onDownloadProgress: (payload) => {
      mainWindow?.webContents.send(EVENT_CHANNEL, {
        name: 'binary:downloadProgress',
        payload
      })
    }
  })

  router.attach(ipcMain, isTrustedSender)

  // Forward registry events to renderer
  registry.on('changed', (payload) => {
    mainWindow?.webContents.send(EVENT_CHANNEL, {
      name: 'registry:changed',
      payload
    })
    trayController?.updateMenu(payload, supervisor.getAllStatuses())
  })

  updateManager.on('state', (payload) => {
    mainWindow?.webContents.send(EVENT_CHANNEL, {
      name: 'update:state',
      payload
    })
    trayController?.setUpdateReady(readyUpdateVersion())
  })

  supervisor.on('status', ({ id, status }) => {
    mainWindow?.webContents.send(EVENT_CHANNEL, {
      name: 'tunnel:status',
      payload: { id, status }
    })
    trayController?.updateMenu(registry.list(), supervisor.getAllStatuses())
  })

  supervisor.on('log', ({ id, line }) => {
    mainWindow?.webContents.send(EVENT_CHANNEL, {
      name: 'tunnel:log',
      payload: { id, line }
    })
  })

  app.whenReady().then(async () => {
    // Set app user model id for windows
    electronApp.setAppUserModelId('com.matheesha.cloudflaredtunnelgui')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    await store.load()
    updateManager.start()
    // 'system' follows the Windows app-mode setting live; light/dark override it
    nativeTheme.themeSource = store.get().theme
    await supervisor.cleanupOrphans()
    await importService.run().catch(() => {})

    const startupSettings = store.get().startup
    app.setLoginItemSettings({
      openAtLogin: startupSettings.launchAtLogin,
      args: startupSettings.startHidden ? ['--hidden'] : []
    })

    const isHiddenLaunch =
      process.argv.includes('--hidden') ||
      (startupSettings.startHidden && app.getLoginItemSettings().wasOpenedAtLogin)

    mainWindow = createMainWindow({ showOnReady: !isHiddenLaunch })

    // Auto-start tunnels configured with autoStart: true
    for (const t of registry.list()) {
      if (t.autoStart) {
        if (t.runMode === 'app') {
          void supervisor.start(t).catch((err) => {
            console.error(`Failed to auto-start tunnel ${t.name}:`, err)
          })
        } else if (t.runMode === 'service') {
          void serviceManager
            .listServices()
            .then((svcs) => {
              const svc = svcs.find(
                (s) => s.cfTunnelId === t.cfTunnelId || s.serviceName.includes(t.id)
              )
              if (svc && svc.state === 'stopped') {
                void serviceManager.startService(svc.serviceName).catch((err) => {
                  console.error(`Failed to auto-start service ${svc.serviceName}:`, err)
                })
              }
            })
            .catch(() => {})
        }
      }
    }

    mainWindow.on('close', (e) => {
      if (!isQuitting) {
        e.preventDefault()
        mainWindow?.hide()
      }
    })

    mainWindow.on('closed', () => {
      mainWindow = null
    })

    const revealWindow = (): void => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
    }

    trayController = new TrayController({
      iconPaths: { x1: resourcePath('tray-16.png'), x2: resourcePath('tray-32.png') },
      onOpen: revealWindow,
      onNavigate: (page) => {
        revealWindow()
        mainWindow?.webContents.send(EVENT_CHANNEL, { name: 'app:navigate', payload: page })
      },
      onQuit: () => {
        isQuitting = true
        app.quit()
      },
      onToggleTunnel: async (id: string, start: boolean) => {
        try {
          if (start) {
            const t = registry.get(id)
            await supervisor.start(t)
          } else {
            await supervisor.stop(id)
          }
        } catch {
          // Ignore toggle error
        }
      },
      onInstallUpdate: () => {
        try {
          updateManager.install()
        } catch {
          // not ready: ignore
        }
      }
    })

    trayController.init()
    trayController.updateMenu(registry.list(), supervisor.getAllStatuses())
    // an update may have become ready before the tray existed
    trayController.setUpdateReady(readyUpdateVersion())

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow()
      }
    })
  })

  app.on('before-quit', () => {
    isQuitting = true
    updateManager.stop()
    void supervisor.stopAll()
    trayController?.destroy()
  })

  app.on('window-all-closed', () => {
    if (isQuitting && process.platform !== 'darwin') {
      app.quit()
    }
  })
}
