import React, { useState } from 'react'
import { Zap, Copy, ExternalLink, Square, FileText, Loader2, Check, Radio } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import {
  useTunnels,
  useRecentQuickTargets,
  useStartQuickTunnel,
  useStopQuickTunnel,
  useTunnelStatuses
} from '@renderer/lib/api'
import { PageContainer } from '@renderer/components/PageContainer'
import { LogsDialog } from '@renderer/components/LogsDialog'
import type { Tunnel, TunnelStatus } from '@shared/schemas'

export function QuickSharePage(): React.JSX.Element {
  const { data: tunnels = [] } = useTunnels()
  const { data: recentTargets = [] } = useRecentQuickTargets()
  const statuses = useTunnelStatuses()
  const startQuickMutation = useStartQuickTunnel()
  const stopQuickMutation = useStopQuickTunnel()

  const [targetInput, setTargetInput] = useState('')
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [selectedLogsTunnel, setSelectedLogsTunnel] = useState<{ id: string; name: string } | null>(
    null
  )

  const quickTunnels = tunnels.filter((t) => t.kind === 'quick')
  const activeTunnel: Tunnel | undefined = quickTunnels[0]
  const activeStatus: TunnelStatus | undefined = activeTunnel
    ? (statuses[activeTunnel.id] ?? { state: 'starting' })
    : undefined

  const handleStart = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!targetInput.trim()) return
    try {
      await startQuickMutation.mutateAsync({ target: targetInput.trim() })
      setTargetInput('')
    } catch {
      // Error handled by mutation state
    }
  }

  const handleStop = async (id: string): Promise<void> => {
    try {
      await stopQuickMutation.mutateAsync({ id })
    } catch {
      // Error handled by mutation state
    }
  }

  const handleCopy = async (url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedUrl(url)
      setTimeout(() => setCopiedUrl(null), 2000)
    } catch {
      // Ignore copy error
    }
  }

  const handleOpen = (url: string): void => {
    window.open(url, '_blank')
  }

  return (
    <PageContainer className="max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Quick share</h1>
        <p className="text-sm text-muted-foreground">
          Instantly expose a local HTTP service or port to the internet via TryCloudflare without
          any credentials.
        </p>
      </div>

      {activeTunnel ? (
        <Card className="border-primary/40 bg-neutral-950/50 shadow-md">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="relative flex h-3 w-3">
                  {activeStatus?.state === 'connected' ? (
                    <>
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                    </>
                  ) : activeStatus?.state === 'starting' ? (
                    <>
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
                    </>
                  ) : (
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-neutral-500"></span>
                  )}
                </span>
                <CardTitle className="text-base font-semibold">Active Quick Tunnel</CardTitle>
              </div>

              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    activeStatus?.state === 'connected'
                      ? 'default'
                      : activeStatus?.state === 'starting'
                        ? 'secondary'
                        : 'outline'
                  }
                  className="capitalize text-xs font-medium"
                >
                  {activeStatus?.state ?? 'Starting'}
                </Badge>
              </div>
            </div>
            <CardDescription className="text-xs text-neutral-400 mt-1">
              Forwarding traffic to:{' '}
              <span className="font-mono text-neutral-200">{activeTunnel.quick?.target}</span>
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
              <div className="text-xs text-neutral-400 mb-1">Public URL:</div>
              {activeStatus?.state === 'connected' && activeStatus.quickUrl ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <a
                    href={activeStatus.quickUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-sm font-medium text-emerald-400 hover:underline break-all"
                  >
                    {activeStatus.quickUrl}
                  </a>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCopy(activeStatus.quickUrl!)}
                      className="h-8 gap-1 text-xs"
                    >
                      {copiedUrl === activeStatus.quickUrl ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          Copy
                        </>
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleOpen(activeStatus.quickUrl!)}
                      className="h-8 gap-1 text-xs"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-neutral-400 py-1">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span>Obtaining public URL from Cloudflare...</span>
                </div>
              )}
            </div>

            {activeStatus?.state === 'connected' && (
              <div className="flex items-center gap-2 text-xs text-neutral-400">
                <Radio className="h-3.5 w-3.5 text-emerald-400" />
                <span>
                  Active edge connections:{' '}
                  <strong className="text-neutral-200">{activeStatus.connections}</strong>
                </span>
              </div>
            )}
          </CardContent>

          <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-800/80 pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setSelectedLogsTunnel({ id: activeTunnel.id, name: activeTunnel.name })
              }
              className="h-8 gap-1.5 text-xs text-neutral-300"
            >
              <FileText className="h-3.5 w-3.5" />
              View Logs
            </Button>

            <Button
              variant="destructive"
              size="sm"
              disabled={stopQuickMutation.isPending}
              onClick={() => handleStop(activeTunnel.id)}
              className="h-8 gap-1.5 text-xs"
            >
              {stopQuickMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              Stop Tunnel
            </Button>
          </CardFooter>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              <CardTitle className="text-lg">Share a Local Service</CardTitle>
            </div>
            <CardDescription>
              Enter a local port (e.g. <span className="font-mono text-neutral-300">3000</span>) or
              complete URL (e.g.{' '}
              <span className="font-mono text-neutral-300">http://localhost:5173</span>).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleStart} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  placeholder="Port or URL (e.g. 3000)"
                  value={targetInput}
                  onChange={(e) => setTargetInput(e.target.value)}
                  disabled={startQuickMutation.isPending}
                  className="font-mono"
                  autoFocus
                />
                <Button
                  type="submit"
                  disabled={!targetInput.trim() || startQuickMutation.isPending}
                  className="shrink-0"
                >
                  {startQuickMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Starting...
                    </>
                  ) : (
                    'Start Tunnel'
                  )}
                </Button>
              </div>

              {recentTargets.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-xs text-muted-foreground">Recent targets:</span>
                  {recentTargets.map((target) => (
                    <button
                      key={target}
                      type="button"
                      onClick={() => setTargetInput(target)}
                      className="cursor-pointer rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-1 font-mono text-xs text-neutral-300 hover:bg-neutral-800 transition-colors"
                    >
                      {target}
                    </button>
                  ))}
                </div>
              )}

              {startQuickMutation.isError && (
                <p className="text-xs font-medium text-destructive">
                  {startQuickMutation.error.message || 'Failed to start quick tunnel.'}
                </p>
              )}
            </form>
          </CardContent>
        </Card>
      )}

      {selectedLogsTunnel && (
        <LogsDialog
          tunnelId={selectedLogsTunnel.id}
          tunnelName={selectedLogsTunnel.name}
          onClose={() => setSelectedLogsTunnel(null)}
        />
      )}
    </PageContainer>
  )
}
