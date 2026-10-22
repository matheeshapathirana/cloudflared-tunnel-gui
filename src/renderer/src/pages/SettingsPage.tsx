import React, { useState } from 'react'
import {
  RotateCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FolderSearch,
  HardDrive,
  Cloud,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  ShieldAlert,
  X,
  Key,
  LogOut,
  Server,
  Play,
  Square,
  RefreshCw,
  Download,
  Sparkles
} from 'lucide-react'
import {
  useBinaryStatus,
  useSettings,
  useSetOverride,
  useSetSettings,
  useBinaryCheckUpdate,
  useBinaryDownload,
  useBinaryDownloadProgress,
  useAccountStatus,
  useSetAccountToken,
  useClearAccountToken,
  useAccountZones,
  useTokenCreationUrl,
  useServices,
  useStartService,
  useStopService,
  useRestartService,
  useAdoptService,
  queryClient
} from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@renderer/components/ui/card'
import { PageContainer } from '@renderer/components/PageContainer'
import { Badge } from '@renderer/components/ui/badge'
import { ThemeSwitcher } from '@renderer/components/ThemeSwitcher'
import { UpdatesCard } from '@renderer/components/UpdatesCard'
import { DownloadProgress } from '@renderer/components/DownloadProgress'
import type { Account } from '@shared/schemas'

function formatSource(source: string): string {
  switch (source) {
    case 'override':
      return 'User Override'
    case 'managed':
      return 'App-Managed'
    case 'path':
      return 'System PATH'
    case 'programFiles':
      return 'Program Files'
    default:
      return source
  }
}

