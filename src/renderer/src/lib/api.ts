import { useEffect, useState } from 'react'
import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'
import type { CommandInput, CommandName, CommandOutput, EventName, EventPayload } from '@shared/ipc'
import type { ErrorCode, Result } from '@shared/result'
import type {
  Account,
  AccountStatus,
  BackupInfo,
  BinaryRelease,
  BinaryStatus,
  CloudflaredService,
  DownloadProgressPayload,
  IngressRule,
  RemoteHostname,
  SettingsPatch,
  SettingsView,
  Tunnel,
  TunnelStatus,
  Zone
} from '@shared/schemas'

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message)
    this.name = 'ApiError'
    Object.setPrototypeOf(this, ApiError.prototype)
  }
}

export interface WindowApi {
  invoke<K extends CommandName>(name: K, input: CommandInput<K>): Promise<Result<CommandOutput<K>>>
  on<K extends EventName>(name: K, cb: (payload: EventPayload<K>) => void): () => void
}

export function getApi(): WindowApi {
  const win = window as unknown as { api?: WindowApi }
  if (!win.api) {
    throw new Error('window.api is not defined')
  }
  return win.api
}

export async function call<K extends CommandName>(
  name: K,
  input: CommandInput<K>
): Promise<CommandOutput<K>> {
  const res = await getApi().invoke(name, input)
  if (!res.ok) {
    throw new ApiError(res.error.code, res.error.message, res.error.details)
  }
  return res.data
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false
    }
  }
})

export function useTunnels(): UseQueryResult<Tunnel[], Error> {
  const client = useQueryClient()

  useEffect(() => {
    try {
      const unsubscribe = getApi().on('registry:changed', (tunnels) => {
        client.setQueryData(['tunnels'], tunnels)
      })
      return () => {
        unsubscribe()
      }
    } catch {
      return
    }
  }, [client])

  return useQuery({
    queryKey: ['tunnels'],
    queryFn: () => call('tunnels.list', undefined)
  })
}

export function useTunnelStatuses(): Record<string, TunnelStatus> {
  const [statuses, setStatuses] = useState<Record<string, TunnelStatus>>({})

  useEffect(() => {
    try {
      const unsubscribe = getApi().on('tunnel:status', ({ id, status }) => {
        setStatuses((prev) => ({ ...prev, [id]: status }))
      })
      return () => {
        unsubscribe()
      }
    } catch {
      return
    }
  }, [])

  return statuses
}

export function useTunnelLogs(tunnelId: string | null): string[] {
  const [logs, setLogs] = useState<string[]>([])

  useEffect(() => {
    if (!tunnelId) {
      return
    }

    let isCancelled = false
    call('tunnels.logs', { id: tunnelId, limit: 100 })
      .then((initial) => {
        if (!isCancelled) {
          setLogs(initial)
        }
      })
      .catch(() => {})

    try {
      const unsubscribe = getApi().on('tunnel:log', ({ id, line }) => {
        if (id === tunnelId) {
          setLogs((prev) => [...prev, line].slice(-2000))
        }
      })
      return () => {
        isCancelled = true
        unsubscribe()
      }
    } catch {
      return () => {
        isCancelled = true
      }
    }
  }, [tunnelId])

  return logs
}

export function useStartTunnel(): UseMutationResult<void, Error, { id: string }> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('tunnels.start', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['tunnels'] })
    }
  })
}

export function useStopTunnel(): UseMutationResult<void, Error, { id: string }> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('tunnels.stop', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['tunnels'] })
    }
  })
}

export function useStartQuickTunnel(): UseMutationResult<Tunnel, Error, { target: string }> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('quick.start', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['tunnels'] })
      client.invalidateQueries({ queryKey: ['quick', 'recentTargets'] })
    }
  })
}

export function useStopQuickTunnel(): UseMutationResult<void, Error, { id: string }> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('quick.stop', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['tunnels'] })
    }
  })
}

export function useRecentQuickTargets(): UseQueryResult<string[], Error> {
  return useQuery({
    queryKey: ['quick', 'recentTargets'],
    queryFn: () => call('quick.recentTargets', undefined)
  })
}

