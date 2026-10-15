import type { TunnelRegistry } from '../tunnels/TunnelRegistry'
import type { SettingsStore } from '../settings/SettingsStore'
import type { ServiceManager } from '../services/ServiceManager'
import type { LocalConfigStore } from '../config/LocalConfigStore'
import type { CloudflareApi } from '../api/CloudflareApi'
import type { SecretStore } from '../security/SecretStore'
import type { Tunnel } from '@shared/schemas'

export interface ImportServiceDeps {
  registry: TunnelRegistry
  store: SettingsStore
  serviceManager: ServiceManager
  localConfigStore: LocalConfigStore
  cloudflareApi: CloudflareApi
  secretStore: SecretStore
}

export class ImportService {
  constructor(private deps: ImportServiceDeps) {}

  /**
   * Run multi-source tunnel discovery and merge.
   * Merges Windows services, ~/.cloudflared YAML configs, and Cloudflare API tunnels by cfTunnelId.
   */
  async run(): Promise<Tunnel[]> {
    const existingList = this.deps.registry.list()
    const existingByCfId = new Map<string, Tunnel>()
    for (const t of existingList) {
      if (t.cfTunnelId) {
        existingByCfId.set(t.cfTunnelId, t)
      }
    }

    // Candidate accumulator map keyed by cfTunnelId
    const candidates = new Map<
      string,
      {
        name: string
        kind: 'remote' | 'local'
        cfTunnelId: string
        runMode: 'app' | 'service'
        serviceName?: string
        localConfigPath?: string
      }
    >()

    // 1. Discover Windows services
    try {
      const services = await this.deps.serviceManager.listServices()
      for (const svc of services) {
        if (svc.cfTunnelId && (svc.kind === 'remote' || svc.kind === 'local')) {
          candidates.set(svc.cfTunnelId, {
            name: svc.displayName.replace(/^Cloudflare Tunnel \((.*)\)$/, '$1'),
            kind: svc.kind,
            cfTunnelId: svc.cfTunnelId,
            runMode: 'service',
            serviceName: svc.serviceName
          })
        }
      }
    } catch {
      // Ignore service discovery errors in non-Windows or restricted environments
    }

    // 2. Discover local YAML config files
    try {
      const configs = await this.deps.localConfigStore.scanConfigs()
      for (const cfg of configs) {
        if (!cfg.cfTunnelId) continue
        const existingCandidate = candidates.get(cfg.cfTunnelId)
        if (existingCandidate) {
          existingCandidate.localConfigPath = cfg.local?.configPath
        } else {
          candidates.set(cfg.cfTunnelId, {
            name: cfg.name,
            kind: 'local',
            cfTunnelId: cfg.cfTunnelId,
            runMode: 'app',
            localConfigPath: cfg.local?.configPath
          })
        }
      }
    } catch {
      // Ignore local config scan errors
    }

    // 3. Discover Cloudflare API tunnels (if token and account configured)
    try {
      const token = await this.deps.secretStore.getToken()
      const accountId = this.deps.store.get().account?.accountId
      if (token && accountId) {
        const apiTunnels = await this.deps.cloudflareApi.listTunnels(token, accountId)
        for (const apiT of apiTunnels) {
          const existingCandidate = candidates.get(apiT.id)
          if (!existingCandidate) {
            candidates.set(apiT.id, {
              name: apiT.name,
              kind: apiT.configSrc === 'local' ? 'local' : 'remote',
              cfTunnelId: apiT.id,
              runMode: 'app'
            })
          }
        }
      }
    } catch {
      // Ignore API errors during import so offline operation works seamlessly
    }

    // 4. Merge candidates into TunnelRegistry
    for (const [cfId, cand] of candidates.entries()) {
      const existing = existingByCfId.get(cfId)
      if (existing) {
        // Update existing record preserving user overrides (name, autoStart)
        await this.deps.registry.update(existing.id, {
          runMode: cand.runMode,
          serviceName: cand.serviceName ?? existing.serviceName,
          local: cand.localConfigPath ? { configPath: cand.localConfigPath } : existing.local
        })
      } else {
        // Add new discovered tunnel
        await this.deps.registry.add({
          name: cand.name,
          kind: cand.kind,
          cfTunnelId: cand.cfTunnelId,
          runMode: cand.runMode,
          serviceName: cand.serviceName,
          autoStart: false,
          local: cand.localConfigPath ? { configPath: cand.localConfigPath } : undefined
        })
      }
    }

    return this.deps.registry.list()
  }
}
