import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const INVOKE_CHANNEL = 'ipc:invoke'
const EVENT_CHANNEL = 'ipc:event'

contextBridge.exposeInMainWorld('api', {
  invoke: (name: string, input?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(INVOKE_CHANNEL, { name, input }),
  on: (name: string, cb: (payload: unknown) => void): (() => void) => {
    const l = (_e: IpcRendererEvent, msg: { name?: string; payload?: unknown }): void => {
      if (msg?.name === name) {
        cb(msg.payload)
      }
    }
    ipcRenderer.on(EVENT_CHANNEL, l)
    return (): void => {
      ipcRenderer.removeListener(EVENT_CHANNEL, l)
    }
  }
})
