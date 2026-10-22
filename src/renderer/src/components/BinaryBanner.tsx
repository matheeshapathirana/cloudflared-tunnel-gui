import { useState } from 'react'
import { AlertTriangle, Download, Loader2 } from 'lucide-react'
import { useBinaryDownload, useBinaryDownloadProgress, useBinaryStatus } from '@renderer/lib/api'
import { needsChecksumConfirmation } from '@renderer/lib/binaryInstall'
import { Button } from './ui/button'
import { DownloadProgress } from './DownloadProgress'

interface BinaryBannerProps {
  onGoToSettings: () => void
}

export function BinaryBanner({ onGoToSettings }: BinaryBannerProps): React.JSX.Element | null {
  const { data: status } = useBinaryStatus()
  const install = useBinaryDownload()
  const progress = useBinaryDownloadProgress()
  const [needsConfirm, setNeedsConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!status || status.found) {
    return null
  }

  const runInstall = async (confirmWithoutChecksum: boolean): Promise<void> => {
    setError(null)
    setNeedsConfirm(false)
    try {
      await install.mutateAsync({ confirmWithoutChecksum })
    } catch (err) {
      if (needsChecksumConfirmation(err)) {
        setNeedsConfirm(true)
      } else {
        setError((err as Error).message || 'Failed to install cloudflared.')
      }
    }
  }

  return (
    <div
      role="alert"
      className="w-full bg-amber-500/15 border-b border-amber-500/30 text-amber-900 dark:text-amber-200 px-4 py-2.5 flex flex-col gap-2 text-sm transition-all"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <AlertTriangle className="size-4.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="font-medium truncate">
            {needsConfirm
              ? 'This release has no published SHA-256 checksum. Install it anyway?'
              : 'cloudflared is not installed.'}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={onGoToSettings}
            disabled={install.isPending}
            className="h-7 text-xs border-amber-500/40 hover:bg-amber-500/20 text-amber-950 dark:text-amber-100"
          >
            Set path manually
          </Button>
          <Button
            size="sm"
            onClick={() => void runInstall(needsConfirm)}
            disabled={install.isPending}
            className="h-7 text-xs gap-1.5"
          >
            {install.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            {needsConfirm ? 'Install anyway' : 'Install cloudflared'}
          </Button>
        </div>
      </div>

      {progress && install.isPending && <DownloadProgress progress={progress} />}
      {error && <span className="text-destructive font-medium text-xs">{error}</span>}
    </div>
  )
}
