import React, { useState } from 'react'
import {
  Plus,
  RotateCw,
  Network,
  Circle,
  Play,
  Square,
  FileText,
  FileCode,
  Globe,
  Trash2,
  Loader2,
  AlertTriangle,
  Server
} from 'lucide-react'
import {
  useTunnels,
  useTunnelStatuses,
  useStartTunnel,
  useStopTunnel,
  useRefreshTunnels,
  useDeleteRemoteTunnel,
  useInstallService,
  useUninstallService,
  useStartService,
  useStopService,
  useServices
} from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { LogsDialog } from '@renderer/components/LogsDialog'
import { CreateTunnelDialog } from '@renderer/components/CreateTunnelDialog'
import { IngressEditorDialog } from '@renderer/components/IngressEditorDialog'
import { RemoteHostnamesDialog } from '@renderer/components/RemoteHostnamesDialog'
import type { Tunnel, TunnelStatus } from '@shared/schemas'

function getKindBadge(kind: Tunnel['kind']): React.JSX.Element {
  switch (kind) {
    case 'quick':
      return <Badge variant="secondary">Quick</Badge>
    case 'remote':
      return (
        <Badge variant="default" className="bg-indigo-600 hover:bg-indigo-500 text-white">
          Remote
        </Badge>
      )
    case 'local':
      return <Badge variant="outline">Local</Badge>
  }
}

function getRunModeBadge(runMode: Tunnel['runMode']): React.JSX.Element {
  switch (runMode) {
    case 'app':
      return <Badge variant="outline">App</Badge>
    case 'service':
      return <Badge variant="secondary">Service</Badge>
  }
}

function getStatusIndicator(status?: TunnelStatus): React.JSX.Element {
  const state = status?.state ?? 'stopped'
  switch (state) {
    case 'connected':
      return (
        <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
          <Circle className="size-2 fill-emerald-400" />
          Connected {status?.state === 'connected' && `(${status.connections})`}
        </span>
      )
    case 'starting':
      return (
        <span className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
          <Circle className="size-2 fill-amber-400 animate-pulse" />
          Starting
        </span>
      )
    case 'degraded':
      return (
        <span className="flex items-center gap-1.5 text-xs text-amber-500 font-medium">
          <Circle className="size-2 fill-amber-500" />
          Degraded
        </span>
      )
    case 'crashed':
      return (
        <span className="flex items-center gap-1.5 text-xs text-destructive font-medium">
          <Circle className="size-2 fill-destructive" />
          Crashed
        </span>
      )
    default:
      return (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
          <Circle className="size-2 fill-muted-foreground/50" />
          Stopped
        </span>
      )
  }
}

interface TunnelsPageProps {
  onNavigateToSettings?: () => void
}

