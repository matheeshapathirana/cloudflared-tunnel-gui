import React, { useState } from 'react'
import { X, ShieldAlert, LogIn, Plus, Loader2, Cloud, HardDrive, ArrowRight } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import {
  useCheckCert,
  useLogin,
  useCreateLocalTunnel,
  useCreateRemoteTunnel,
  useAccountStatus
} from '../lib/api'

interface CreateTunnelDialogProps {
  onClose: () => void
  onCreated?: () => void
  onNavigateToSettings?: () => void
}

type TunnelKindSelection = 'remote' | 'local'

export function CreateTunnelDialog({
  onClose,
  onCreated,
  onNavigateToSettings
}: CreateTunnelDialogProps): React.JSX.Element {
  const [kind, setKind] = useState<TunnelKindSelection>('remote')
  const [name, setName] = useState('')

  const { data: accountStatus, isLoading: isAccountLoading } = useAccountStatus()
  const { data: certInfo, isLoading: isCertLoading } = useCheckCert()

  const loginMutation = useLogin()
  const createLocalMutation = useCreateLocalTunnel()
  const createRemoteMutation = useCreateRemoteTunnel()

  const isCreating = createLocalMutation.isPending || createRemoteMutation.isPending
  const isConnected = Boolean(accountStatus?.connected)

  const handleLogin = async (): Promise<void> => {
    try {
      await loginMutation.mutateAsync()
    } catch {
      // Handled by mutation error
    }
  }

  const handleCreate = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return

    try {
      if (kind === 'remote') {
        await createRemoteMutation.mutateAsync({ name: trimmed })
      } else {
        await createLocalMutation.mutateAsync({ name: trimmed })
      }
      if (onCreated) onCreated()
      onClose()
    } catch {
      // Handled by mutation error state
    }
  }

  const canSubmit = (): boolean => {
    if (!name.trim() || isCreating) return false
    if (kind === 'remote') {
      return !isAccountLoading && isConnected
    }
    return !isCertLoading && Boolean(certInfo?.hasCert)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <div className="flex w-full max-w-md flex-col rounded-xl border border-border bg-card p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Create New Tunnel</h2>
            <p className="text-xs text-muted-foreground">
              Configure a new persistent tunnel routed to Cloudflare.
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close dialog">
            <X className="h-5 w-5 text-muted-foreground hover:text-foreground" />
          </Button>
        </div>

        {/* Content */}
        <form onSubmit={handleCreate} className="space-y-4 pt-4">
          {/* Tunnel Type Selection */}
          <div className="space-y-2">
            <Label className="text-xs font-medium text-foreground/80">Tunnel Type</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setKind('remote')}
                className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                  kind === 'remote'
                    ? 'border-indigo-500 bg-indigo-500/10 text-foreground'
                    : 'border-border bg-muted/40 text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                }`}
              >
                <div className="flex items-center gap-1.5 font-medium text-xs">
                  <Cloud className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                  <span>Remote</span>
                </div>
                <span className="text-[11px] leading-tight text-muted-foreground">
                  Cloudflare API-managed. Zero local configuration files.
                </span>
              </button>

              <button
                type="button"
                onClick={() => setKind('local')}
                className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                  kind === 'local'
                    ? 'border-indigo-500 bg-indigo-500/10 text-foreground'
                    : 'border-border bg-muted/40 text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                }`}
              >
                <div className="flex items-center gap-1.5 font-medium text-xs">
                  <HardDrive className="h-3.5 w-3.5 text-foreground/80" />
                  <span>Local</span>
                </div>
                <span className="text-[11px] leading-tight text-muted-foreground">
                  YAML config-file managed in ~/.cloudflared.
                </span>
              </button>
            </div>
          </div>

          {/* Tunnel Name Input */}
          <div className="space-y-2">
            <Label htmlFor="tunnel-name" className="text-xs font-medium text-foreground/80">
              Tunnel Name
            </Label>
            <Input
              id="tunnel-name"
              placeholder={kind === 'remote' ? 'e.g. production-api' : 'e.g. dev-api, web-app'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isCreating}
              autoFocus
            />
          </div>

          {/* Warning Banner: Remote not connected */}
          {kind === 'remote' && !isAccountLoading && !isConnected && (
            <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 space-y-2">
              <div className="flex items-start gap-2 text-amber-600 dark:text-amber-400 text-xs">
                <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  Connect your Cloudflare account in Settings before creating remote tunnels.
                </span>
              </div>
              {onNavigateToSettings && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onClose()
                    onNavigateToSettings()
                  }}
                  className="w-full gap-1.5 text-xs border-amber-500/35 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
                >
                  <span>Go to Settings</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}

          {/* Warning Banner: Local cert missing */}
          {kind === 'local' && !isCertLoading && !certInfo?.hasCert && (
            <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 space-y-2">
              <div className="flex items-start gap-2 text-amber-600 dark:text-amber-400 text-xs">
                <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  No Cloudflare origin certificate (
                  <code className="font-mono text-amber-700 dark:text-amber-300">cert.pem</code>)
                  found in{' '}
                  <code className="font-mono text-amber-700 dark:text-amber-300">
                    ~/.cloudflared
                  </code>
                  .
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleLogin}
                disabled={loginMutation.isPending}
                className="w-full gap-1.5 text-xs border-amber-500/35 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
              >
                {loginMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LogIn className="h-3.5 w-3.5" />
                )}
                Log in with Cloudflare (Opens Browser)
              </Button>
            </div>
          )}

          {/* Error Display */}
          {(createLocalMutation.isError || createRemoteMutation.isError) && (
            <p className="text-xs text-destructive font-medium">
              {createLocalMutation.error?.message ||
                createRemoteMutation.error?.message ||
                'Failed to create tunnel.'}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit()} className="gap-1.5">
              {isCreating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Create Tunnel
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
