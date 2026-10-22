import type { DownloadProgressPayload } from '@shared/schemas'

interface DownloadProgressProps {
  progress: DownloadProgressPayload
}

export function DownloadProgress({ progress }: DownloadProgressProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <div className="flex justify-between text-muted-foreground text-[11px]">
        <span>Downloading cloudflared-windows-amd64.exe...</span>
        <span>{progress.percent}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full bg-blue-600 transition-all duration-200"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
    </div>
  )
}
