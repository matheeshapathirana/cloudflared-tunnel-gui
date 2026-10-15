import type { IpcRouter } from './IpcRouter'
import type { TunnelRegistry } from '../tunnels/TunnelRegistry'
import type { BinaryManager } from '../binary/BinaryManager'
import type { SettingsStore } from '../settings/SettingsStore'
import type { ProcessSupervisor } from '../process/ProcessSupervisor'
import type { LocalConfigStore } from '../config/LocalConfigStore'
import type { SecretStore, ISecretStore } from '../security/SecretStore'
import type { CloudflareApi, ICloudflareApi } from '../api/CloudflareApi'
import type { ServiceManager } from '../services/ServiceManager'
import type { ImportService } from '../import/ImportService'
import type {
  SettingsView,
  Tunnel,
  RemoteHostname,
  DownloadProgressPayload,
  ThemePreference
} from '@shared/schemas'
import { AppErrorException } from '@shared/result'
import { app } from 'electron'
import path from 'node:path'

export interface RegisterCommandsDeps {
  registry: TunnelRegistry
  binaryManager: BinaryManager
  store: SettingsStore
  supervisor?: ProcessSupervisor
  localConfigStore?: LocalConfigStore
  secretStore?: SecretStore | ISecretStore
  cloudflareApi?: CloudflareApi | ICloudflareApi
  serviceManager?: ServiceManager
  importService?: ImportService
  appVersion: string
  quitApp?: () => void
  setLoginSettings?: (settings: { openAtLogin: boolean; args: string[] }) => void
  applyTheme?: (theme: ThemePreference) => void
  onDownloadProgress?: (payload: DownloadProgressPayload) => void
}

export function normalizeTarget(target: string): string {
  const trimmed = target.trim()
  if (/^\d+$/.test(trimmed)) {
    return `http://localhost:${trimmed}`
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return `http://${trimmed}`
  }
  return trimmed
}

const samePath = (a: string, b: string): boolean =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/**
 * The renderer must not be able to point config commands at arbitrary files: only config files
 * of registered tunnels, or YAML files directly inside the cloudflared config directory.
 */
export function assertKnownConfigPath(deps: RegisterCommandsDeps, configPath: string): string {
  if (!/\.ya?ml$/i.test(configPath)) {
    throw new AppErrorException('VALIDATION', 'Config path must be a .yml or .yaml file')
  }
  const resolved = path.resolve(configPath)
  const registered = deps.registry
    .list()
    .some((t) => t.local?.configPath && samePath(t.local.configPath, resolved))
  const configDir = deps.localConfigStore?.getConfigDir()
  const inConfigDir = configDir ? samePath(path.dirname(resolved), configDir) : false
  if (!registered && !inConfigDir) {
    throw new AppErrorException('VALIDATION', 'Not a config file managed by this app')
  }
  return resolved
}

const TUNNEL_PERMISSION_HINT =
  'In the Cloudflare dashboard, edit the token: it needs Account > Cloudflare Tunnel > Edit with your account chosen under Account Resources. Then paste it again.'

