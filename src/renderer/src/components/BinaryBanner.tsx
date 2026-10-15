import { AlertTriangle, ArrowRight } from 'lucide-react'
import { useBinaryStatus } from '@renderer/lib/api'
import { Button } from './ui/button'

interface BinaryBannerProps {
  onGoToSettings: () => void
}

export function BinaryBanner({ onGoToSettings }: BinaryBannerProps): React.JSX.Element | null {
  const { data: status } = useBinaryStatus()

  if (!status || status.found) {
    return null
  }

  return (
    <div
      role="alert"
      className="w-full bg-amber-500/15 border-b border-amber-500/30 text-amber-900 dark:text-amber-200 px-4 py-2.5 flex items-center justify-between gap-3 text-sm transition-all"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <AlertTriangle className="size-4.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="font-medium truncate">
          cloudflared not found. Set its path in Settings
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onGoToSettings}
        className="shrink-0 h-7 text-xs border-amber-500/40 hover:bg-amber-500/20 text-amber-950 dark:text-amber-100"
      >
        <span>Go to Settings</span>
        <ArrowRight className="size-3.5 ml-1" />
      </Button>
    </div>
  )
}
