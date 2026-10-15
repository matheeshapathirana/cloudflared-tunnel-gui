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
      <div className="flex w-full max-w-md flex-col rounded-xl border border-neutral-800 bg-neutral-950 p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-neutral-800">
          <div>
            <h2 className="text-lg font-semibold text-neutral-100">Create New Tunnel</h2>
            <p className="text-xs text-neutral-400">
              Configure a new persistent tunnel routed to Cloudflare.
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close dialog">
            <X className="h-5 w-5 text-neutral-400 hover:text-neutral-200" />
          </Button>
        </div>

        {/* Content */}
        <form onSubmit={handleCreate} className="space-y-4 pt-4">
          {/* Tunnel Type Selection */}
          <div className="space-y-2">
            <Label className="text-xs font-medium text-neutral-300">Tunnel Type</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setKind('remote')}
                className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                  kind === 'remote'
                    ? 'border-indigo-500 bg-indigo-950/20 text-neutral-100'
                    : 'border-neutral-800 bg-neutral-900/40 text-neutral-400 hover:border-neutral-700 hover:text-neutral-300'
                }`}
              >
                <div className="flex items-center gap-1.5 font-medium text-xs">
                  <Cloud className="h-3.5 w-3.5 text-indigo-400" />
                  <span>Remote</span>
                </div>
                <span className="text-[11px] leading-tight text-neutral-400">
                  Cloudflare API-managed. Zero local configuration files.
                </span>
              </button>

              <button
                type="button"
                onClick={() => setKind('local')}
                className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                  kind === 'local'
                    ? 'border-indigo-500 bg-indigo-950/20 text-neutral-100'
                    : 'border-neutral-800 bg-neutral-900/40 text-neutral-400 hover:border-neutral-700 hover:text-neutral-300'
                }`}
              >
                <div className="flex items-center gap-1.5 font-medium text-xs">
                  <HardDrive className="h-3.5 w-3.5 text-neutral-300" />
                  <span>Local</span>
                </div>
                <span className="text-[11px] leading-tight text-neutral-400">
                  YAML config-file managed in ~/.cloudflared.
                </span>
              </button>
            </div>
          </div>

          {/* Tunnel Name Input */}
          <div className="space-y-2">
            <Label htmlFor="tunnel-name" className="text-xs font-medium text-neutral-300">
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
            <div className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-3 space-y-2">
              <div className="flex items-start gap-2 text-amber-400 text-xs">
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
                  className="w-full gap-1.5 text-xs border-amber-800/80 text-amber-300 hover:bg-amber-950/40"
                >
                  <span>Go to Settings</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}

          {/* Warning Banner: Local cert missing */}
          {kind === 'local' && !isCertLoading && !certInfo?.hasCert && (
            <div className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-3 space-y-2">
              <div className="flex items-start gap-2 text-amber-400 text-xs">
                <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  No Cloudflare origin certificate (
                  <code className="font-mono text-amber-300">cert.pem</code>) found in{' '}
                  <code className="font-mono text-amber-300">~/.cloudflared</code>.
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleLogin}
                disabled={loginMutation.isPending}
                className="w-full gap-1.5 text-xs border-amber-800/80 text-amber-300 hover:bg-amber-950/40"
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
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-800">
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