export function useBinaryStatus(): UseQueryResult<BinaryStatus, Error> {
  return useQuery({
    queryKey: ['binary', 'status'],
    queryFn: () => call('binary.status', undefined)
  })
}

export function useSettings(): UseQueryResult<SettingsView, Error> {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => call('app.getSettings', undefined)
  })
}

export function useSetOverride(): UseMutationResult<BinaryStatus, Error, { path: string | null }> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('binary.setOverride', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['binary', 'status'] })
      client.invalidateQueries({ queryKey: ['settings'] })
    }
  })
}

export function useSetSettings(): UseMutationResult<SettingsView, Error, SettingsPatch> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('app.setSettings', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['settings'] })
    }
  })
}

export function useImportLocalTunnels(): UseMutationResult<Tunnel[], Error, void> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => call('local.import', undefined),
    onSuccess: (tunnels) => {
      client.setQueryData(['tunnels'], tunnels)
    }
  })
}

export function useReadConfig(
  configPath: string | null
): UseQueryResult<{ rawYaml: string; ingress: IngressRule[] }, Error> {
  return useQuery({
    queryKey: ['local', 'readConfig', configPath],
    queryFn: () => call('local.readConfig', { configPath: configPath! }),
    enabled: Boolean(configPath)
  })
}

export function useSaveConfig(): UseMutationResult<
  void,
  Error,
  { configPath: string; rawYaml: string }
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('local.saveConfig', input),
    onSuccess: (_, variables) => {
      client.invalidateQueries({
        queryKey: ['local', 'readConfig', variables.configPath]
      })
      client.invalidateQueries({
        queryKey: ['local', 'backups', variables.configPath]
      })
    }
  })
}

export function useValidateYaml(): UseMutationResult<
  { valid: boolean; error?: string },
  Error,
  { rawYaml: string }
> {
  return useMutation({
    mutationFn: (input) => call('local.validate', input)
  })
}

export function useListBackups(configPath: string | null): UseQueryResult<BackupInfo[], Error> {
  return useQuery({
    queryKey: ['local', 'backups', configPath],
    queryFn: () => call('local.listBackups', { configPath: configPath! }),
    enabled: Boolean(configPath)
  })
}

export function useRestoreBackup(): UseMutationResult<
  void,
  Error,
  { configPath: string; backupPath: string }
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('local.restoreBackup', input),
    onSuccess: (_, variables) => {
      client.invalidateQueries({
        queryKey: ['local', 'readConfig', variables.configPath]
      })
      client.invalidateQueries({
        queryKey: ['local', 'backups', variables.configPath]
      })
    }
  })
}

export function useCheckCert(): UseQueryResult<{ hasCert: boolean; certPath?: string }, Error> {
  return useQuery({
    queryKey: ['local', 'checkCert'],
    queryFn: () => call('local.checkCert', undefined)
  })
}

export function useLogin(): UseMutationResult<void, Error, void> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => call('local.login', undefined),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['local', 'checkCert'] })
    }
  })
}

export function useCreateLocalTunnel(): UseMutationResult<Tunnel, Error, { name: string }> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('local.create', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['tunnels'] })
    }
  })
}

export function useAccountStatus(): UseQueryResult<AccountStatus, Error> {
  return useQuery({
    queryKey: ['account', 'status'],
    queryFn: () => call('account.status', undefined)
  })
}

export function useSetAccountToken(): UseMutationResult<
  { status: AccountStatus; accounts: Account[]; zones: Zone[] },
  Error,
  { token: string; accountId?: string }
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('account.setToken', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['account', 'status'] })
      client.invalidateQueries({ queryKey: ['account', 'zones'] })
    }
  })
}

export function useClearAccountToken(): UseMutationResult<void, Error, void> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => call('account.clearToken', undefined),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['account', 'status'] })
      client.invalidateQueries({ queryKey: ['account', 'zones'] })
    }
  })
}

export function useAccountZones(): UseQueryResult<Zone[], Error> {
  return useQuery({
    queryKey: ['account', 'zones'],
    queryFn: () => call('account.listZones', undefined)
  })
}

export function useTokenCreationUrl(): UseQueryResult<{ url: string }, Error> {
  return useQuery({
    queryKey: ['account', 'tokenCreationUrl'],
    queryFn: () => call('account.tokenCreationUrl', undefined)
  })
}

