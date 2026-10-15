import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import type { Tunnel } from '@shared/schemas'
import { AppErrorException } from '@shared/result'
import type { SettingsStore } from '../settings/SettingsStore'

export class TunnelRegistry extends EventEmitter {
  constructor(private store: SettingsStore) {
    super()
  }

  override emit(event: 'changed', tunnels: Tunnel[]): boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args)
  }

  override on(event: 'changed', listener: (tunnels: Tunnel[]) => void): this
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener)
  }

  list(): Tunnel[] {
    return this.store.get().tunnels
  }

  get(id: string): Tunnel {
    const tunnel = this.store.get().tunnels.find((t) => t.id === id)
    if (!tunnel) {
      throw new AppErrorException('NOT_FOUND', `Tunnel not found: ${id}`)
    }
    return tunnel
  }

  async add(input: Omit<Tunnel, 'id'>): Promise<Tunnel> {
    const id = crypto.randomUUID()
    const newTunnel = {
      ...input,
      id
    } as Tunnel

    await this.store.update((draft) => {
      draft.tunnels.push(newTunnel)
    })

    this.emit('changed', this.list())
    return newTunnel
  }

  async update(id: string, patch: Partial<Omit<Tunnel, 'id'>>): Promise<Tunnel> {
    let updated: Tunnel | undefined

    await this.store.update((draft) => {
      const idx = draft.tunnels.findIndex((t) => t.id === id)
      if (idx === -1) {
        throw new AppErrorException('NOT_FOUND', `Tunnel not found: ${id}`)
      }
      const existing = draft.tunnels[idx]
      const merged = { ...existing, ...patch, id } as Tunnel
      draft.tunnels[idx] = merged
      updated = merged
    })

    this.emit('changed', this.list())
    return updated!
  }

  async remove(id: string): Promise<void> {
    await this.store.update((draft) => {
      const idx = draft.tunnels.findIndex((t) => t.id === id)
      if (idx === -1) {
        throw new AppErrorException('NOT_FOUND', `Tunnel not found: ${id}`)
      }
      draft.tunnels.splice(idx, 1)
    })

    this.emit('changed', this.list())
  }
}
