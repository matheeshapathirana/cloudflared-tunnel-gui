import { describe, it, expect } from 'vitest'
import {
  TunnelSchema,
  AppStateSchema,
  defaultAppState,
  BinaryStatusSchema,
  SettingsViewSchema,
  SettingsPatchSchema,
  AccountStatusSchema,
  AccountSchema,
  ZoneSchema,
  RemoteHostnameSchema,
  CloudflaredServiceSchema,
  BinaryReleaseSchema,
  DownloadProgressPayloadSchema
} from './schemas'

describe('schemas', () => {
  describe('defaultAppState', () => {
    it('returns a valid AppState', () => {
      const state = defaultAppState()
      expect(AppStateSchema.safeParse(state).success).toBe(true)
    })
  })

  describe('TunnelSchema', () => {
    const validUuid = '123e4567-e89b-12d3-a456-426614174000'

    it('accepts a valid quick tunnel', () => {
      const res = TunnelSchema.safeParse({
        id: validUuid,
        name: 'My Quick Tunnel',
        kind: 'quick',
        runMode: 'app',
        autoStart: false,
        quick: { target: 'http://localhost:3000' }
      })
      expect(res.success).toBe(true)
    })

    it('rejects a quick tunnel without quick.target', () => {
      const res = TunnelSchema.safeParse({
        id: validUuid,
        name: 'Quick Without Target',
        kind: 'quick',
        runMode: 'app',
        autoStart: false
      })
      expect(res.success).toBe(false)
      if (!res.success) {
        expect(res.error.issues.some((i) => i.path.join('.') === 'quick.target')).toBe(true)
      }
    })

    it('rejects a quick tunnel with runMode: service', () => {
      const res = TunnelSchema.safeParse({
        id: validUuid,
        name: 'Service Quick',
        kind: 'quick',
        runMode: 'service',
        serviceName: 'cftunnel-quick',
        autoStart: false,
        quick: { target: 'http://localhost:3000' }
      })
      expect(res.success).toBe(false)
      if (!res.success) {
        expect(res.error.issues.some((i) => i.path.includes('runMode'))).toBe(true)
      }
    })

    it('accepts a valid local tunnel', () => {
      const res = TunnelSchema.safeParse({
        id: validUuid,
        name: 'My Local Tunnel',
        kind: 'local',
        cfTunnelId: 'cf-tunnel-123',
        runMode: 'app',
        autoStart: true,
        local: { configPath: 'C:\\path\\to\\config.yml' }
      })
      expect(res.success).toBe(true)
    })

    it('rejects local tunnel missing configPath or cfTunnelId', () => {
      const missingConfig = TunnelSchema.safeParse({
        id: validUuid,
        name: 'Local Missing Config',
        kind: 'local',
        cfTunnelId: 'cf-tunnel-123',
        runMode: 'app',
        autoStart: false
      })
      expect(missingConfig.success).toBe(false)

      const missingId = TunnelSchema.safeParse({
        id: validUuid,
        name: 'Local Missing ID',
        kind: 'local',
        runMode: 'app',
        autoStart: false,
        local: { configPath: 'C:\\path\\config.yml' }
      })
      expect(missingId.success).toBe(false)
    })

    it('accepts a valid remote tunnel', () => {
      const res = TunnelSchema.safeParse({
        id: validUuid,
        name: 'My Remote Tunnel',
        kind: 'remote',
        cfTunnelId: 'cf-remote-123',
        runMode: 'app',
        autoStart: false
      })
      expect(res.success).toBe(true)
    })

    it('rejects remote tunnel missing cfTunnelId', () => {
      const res = TunnelSchema.safeParse({
        id: validUuid,
        name: 'Remote Missing ID',
        kind: 'remote',
        runMode: 'app',
        autoStart: false
      })
      expect(res.success).toBe(false)
    })

    it('accepts a valid service runMode with serviceName', () => {
      const res = TunnelSchema.safeParse({
        id: validUuid,
        name: 'Service Tunnel',
        kind: 'remote',
        cfTunnelId: 'cf-remote-123',
        runMode: 'service',
        serviceName: 'cftunnel-prod',
        autoStart: false
      })
      expect(res.success).toBe(true)
    })

    it('rejects service runMode missing serviceName', () => {
      const res = TunnelSchema.safeParse({
        id: validUuid,
        name: 'Service Tunnel Missing Name',
        kind: 'remote',
        cfTunnelId: 'cf-remote-123',
        runMode: 'service',
        autoStart: false
      })
      expect(res.success).toBe(false)
    })

    it('rejects unknown kind', () => {
      const res = TunnelSchema.safeParse({
        id: validUuid,
        name: 'Unknown Kind',
        kind: 'other',
        runMode: 'app',
        autoStart: false
      })
      expect(res.success).toBe(false)
    })
  })

  describe('BinaryStatusSchema', () => {
    it('validates found binary status', () => {
      const res = BinaryStatusSchema.safeParse({
        found: true,
        path: 'C:\\path\\cloudflared.exe',
        source: 'managed',
        version: '2026.10.0',
        overrideInvalid: false
      })
      expect(res.success).toBe(true)
    })

    it('validates not found binary status', () => {
      const res = BinaryStatusSchema.safeParse({
        found: false,
        searched: ['path1', 'path2'],
        overrideInvalid: true
      })
      expect(res.success).toBe(true)
    })
  })

  describe('SettingsViewSchema & SettingsPatchSchema', () => {
    it('validates SettingsView', () => {
      const res = SettingsViewSchema.safeParse({
        startup: { launchAtLogin: false, startHidden: true },
        binary: { overridePath: 'C:\\cloudflared.exe' },
        appVersion: '1.0.0'
      })
      expect(res.success).toBe(true)
    })

    it('validates SettingsPatch', () => {
      const res = SettingsPatchSchema.safeParse({
        startup: { launchAtLogin: true }
      })
      expect(res.success).toBe(true)
    })
  })

  describe('AccountStatusSchema', () => {
    it('validates connected and disconnected account status', () => {
      const connected = AccountStatusSchema.safeParse({
        connected: true,
        accountId: 'acc-123',
        accountName: 'My Account'
      })
      expect(connected.success).toBe(true)

      const disconnected = AccountStatusSchema.safeParse({
        connected: false
      })
      expect(disconnected.success).toBe(true)
    })
  })

  describe('AccountSchema', () => {
    it('validates account data', () => {
      const res = AccountSchema.safeParse({
        id: 'acc-123',
        name: 'Production Team',
        type: 'standard'
      })
      expect(res.success).toBe(true)
    })
  })

  describe('ZoneSchema', () => {
    it('validates zone data', () => {
      const res = ZoneSchema.safeParse({
        id: 'zone-123',
        name: 'example.com',
        status: 'active'
      })
      expect(res.success).toBe(true)
    })
  })

  describe('RemoteHostnameSchema', () => {
    it('validates remote hostname data', () => {
      const res = RemoteHostnameSchema.safeParse({
        hostname: 'app.example.com',
        service: 'http://localhost:3000',
        path: '/api',
        noTlsVerify: true
      })
      expect(res.success).toBe(true)
    })

    it('validates minimal remote hostname data', () => {
      const res = RemoteHostnameSchema.safeParse({
        hostname: 'app.example.com',
        service: 'http://localhost:3000'
      })
      expect(res.success).toBe(true)
    })
  })

  describe('CloudflaredServiceSchema', () => {
    it('validates complete cloudflared service data', () => {
      const res = CloudflaredServiceSchema.safeParse({
        serviceName: 'cftunnel-prod',
        displayName: 'Cloudflare Tunnel (Prod)',
        state: 'running',
        kind: 'remote',
        cfTunnelId: 'cf-tunnel-uuid-1',
        metricsPort: 40500,
        logPath: 'C:\\logs\\cftunnel-prod.log',
        binaryVersion: '2026.10.0'
      })
      expect(res.success).toBe(true)
    })

    it('validates minimal unlinked cloudflared service data', () => {
      const res = CloudflaredServiceSchema.safeParse({
        serviceName: 'Cloudflared',
        displayName: 'Cloudflared',
        state: 'stopped',
        kind: 'unlinked'
      })
      expect(res.success).toBe(true)
    })
  })

  describe('BinaryReleaseSchema & DownloadProgressPayloadSchema', () => {
    it('validates binary release data', () => {
      const res = BinaryReleaseSchema.safeParse({
        version: '2026.10.1',
        releaseUrl: 'https://github.com/cloudflare/cloudflared/releases/tag/2026.10.1',
        publishedAt: '2026-10-14T00:00:00Z',
        downloadUrl:
          'https://github.com/cloudflare/cloudflared/releases/download/2026.10.1/cloudflared-windows-amd64.exe',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        hasChecksum: true,
        isUpdateAvailable: true
      })
      expect(res.success).toBe(true)
    })

    it('validates download progress payload', () => {
      const res = DownloadProgressPayloadSchema.safeParse({
        percent: 45.5,
        transferred: 15000000,
        total: 33000000
      })
      expect(res.success).toBe(true)
    })
  })
})