export function SettingsPage(): React.JSX.Element {
  const { data: binaryStatus, isLoading: isBinaryLoading } = useBinaryStatus()
  const { data: settings, isLoading: isSettingsLoading } = useSettings()
  const setOverride = useSetOverride()
  const setSettings = useSetSettings()

  // Phase 4 Account hooks
  const { data: accountStatus, isLoading: isAccountLoading } = useAccountStatus()
  const { data: zones = [], isLoading: isZonesLoading } = useAccountZones()
  const { data: tokenCreationUrlData } = useTokenCreationUrl()
  const setAccountToken = useSetAccountToken()
  const clearAccountToken = useClearAccountToken()

  // Phase 5 Services hooks
  const { data: services = [], isLoading: isServicesLoading } = useServices()
  const startService = useStartService()
  const stopService = useStopService()
  const restartService = useRestartService()
  const adoptService = useAdoptService()

  // Phase 6 Binary update & download hooks
  const {
    data: updateData,
    isFetching: isCheckingUpdate,
    refetch: checkUpdate,
    error: updateCheckError
  } = useBinaryCheckUpdate()
  const downloadBinary = useBinaryDownload()
  const downloadProgress = useBinaryDownloadProgress()
  const [confirmWithoutChecksum, setConfirmWithoutChecksum] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  // The update query is disabled (manual only), so the post-download invalidation never refetches it
  // and `updateData` would keep offering the version that was just installed.
  const [installedVersion, setInstalledVersion] = useState<string | null>(null)

  const handleDownloadUpdate = async (): Promise<void> => {
    setDownloadError(null)
    const targetVersion = updateData?.version ?? null
    try {
      await downloadBinary.mutateAsync({ confirmWithoutChecksum })
      setInstalledVersion(targetVersion)
    } catch (err) {
      setDownloadError((err as Error).message || 'Failed to download binary.')
    }
  }

  const handleCheckUpdate = (): void => {
    setInstalledVersion(null)
    void checkUpdate()
  }

  // Account modal states
  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [availableAccounts, setAvailableAccounts] = useState<Account[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [connectError, setConnectError] = useState<string | null>(null)
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false)

  // Binary override states
  const [userOverridePath, setUserOverridePath] = useState<string | null>(null)
  const overridePath = userOverridePath ?? settings?.binary.overridePath ?? ''

  const handleSaveOverride = (): void => {
    const trimmed = overridePath.trim()
    setOverride.mutate({ path: trimmed || null })
  }

  const handleClearOverride = (): void => {
    setUserOverridePath('')
    setOverride.mutate({ path: null })
  }

  const handleRecheck = (): void => {
    queryClient.invalidateQueries({ queryKey: ['binary', 'status'] })
  }

  const handleOpenConnectModal = (): void => {
    setTokenInput('')
    setShowToken(false)
    setAvailableAccounts([])
    setSelectedAccountId('')
    setConnectError(null)
    setIsConnectModalOpen(true)
  }

  const handleVerifyAndConnect = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setConnectError(null)

    const trimmed = tokenInput.trim()
    if (!trimmed) {
      setConnectError('Please enter an API Token.')
      return
    }

    try {
      const res = await setAccountToken.mutateAsync({
        token: trimmed,
        accountId: selectedAccountId || undefined
      })

      // If multiple accounts found and user hasn't explicitly chosen one yet
      if (res.accounts && res.accounts.length > 1 && !selectedAccountId) {
        setAvailableAccounts(res.accounts)
        setSelectedAccountId(res.accounts[0].id)
        return
      }

      // Successful connection
      setIsConnectModalOpen(false)
    } catch (err) {
      setConnectError((err as Error).message || 'Failed to verify API Token.')
    }
  }

  const handleDisconnect = async (): Promise<void> => {
    try {
      await clearAccountToken.mutateAsync()
      setShowDisconnectConfirm(false)
    } catch {
      // Handled by react-query
    }
  }

  const isConnected = Boolean(accountStatus?.connected)

  return (
    <PageContainer className="max-w-4xl 2xl:max-w-[1400px] 2xl:grid 2xl:grid-cols-2 2xl:items-start">
      <div className="2xl:col-span-2">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure application preferences, Cloudflare authentication, and binary location.
        </p>
      </div>

      {/* Cloudflare Account Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cloud className="size-5 text-indigo-600 dark:text-indigo-400" />
              <div>
                <CardTitle className="text-base">Cloudflare Account</CardTitle>
                <CardDescription className="text-xs">
                  Centralized account authentication for Cloudflare API-managed tunnels and DNS
                  routing.
                </CardDescription>
              </div>
            </div>

            {isConnected ? (
              <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 gap-1 text-xs">
                <CheckCircle2 className="size-3" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1 text-xs">
                <XCircle className="size-3" />
                Not Connected
              </Badge>
            )}
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div className="rounded-lg border bg-muted/30 p-4 flex flex-col gap-3 text-sm">
            {isAccountLoading ? (
              <span className="text-muted-foreground text-xs">Checking Cloudflare account...</span>
            ) : isConnected ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs font-medium">Account Name</span>
                  <span className="text-xs font-semibold text-foreground">
                    {accountStatus?.accountName || 'Unknown'}
                  </span>
                </div>

                <div className="flex items-start justify-between gap-4">
                  <span className="text-muted-foreground text-xs font-medium shrink-0">
                    Account ID
                  </span>
                  <code className="text-xs font-mono break-all text-right text-foreground/80">
                    {accountStatus?.accountId || 'N/A'}
                  </code>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs font-medium">DNS Zones</span>
                  <span className="text-xs font-medium">
                    {isZonesLoading
                      ? 'Loading...'
                      : `${zones.length} active domain${zones.length === 1 ? '' : 's'}`}
                  </span>
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-muted-foreground">
                  Connect your Cloudflare API token to manage tunnels, view remote ingress
                  configurations, and automatically provision proxied DNS hostnames.
                </p>
              </div>
            )}
          </div>

          {/* Account Actions */}
          <div className="flex items-center justify-between pt-2 border-t">
            {isConnected ? (
              <div className="flex items-center gap-2 w-full justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleOpenConnectModal}
                  className="gap-1.5 text-xs"
                >
                  <Key className="size-3.5" />
                  Change Token
                </Button>

                {showDisconnectConfirm ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-destructive font-medium">
                      Disconnect account?
                    </span>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleDisconnect}
                      disabled={clearAccountToken.isPending}
                      className="text-xs h-7 px-2"
                    >
                      {clearAccountToken.isPending ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        'Yes, Disconnect'
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowDisconnectConfirm(false)}
                      className="text-xs h-7 px-2"
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowDisconnectConfirm(true)}
                    className="gap-1.5 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                  >
                    <LogOut className="size-3.5" />
                    Disconnect
                  </Button>
                )}
              </div>
            ) : (
              <Button
                size="sm"
                onClick={handleOpenConnectModal}
                className="gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white"
              >
                <Cloud className="size-3.5" />
                Connect Account
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* cloudflared Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HardDrive className="size-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">cloudflared Binary</CardTitle>
                <CardDescription className="text-xs">
                  The command-line daemon powering Cloudflare Tunnels.
                </CardDescription>
              </div>
            </div>

            <Button variant="outline" size="sm" onClick={handleRecheck} disabled={isBinaryLoading}>
              <RotateCw className={`size-3.5 mr-1.5 ${isBinaryLoading ? 'animate-spin' : ''}`} />
              Re-check
            </Button>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {binaryStatus?.overrideInvalid && (
            <div
              role="alert"
              className="flex items-center gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200"
            >
              <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span>
                The specified override path was not found or is invalid. Falling back to automatic
                lookup.
              </span>
            </div>
          )}

          {/* Status Display */}
          <div className="rounded-lg border bg-muted/30 p-4 flex flex-col gap-3 text-sm">
            {isBinaryLoading ? (
              <span className="text-muted-foreground text-xs">Detecting cloudflared...</span>
            ) : binaryStatus?.found ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs font-medium">Status</span>
                  <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                    <CheckCircle2 className="size-3.5" />
                    <span>Found &amp; Verified</span>
                  </div>
                </div>

                <div className="flex items-start justify-between gap-4">
                  <span className="text-muted-foreground text-xs font-medium shrink-0">
                    Location
                  </span>
                  <span className="text-xs font-mono break-all text-right">
                    {binaryStatus.path}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs font-medium">Source</span>
                  <Badge variant="secondary" className="text-xs">
                    {formatSource(binaryStatus.source)}
                  </Badge>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs font-medium">Version</span>
                  <span className="text-xs font-mono font-medium">
                    {binaryStatus.version ?? 'Unknown version'}
                  </span>
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-xs font-medium">Status</span>
                  <div className="flex items-center gap-1.5 text-xs text-destructive font-medium">
                    <XCircle className="size-3.5" />
                    <span>Not found</span>
                  </div>
                </div>

                {binaryStatus?.searched && binaryStatus.searched.length > 0 && (
                  <div className="flex flex-col gap-1.5 mt-1">
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <FolderSearch className="size-3.5" />
                      <span>Searched paths:</span>
                    </div>
                    <ul className="list-disc list-inside text-xs font-mono text-muted-foreground space-y-0.5 pl-1 max-h-28 overflow-y-auto">
                      {binaryStatus.searched.map((p, idx) => (
                        <li key={idx} className="truncate">
                          {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Update Checker Section */}
          <div className="flex flex-col gap-3 pt-3 border-t">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-medium">Software Updates</span>
                <p className="text-xs text-muted-foreground">
                  Check for newer releases of cloudflared from GitHub.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCheckUpdate}
                disabled={isCheckingUpdate || downloadBinary.isPending}
                className="text-xs gap-1.5"
              >
                {isCheckingUpdate ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                Check for updates
              </Button>
            </div>

            {updateCheckError && (
              <div
                role="alert"
                className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive"
              >
                <AlertTriangle className="size-3.5 shrink-0" />
                <span>{(updateCheckError as Error).message || 'Failed to check for updates'}</span>
              </div>
            )}

            {updateData && (
              <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3 text-xs">
                {installedVersion !== null && !isCheckingUpdate ? (
                  <div
                    role="status"
                    className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium"
                  >
                    <CheckCircle2 className="size-3.5" />
                    <span>cloudflared updated successfully (version {installedVersion})</span>
                  </div>
                ) : updateData.isUpdateAvailable ? (
                  <>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 font-medium text-blue-600 dark:text-blue-400">
                        <Download className="size-3.5" />
                        <span>New version available: {updateData.version}</span>
                      </div>
                      <a
                        href={updateData.releaseUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                      >
                        Release notes <ExternalLink className="size-3" />
                      </a>
                    </div>

                    {!updateData.hasChecksum && (
                      <div className="flex items-center gap-2 pt-1 text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="size-3.5 shrink-0" />
                        <span>No published SHA-256 checksum found for this release.</span>
                        <label className="flex items-center gap-1 cursor-pointer ml-auto font-medium text-foreground">
                          <input
                            type="checkbox"
                            checked={confirmWithoutChecksum}
                            onChange={(e) => setConfirmWithoutChecksum(e.target.checked)}
                            className="rounded"
                          />
                          Allow install
                        </label>
                      </div>
                    )}

                    {downloadProgress && downloadBinary.isPending && (
                      <DownloadProgress progress={downloadProgress} />
                    )}

                    {downloadError && (
                      <span className="text-destructive font-medium">{downloadError}</span>
                    )}

                    <div className="pt-1 flex justify-end">
                      <Button
                        size="sm"
                        onClick={handleDownloadUpdate}
                        disabled={
                          downloadBinary.isPending ||
                          (!updateData.hasChecksum && !confirmWithoutChecksum)
                        }
                        className="text-xs gap-1.5 bg-blue-600 hover:bg-blue-500 text-white"
                      >
                        {downloadBinary.isPending ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Download className="size-3.5" />
                        )}
                        Download &amp; Install {updateData.version}
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
                    <CheckCircle2 className="size-3.5" />
                    <span>cloudflared is up to date (version {updateData.version})</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Override Path Input */}
          <div className="flex flex-col gap-2 pt-2 border-t">
            <Label htmlFor="binary-override" className="text-xs">
              Custom binary path override
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="binary-override"
                placeholder="C:\path\to\cloudflared.exe"
                value={overridePath}
                onChange={(e) => setUserOverridePath(e.target.value)}
                className="font-mono text-xs"
              />
              <Button size="sm" onClick={handleSaveOverride} disabled={setOverride.isPending}>
                Save
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearOverride}
                disabled={
                  setOverride.isPending || (!overridePath && !settings?.binary.overridePath)
                }
              >
                Clear
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Provide an absolute path to cloudflared.exe if you want to bypass auto-detection.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Appearance Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Appearance</CardTitle>
          <CardDescription className="text-xs">
            Choose a light or dark theme, or follow Windows.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ThemeSwitcher />
          <p className="text-xs text-muted-foreground">
            <strong className="font-medium text-foreground">System</strong> follows the Windows app
            mode setting and updates as soon as you change it there.
          </p>
        </CardContent>
      </Card>

      {/* Startup Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Startup &amp; Behavior</CardTitle>
          <CardDescription className="text-xs">Manage system launch behavior.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="launch-login" className="text-sm">
                Launch at login
              </Label>
              <p className="text-xs text-muted-foreground">
                Automatically start Cloudflared Tunnel GUI when signing in to Windows.
              </p>
            </div>
            <Switch
              id="launch-login"
              checked={settings?.startup.launchAtLogin ?? false}
              disabled={isSettingsLoading || setSettings.isPending}
              onCheckedChange={(checked) => {
                setSettings.mutate({ startup: { launchAtLogin: checked } })
              }}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="start-hidden" className="text-sm">
                Start hidden
              </Label>
              <p className="text-xs text-muted-foreground">
                Open minimized to the system notification area on startup.
              </p>
            </div>
            <Switch
              id="start-hidden"
              checked={settings?.startup.startHidden ?? true}
              disabled={isSettingsLoading || setSettings.isPending}
              onCheckedChange={(checked) => {
                setSettings.mutate({ startup: { startHidden: checked } })
              }}
            />
          </div>

          <div className="text-xs text-muted-foreground rounded-md bg-muted/40 p-2.5 border">
            Startup preferences are active. Launching at login starts Cloudflared Tunnel GUI
            automatically, and auto-start tunnels will begin running immediately on launch.
          </div>
        </CardContent>
      </Card>

      {/* Windows Services Card */}
      <Card className="2xl:order-last 2xl:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Server className="size-4 text-blue-600 dark:text-blue-400" />
              Windows Services
            </CardTitle>
            <CardDescription className="text-xs">
              Background cloudflared daemon services installed on this system.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => queryClient.invalidateQueries({ queryKey: ['services'] })}
            disabled={isServicesLoading}
            className="h-8 gap-1.5 text-xs"
          >
            <RefreshCw className={`size-3.5 ${isServicesLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {isServicesLoading ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              Checking Windows services...
            </div>
          ) : services.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground rounded-lg border border-dashed p-4">
              No cloudflared Windows services detected. You can install tunnels as services from the
              Tunnels page.
            </div>
          ) : (
            <div className="space-y-2">
              {services.map((svc) => {
                const isRunning = svc.state === 'running'
                const isActionPending =
                  (startService.isPending &&
                    startService.variables?.serviceName === svc.serviceName) ||
                  (stopService.isPending &&
                    stopService.variables?.serviceName === svc.serviceName) ||
                  (restartService.isPending &&
                    restartService.variables?.serviceName === svc.serviceName) ||
                  (adoptService.isPending &&
                    adoptService.variables?.serviceName === svc.serviceName)

                return (
                  <div
                    key={svc.serviceName}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-border bg-muted/50 p-3"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-foreground">
                          {svc.displayName || svc.serviceName}
                        </span>
                        <Badge
                          variant={
                            isRunning
                              ? 'default'
                              : svc.state === 'stopped'
                                ? 'outline'
                                : 'secondary'
                          }
                          className="text-[10px] uppercase font-mono px-1.5 py-0"
                        >
                          {svc.state}
                        </Badge>
                        <Badge
                          variant="outline"
                          className="text-[10px] font-mono px-1.5 py-0 text-muted-foreground"
                        >
                          {svc.kind}
                        </Badge>
                      </div>
                      <div className="text-[11px] text-muted-foreground font-mono truncate max-w-md">
                        {svc.serviceName}
                        {svc.metricsPort ? ` • metrics: :${svc.metricsPort}` : ''}
                        {svc.logPath ? ` • logs: ${svc.logPath}` : ''}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {svc.kind === 'unlinked' && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isActionPending}
                          onClick={() => adoptService.mutate({ serviceName: svc.serviceName })}
                          className="h-7 text-xs gap-1 text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-300"
                        >
                          {adoptService.isPending ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            'Adopt'
                          )}
                        </Button>
                      )}

                      <Button
                        variant={isRunning ? 'destructive' : 'outline'}
                        size="sm"
                        disabled={isActionPending}
                        onClick={() => {
                          if (isRunning) {
                            stopService.mutate({ serviceName: svc.serviceName })
                          } else {
                            startService.mutate({ serviceName: svc.serviceName })
                          }
                        }}
                        className="h-7 text-xs min-w-[60px]"
                      >
                        {isActionPending ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : isRunning ? (
                          <>
                            <Square className="size-3 mr-1" /> Stop
                          </>
                        ) : (
                          <>
                            <Play className="size-3 mr-1" /> Start
                          </>
                        )}
                      </Button>

                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!isRunning || isActionPending}
                        onClick={() => restartService.mutate({ serviceName: svc.serviceName })}
                        className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground"
                        title="Restart service"
                      >
                        <RefreshCw className="size-3" />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <UpdatesCard />

      {/* Connect Cloudflare Account Dialog */}
      {isConnectModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <div className="flex w-full max-w-md flex-col rounded-xl border border-border bg-card p-6 shadow-2xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-4 border-b border-border">
              <div className="flex items-center gap-2">
                <Cloud className="size-5 text-indigo-600 dark:text-indigo-400" />
                <div>
                  <h2 className="text-lg font-semibold text-foreground">
                    {isConnected ? 'Update Cloudflare Token' : 'Connect Cloudflare Account'}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    API token encrypted using Windows DPAPI.
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsConnectModalOpen(false)}
                aria-label="Close dialog"
              >
                <X className="h-5 w-5 text-muted-foreground hover:text-foreground" />
              </Button>
            </div>

            {/* Modal Form */}
            <form onSubmit={handleVerifyAndConnect} className="space-y-4 pt-4">
              {/* Token Input */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="cf-token" className="text-xs font-medium text-foreground/80">
                    Cloudflare API Token
                  </Label>
                  <a
                    href={
                      tokenCreationUrlData?.url ?? 'https://dash.cloudflare.com/profile/api-tokens'
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300 transition-colors"
                  >
                    <span>Create token in Dashboard</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>

                <div className="relative">
                  <Input
                    id="cf-token"
                    type={showToken ? 'text' : 'password'}
                    placeholder="Enter your Cloudflare API token"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    disabled={setAccountToken.isPending}
                    className="font-mono text-xs pr-9"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showToken ? 'Hide token' : 'Show token'}
                  >
                    {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>

                <div className="space-y-1.5 text-[11px] leading-normal text-muted-foreground">
                  <p>The token needs these permissions (the link pre-fills all three):</p>
                  <ul className="list-disc space-y-0.5 pl-4 font-mono text-muted-foreground">
                    <li>Account → Cloudflare Tunnel → Edit</li>
                    <li>Zone → DNS → Edit</li>
                    <li>Zone → Zone → Read</li>
                  </ul>
                  <p>
                    On the Cloudflare page, choose your account under{' '}
                    <span className="text-muted-foreground">Account Resources</span> and the domains
                    you will use under <span className="text-muted-foreground">Zone Resources</span>
                    .
                  </p>
                </div>
              </div>

              {/* Account Dropdown if multiple accounts found */}
              {availableAccounts.length > 1 && (
                <div className="space-y-2 rounded-lg border border-border bg-muted/60 p-3">
                  <Label
                    htmlFor="account-select"
                    className="text-xs font-medium text-foreground/80"
                  >
                    Select Account ({availableAccounts.length} accessible)
                  </Label>
                  <select
                    id="account-select"
                    value={selectedAccountId}
                    onChange={(e) => setSelectedAccountId(e.target.value)}
                    className="w-full rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {availableAccounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} ({acc.id})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Error Message */}
              {connectError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
                  <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{connectError}</span>
                </div>
              )}

              {/* Modal Actions */}
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsConnectModalOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!tokenInput.trim() || setAccountToken.isPending}
                  className="gap-1.5"
                >
                  {setAccountToken.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Cloud className="h-3.5 w-3.5" />
                  )}
                  {availableAccounts.length > 1 ? 'Save & Connect' : 'Verify & Connect'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </PageContainer>
  )
}
