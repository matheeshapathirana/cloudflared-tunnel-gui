import React, { useState, useMemo } from 'react'
import {
  X,
  Globe,
  Plus,
  Trash2,
  Loader2,
  ArrowRight,
  ShieldAlert,
  ChevronUp,
  Pencil
} from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Badge } from './ui/badge'
import { Switch } from './ui/switch'
import {
  useAccountZones,
  useRemoteHostnames,
  useAddRemoteHostname,
  useUpdateRemoteHostname,
  useRemoveRemoteHostname
} from '../lib/api'
import {
  normalizeServiceUrl,
  findZoneForHostname,
  subdomainFor,
  computeHostname,
  getRowKey
} from '../lib/remoteHostnames'
import type { Tunnel, RemoteHostname, Zone } from '@shared/schemas'

interface HostnameFormData {
  hostname: string
  service: string
  noTlsVerify: boolean
  zoneId?: string
}

interface HostnameFormProps {
  mode: 'add' | 'edit'
  zones: Zone[]
  isZonesLoading: boolean
  initialItem?: RemoteHostname
  isPending: boolean
  onSubmit: (data: HostnameFormData) => Promise<void>
  onCancel: () => void
}

function HostnameForm({
  mode,
  zones,
  isZonesLoading,
  initialItem,
  isPending,
  onSubmit,
  onCancel
}: HostnameFormProps): React.JSX.Element {
  const isEdit = mode === 'edit'
  // Fixed when the form opens. If zones arrived later, an empty subdomain would read as a rename to the apex.
  const [matchedZone] = useState(() =>
    initialItem ? findZoneForHostname(initialItem.hostname, zones) : undefined
  )
  const isUnknownZone = isEdit && !matchedZone

  const [selectedZoneId, setSelectedZoneId] = useState<string>(() => {
    if (isEdit && matchedZone) {
      return matchedZone.id
    }
    return zones.length > 0 ? zones[0].id : ''
  })

  const [subdomain, setSubdomain] = useState<string>(() => {
    if (isEdit && matchedZone && initialItem) {
      return subdomainFor(initialItem.hostname, matchedZone.name)
    }
    return ''
  })

  const [service, setService] = useState<string>(() => initialItem?.service ?? 'http://localhost:')
  const [noTlsVerify, setNoTlsVerify] = useState<boolean>(() => Boolean(initialItem?.noTlsVerify))

  const activeZoneId = selectedZoneId || (zones.length > 0 ? zones[0].id : '')
  const selectedZone = useMemo(() => {
    return zones.find((z) => z.id === activeZoneId)
  }, [zones, activeZoneId])

  const computedHostname = useMemo(() => {
    if (isUnknownZone && initialItem) {
      return initialItem.hostname
    }
    return computeHostname(subdomain, selectedZone?.name ?? '')
  }, [isUnknownZone, initialItem, subdomain, selectedZone])

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const targetService = normalizeServiceUrl(service)
    if (isEdit) {
      const finalHostname = isUnknownZone ? (initialItem?.hostname ?? '') : computedHostname
      const renaming = initialItem ? finalHostname !== initialItem.hostname : false
      await onSubmit({
        hostname: finalHostname,
        service: targetService,
        noTlsVerify,
        zoneId: renaming ? activeZoneId : undefined
      })
    } else {
      await onSubmit({
        hostname: computedHostname,
        service: targetService,
        noTlsVerify,
        zoneId: activeZoneId
      })
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-border bg-muted/60 p-4 space-y-4"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
          {isEdit ? 'Edit Public Hostname' : 'New Public Hostname'}
        </span>
        {computedHostname && (
          <Badge variant="secondary" className="font-mono text-xs">
            {computedHostname}
          </Badge>
        )}
      </div>

      {isUnknownZone ? (
        <div className="space-y-1.5">
          <Label htmlFor="hostname-readonly" className="text-xs text-foreground/80">
            Hostname
          </Label>
          <Input
            id="hostname-readonly"
            value={initialItem?.hostname ?? ''}
            readOnly
            disabled
            className="h-9 text-xs font-mono bg-muted/50 cursor-not-allowed"
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Zone Picker */}
          <div className="space-y-1.5">
            <Label htmlFor="zone-select" className="text-xs text-foreground/80">
              DNS Zone (Domain)
            </Label>
            {isZonesLoading ? (
              <div className="flex h-9 items-center rounded-md border border-border bg-muted px-3 text-xs text-muted-foreground">
                Loading zones...
              </div>
            ) : zones.length === 0 ? (
              <div className="text-xs text-amber-600 dark:text-amber-400">
                No DNS zones found on your account.
              </div>
            ) : (
              <select
                id="zone-select"
                value={activeZoneId}
                onChange={(e) => setSelectedZoneId(e.target.value)}
                className="w-full rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name} ({z.status})
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Subdomain Input */}
          <div className="space-y-1.5">
            <Label htmlFor="subdomain" className="text-xs text-foreground/80">
              Subdomain <span className="text-muted-foreground">(leave blank or @ for apex)</span>
            </Label>
            <Input
              id="subdomain"
              placeholder="e.g. app, api, dev"
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value)}
              className="h-9 text-xs"
            />
          </div>
        </div>
      )}

      {/* Path Input (Read-only if present) */}
      {initialItem?.path && (
        <div className="space-y-1.5">
          <Label htmlFor="path-readonly" className="text-xs text-foreground/80">
            Path
          </Label>
          <Input
            id="path-readonly"
            value={initialItem.path}
            readOnly
            disabled
            className="h-9 text-xs font-mono bg-muted/50 cursor-not-allowed"
          />
        </div>
      )}

      {/* Service URL Input */}
      <div className="space-y-1.5">
        <Label htmlFor="service-url" className="text-xs text-foreground/80">
          Target Service URL
        </Label>
        <Input
          id="service-url"
          placeholder="e.g. http://localhost:3000, 8080"
          value={service}
          onChange={(e) => setService(e.target.value)}
          className="h-9 text-xs font-mono"
        />
      </div>

      {/* Options */}
      <div className="flex items-center justify-between rounded border border-border bg-card/50 p-2.5">
        <div className="space-y-0.5">
          <Label htmlFor="no-tls" className="text-xs font-medium text-foreground/80 cursor-pointer">
            No TLS Verify
          </Label>
          <p className="text-[11px] text-muted-foreground">
            Disables TLS certificate verification on HTTPS origin services.
          </p>
        </div>
        <Switch id="no-tls" checked={noTlsVerify} onCheckedChange={setNoTlsVerify} />
      </div>

      {/* Submit Buttons */}
      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={onCancel}
          className="text-xs"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={
            isPending ||
            (isUnknownZone
              ? !service.trim()
              : !computedHostname || !activeZoneId || !service.trim())
          }
          className="gap-1.5 text-xs"
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : isEdit ? null : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {isEdit ? 'Save Changes' : 'Save & Route Hostname'}
        </Button>
      </div>
    </form>
  )
}

