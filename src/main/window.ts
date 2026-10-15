import { BrowserWindow, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { resourcePath } from './assets'
import { isAllowedExternalUrl } from './externalLinks'

export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url
  if (!url) return false
  try {
    const parsed = new URL(url)
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      const devOrigin = new URL(process.env['ELECTRON_RENDERER_URL']).origin
      return parsed.origin === devOrigin
    }
    return parsed.protocol === 'file:'
  } catch {
    return false
  }
}

export function createMainWindow(options?: { showOnReady?: boolean }): BrowserWindow {
  const showOnReady = options?.showOnReady ?? true
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    show: false,
    // match the theme background so a dark window doesn't flash white before first paint
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#09090b' : '#ffffff',
    autoHideMenuBar: true,
    icon: resourcePath('icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (showOnReady) {
      mainWindow.show()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url)
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        const appOrigin = new URL(process.env['ELECTRON_RENDERER_URL']).origin
        if (parsed.origin === appOrigin) {
          return
        }
      } else {
        if (parsed.protocol === 'file:') {
          return
        }
      }
    } catch {
      // Invalid URL
    }
    event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}
