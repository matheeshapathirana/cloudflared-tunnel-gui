import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { IpcRouter } from './IpcRouter'
import { registerCommands, normalizeTarget } from './registerCommands'
import type { Tunnel, BinaryStatus, AppState, BackupInfo } from '@shared/schemas'
import { defaultAppState } from '@shared/schemas'
import type { TunnelRegistry } from '../tunnels/TunnelRegistry'
import type { BinaryManager } from '../binary/BinaryManager'
import type { SettingsStore } from '../settings/SettingsStore'
import type { ProcessSupervisor } from '../process/ProcessSupervisor'
import type { LocalConfigStore } from '../config/LocalConfigStore'
import type { ISecretStore } from '../security/SecretStore'
import type { ICloudflareApi } from '../api/CloudflareApi'

describe('registerCommands', () => {
  const sampleTunnel: Tunnel = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'tunnel-1',
    kind: 'quick',
    runMode: 'app',
    autoStart: false,
    quick: { target: 'http://localhost:8080' }
  }

  const sampleLocalTunnel: Tunnel = {
    id: '123e4567-e89b-12d3-a456-426614174002',
    name: 'local-tunnel',
    kind: 'local',
    cfTunnelId: 'cf-tunnel-local-1',
    runMode: 'app',
    autoStart: false,
    local: { configPath: '/path/to/config.yml' }
  }

  const sampleRemoteTunnel: Tunnel = {
    id: '123e4567-e89b-12d3-a456-426614174003',
    name: 'remote-tunnel',
    kind: 'remote',
    cfTunnelId: 'cf-remote-1',
    runMode: 'app',
    autoStart: false
  }

  const sampleBinaryStatus: BinaryStatus = {
    found: true,
    path: 'C:\\bin\\cloudflared.exe',
    source: 'override',
    version: '2026.10.0',
    overrideInvalid: false
  }

  const sampleState: AppState = {
    ...defaultAppState(),
    account: { accountId: 'acc-1', accountName: 'My Account' },
    tunnels: [sampleTunnel, sampleRemoteTunnel],
    recentQuickTargets: ['http://localhost:3000']
  }

  interface SetupResult {
    router: IpcRouter
    mockRegistry: Partial<TunnelRegistry>
    mockBinaryManager: Partial<BinaryManager>
    mockStore: Partial<SettingsStore>
    mockSupervisor: Partial<ProcessSupervisor>
    mockLocalConfigStore: Partial<LocalConfigStore>
    mockSecretStore: Partial<ISecretStore>
    mockCloudflareApi: Partial<ICloudflareApi>
    mockServiceManager: Record<string, ReturnType<typeof vi.fn>>
    mockImportService: Record<string, ReturnType<typeof vi.fn>>
    setLoginSettings: ReturnType<typeof vi.fn>
    onDownloadProgress: ReturnType<typeof vi.fn>
    quitApp: ReturnType<typeof vi.fn>
  }

  function setup(customMocks?: {
    secretStore?: Partial<ISecretStore>
    cloudflareApi?: Partial<ICloudflareApi>
    initialState?: Partial<AppState>
  }): SetupResult {
    const router = new IpcRouter()
    let currentState: AppState = {
      ...JSON.parse(JSON.stringify(sampleState)),
      ...customMocks?.initialState
    }

    const mockRegistry: Partial<TunnelRegistry> = {
      list: vi.fn(() => [sampleTunnel]),
      get: vi.fn((id: string) => {
        const found = [sampleTunnel, sampleLocalTunnel, sampleRemoteTunnel].find((t) => t.id === id)
        if (!found) throw new Error(`Tunnel not found: ${id}`)
        return found
      }),
      add: vi.fn(async (input: Omit<Tunnel, 'id'>) => {
        return { ...input, id: 'new-id' } as Tunnel
      }),
      update: vi.fn(async (id: string, patch: Partial<Tunnel>) => {
        return { ...sampleTunnel, ...patch, id } as Tunnel
      }),
      remove: vi.fn(async () => {})
    }

    const mockBinaryManager: Partial<BinaryManager> = {
      status: vi.fn(async () => sampleBinaryStatus),
      checkUpdate: vi.fn(async () => ({
        version: '2026.10.1',
        releaseUrl: 'https://github.com/releases/2026.10.1',
        publishedAt: '2026-10-14T00:00:00Z',
        downloadUrl: 'https://github.com/download/cloudflared-windows-amd64.exe',
        sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        hasChecksum: true,
        isUpdateAvailable: true
      })),
      download: vi.fn(async () => 'C:\\AppData\\cloudflared.exe')
    }

    const mockStore: Partial<SettingsStore> = {
      get: vi.fn(() => JSON.parse(JSON.stringify(currentState))),
      update: vi.fn(async (mutator) => {
        const draft = JSON.parse(JSON.stringify(currentState))
        const res = await mutator(draft)
        currentState = res ?? draft
        return currentState
      })
    }

    const mockSupervisor: Partial<ProcessSupervisor> = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      getStatus: vi.fn(() => ({ state: 'connected' as const, connections: 1 })),
      getLogs: vi.fn(() => ['line 1', 'line 2'])
    }

    const sampleBackup: BackupInfo = {
      fileName: 'config.bak-1.yml',
      timestamp: 123456789,
      path: '/path/backups/config.bak-1.yml',
      size: 512
    }

    const mockLocalConfigStore: Partial<LocalConfigStore> = {
      getConfigDir: vi.fn(() => '/path/to'),
      scanConfigs: vi.fn(async () => [sampleLocalTunnel]),
      readConfig: vi.fn(async () => ({
        rawYaml: 'tunnel: 123',
        ingress: [{ service: 'http_status:404' }]
      })),
      saveConfig: vi.fn(async () => {}),
      validateYaml: vi.fn(async () => ({ valid: true })),
      listBackups: vi.fn(async () => [sampleBackup]),
      restoreBackup: vi.fn(async () => {}),
      checkCert: vi.fn(async () => ({ hasCert: true, certPath: '/path/cert.pem' })),
      login: vi.fn(async () => {}),
      createTunnel: vi.fn(async (name) => ({
        id: 'new-id',
        name,
        kind: 'local' as const,
        cfTunnelId: 'cf-new-1',
        runMode: 'app' as const,
        autoStart: false,
        local: { configPath: `/path/${name}.yml` }
      }))
    }

    const mockSecretStore: Partial<ISecretStore> = {
      hasToken: vi.fn(async () => true),
      getToken: vi.fn(async () => 'mock-token'),
      setToken: vi.fn(async () => {}),
      clearToken: vi.fn(async () => {}),
      ...customMocks?.secretStore
    }

    const mockCloudflareApi: Partial<ICloudflareApi> = {
      verifyToken: vi.fn(async () => ({ valid: true, id: 'token-id' })),
      listAccounts: vi.fn(async () => [{ id: 'acc-1', name: 'My Account', type: 'standard' }]),
      listZones: vi.fn(async () => [{ id: 'zone-1', name: 'example.com', status: 'active' }]),
      createTunnel: vi.fn(async (_tok, _acc, name) => ({
        id: 'cf-created-1',
        name,
        credentialsFile: ''
      })),
      getTunnelToken: vi.fn(async () => 'mock-run-token'),
      deleteTunnel: vi.fn(async () => {}),
      getConfiguration: vi.fn(async () => ({
        ingress: [
          { hostname: 'app.example.com', service: 'http://localhost:3000' },
          { service: 'http_status:404' }
        ]
      })),
      putConfiguration: vi.fn(async () => {}),
      listDnsRecords: vi.fn(async () => [
        {
          id: 'rec-1',
          name: 'app.example.com',
          type: 'CNAME',
          content: 'cf-remote-1.cfargotunnel.com',
          proxied: true
        }
      ]),
      createDnsCname: vi.fn(async () => ({ id: 'rec-new' })),
      deleteDnsRecord: vi.fn(async () => {}),
      ...customMocks?.cloudflareApi
    }

    const mockServiceManager = {
      listServices: vi.fn(async () => [
        {
          serviceName: 'cftunnel-prod',
          displayName: 'Cloudflare Tunnel (Prod)',
          state: 'running' as const,
          kind: 'remote' as const,
          cfTunnelId: 'cf-remote-1'
        }
      ]),
      startService: vi.fn(async () => {}),
      stopService: vi.fn(async () => {}),
      restartService: vi.fn(async () => {}),
      installRemote: vi.fn(async () => 'cftunnel-installed-remote'),
      installLocal: vi.fn(async () => 'cftunnel-installed-local'),
      uninstall: vi.fn(async () => {}),
      adopt: vi.fn(async () => {})
    }

    const mockImportService = {
      run: vi.fn(async () => [sampleTunnel, sampleRemoteTunnel])
    }

    const quitApp = vi.fn()
    const setLoginSettings = vi.fn()
    const onDownloadProgress = vi.fn()

    registerCommands(router, {
      registry: mockRegistry as TunnelRegistry,
      binaryManager: mockBinaryManager as BinaryManager,
      store: mockStore as SettingsStore,
      supervisor: mockSupervisor as ProcessSupervisor,
      localConfigStore: mockLocalConfigStore as LocalConfigStore,
      secretStore: mockSecretStore as unknown as import('../security/SecretStore').SecretStore,
      cloudflareApi: mockCloudflareApi as unknown as import('../api/CloudflareApi').CloudflareApi,
      serviceManager:
        mockServiceManager as unknown as import('../services/ServiceManager').ServiceManager,
      importService:
        mockImportService as unknown as import('../import/ImportService').ImportService,
      appVersion: '1.2.3',
      quitApp,
      setLoginSettings,
      onDownloadProgress
    })

    return {
      router,
      mockRegistry,
      mockBinaryManager,
      mockStore,
      mockSupervisor,
      mockLocalConfigStore,
      mockSecretStore,
      mockCloudflareApi,
      mockServiceManager,
      mockImportService,
      setLoginSettings,
      onDownloadProgress,
      quitApp
    }
  }

  describe('normalizeTarget', () => {
    it('prepends http://localhost: to port numbers', () => {
      expect(normalizeTarget('3000')).toBe('http://localhost:3000')
      expect(normalizeTarget('  8080 ')).toBe('http://localhost:8080')
    })

    it('prepends http:// if protocol is omitted', () => {
      expect(normalizeTarget('localhost:5173')).toBe('http://localhost:5173')
      expect(normalizeTarget('127.0.0.1:4000')).toBe('http://127.0.0.1:4000')
    })

    it('keeps existing http/https protocols', () => {
      expect(normalizeTarget('http://localhost:3000')).toBe('http://localhost:3000')
      expect(normalizeTarget('https://example.com')).toBe('https://example.com')
    })
  })

  it('registers and handles tunnels.list', async () => {
    const { router, mockRegistry } = setup()
    const res = await router.dispatch('tunnels.list', undefined)
    expect(res).toEqual({ ok: true, data: [sampleTunnel] })
    expect(mockRegistry.list).toHaveBeenCalledOnce()
  })

  it('registers and handles tunnels.start and tunnels.stop', async () => {
    const { router, mockSupervisor } = setup()
    const startRes = await router.dispatch('tunnels.start', { id: sampleTunnel.id })
    expect(startRes).toEqual({ ok: true, data: undefined })
    expect(mockSupervisor.start).toHaveBeenCalledOnce()

    const stopRes = await router.dispatch('tunnels.stop', { id: sampleTunnel.id })
    expect(stopRes).toEqual({ ok: true, data: undefined })
    expect(mockSupervisor.stop).toHaveBeenCalledWith(sampleTunnel.id)
  })

  it('registers and handles tunnels.logs', async () => {
    const { router, mockSupervisor } = setup()
    const res = await router.dispatch('tunnels.logs', { id: sampleTunnel.id, limit: 10 })
    expect(res).toEqual({ ok: true, data: ['line 1', 'line 2'] })
    expect(mockSupervisor.getLogs).toHaveBeenCalledWith(sampleTunnel.id, 10)
  })

  it('registers and handles quick.start and quick.stop', async () => {
    const { router, mockRegistry, mockSupervisor, mockStore } = setup()
    const startRes = await router.dispatch('quick.start', { target: '5173' })
    expect(startRes.ok).toBe(true)
    expect(mockStore.update).toHaveBeenCalled()
    expect(mockRegistry.add).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'quick',
        quick: { target: 'http://localhost:5173' }
      })
    )
    expect(mockSupervisor.start).toHaveBeenCalled()

    const stopRes = await router.dispatch('quick.stop', { id: sampleTunnel.id })
    expect(stopRes).toEqual({ ok: true, data: undefined })
    expect(mockSupervisor.stop).toHaveBeenCalledWith(sampleTunnel.id)
    expect(mockRegistry.remove).toHaveBeenCalledWith(sampleTunnel.id)
  })

  it('registers and handles quick.recentTargets', async () => {
    const { router } = setup()
    const res = await router.dispatch('quick.recentTargets', undefined)
    expect(res).toEqual({ ok: true, data: ['http://localhost:3000'] })
  })

  it('registers and handles local.import', async () => {
    const { router, mockLocalConfigStore, mockRegistry } = setup()
    const res = await router.dispatch('local.import', undefined)
    expect(res.ok).toBe(true)
    expect(mockLocalConfigStore.scanConfigs).toHaveBeenCalledOnce()
    expect(mockRegistry.add).toHaveBeenCalled()
  })

  it('registers and handles local.readConfig, saveConfig, and validate', async () => {
    const { router, mockLocalConfigStore } = setup()
    const readRes = await router.dispatch('local.readConfig', {
      configPath: '/path/to/config.yml'
    })
    expect(readRes.ok).toBe(true)
    expect(mockLocalConfigStore.readConfig).toHaveBeenCalledWith(
      path.resolve('/path/to/config.yml')
    )

    const saveRes = await router.dispatch('local.saveConfig', {
      configPath: '/path/to/config.yml',
      rawYaml: 'tunnel: 123\n'
    })
    expect(saveRes.ok).toBe(true)
    expect(mockLocalConfigStore.saveConfig).toHaveBeenCalledWith(
      path.resolve('/path/to/config.yml'),
      'tunnel: 123\n'
    )

    const valRes = await router.dispatch('local.validate', {
      rawYaml: 'tunnel: 123\n'
    })
    expect(valRes.ok).toBe(true)
    expect(mockLocalConfigStore.validateYaml).toHaveBeenCalledWith('tunnel: 123\n')
  })

  it('registers and handles local.listBackups and restoreBackup', async () => {
    const { router, mockLocalConfigStore } = setup()
    const listRes = await router.dispatch('local.listBackups', {
      configPath: '/path/to/config.yml'
    })
    expect(listRes.ok).toBe(true)
    expect(mockLocalConfigStore.listBackups).toHaveBeenCalledWith(
      path.resolve('/path/to/config.yml')
    )

    const restoreRes = await router.dispatch('local.restoreBackup', {
      configPath: '/path/to/config.yml',
      backupPath: '/path/backups/config.bak-1.yml'
    })
    expect(restoreRes.ok).toBe(true)
    expect(mockLocalConfigStore.restoreBackup).toHaveBeenCalledWith(
      path.resolve('/path/to/config.yml'),
      '/path/backups/config.bak-1.yml'
    )
  })

  it('refuses local.* commands for files that are not this app’s tunnel configs', async () => {
    const { router, mockLocalConfigStore } = setup()
    for (const configPath of [
      '/etc/hosts',
      '/path/to/secret.txt',
      '/elsewhere/config.yml',
      '/path/to/../elsewhere/config.yml'
    ]) {
      const read = await router.dispatch('local.readConfig', { configPath })
      expect(read).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
      const save = await router.dispatch('local.saveConfig', { configPath, rawYaml: 'a: b\n' })
      expect(save).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
      const restore = await router.dispatch('local.restoreBackup', {
        configPath,
        backupPath: '/path/to/backups/x.bak-1.yml'
      })
      expect(restore).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    }
    expect(mockLocalConfigStore.readConfig).not.toHaveBeenCalled()
    expect(mockLocalConfigStore.saveConfig).not.toHaveBeenCalled()
    expect(mockLocalConfigStore.restoreBackup).not.toHaveBeenCalled()
  })

  it('allows local.* for a registered tunnel config outside the default config directory', async () => {
    const { router, mockRegistry, mockLocalConfigStore } = setup()
    const elsewhere = path.resolve('/elsewhere/tunnel.yaml')
    ;(mockRegistry.list as ReturnType<typeof vi.fn>).mockReturnValue([
      { ...sampleLocalTunnel, local: { configPath: elsewhere } }
    ])
    const res = await router.dispatch('local.readConfig', { configPath: elsewhere })
    expect(res.ok).toBe(true)
    expect(mockLocalConfigStore.readConfig).toHaveBeenCalledWith(elsewhere)
  })

  it('does not start a tunnel in the app when a Windows service owns it', async () => {
    const { router, mockRegistry, mockSupervisor } = setup()

    // registry says the tunnel runs as a service
    ;(mockRegistry.get as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      ...sampleLocalTunnel,
      runMode: 'service',
      serviceName: 'cftunnel-prod'
    })
    const byMode = await router.dispatch('tunnels.start', { id: sampleLocalTunnel.id })
    expect(byMode).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: expect.stringContaining('cftunnel-prod') }
    })

    // registry says app mode, but a service for the same Cloudflare tunnel is running
    const byLiveService = await router.dispatch('tunnels.start', { id: sampleRemoteTunnel.id })
    expect(byLiveService).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: expect.stringContaining('cftunnel-prod') }
    })
    expect(mockSupervisor.start).not.toHaveBeenCalled()
  })

  it('registers and handles local.checkCert, login, and create', async () => {
    const { router, mockLocalConfigStore, mockRegistry } = setup()
    const certRes = await router.dispatch('local.checkCert', undefined)
    expect(certRes.ok).toBe(true)
    expect(mockLocalConfigStore.checkCert).toHaveBeenCalledOnce()

    const loginRes = await router.dispatch('local.login', undefined)
    expect(loginRes.ok).toBe(true)
    expect(mockLocalConfigStore.login).toHaveBeenCalledOnce()

    const createRes = await router.dispatch('local.create', { name: 'my-new-tunnel' })
    expect(createRes.ok).toBe(true)
    expect(mockLocalConfigStore.createTunnel).toHaveBeenCalledWith('my-new-tunnel')
    expect(mockRegistry.add).toHaveBeenCalled()
  })

  it('registers and handles app.quit', async () => {
    const { router, quitApp } = setup()
    const res = await router.dispatch('app.quit', undefined)
    expect(res).toEqual({ ok: true, data: undefined })
    expect(quitApp).toHaveBeenCalledOnce()
  })

  it('registers and handles tunnels.rename', async () => {
    const { router, mockRegistry } = setup()
    const res = await router.dispatch('tunnels.rename', {
      id: sampleTunnel.id,
      name: 'renamed-tunnel'
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect((res.data as Tunnel).name).toBe('renamed-tunnel')
    }
    expect(mockRegistry.update).toHaveBeenCalledWith(sampleTunnel.id, { name: 'renamed-tunnel' })
  })

  it('registers and handles tunnels.setAutoStart', async () => {
    const { router, mockRegistry } = setup()
    const res = await router.dispatch('tunnels.setAutoStart', {
      id: sampleTunnel.id,
      autoStart: true
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect((res.data as Tunnel).autoStart).toBe(true)
    }
    expect(mockRegistry.update).toHaveBeenCalledWith(sampleTunnel.id, { autoStart: true })
  })

  it('registers and handles tunnels.delete', async () => {
    const { router, mockRegistry } = setup()
    const res = await router.dispatch('tunnels.delete', {
      id: sampleTunnel.id
    })
    expect(res).toEqual({ ok: true, data: undefined })
    expect(mockRegistry.remove).toHaveBeenCalledWith(sampleTunnel.id)
  })

  it('registers and handles binary.status', async () => {
    const { router, mockBinaryManager } = setup()
    const res = await router.dispatch('binary.status', undefined)
    expect(res).toEqual({ ok: true, data: sampleBinaryStatus })
    expect(mockBinaryManager.status).toHaveBeenCalledOnce()
  })

  it('registers and handles binary.setOverride', async () => {
    const { router, mockStore, mockBinaryManager } = setup()
    const res = await router.dispatch('binary.setOverride', {
      path: 'C:\\custom\\cloudflared.exe'
    })
    expect(res).toEqual({ ok: true, data: sampleBinaryStatus })
    expect(mockStore.update).toHaveBeenCalled()
    expect(mockBinaryManager.status).toHaveBeenCalledOnce()
  })

  it('registers and handles app.getSettings', async () => {
    const { router } = setup()
    const res = await router.dispatch('app.getSettings', undefined)
    expect(res).toEqual({
      ok: true,
      data: {
        startup: { launchAtLogin: false, startHidden: true },
        binary: { overridePath: undefined },
        appVersion: '1.2.3'
      }
    })
  })

  it('registers and handles app.setSettings', async () => {
    const { router } = setup()
    const res = await router.dispatch('app.setSettings', {
      startup: { launchAtLogin: true }
    })
    expect(res).toEqual({
      ok: true,
      data: {
        startup: { launchAtLogin: true, startHidden: true },
        binary: { overridePath: undefined },
        appVersion: '1.2.3'
      }
    })
  })

  describe('account commands', () => {
    it('account.status returns connected: false when no token', async () => {
      const { router } = setup({
        secretStore: {
          hasToken: vi.fn(async () => false)
        }
      })
      const res = await router.dispatch('account.status', undefined)
      expect(res).toEqual({ ok: true, data: { connected: false } })
    })

    it('account.status returns connected: true with account details', async () => {
      const { router } = setup({
        secretStore: {
          hasToken: vi.fn(async () => true)
        }
      })
      const res = await router.dispatch('account.status', undefined)
      expect(res).toEqual({
        ok: true,
        data: {
          connected: true,
          accountId: 'acc-1',
          accountName: 'My Account'
        }
      })
    })

    it('account.setToken succeeds with valid token', async () => {
      const { router, mockSecretStore, mockStore } = setup()
      const res = await router.dispatch('account.setToken', {
        token: 'valid-cf-token'
      })
      expect(res.ok).toBe(true)
      if (res.ok) {
        const data = res.data as {
          status: { connected: boolean; accountId?: string; accountName?: string }
          accounts: unknown[]
          zones: unknown[]
        }
        expect(data.status).toEqual({
          connected: true,
          accountId: 'acc-1',
          accountName: 'My Account'
        })
        expect(data.accounts).toHaveLength(1)
        expect(data.zones).toHaveLength(1)
      }
      expect(mockSecretStore.setToken).toHaveBeenCalledWith('valid-cf-token')
      expect(mockStore.update).toHaveBeenCalled()
    })

    it('account.setToken fails with UNAUTHORIZED on invalid token', async () => {
      const { router } = setup({
        cloudflareApi: {
          verifyToken: vi.fn(async () => ({ valid: false, error: 'Token is invalid' }))
        }
      })
      const res = await router.dispatch('account.setToken', { token: 'bad-token' })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.code).toBe('UNAUTHORIZED')
      }
    })

    it('account.setToken fails with VALIDATION if no accounts accessible', async () => {
      const { router } = setup({
        cloudflareApi: {
          verifyToken: vi.fn(async () => ({ valid: true })),
          listAccounts: vi.fn(async () => [])
        }
      })
      const res = await router.dispatch('account.setToken', { token: 'valid-token' })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.code).toBe('VALIDATION')
      }
    })

    it('account.clearToken clears token and resets store account', async () => {
      const { router, mockSecretStore, mockStore } = setup()
      const res = await router.dispatch('account.clearToken', undefined)
      expect(res).toEqual({ ok: true, data: undefined })
      expect(mockSecretStore.clearToken).toHaveBeenCalledOnce()
      expect(mockStore.update).toHaveBeenCalled()
    })

    it('account.listZones returns zones for selected account', async () => {
      const { router, mockCloudflareApi } = setup()
      const res = await router.dispatch('account.listZones', undefined)
      expect(res).toEqual({
        ok: true,
        data: [{ id: 'zone-1', name: 'example.com', status: 'active' }]
      })
      expect(mockCloudflareApi.listZones).toHaveBeenCalledWith('mock-token', 'acc-1')
    })

    it('account.tokenCreationUrl returns correct dashboard URL', async () => {
      const { router } = setup()
      const res = await router.dispatch('account.tokenCreationUrl', undefined)
      expect(res.ok).toBe(true)
      if (res.ok) {
        const data = res.data as { url: string }
        expect(data.url).toContain('dash.cloudflare.com/profile/api-tokens')
        expect(data.url).toContain('account_tunnel')
      }
    })
  })

  describe('remote commands', () => {
    it('remote.create creates tunnel via api and adds to registry', async () => {
      const { router, mockCloudflareApi, mockRegistry } = setup()
      const res = await router.dispatch('remote.create', { name: 'new-remote' })
      expect(res.ok).toBe(true)
      expect(mockCloudflareApi.createTunnel).toHaveBeenCalledWith(
        'mock-token',
        'acc-1',
        'new-remote'
      )
      expect(mockRegistry.add).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'new-remote',
          kind: 'remote',
          cfTunnelId: 'cf-created-1'
        })
      )
    })

    it('remote.listHostnames returns non-404 ingress rules', async () => {
      const { router, mockCloudflareApi } = setup()
      const res = await router.dispatch('remote.listHostnames', {
        tunnelId: sampleRemoteTunnel.id
      })
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.data).toEqual([
          {
            hostname: 'app.example.com',
            service: 'http://localhost:3000',
            path: undefined,
            noTlsVerify: undefined
          }
        ])
      }
      expect(mockCloudflareApi.getConfiguration).toHaveBeenCalledWith(
        'mock-token',
        'acc-1',
        sampleRemoteTunnel.cfTunnelId
      )
    })

    it('remote.addHostname appends rule and creates DNS CNAME', async () => {
      const { router, mockCloudflareApi } = setup()
      const res = await router.dispatch('remote.addHostname', {
        tunnelId: sampleRemoteTunnel.id,
        zoneId: 'zone-1',
        hostname: 'blog.example.com',
        service: 'http://localhost:4000',
        noTlsVerify: true
      })
      expect(res).toEqual({ ok: true, data: undefined })
      expect(mockCloudflareApi.putConfiguration).toHaveBeenCalledWith(
        'mock-token',
        'acc-1',
        sampleRemoteTunnel.cfTunnelId,
        expect.arrayContaining([
          expect.objectContaining({
            hostname: 'blog.example.com',
            service: 'http://localhost:4000',
            originRequest: { noTLSVerify: true }
          }),
          { service: 'http_status:404' }
        ])
      )
      expect(mockCloudflareApi.createDnsCname).toHaveBeenCalledWith(
        'mock-token',
        'zone-1',
        'blog.example.com',
        `${sampleRemoteTunnel.cfTunnelId}.cfargotunnel.com`
      )
    })

    it('remote.removeHostname removes rule and deletes DNS CNAME', async () => {
      const { router, mockCloudflareApi } = setup()
      const res = await router.dispatch('remote.removeHostname', {
        tunnelId: sampleRemoteTunnel.id,
        zoneId: 'zone-1',
        hostname: 'app.example.com'
      })
      expect(res).toEqual({ ok: true, data: undefined })
      expect(mockCloudflareApi.putConfiguration).toHaveBeenCalled()
      expect(mockCloudflareApi.deleteDnsRecord).toHaveBeenCalledWith(
        'mock-token',
        'zone-1',
        'rec-1'
      )
    })

    it('remote.delete stops running tunnel, deletes DNS records, deletes tunnel, and removes from registry', async () => {
      const { router, mockSupervisor, mockCloudflareApi, mockRegistry } = setup()
      const res = await router.dispatch('remote.delete', {
        tunnelId: sampleRemoteTunnel.id
      })
      expect(res).toEqual({ ok: true, data: undefined })
      expect(mockSupervisor.stop).toHaveBeenCalledWith(sampleRemoteTunnel.id)
      expect(mockCloudflareApi.deleteDnsRecord).toHaveBeenCalledWith(
        'mock-token',
        'zone-1',
        'rec-1'
      )
      expect(mockCloudflareApi.deleteTunnel).toHaveBeenCalledWith(
        'mock-token',
        'acc-1',
        sampleRemoteTunnel.cfTunnelId
      )
      expect(mockRegistry.remove).toHaveBeenCalledWith(sampleRemoteTunnel.id)
    })
  })

  describe('services and refresh commands', () => {
    it('services.list returns discovered services', async () => {
      const { router, mockServiceManager } = setup()
      const res = await router.dispatch('services.list', undefined)
      expect(res).toEqual({
        ok: true,
        data: [
          expect.objectContaining({
            serviceName: 'cftunnel-prod',
            state: 'running',
            kind: 'remote'
          })
        ]
      })
      expect(mockServiceManager.listServices).toHaveBeenCalled()
    })

    it('services.start and services.stop invoke serviceManager', async () => {
      const { router, mockServiceManager } = setup()
      const resStart = await router.dispatch('services.start', { serviceName: 'cftunnel-prod' })
      expect(resStart).toEqual({ ok: true, data: undefined })
      expect(mockServiceManager.startService).toHaveBeenCalledWith('cftunnel-prod')

      const resStop = await router.dispatch('services.stop', { serviceName: 'cftunnel-prod' })
      expect(resStop).toEqual({ ok: true, data: undefined })
      expect(mockServiceManager.stopService).toHaveBeenCalledWith('cftunnel-prod')
    })

    it('services.install for remote tunnel installs service and updates runMode', async () => {
      const { router, mockServiceManager, mockRegistry } = setup()
      const res = await router.dispatch('services.install', { tunnelId: sampleRemoteTunnel.id })
      expect(res.ok).toBe(true)
      expect(mockServiceManager.installRemote).toHaveBeenCalledWith({
        tunnelName: sampleRemoteTunnel.name,
        token: 'mock-run-token',
        cfTunnelId: sampleRemoteTunnel.cfTunnelId
      })
      expect(mockRegistry.update).toHaveBeenCalledWith(sampleRemoteTunnel.id, {
        runMode: 'service',
        serviceName: 'cftunnel-installed-remote'
      })
    })

    it('services.uninstall uninstalls service and updates runMode to app', async () => {
      const { router, mockRegistry } = setup()
      const res = await router.dispatch('services.uninstall', { tunnelId: sampleRemoteTunnel.id })
      expect(res.ok).toBe(true)
      expect(mockRegistry.update).toHaveBeenCalledWith(sampleRemoteTunnel.id, {
        runMode: 'app',
        serviceName: undefined
      })
    })

    it('tunnels.refresh executes importService and returns tunnels', async () => {
      const { router, mockImportService } = setup()
      const res = await router.dispatch('tunnels.refresh', undefined)
      expect(res.ok).toBe(true)
      expect(mockImportService.run).toHaveBeenCalled()
    })

    it('binary.checkUpdate calls binaryManager.checkUpdate and returns release info', async () => {
      const { router, mockBinaryManager } = setup()
      const res = await router.dispatch('binary.checkUpdate', undefined)
      expect(res.ok).toBe(true)
      expect(mockBinaryManager.status).toHaveBeenCalled()
      expect(mockBinaryManager.checkUpdate).toHaveBeenCalled()
    })

    it('binary.download calls binaryManager.download and returns new binary status', async () => {
      const { router, mockBinaryManager } = setup()
      const res = await router.dispatch('binary.download', { confirmWithoutChecksum: true })
      expect(res.ok).toBe(true)
      expect(mockBinaryManager.download).toHaveBeenCalledWith(
        expect.objectContaining({ confirmWithoutChecksum: true })
      )
      expect(mockBinaryManager.status).toHaveBeenCalled()
    })

    it('app.setSettings calls setLoginSettings when startup settings are updated', async () => {
      const { router, setLoginSettings } = setup()
      const res = await router.dispatch('app.setSettings', {
        startup: { launchAtLogin: true, startHidden: true }
      })
      expect(res.ok).toBe(true)
      expect(setLoginSettings).toHaveBeenCalledWith({
        openAtLogin: true,
        args: ['--hidden']
      })
    })
  })
})