interface RemoteHostnamesDialogProps {
  tunnel: Tunnel
  onClose: () => void
}

export function RemoteHostnamesDialog({
  tunnel,
  onClose
}: RemoteHostnamesDialogProps): React.JSX.Element {
  // the remote.* commands look the tunnel up in the app registry, so they take the app id,
  // not Cloudflare's tunnel id (that one is only shown below)
  const tunnelId = tunnel.id

  const { data: hostnames = [], isLoading: isHostnamesLoading } = useRemoteHostnames(tunnelId)
  const { data: zones = [], isLoading: isZonesLoading } = useAccountZones()
  const addMutation = useAddRemoteHostname()
  const updateMutation = useUpdateRemoteHostname()
  const removeMutation = useRemoveRemoteHostname()

  const [isAddOpen, setIsAddOpen] = useState(false)
  const [editingRowKey, setEditingRowKey] = useState<string | null>(null)
  const [deletingHostname, setDeletingHostname] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const isAnyMutationPending =
    addMutation.isPending || updateMutation.isPending || removeMutation.isPending

  const handleAddHostname = async (data: HostnameFormData): Promise<void> => {
    setErrorMsg(null)

    if (!data.zoneId) {
      setErrorMsg('Please select a DNS zone.')
      return
    }

    if (!data.hostname) {
      setErrorMsg('Please enter a valid hostname.')
      return
    }

    try {
      await addMutation.mutateAsync({
        tunnelId,
        zoneId: data.zoneId,
        hostname: data.hostname,
        service: data.service,
        noTlsVerify: data.noTlsVerify || undefined
      })
      setIsAddOpen(false)
    } catch (err) {
      setErrorMsg((err as Error).message || 'Failed to add hostname.')
    }
  }

  const handleUpdateHostname = async (
    item: RemoteHostname,
    data: HostnameFormData
  ): Promise<void> => {
    setErrorMsg(null)

    const renaming = data.hostname !== item.hostname
    if (renaming && !data.zoneId) {
      setErrorMsg('Please select a DNS zone.')
      return
    }

    if (!data.hostname) {
      setErrorMsg('Please enter a valid hostname.')
      return
    }

    try {
      await updateMutation.mutateAsync({
        tunnelId,
        hostname: item.hostname,
        path: item.path,
        newHostname: data.hostname,
        zoneId: renaming ? data.zoneId : undefined,
        service: data.service,
        noTlsVerify: data.noTlsVerify
      })
      setEditingRowKey(null)
    } catch (err) {
      setErrorMsg((err as Error).message || 'Failed to update hostname.')
    }
  }

  const handleDeleteHostname = async (hostname: string): Promise<void> => {
    setErrorMsg(null)
    setDeletingHostname(hostname)
    try {
      // Find matching zone if possible
      const matchingZone = zones.find((z) => hostname.endsWith(z.name))
      await removeMutation.mutateAsync({
        tunnelId,
        hostname,
        zoneId: matchingZone?.id
      })
    } catch (err) {
      setErrorMsg((err as Error).message || 'Failed to remove hostname.')
    } finally {
      setDeletingHostname(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <div className="flex w-full max-w-2xl max-h-[90vh] flex-col rounded-xl border border-border bg-card p-6 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-border shrink-0">
          <div className="space-y-1 min-w-0 pr-4">
            <div className="flex items-center gap-2 flex-wrap">
              <Globe className="h-5 w-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
              <h2 className="text-lg font-semibold text-foreground truncate">
                Public Hostnames &amp; Routing
              </h2>
              <Badge variant="outline" className="text-xs font-mono">
                {tunnel.name}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Cloudflare Tunnel ID:</span>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
                {tunnel.cfTunnelId ?? 'N/A'}
              </code>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close dialog">
            <X className="h-5 w-5 text-muted-foreground hover:text-foreground" />
          </Button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto py-4 space-y-4">
          {errorMsg && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Hostnames List Header & Add Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-foreground">
                Active Routes ({hostnames.length})
              </h3>
              <p className="text-xs text-muted-foreground">
                Incoming traffic is proxied through Cloudflare to your services.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setErrorMsg(null)
                setEditingRowKey(null)
                setIsAddOpen((prev) => !prev)
              }}
              className="gap-1.5 text-xs"
            >
              {isAddOpen ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5" />
                  Hide Form
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" />
                  Add Hostname
                </>
              )}
            </Button>
          </div>

          {/* Add Hostname Collapsible Section */}
          {isAddOpen && (
            <HostnameForm
              mode="add"
              zones={zones}
              isZonesLoading={isZonesLoading}
              isPending={addMutation.isPending}
              onSubmit={handleAddHostname}
              onCancel={() => setIsAddOpen(false)}
            />
          )}

          {/* List of Hostnames */}
          {isHostnamesLoading ? (
            <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading hostnames...
            </div>
          ) : hostnames.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border p-8 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted mb-3 text-muted-foreground">
                <Globe className="h-5 w-5" />
              </div>
              <h4 className="text-sm font-medium text-foreground">No hostnames configured</h4>
              <p className="text-xs text-muted-foreground max-w-sm mt-1">
                No public hostnames are currently routing to this tunnel. Click{' '}
                <strong>Add Hostname</strong> above to expose a local service on your Cloudflare
                domain.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {hostnames.map((item) => {
                const rowKey = getRowKey(item)
                if (editingRowKey === rowKey) {
                  return (
                    <HostnameForm
                      key={rowKey}
                      mode="edit"
                      zones={zones}
                      isZonesLoading={isZonesLoading}
                      initialItem={item}
                      isPending={updateMutation.isPending}
                      onSubmit={(data) => handleUpdateHostname(item, data)}
                      onCancel={() => setEditingRowKey(null)}
                    />
                  )
                }

                const isDeleting = deletingHostname === item.hostname
                return (
                  <div
                    key={rowKey}
                    className="flex items-center justify-between rounded-lg border border-border bg-muted/40 p-3 transition-colors hover:border-foreground/30"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex flex-col min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs font-semibold text-foreground truncate">
                            {item.hostname}
                          </span>
                          {item.noTlsVerify && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] px-1.5 py-0 bg-accent text-muted-foreground"
                            >
                              No TLS Verify
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono mt-0.5 truncate">
                          <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="truncate">{item.service}</span>
                          {item.path && (
                            <span className="text-muted-foreground">({item.path})</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isZonesLoading || isAnyMutationPending}
                        onClick={() => {
                          setIsAddOpen(false)
                          setErrorMsg(null)
                          setEditingRowKey(rowKey)
                        }}
                        className="h-8 px-2 text-muted-foreground hover:text-foreground shrink-0"
                        aria-label={`Edit hostname ${item.hostname}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isDeleting || isAnyMutationPending}
                        onClick={() => handleDeleteHostname(item.hostname)}
                        className="h-8 px-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
                        aria-label={`Delete hostname ${item.hostname}`}
                      >
                        {isDeleting ? (
                          <Loader2 className="h-4 w-4 animate-spin text-destructive" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end pt-3 border-t border-border shrink-0">
          <Button variant="outline" size="sm" onClick={onClose} className="text-xs">
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}