export function useCreateRemoteTunnel(): UseMutationResult<Tunnel, Error, { name: string }> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('remote.create', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['tunnels'] })
    }
  })
}

export function useRemoteHostnames(
  tunnelId: string | null
): UseQueryResult<RemoteHostname[], Error> {
  return useQuery({
    queryKey: ['remote', 'hostnames', tunnelId],
    queryFn: () => call('remote.listHostnames', { tunnelId: tunnelId! }),
    enabled: Boolean(tunnelId)
  })
}

export function useAddRemoteHostname(): UseMutationResult<
  void,
  Error,
  {
    tunnelId: string
    zoneId: string
    hostname: string
    service: string
    noTlsVerify?: boolean
  }
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('remote.addHostname', input),
    onSuccess: (_, variables) => {
      client.invalidateQueries({
        queryKey: ['remote', 'hostnames', variables.tunnelId]
      })
    }
  })
}

export function useRemoveRemoteHostname(): UseMutationResult<
  void,
  Error,
  {
    tunnelId: string
    zoneId?: string
    hostname: string
  }
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('remote.removeHostname', input),
    onSuccess: (_, variables) => {
      client.invalidateQueries({
        queryKey: ['remote', 'hostnames', variables.tunnelId]
      })
    }
  })
}

export function useDeleteRemoteTunnel(): UseMutationResult<void, Error, { tunnelId: string }> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('remote.delete', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['tunnels'] })
    }
  })
}

export function useServices(): UseQueryResult<CloudflaredService[], Error> {
  return useQuery({
    queryKey: ['services'],
    queryFn: () => call('services.list', undefined)
  })
}

export function useStartService(): UseMutationResult<void, Error, { serviceName: string }> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('services.start', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['services'] })
      client.invalidateQueries({ queryKey: ['tunnels'] })
    }
  })
}

export function useStopService(): UseMutationResult<void, Error, { serviceName: string }> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('services.stop', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['services'] })
      client.invalidateQueries({ queryKey: ['tunnels'] })
    }
  })
}

export function useRestartService(): UseMutationResult<void, Error, { serviceName: string }> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('services.restart', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['services'] })
    }
  })
}

export function useInstallService(): UseMutationResult<Tunnel, Error, { tunnelId: string }> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('services.install', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['services'] })
      client.invalidateQueries({ queryKey: ['tunnels'] })
    }
  })
}

export function useUninstallService(): UseMutationResult<Tunnel, Error, { tunnelId: string }> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('services.uninstall', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['services'] })
      client.invalidateQueries({ queryKey: ['tunnels'] })
    }
  })
}

export function useAdoptService(): UseMutationResult<
  CloudflaredService,
  Error,
  { serviceName: string }
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input) => call('services.adopt', input),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['services'] })
    }
  })
}

export function useRefreshTunnels(): UseMutationResult<Tunnel[], Error, void> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => call('tunnels.refresh', undefined),
    onSuccess: (tunnels) => {
      client.setQueryData(['tunnels'], tunnels)
      client.invalidateQueries({ queryKey: ['services'] })
    }
  })
}

export function useBinaryCheckUpdate(): UseQueryResult<BinaryRelease, ApiError> {
  return useQuery({
    queryKey: ['binary', 'update'],
    queryFn: () => call('binary.checkUpdate', undefined),
    staleTime: 5 * 60 * 1000,
    enabled: false
  })
}

export function useBinaryDownload(): UseMutationResult<
  BinaryStatus,
  ApiError,
  { confirmWithoutChecksum?: boolean } | void
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (variables) =>
      call('binary.download', {
        confirmWithoutChecksum: variables?.confirmWithoutChecksum
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['binary', 'status'] })
      client.invalidateQueries({ queryKey: ['binary', 'update'] })
    }
  })
}

export function useBinaryDownloadProgress(): DownloadProgressPayload | null {
  const [progress, setProgress] = useState<DownloadProgressPayload | null>(null)
  useEffect(() => {
    return window.api.on('binary:downloadProgress', (p) => {
      setProgress(p)
    })
  }, [])
  return progress
}
