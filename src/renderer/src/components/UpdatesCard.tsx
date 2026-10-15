import React from 'react'
import { ExternalLink, Loader2, RefreshCw, RotateCw } from 'lucide-react'
import {
  useCheckForUpdate,
  useInstallUpdate,
  useSetSettings,
  useSettings,
  useUpdateState
} from '@renderer/lib/api'
import { describeUpdate } from '@renderer/lib/updateText'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@renderer/components/ui/card'

const RELEASES_URL = 'https://github.com/matheeshapathirana/cloudflared-tunnel-gui/releases'

export function UpdatesCard(): React.JSX.Element {
  const update = useUpdateState()
  const { data: settings, isLoading: isSettingsLoading } = useSettings()
  const setSettings = useSetSettings()
  const checkForUpdate = useCheckForUpdate()
  const installUpdate = useInstallUpdate()

  const status = update?.status
  const isBusy = status?.state === 'checking' || status?.state === 'downloading'
  const isChecking = status?.state === 'checking' || checkForUpdate.isPending
  const version = update?.currentVersion ?? settings?.appVersion ?? '1.0.0'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">About &amp; Updates</CardTitle>
        <CardDescription className="text-xs">
          Application version, updates and information.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Version</span>
            <span className="font-mono font-medium">{version}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Environment</span>
            <span className="font-medium">Desktop (Electron)</span>
          </div>
          <div className="flex items-start justify-between gap-4 text-xs">
            <span className="shrink-0 text-muted-foreground">Status</span>
            <span
              className={
                status?.state === 'error'
                  ? 'min-w-0 break-words text-right text-destructive font-medium'
                  : 'min-w-0 break-words text-right font-medium'
              }
              role="status"
            >
              {update ? describeUpdate(update) : 'Loading…'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => checkForUpdate.mutate()}
            disabled={isBusy || checkForUpdate.isPending}
            className="text-xs gap-1.5"
          >
            {isChecking ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Check for updates
          </Button>
          {status?.state === 'ready' && (
            <Button
              size="sm"
              onClick={() => installUpdate.mutate()}
              disabled={installUpdate.isPending}
              className="text-xs gap-1.5"
            >
              {installUpdate.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCw className="size-3.5" />
              )}
              Restart to update
            </Button>
          )}
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className="ml-auto flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300 transition-colors"
          >
            <span>What&apos;s new</span>
            <ExternalLink className="size-3" />
          </a>
        </div>

        {(installUpdate.isError || checkForUpdate.isError) && (
          <p className="text-xs text-destructive font-medium" role="alert">
            {installUpdate.error?.message ?? checkForUpdate.error?.message}
          </p>
        )}

        <div className="flex items-center justify-between pt-3 border-t">
          <div className="space-y-0.5">
            <Label htmlFor="auto-check-updates" className="text-sm">
              Check automatically
            </Label>
            <p className="text-xs text-muted-foreground">
              Look for new versions in the background and download them for you.
            </p>
          </div>
          <Switch
            id="auto-check-updates"
            checked={settings?.updates.autoCheck ?? true}
            disabled={isSettingsLoading || setSettings.isPending}
            onCheckedChange={(checked) => {
              setSettings.mutate({ updates: { autoCheck: checked } })
            }}
          />
        </div>
      </CardContent>
    </Card>
  )
}