export function registerCommands(router: IpcRouter, deps: RegisterCommandsDeps): void {
  router.register('tunnels.list', () => {
    return deps.registry.list()
  })

  router.register('tunnels.rename', (input) => {
    return deps.registry.update(input.id, { name: input.name })
  })

  router.register('tunnels.setAutoStart', (input) => {
    return deps.registry.update(input.id, { autoStart: input.autoStart })
  })

  router.register('tunnels.delete', async (input) => {
    if (deps.supervisor) {
      await deps.supervisor.stop(input.id)
    }
    await deps.registry.remove(input.id)
  })

  router.register('tunnels.start', async (input) => {
    if (!deps.supervisor) return
    const tunnel = deps.registry.get(input.id)
    if (tunnel.runMode === 'service') {
      const by = tunnel.serviceName ? ` ${tunnel.serviceName}` : ''
      throw new AppErrorException(
        'VALIDATION',
        `Managed by Windows service${by}. Switch it to app mode first.`
      )
    }
    if (tunnel.cfTunnelId && deps.serviceManager) {
      const running = (await deps.serviceManager.listServices()).find(
        (s) => s.cfTunnelId === tunnel.cfTunnelId && s.state !== 'stopped'
      )
      if (running) {
        throw new AppErrorException(
          'VALIDATION',
          `Already running as Windows service ${running.serviceName}. Stop the service first to avoid a second connector.`
        )
      }
    }
    await deps.supervisor.start(tunnel)
  })

  router.register('tunnels.stop', async (input) => {
    if (!deps.supervisor) return
    await deps.supervisor.stop(input.id)
  })

  router.register('tunnels.logs', (input) => {
    if (!deps.supervisor) return []
    return deps.supervisor.getLogs(input.id, input.limit)
  })

  router.register('quick.start', async (input) => {
    const target = normalizeTarget(input.target)

    // Save to recentQuickTargets (keep up to 10 unique targets)
    await deps.store.update((s) => {
      const existing = s.recentQuickTargets.filter((t) => t !== target)
      s.recentQuickTargets = [target, ...existing].slice(0, 10)
    })

    const tunnelInput: Omit<Tunnel, 'id'> = {
      name: `Quick (${target})`,
      kind: 'quick',
      runMode: 'app',
      autoStart: false,
      quick: { target }
    }

    const tunnel = await deps.registry.add(tunnelInput)

    if (deps.supervisor) {
      await deps.supervisor.start(tunnel)
    }

    return tunnel
  })

  router.register('quick.stop', async (input) => {
    if (deps.supervisor) {
      await deps.supervisor.stop(input.id)
    }
    await deps.registry.remove(input.id)
  })

  router.register('quick.recentTargets', () => {
    return deps.store.get().recentQuickTargets
  })

  router.register('quick.clearRecentTargets', async () => {
    await deps.store.update((s) => {
      s.recentQuickTargets = []
    })
  })

  router.register('local.import', async () => {
    if (!deps.localConfigStore) return deps.registry.list()

    const discovered = await deps.localConfigStore.scanConfigs()
    const existingList = deps.registry.list()

    for (const item of discovered) {
      const alreadyPresent = existingList.some(
        (t) => t.cfTunnelId && item.cfTunnelId && t.cfTunnelId === item.cfTunnelId
      )
      if (!alreadyPresent) {
        await deps.registry.add({
          name: item.name,
          kind: 'local',
          cfTunnelId: item.cfTunnelId,
          runMode: 'app',
          autoStart: false,
          local: item.local
        })
      }
    }

    return deps.registry.list()
  })

  router.register('local.readConfig', async (input) => {
    if (!deps.localConfigStore) {
      return { rawYaml: '', ingress: [] }
    }
    return deps.localConfigStore.readConfig(assertKnownConfigPath(deps, input.configPath))
  })

  router.register('local.saveConfig', async (input) => {
    if (!deps.localConfigStore) return
    await deps.localConfigStore.saveConfig(
      assertKnownConfigPath(deps, input.configPath),
      input.rawYaml
    )
  })

  router.register('local.validate', async (input) => {
    if (!deps.localConfigStore) return { valid: true }
    return deps.localConfigStore.validateYaml(input.rawYaml)
  })

  router.register('local.listBackups', async (input) => {
    if (!deps.localConfigStore) return []
    return deps.localConfigStore.listBackups(assertKnownConfigPath(deps, input.configPath))
  })

  router.register('local.restoreBackup', async (input) => {
    if (!deps.localConfigStore) return
    await deps.localConfigStore.restoreBackup(
      assertKnownConfigPath(deps, input.configPath),
      input.backupPath
    )
  })

  router.register('local.checkCert', async () => {
    if (!deps.localConfigStore) return { hasCert: false }
    return deps.localConfigStore.checkCert()
  })

  router.register('local.login', async () => {
    if (!deps.localConfigStore) return
    await deps.localConfigStore.login()
  })

  router.register('local.create', async (input) => {
    if (!deps.localConfigStore) {
      throw new Error('LocalConfigStore not initialized')
    }
    const created = await deps.localConfigStore.createTunnel(input.name)
    return deps.registry.add({
      name: created.name,
      kind: 'local',
      cfTunnelId: created.cfTunnelId,
      runMode: 'app',
      autoStart: false,
      local: created.local
    })
  })

  router.register('account.status', async () => {
    if (!deps.secretStore) {
      return { connected: false }
    }
    const hasToken = await deps.secretStore.hasToken()
    if (!hasToken) {
      return { connected: false }
    }
    const account = deps.store.get().account
    return {
      connected: true,
      accountId: account?.accountId,
      accountName: account?.accountName
    }
  })

  router.register('account.setToken', async (input) => {
    if (!deps.secretStore || !deps.cloudflareApi) {
      throw new AppErrorException('INTERNAL', 'Cloudflare integration not configured')
    }
    const verification = await deps.cloudflareApi.verifyToken(input.token)
    if (!verification.valid) {
      throw new AppErrorException(
        'UNAUTHORIZED',
        verification.error || 'Invalid Cloudflare API token'
      )
    }
    let accounts: Awaited<ReturnType<typeof deps.cloudflareApi.listAccounts>>
    try {
      accounts = await deps.cloudflareApi.listAccounts(input.token)
    } catch (err) {
      if (err instanceof AppErrorException && err.code === 'UNAUTHORIZED') {
        throw new AppErrorException(
          'UNAUTHORIZED',
          `This token cannot see any account, so it cannot manage tunnels. ${TUNNEL_PERMISSION_HINT}`
        )
      }
      throw err
    }
    if (!accounts || accounts.length === 0) {
      throw new AppErrorException(
        'VALIDATION',
        `Cloudflare reported no accounts or domains for this token. Check that Account Resources includes your account and Zone Resources includes your domain. ${TUNNEL_PERMISSION_HINT}`
      )
    }
    const selectedAccount = input.accountId
      ? accounts.find((a) => a.id === input.accountId)
      : accounts[0]
    if (!selectedAccount) {
      throw new AppErrorException('NOT_FOUND', 'Selected account not found')
    }
    // Probe the tunnel permission before saving anything, so a zone-only token fails here with a
    // clear message instead of later when creating or running a tunnel.
    try {
      await deps.cloudflareApi.listTunnels(input.token, selectedAccount.id)
    } catch (err) {
      if (err instanceof AppErrorException && err.code === 'UNAUTHORIZED') {
        throw new AppErrorException(
          'UNAUTHORIZED',
          `This token cannot manage Cloudflare Tunnels. ${TUNNEL_PERMISSION_HINT}`
        )
      }
      throw err
    }
    await deps.secretStore.setToken(input.token)
    await deps.store.update((s) => {
      s.account = { accountId: selectedAccount.id, accountName: selectedAccount.name }
    })
    const zones = await deps.cloudflareApi.listZones(input.token, selectedAccount.id)
    return {
      status: {
        connected: true,
        accountId: selectedAccount.id,
        accountName: selectedAccount.name
      },
      accounts,
      zones
    }
  })

  router.register('account.clearToken', async () => {
    if (deps.secretStore) {
      await deps.secretStore.clearToken()
    }
    await deps.store.update((s) => {
      s.account = undefined
    })
  })

  router.register('account.listZones', async () => {
    if (!deps.secretStore || !deps.cloudflareApi) {
      throw new AppErrorException('INTERNAL', 'Cloudflare integration not configured')
    }
    const token = await deps.secretStore.getToken()
    if (!token) {
      throw new AppErrorException('UNAUTHORIZED', 'Cloudflare token not configured')
    }
    const accountId = deps.store.get().account?.accountId
    if (!accountId) {
      throw new AppErrorException('UNAUTHORIZED', 'Cloudflare account not selected')
    }
    return deps.cloudflareApi.listZones(token, accountId)
  })

  router.register('account.tokenCreationUrl', () => {
    return {
      // Cloudflare silently drops permission keys it does not recognise, so every key here was
      // checked by opening this link: `argotunnel` is Account > Cloudflare Tunnel (it is not in
      // Cloudflare's docs), `dns` and `zone` are documented. Account Resources is left for the user.
      url: 'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[{"key":"argotunnel","type":"edit"},{"key":"dns","type":"edit"},{"key":"zone","type":"read"}]&name=Cloudflared%20Tunnel%20GUI'
    }
  })

  router.register('remote.create', async (input) => {
    if (!deps.secretStore || !deps.cloudflareApi) {
      throw new AppErrorException('INTERNAL', 'Cloudflare integration not configured')
    }
    const token = await deps.secretStore.getToken()
    if (!token) {
      throw new AppErrorException('UNAUTHORIZED', 'Cloudflare token not configured')
    }
    const accountId = deps.store.get().account?.accountId
    if (!accountId) {
      throw new AppErrorException('UNAUTHORIZED', 'Cloudflare account not selected')
    }
    const cfTunnel = await deps.cloudflareApi.createTunnel(token, accountId, input.name)
    return deps.registry.add({
      name: input.name,
      kind: 'remote',
      cfTunnelId: cfTunnel.id,
      runMode: 'app',
      autoStart: false
    })
  })

  router.register('remote.listHostnames', async (input) => {
    const tunnel = deps.registry.get(input.tunnelId)
    if (tunnel.kind !== 'remote' || !tunnel.cfTunnelId) {
      throw new AppErrorException('VALIDATION', 'Tunnel is not a remote tunnel')
    }
    if (!deps.secretStore || !deps.cloudflareApi) {
      throw new AppErrorException('INTERNAL', 'Cloudflare integration not configured')
    }
    const token = await deps.secretStore.getToken()
    if (!token) {
      throw new AppErrorException('UNAUTHORIZED', 'Cloudflare token not configured')
    }
    const accountId = deps.store.get().account?.accountId
    if (!accountId) {
      throw new AppErrorException('UNAUTHORIZED', 'Cloudflare account not selected')
    }
    const config = await deps.cloudflareApi.getConfiguration(token, accountId, tunnel.cfTunnelId)
    const hostnames: RemoteHostname[] = []
    for (const r of config.ingress) {
      if (r.service.startsWith('http_status:') || r.service === 'http_status:404') {
        continue
      }
      if (!r.hostname) continue
      hostnames.push({
        hostname: r.hostname,
        service: r.service,
        path: r.path,
        noTlsVerify: (r.originRequest as { noTLSVerify?: boolean } | undefined)?.noTLSVerify
      })
    }
    return hostnames
  })

  router.register('remote.addHostname', async (input) => {
    const tunnel = deps.registry.get(input.tunnelId)
    if (tunnel.kind !== 'remote' || !tunnel.cfTunnelId) {
      throw new AppErrorException('VALIDATION', 'Tunnel is not a remote tunnel')
    }
    if (!deps.secretStore || !deps.cloudflareApi) {
      throw new AppErrorException('INTERNAL', 'Cloudflare integration not configured')
    }
    const token = await deps.secretStore.getToken()
    if (!token) {
      throw new AppErrorException('UNAUTHORIZED', 'Cloudflare token not configured')
    }
    const accountId = deps.store.get().account?.accountId
    if (!accountId) {
      throw new AppErrorException('UNAUTHORIZED', 'Cloudflare account not selected')
    }
    const config = await deps.cloudflareApi.getConfiguration(token, accountId, tunnel.cfTunnelId)
    const rules = config.ingress.filter(
      (r) => !r.service.startsWith('http_status:') && r.service !== 'http_status:404'
    )
    rules.push({
      hostname: input.hostname,
      service: input.service,
      originRequest: input.noTlsVerify ? { noTLSVerify: true } : undefined
    })
    rules.push({ service: 'http_status:404' })
    await deps.cloudflareApi.putConfiguration(token, accountId, tunnel.cfTunnelId, rules)
    const target = `${tunnel.cfTunnelId}.cfargotunnel.com`
    await deps.cloudflareApi.createDnsCname(token, input.zoneId, input.hostname, target)
  })

  router.register('remote.removeHostname', async (input) => {
    const tunnel = deps.registry.get(input.tunnelId)
    if (tunnel.kind !== 'remote' || !tunnel.cfTunnelId) {
      throw new AppErrorException('VALIDATION', 'Tunnel is not a remote tunnel')
    }
    if (!deps.secretStore || !deps.cloudflareApi) {
      throw new AppErrorException('INTERNAL', 'Cloudflare integration not configured')
    }
    const token = await deps.secretStore.getToken()
    if (!token) {
      throw new AppErrorException('UNAUTHORIZED', 'Cloudflare token not configured')
    }
    const accountId = deps.store.get().account?.accountId
    if (!accountId) {
      throw new AppErrorException('UNAUTHORIZED', 'Cloudflare account not selected')
    }
    const config = await deps.cloudflareApi.getConfiguration(token, accountId, tunnel.cfTunnelId)
    const rules = config.ingress.filter((r) => r.hostname !== input.hostname)
    await deps.cloudflareApi.putConfiguration(token, accountId, tunnel.cfTunnelId, rules)

    let zoneIds: string[] = []
    if (input.zoneId) {
      zoneIds = [input.zoneId]
    } else {
      try {
        const zones = await deps.cloudflareApi.listZones(token, accountId)
        zoneIds = zones.map((z) => z.id)
      } catch {
        zoneIds = []
      }
    }
    const target = `${tunnel.cfTunnelId}.cfargotunnel.com`
    for (const zid of zoneIds) {
      try {
        const records = await deps.cloudflareApi.listDnsRecords(token, zid, input.hostname)
        for (const record of records) {
          if (record.content === target) {
            await deps.cloudflareApi.deleteDnsRecord(token, zid, record.id)
          }
        }
      } catch {
        // Ignore errors in zone query
      }
    }
  })

  router.register('remote.delete', async (input) => {
    const tunnel = deps.registry.get(input.tunnelId)
    if (tunnel.kind !== 'remote' || !tunnel.cfTunnelId) {
      throw new AppErrorException('VALIDATION', 'Tunnel is not a remote tunnel')
    }

    if (deps.supervisor) {
      const status = deps.supervisor.getStatus(tunnel.id)
      if (status.state !== 'stopped') {
        await deps.supervisor.stop(tunnel.id)
      }
    }

    if (!deps.secretStore || !deps.cloudflareApi) {
      throw new AppErrorException('INTERNAL', 'Cloudflare integration not configured')
    }
    const token = await deps.secretStore.getToken()
    if (!token) {
      throw new AppErrorException('UNAUTHORIZED', 'Cloudflare token not configured')
    }
    const accountId = deps.store.get().account?.accountId
    if (!accountId) {
      throw new AppErrorException('UNAUTHORIZED', 'Cloudflare account not selected')
    }

    const target = `${tunnel.cfTunnelId}.cfargotunnel.com`
    try {
      const zones = await deps.cloudflareApi.listZones(token, accountId)
      for (const zone of zones) {
        try {
          const records = await deps.cloudflareApi.listDnsRecords(token, zone.id)
          for (const record of records) {
            if (record.content === target) {
              await deps.cloudflareApi.deleteDnsRecord(token, zone.id, record.id)
            }
          }
        } catch {
          // Ignore zone-level errors
        }
      }
    } catch {
      // Ignore zone listing errors
    }

    await deps.cloudflareApi.deleteTunnel(token, accountId, tunnel.cfTunnelId)
    await deps.registry.remove(tunnel.id)
  })

  router.register('binary.status', () => {
    return deps.binaryManager.status()
  })

  router.register('binary.setOverride', async (input) => {
    await deps.store.update((s) => {
      s.binary.overridePath = input.path ?? undefined
    })
    return deps.binaryManager.status()
  })

  router.register('services.list', async () => {
    if (!deps.serviceManager) return []
    return deps.serviceManager.listServices()
  })

  router.register('services.start', async (input) => {
    if (!deps.serviceManager) return
    await deps.serviceManager.startService(input.serviceName)
  })

  router.register('services.stop', async (input) => {
    if (!deps.serviceManager) return
    await deps.serviceManager.stopService(input.serviceName)
  })

  router.register('services.restart', async (input) => {
    if (!deps.serviceManager) return
    await deps.serviceManager.restartService(input.serviceName)
  })

  router.register('services.install', async (input) => {
    if (!deps.serviceManager) {
      throw new AppErrorException('INTERNAL', 'ServiceManager is not available')
    }
    const tunnel = deps.registry.get(input.tunnelId)
    if (tunnel.kind === 'quick') {
      throw new AppErrorException(
        'VALIDATION',
        'Quick tunnels cannot be installed as Windows services'
      )
    }

    if (tunnel.kind === 'remote') {
      if (!deps.secretStore || !deps.cloudflareApi) {
        throw new AppErrorException('UNAUTHORIZED', 'Cloudflare API not configured')
      }
      const token = await deps.secretStore.getToken()
      const accountId = deps.store.get().account?.accountId
      if (!token || !accountId || !tunnel.cfTunnelId) {
        throw new AppErrorException('UNAUTHORIZED', 'Cloudflare API token and account required')
      }
      const runToken = await deps.cloudflareApi.getTunnelToken(token, accountId, tunnel.cfTunnelId)
      if (deps.supervisor) {
        await deps.supervisor.stop(tunnel.id).catch(() => {})
      }
      const slug = await deps.serviceManager.installRemote({
        tunnelName: tunnel.name,
        token: runToken,
        cfTunnelId: tunnel.cfTunnelId
      })
      return deps.registry.update(tunnel.id, {
        runMode: 'service',
        serviceName: slug
      })
    }

    if (tunnel.kind === 'local') {
      if (!tunnel.local?.configPath) {
        throw new AppErrorException('VALIDATION', 'Local tunnel config path is missing')
      }
      if (deps.supervisor) {
        await deps.supervisor.stop(tunnel.id).catch(() => {})
      }
      const slug = await deps.serviceManager.installLocal({
        tunnelName: tunnel.name,
        configPath: tunnel.local.configPath,
        cfTunnelId: tunnel.cfTunnelId
      })
      return deps.registry.update(tunnel.id, {
        runMode: 'service',
        serviceName: slug
      })
    }

    throw new AppErrorException('VALIDATION', `Unsupported tunnel kind: ${String(tunnel.kind)}`)
  })

  router.register('services.uninstall', async (input) => {
    if (!deps.serviceManager) {
      throw new AppErrorException('INTERNAL', 'ServiceManager is not available')
    }
    const tunnel = deps.registry.get(input.tunnelId)
    if (tunnel.serviceName) {
      await deps.serviceManager.uninstall(tunnel.serviceName)
    }
    return deps.registry.update(tunnel.id, {
      runMode: 'app',
      serviceName: undefined
    })
  })

  router.register('services.adopt', async (input) => {
    if (!deps.serviceManager) {
      throw new AppErrorException('INTERNAL', 'ServiceManager is not available')
    }
    await deps.serviceManager.adopt(input.serviceName)
    const services = await deps.serviceManager.listServices()
    const adopted = services.find((s) => s.serviceName === input.serviceName)
    if (!adopted) {
      throw new AppErrorException('NOT_FOUND', `Adopted service ${input.serviceName} not found`)
    }
    return adopted
  })

  router.register('tunnels.refresh', async () => {
    if (deps.importService) {
      return deps.importService.run()
    }
    return deps.registry.list()
  })

  router.register('binary.checkUpdate', async () => {
    const status = await deps.binaryManager.status()
    const currentVersion = status.found ? status.version : null
    return deps.binaryManager.checkUpdate(currentVersion)
  })

  router.register('binary.download', async (input) => {
    await deps.binaryManager.download({
      confirmWithoutChecksum: input.confirmWithoutChecksum,
      onProgress: (payload) => {
        deps.onDownloadProgress?.(payload)
      }
    })
    return deps.binaryManager.status()
  })

  const getSettings = (): SettingsView => {
    const state = deps.store.get()
    return {
      startup: state.startup,
      binary: state.binary,
      theme: state.theme,
      appVersion: deps.appVersion
    }
  }

  router.register('app.getSettings', () => {
    return getSettings()
  })

  router.register('app.setSettings', async (input) => {
    await deps.store.update((s) => {
      if (input.startup) {
        s.startup = { ...s.startup, ...input.startup }
      }
      if (input.theme) {
        s.theme = input.theme
      }
    })
    if (input.theme) {
      deps.applyTheme?.(input.theme)
    }
    if (input.startup && deps.setLoginSettings) {
      const state = deps.store.get()
      deps.setLoginSettings({
        openAtLogin: state.startup.launchAtLogin,
        args: state.startup.startHidden ? ['--hidden'] : []
      })
    }
    return getSettings()
  })

  router.register('app.quit', () => {
    if (deps.quitApp) {
      deps.quitApp()
    } else {
      app.quit()
    }
  })
}