export function TunnelsPage({ onNavigateToSettings }: TunnelsPageProps): React.JSX.Element {
  const { data: tunnels, isLoading } = useTunnels()
  const { data: services = [] } = useServices()
  const statuses = useTunnelStatuses()
  const startMutation = useStartTunnel()
  const stopMutation = useStopTunnel()
  const refreshMutation = useRefreshTunnels()
  const deleteRemoteMutation = useDeleteRemoteTunnel()
  const installServiceMutation = useInstallService()
  const uninstallServiceMutation = useUninstallService()
  const startServiceMutation = useStartService()
  const stopServiceMutation = useStopService()

  const [selectedLogsTunnel, setSelectedLogsTunnel] = useState<{
    id: string
    name: string
  } | null>(null)

  const [selectedEditTunnel, setSelectedEditTunnel] = useState<Tunnel | null>(null)
  const [selectedHostnamesTunnel, setSelectedHostnamesTunnel] = useState<Tunnel | null>(null)
  const [tunnelToDelete, setTunnelToDelete] = useState<Tunnel | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)

  const handleToggle = async (tunnel: Tunnel): Promise<void> => {
    const isService = tunnel.runMode === 'service' && Boolean(tunnel.serviceName)
    const serviceInfo = isService
      ? services.find((s) => s.serviceName === tunnel.serviceName)
      : null
    const isRunning = isService
      ? serviceInfo?.state === 'running'
      : statuses[tunnel.id]?.state === 'connected' || statuses[tunnel.id]?.state === 'starting'

    try {
      if (isRunning) {
        if (isService && tunnel.serviceName) {
          await stopServiceMutation.mutateAsync({ serviceName: tunnel.serviceName })
        } else {
          await stopMutation.mutateAsync({ id: tunnel.id })
        }
      } else {
        if (isService && tunnel.serviceName) {
          await startServiceMutation.mutateAsync({ serviceName: tunnel.serviceName })
        } else {
          await startMutation.mutateAsync({ id: tunnel.id })
        }
      }
    } catch {
      // Mutation errors handled by react-query
    }
  }

  const handleRefresh = async (): Promise<void> => {
    try {
      await refreshMutation.mutateAsync()
    } catch {
      // Handled by mutation
    }
  }

  const handleToggleRunMode = async (tunnel: Tunnel): Promise<void> => {
    try {
      if (tunnel.runMode === 'app') {
        await installServiceMutation.mutateAsync({ tunnelId: tunnel.id })
      } else {
        await uninstallServiceMutation.mutateAsync({ tunnelId: tunnel.id })
      }
    } catch {
      // Handled by mutation
    }
  }

  const handleConfirmDelete = async (): Promise<void> => {
    if (!tunnelToDelete) return
    setDeleteError(null)

    try {
      await deleteRemoteMutation.mutateAsync({ tunnelId: tunnelToDelete.id })
      setTunnelToDelete(null)
    } catch (err) {
      setDeleteError((err as Error).message || 'Failed to delete remote tunnel.')
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Tunnels</h1>
          <p className="text-sm text-muted-foreground">
            Manage your Cloudflare Tunnels and active connections.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshMutation.isPending}
            className="gap-1.5 text-xs"
          >
            <RotateCw className={`size-4 ${refreshMutation.isPending ? 'animate-spin' : ''}`} />
            Refresh
          </Button>

          <Button size="sm" onClick={() => setShowCreateDialog(true)} className="gap-1.5 text-xs">
            <Plus className="size-4" />
            New tunnel
          </Button>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center p-12 text-sm text-muted-foreground">
          Loading tunnels...
        </div>
      ) : !tunnels || tunnels.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader className="text-center py-12">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted mb-3">
              <Network className="size-6 text-muted-foreground" />
            </div>
            <CardTitle className="text-base">No tunnels configured</CardTitle>
            <CardDescription className="max-w-sm mx-auto text-sm mt-1">
              You haven&apos;t added any Cloudflare Tunnels yet. Click <strong>Refresh</strong> to
              import config-file tunnels from ~/.cloudflared or <strong>New tunnel</strong> to
              create one.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-3">
          {tunnels.map((tunnel) => {
            const status = statuses[tunnel.id]
            const isRunning = status?.state === 'connected' || status?.state === 'starting'
            const isPending =
              (startMutation.isPending && startMutation.variables?.id === tunnel.id) ||
              (stopMutation.isPending && stopMutation.variables?.id === tunnel.id)

            return (
              <Card key={tunnel.id} className="transition-colors hover:border-muted-foreground/30">
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex flex-col min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{tunnel.name}</span>
                        {getKindBadge(tunnel.kind)}
                        {getRunModeBadge(tunnel.runMode)}
                      </div>
                      <span className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                        {tunnel.kind === 'remote'
                          ? `cfTunnelId: ${tunnel.cfTunnelId ?? 'N/A'}`
                          : (tunnel.quick?.target ?? tunnel.local?.configPath ?? tunnel.id)}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {getStatusIndicator(status)}

                    {tunnel.kind === 'local' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedEditTunnel(tunnel)}
                        className="h-8 gap-1.5 text-xs text-neutral-300"
                      >
                        <FileCode className="h-3.5 w-3.5" />
                        Ingress
                      </Button>
                    )}

                    {tunnel.kind === 'remote' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedHostnamesTunnel(tunnel)}
                        className="h-8 gap-1.5 text-xs text-neutral-300"
                      >
                        <Globe className="h-3.5 w-3.5 text-indigo-400" />
                        Hostnames
                      </Button>
                    )}

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedLogsTunnel({ id: tunnel.id, name: tunnel.name })}
                      className="h-8 gap-1.5 text-xs text-neutral-300"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      Logs
                    </Button>

                    {tunnel.kind !== 'quick' && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          installServiceMutation.isPending || uninstallServiceMutation.isPending
                        }
                        onClick={() => handleToggleRunMode(tunnel)}
                        className="h-8 gap-1.5 text-xs text-neutral-300"
                        title={
                          tunnel.runMode === 'app'
                            ? 'Install and run as background Windows service'
                            : 'Uninstall Windows service and run in app'
                        }
                      >
                        <Server className="h-3.5 w-3.5 text-blue-400" />
                        {tunnel.runMode === 'app' ? 'Run as service' : 'Run in app'}
                      </Button>
                    )}

                    <Button
                      variant={isRunning ? 'destructive' : 'outline'}
                      size="sm"
                      disabled={isPending}
                      onClick={() => handleToggle(tunnel)}
                      className="h-8 gap-1.5 text-xs min-w-[75px]"
                    >
                      {isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : isRunning ? (
                        <>
                          <Square className="h-3.5 w-3.5" />
                          Stop
                        </>
                      ) : (
                        <>
                          <Play className="h-3.5 w-3.5" />
                          Start
                        </>
                      )}
                    </Button>

                    {tunnel.kind === 'remote' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setDeleteError(null)
                          setTunnelToDelete(tunnel)
                        }}
                        className="h-8 px-2 text-neutral-400 hover:text-destructive hover:bg-destructive/10"
                        aria-label={`Delete remote tunnel ${tunnel.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {selectedLogsTunnel && (
        <LogsDialog
          tunnelId={selectedLogsTunnel.id}
          tunnelName={selectedLogsTunnel.name}
          onClose={() => setSelectedLogsTunnel(null)}
        />
      )}

      {selectedEditTunnel && (
        <IngressEditorDialog
          tunnel={selectedEditTunnel}
          onClose={() => setSelectedEditTunnel(null)}
        />
      )}

      {selectedHostnamesTunnel && (
        <RemoteHostnamesDialog
          tunnel={selectedHostnamesTunnel}
          onClose={() => setSelectedHostnamesTunnel(null)}
        />
      )}

      {showCreateDialog && (
        <CreateTunnelDialog
          onClose={() => setShowCreateDialog(false)}
          onNavigateToSettings={onNavigateToSettings}
        />
      )}

      {/* Delete Remote Tunnel Confirmation Dialog */}
      {tunnelToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <div className="flex w-full max-w-md flex-col rounded-xl border border-neutral-800 bg-neutral-950 p-6 shadow-2xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive shrink-0">
                <AlertTriangle className="size-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-neutral-100">Delete Remote Tunnel</h3>
                <p className="text-xs text-neutral-400 mt-1">
                  Are you sure you want to delete remote tunnel{' '}
                  <strong className="text-neutral-200">{tunnelToDelete.name}</strong>?
                </p>
                <p className="text-xs text-neutral-400 mt-2">
                  This will stop the tunnel, remove all associated DNS CNAME records, and
                  permanently delete the tunnel in Cloudflare.
                </p>
              </div>
            </div>

            {deleteError && <p className="text-xs text-destructive font-medium">{deleteError}</p>}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-800">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setTunnelToDelete(null)
                  setDeleteError(null)
                }}
                disabled={deleteRemoteMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleConfirmDelete}
                disabled={deleteRemoteMutation.isPending}
                className="gap-1.5"
              >
                {deleteRemoteMutation.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                Delete Tunnel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
