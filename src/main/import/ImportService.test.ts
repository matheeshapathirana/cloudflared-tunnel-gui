import { describe, it, expect, vi } from 'vitest'
import { ImportService } from './ImportService'
import type { Tunnel } from '@shared/schemas'

interface SetupResult {
  importService: ImportService
  mockRegistry: {
    list: ReturnType<typeof vi.fn>
    add: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  mockServiceManager: {
    listServices: ReturnType<typeof vi.fn>
  }
  mockLocalConfigStore: {
    scanConfigs: ReturnType<typeof vi.fn>
  }
  mockCloudflareApi: {
    listTunnels: ReturnType<typeof vi.fn>
  }
  mockSecretStore: {
    getToken: ReturnType<typeof vi.fn>
  }
}

describe('ImportService', () => {
  function setup(overrides?: {
    initialTunnels?: Tunnel[]
    services?: Array<{
      serviceName: string
      displayName: string
      state: 'running' | 'stopped' | 'starting' | 'unknown'
      kind: 'remote' | 'local' | 'unlinked'
      cfTunnelId?: string
    }>
    localConfigs?: Tunnel[]
    apiTunnels?: Array<{ id: string; name: string; status: string; configSrc: string }>
    token?: string | null
    accountId?: string
  }): SetupResult {
    const tunnels: Tunnel[] = overrides?.initialTunnels ? [...overrides.initialTunnels] : []

    const mockRegistry = {
      list: vi.fn(() => [...tunnels]),
      add: vi.fn(async (input: Omit<Tunnel, 'id'>) => {
        const created: Tunnel = { id: `uuid-${tunnels.length + 1}`, ...input }
        tunnels.push(created)
        return created
      }),
      update: vi.fn(async (id: string, patch: Partial<Omit<Tunnel, 'id'>>) => {
        const idx = tunnels.findIndex((t) => t.id === id)
        if (idx === -1) throw new Error('Not found')
        tunnels[idx] = { ...tunnels[idx], ...patch }
        return tunnels[idx]
      })
    }

    const mockStore = {
      get: vi.fn(() => ({
        account: overrides?.accountId
          ? { accountId: overrides.accountId, accountName: 'Test Acc' }
          : undefined
      }))
    }

    const mockServiceManager = {
      listServices: vi.fn(async () => overrides?.services ?? [])
    }

    const mockLocalConfigStore = {
      scanConfigs: vi.fn(async () => overrides?.localConfigs ?? [])
    }

    const mockCloudflareApi = {
      listTunnels: vi.fn(async () => overrides?.apiTunnels ?? [])
    }

    const mockSecretStore = {
      getToken: vi.fn(async () => (overrides?.token !== undefined ? overrides.token : 'test-token'))
    }

    const importService = new ImportService({
      registry: mockRegistry as unknown as import('../tunnels/TunnelRegistry').TunnelRegistry,
      store: mockStore as unknown as import('../settings/SettingsStore').SettingsStore,
      serviceManager:
        mockServiceManager as unknown as import('../services/ServiceManager').ServiceManager,
      localConfigStore:
        mockLocalConfigStore as unknown as import('../config/LocalConfigStore').LocalConfigStore,
      cloudflareApi: mockCloudflareApi as unknown as import('../api/CloudflareApi').CloudflareApi,
      secretStore: mockSecretStore as unknown as import('../security/SecretStore').SecretStore
    })

    return {
      importService,
      mockRegistry,
      mockServiceManager,
      mockLocalConfigStore,
      mockCloudflareApi,
      mockSecretStore
    }
  }

  it('discovers and adds new Windows service tunnel', async () => {
    const { importService, mockRegistry } = setup({
      services: [
        {
          serviceName: 'cftunnel-web',
          displayName: 'Cloudflare Tunnel (Web App)',
          state: 'running',
          kind: 'remote',
          cfTunnelId: 'cf-web-123'
        }
      ]
    })

    const result = await importService.run()
    expect(mockRegistry.add).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Web App',
        kind: 'remote',
        cfTunnelId: 'cf-web-123',
        runMode: 'service',
        serviceName: 'cftunnel-web'
      })
    )
    expect(result).toHaveLength(1)
  })

  it('links Windows service to existing tunnel preserving user preferences', async () => {
    const existing: Tunnel = {
      id: 'existing-id-1',
      name: 'Custom User Name',
      kind: 'remote',
      cfTunnelId: 'cf-remote-100',
      runMode: 'app',
      autoStart: true
    }

    const { importService, mockRegistry } = setup({
      initialTunnels: [existing],
      services: [
        {
          serviceName: 'cftunnel-prod',
          displayName: 'Cloudflare Tunnel (Default Name)',
          state: 'running',
          kind: 'remote',
          cfTunnelId: 'cf-remote-100'
        }
      ]
    })

    const result = await importService.run()
    expect(mockRegistry.update).toHaveBeenCalledWith('existing-id-1', {
      runMode: 'service',
      serviceName: 'cftunnel-prod',
      local: undefined
    })
    expect(result[0].name).toBe('Custom User Name')
    expect(result[0].autoStart).toBe(true)
    expect(result[0].runMode).toBe('service')
  })

  it('discovers local config files and registers them', async () => {
    const { importService, mockRegistry } = setup({
      localConfigs: [
        {
          id: 'cfg-id-1',
          name: 'My Local App',
          kind: 'local',
          cfTunnelId: 'cf-local-200',
          runMode: 'app',
          autoStart: false,
          local: { configPath: 'C:\\Users\\user\\.cloudflared\\my-app.yml' }
        }
      ]
    })

    const result = await importService.run()
    expect(mockRegistry.add).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'My Local App',
        kind: 'local',
        cfTunnelId: 'cf-local-200',
        runMode: 'app',
        local: { configPath: 'C:\\Users\\user\\.cloudflared\\my-app.yml' }
      })
    )
    expect(result).toHaveLength(1)
  })

  it('discovers API tunnels when token and account are configured', async () => {
    const { importService, mockRegistry } = setup({
      token: 'valid-token',
      accountId: 'acc-1',
      apiTunnels: [
        {
          id: 'cf-api-tunnel-1',
          name: 'Cloudflare Hosted Tunnel',
          status: 'healthy',
          configSrc: 'cloudflare'
        }
      ]
    })

    const result = await importService.run()
    expect(mockRegistry.add).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Cloudflare Hosted Tunnel',
        kind: 'remote',
        cfTunnelId: 'cf-api-tunnel-1',
        runMode: 'app'
      })
    )
    expect(result).toHaveLength(1)
  })

  it('handles offline / missing token gracefully without crashing', async () => {
    const { importService } = setup({
      token: null,
      services: []
    })

    const result = await importService.run()
    expect(result).toEqual([])
  })
})
