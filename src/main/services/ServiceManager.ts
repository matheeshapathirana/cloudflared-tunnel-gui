import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import { AppErrorException } from '@shared/result'
import type { BinaryManager } from '../binary/BinaryManager'

export interface CloudflaredService {
  serviceName: string
  displayName: string
  state: 'running' | 'stopped' | 'starting' | 'unknown'
  kind: 'remote' | 'local' | 'unlinked'
  cfTunnelId?: string
  metricsPort?: number
  logPath?: string
  binaryPath?: string
  binaryVersion?: string
}

/** Internal view: also carries the raw service command line, which may contain a token. Never send to the renderer. */
type RawService = CloudflaredService & { commandLine: string }

export interface ParsedServiceCommandLine {
  binaryPath?: string
  metricsPort?: number
  logPath?: string
  token?: string
  tokenPath?: string
  configPath?: string
  cfTunnelId?: string
  kind: 'remote' | 'local' | 'unlinked'
}

export interface ServiceManagerDeps {
  binaryManager: BinaryManager
  programDataDir?: string
  execFile?: (
    file: string,
    args: string[],
    options?: { timeout?: number }
  ) => Promise<{ stdout: string; stderr: string }>
  runElevatedScript?: (scriptContent: string) => Promise<{ success: boolean; error?: string }>
  isPortFree?: (port: number) => Promise<boolean>
}

const MANAGED_NAME = /^cftunnel-[a-z0-9-]{1,40}$/
const METRICS_PORT_RANGE = { min: 40500, max: 40599 }

/**
 * Valid names for operating on an existing service: the ones this app creates
 * (cftunnel-*) plus the stock "Cloudflared" service from `cloudflared service install`.
 */
export function isValidServiceName(name: string): boolean {
  if (/^Cloudflared$/i.test(name)) return true
  return MANAGED_NAME.test(name)
}

/** Only names this app creates. Required when installing. */
export function isManagedServiceName(name: string): boolean {
  return MANAGED_NAME.test(name)
}

function assertServiceName(name: string): void {
  if (!isValidServiceName(name)) {
    throw new AppErrorException('VALIDATION', `Invalid service name: ${name}`)
  }
}

function assertManagedServiceName(name: string): void {
  if (!isManagedServiceName(name)) {
    throw new AppErrorException(
      'VALIDATION',
      `Invalid service name: ${name}. Must match ^cftunnel-[a-z0-9-]{1,40}$`
    )
  }
}

/**
 * PowerShell single-quoted literal. Nothing inside is expanded ($, backtick, subexpressions),
 * so any validated value can be embedded safely. Control characters and the typographic quote
 * characters PowerShell treats as quotes are rejected rather than escaped.
 */
export function psq(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u0085\u2018-\u201b\u2028\u2029]/.test(value)) {
    throw new AppErrorException('VALIDATION', 'Value contains characters that are not allowed')
  }
  return `'${value.replace(/'/g, "''")}'`
}

/** Absolute local Windows path with no quotes, wildcards, traversal or odd characters. */
function assertWinPath(value: string, label: string): string {
  // eslint-disable-next-line no-control-regex
  const ok = /^[A-Za-z]:\\[^"<>|*?\u0000-\u001f]*$/.test(value) && !value.split('\\').includes('..')
  if (!ok) {
    throw new AppErrorException('VALIDATION', `${label} must be an absolute Windows path`)
  }
  return value
}

function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new AppErrorException('VALIDATION', `Invalid port: ${port}`)
  }
  return port
}

function assertToken(token: string): string {
  const t = token.trim()
  if (!/^[A-Za-z0-9+/=_-]{16,8192}$/.test(t)) {
    throw new AppErrorException('VALIDATION', 'Tunnel token has an unexpected format')
  }
  return t
}

function sanitizeDisplayName(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N} ._()-]/gu, '')
    .trim()
    .slice(0, 80)
  return cleaned || 'tunnel'
}

/**
 * Generates slug from tunnel ID or name.
 */
export function generateServiceSlug(idOrName: string): string {
  const sanitized = idOrName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 31)
  return `cftunnel-${sanitized || 'tunnel'}`
}

/**
 * Extracts cfTunnelId from base64 JWT run token.
 * Tokens are base64-encoded JSON: {"a":"...","t":"<uuid>","s":"..."}
 */
export function parseTokenTunnelId(token: string): string | undefined {
  try {
    const raw = Buffer.from(token.trim(), 'base64').toString('utf8')
    const parsed = JSON.parse(raw) as { t?: string }
    return parsed.t
  } catch {
    return undefined
  }
}

/**
 * Parses cloudflared service command line.
 */
export function parseServiceCommandLine(commandLine: string): ParsedServiceCommandLine {
  const result: ParsedServiceCommandLine = {
    kind: 'unlinked'
  }

  // Extract binary path
  const binMatch = commandLine.match(/^\s*"([^"]+)"|^\s*(\S+)/)
  if (binMatch) {
    result.binaryPath = binMatch[1] || binMatch[2]
  }

  // Extract metrics port
  const metricsMatch = commandLine.match(/--metrics\s+(?:127\.0\.0\.1|0\.0\.0\.0|localhost):(\d+)/i)
  if (metricsMatch) {
    result.metricsPort = Number.parseInt(metricsMatch[1], 10)
  }

  // Extract logfile
  const logMatch = commandLine.match(/--logfile\s+"([^"]+)"|--logfile\s+(\S+)/i)
  if (logMatch) {
    result.logPath = logMatch[1] || logMatch[2]
  }

  // Extract token-file
  const tokenFileMatch = commandLine.match(/--token-file\s+"([^"]+)"|--token-file\s+(\S+)/i)
  if (tokenFileMatch) {
    result.tokenPath = tokenFileMatch[1] || tokenFileMatch[2]
    result.kind = 'remote'
  }

  // Extract token (not --token-file)
  const tokenMatch = commandLine.match(/--token\s+"([^"]+)"|--token\s+(\S+)/i)
  if (tokenMatch) {
    result.token = tokenMatch[1] || tokenMatch[2]
    result.kind = 'remote'
    const cfId = parseTokenTunnelId(result.token)
    if (cfId) {
      result.cfTunnelId = cfId
    }
  }

  // Extract config
  const configMatch = commandLine.match(/--config\s+"([^"]+)"|--config\s+(\S+)/i)
  if (configMatch) {
    result.configPath = configMatch[1] || configMatch[2]
    result.kind = 'local'
  }

  return result
}

/**
 * Builds the new service command line for "adopt": keeps everything the service already runs
 * and only adds `--metrics` and `--logfile` before the `run` subcommand.
 */
export function buildAdoptedCommandLine(original: string, port: number, logFile: string): string {
  assertPort(port)
  assertWinPath(logFile, 'Log file')
  const bin = original.match(/^\s*("[^"]*"|\S+)/)
  if (!bin) {
    throw new AppErrorException('VALIDATION', 'Service has no command line to adopt')
  }
  const rest = original
    .slice(bin[0].length)
    .replace(/\s--metrics\s+\S+/gi, '')
    .replace(/\s--logfile\s+(?:"[^"]*"|\S+)/gi, '')
  const runAt = rest.search(/(^|\s)run(?=\s|$)/)
  if (runAt === -1) {
    throw new AppErrorException(
      'VALIDATION',
      'Cannot adopt: the service command line has no "run" subcommand'
    )
  }
  const runStart = rest.indexOf('run', runAt)
  const injected = ` --metrics 127.0.0.1:${port} --logfile "${logFile}" `
  return `${bin[0].trim()}${rest.slice(0, runStart).replace(/\s+$/, '')}${injected}${rest.slice(runStart)}`
}

/**
 * Shared helpers for every elevated script.
 *  - Protect-Dir: creates a directory owned by Administrators/SYSTEM and resets its ACL
 *    (SYSTEM + Administrators full control, optionally Users read/execute). Refuses
 *    directories that already exist but are owned by someone else, so a normal user cannot
 *    pre-create a folder that later holds a binary run as SYSTEM.
 *  - Assert-Signed: refuses to put any binary that is not signed by Cloudflare, Inc. into
 *    the SYSTEM-run folder.
 */
const PRELUDE = `$ErrorActionPreference = 'Stop'
function Assert-AdminOwned([string]$p) {
  $owner = (Get-Acl -LiteralPath $p).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne 'S-1-5-32-544' -and $owner -ne 'S-1-5-18') { throw "Refusing to use $($p) because it is not owned by Administrators or SYSTEM" }
}
function Protect-Dir([string]$p, [bool]$usersRead) {
  New-Item -ItemType Directory -Force -Path $p | Out-Null
  Assert-AdminOwned $p
  $a = @($p, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '/grant:r', '*S-1-5-32-544:(OI)(CI)F')
  if ($usersRead) { $a += @('/grant:r', '*S-1-5-32-545:(OI)(CI)RX') }
  & icacls.exe @a | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed for $p" }
}
function Stop-Svc([string]$n) {
  $s = Get-Service -Name $n -ErrorAction SilentlyContinue
  if ($s -and $s.Status -ne 'Stopped') {
    Stop-Service -Name $n -Force -ErrorAction Stop
    $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
  }
}
function Assert-Signed([string]$p) {
  $sig = Get-AuthenticodeSignature -LiteralPath $p
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O="?Cloudflare, Inc\\.') { throw "Signature check failed for $p" }
}
`

function dirs(programDataDir: string): {
  base: string
  bin: string
  tokens: string
  logs: string
  svcBin: string
} {
  const base = assertWinPath(programDataDir, 'Data directory')
  return {
    base,
    bin: path.win32.join(base, 'bin'),
    tokens: path.win32.join(base, 'tokens'),
    logs: path.win32.join(base, 'logs'),
    svcBin: path.win32.join(base, 'bin', 'cloudflared.exe')
  }
}

function installScript(opts: {
  serviceName: string
  displayName: string
  programDataDir: string
  sourceBinaryPath: string
  token?: string
  commandLine: (d: ReturnType<typeof dirs>, tokenFile: string) => string
}): string {
  assertManagedServiceName(opts.serviceName)
  const d = dirs(opts.programDataDir)
  const source = assertWinPath(opts.sourceBinaryPath, 'Source binary')
  const tokenFile = path.win32.join(d.tokens, opts.serviceName)
  const token = opts.token === undefined ? undefined : assertToken(opts.token)
  const commandLine = opts.commandLine(d, tokenFile)
  const name = psq(opts.serviceName)

  return `${PRELUDE}
$created = $false
$wroteToken = $false
try {
  if (Get-Service -Name ${name} -ErrorAction SilentlyContinue) { throw 'A service with this name already exists' }
  Protect-Dir ${psq(d.base)} $true
  Protect-Dir ${psq(d.bin)} $true
  Protect-Dir ${psq(d.tokens)} $false
  Protect-Dir ${psq(d.logs)} $true
  if (-not (Test-Path -LiteralPath ${psq(d.svcBin)})) {
    Copy-Item -LiteralPath ${psq(source)} -Destination ${psq(d.svcBin)} -Force
  }
  Assert-Signed ${psq(d.svcBin)}
${
  token === undefined
    ? ''
    : `  [System.IO.File]::WriteAllText(${psq(tokenFile)}, ${psq(token)})
  $wroteToken = $true
`
}  New-Service -Name ${name} -BinaryPathName ${psq(commandLine)} -DisplayName ${psq(sanitizeDisplayName(opts.displayName))} -StartupType Automatic | Out-Null
  $created = $true
  & sc.exe config ${name} start= delayed-auto | Out-Null
  & sc.exe failure ${name} reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
  Start-Service -Name ${name}
  exit 0
} catch {
  if ($created) {
    try { Stop-Svc ${name} } catch {}
    try { & sc.exe delete ${name} | Out-Null } catch {}
  }
  if ($wroteToken) { try { Remove-Item -LiteralPath ${psq(tokenFile)} -Force } catch {} }
  exit 1
}
`
}

/**
 * Pure generator: installs a remote (token) tunnel as a Windows service.
 */
export function generateInstallRemoteScript(opts: {
  serviceName: string
  displayName: string
  token: string
  port: number
  programDataDir: string
  sourceBinaryPath: string
}): string {
  assertPort(opts.port)
  return installScript({
    ...opts,
    commandLine: (d, tokenFile) =>
      `"${d.svcBin}" tunnel --no-autoupdate --metrics 127.0.0.1:${opts.port} --logfile "${path.win32.join(d.logs, `${opts.serviceName}.log`)}" run --token-file "${tokenFile}"`
  })
}

/**
 * Pure generator: installs a local (config-file) tunnel as a Windows service.
 */
export function generateInstallLocalScript(opts: {
  serviceName: string
  displayName: string
  configPath: string
  port: number
  programDataDir: string
  sourceBinaryPath: string
}): string {
  assertPort(opts.port)
  const config = assertWinPath(opts.configPath, 'Config path')
  return installScript({
    serviceName: opts.serviceName,
    displayName: opts.displayName,
    programDataDir: opts.programDataDir,
    sourceBinaryPath: opts.sourceBinaryPath,
    commandLine: (d) =>
      `"${d.svcBin}" tunnel --no-autoupdate --metrics 127.0.0.1:${opts.port} --logfile "${path.win32.join(d.logs, `${opts.serviceName}.log`)}" --config "${config}" run`
  })
}

/**
 * Pure generator: uninstalls a service. Removes the token file only for services this app created.
 */
export function generateUninstallScript(opts: {
  serviceName: string
  programDataDir: string
}): string {
  assertServiceName(opts.serviceName)
  const d = dirs(opts.programDataDir)
  const name = psq(opts.serviceName)
  const tokenCleanup = isManagedServiceName(opts.serviceName)
    ? `\n  Remove-Item -LiteralPath ${psq(path.win32.join(d.tokens, opts.serviceName))} -Force -ErrorAction SilentlyContinue`
    : ''

  return `${PRELUDE}
try {
  if (Get-Service -Name ${name} -ErrorAction SilentlyContinue) {
    Stop-Svc ${name}
    & sc.exe delete ${name} | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'sc delete failed' }
  }${tokenCleanup}
  exit 0
} catch {
  exit 1
}
`
}

/**
 * Pure generator: start / stop / restart a service.
 */
export function generateControlScript(opts: {
  action: 'start' | 'stop' | 'restart'
  serviceName: string
}): string {
  assertServiceName(opts.serviceName)
  const name = psq(opts.serviceName)
  const steps = {
    start: `Start-Service -Name ${name}`,
    stop: `Stop-Svc ${name}`,
    restart: `Stop-Svc ${name}\n  Start-Service -Name ${name}`
  }[opts.action]

  return `${PRELUDE}
try {
  ${steps}
  exit 0
} catch {
  exit 1
}
`
}

/**
 * Pure generator: adopts an existing service by adding --metrics and --logfile to its command
 * line. Keeps the original command line and restores it if anything fails.
 */
export function generateAdoptScript(opts: {
  serviceName: string
  currentCommandLine: string
  port: number
  programDataDir: string
}): string {
  assertServiceName(opts.serviceName)
  const d = dirs(opts.programDataDir)
  const logFile = path.win32.join(d.logs, `${opts.serviceName}.log`)
  const adopted = buildAdoptedCommandLine(opts.currentCommandLine, opts.port, logFile)
  const name = psq(opts.serviceName)

  return `${PRELUDE}
$name = ${name}
$orig = $null
$wasRunning = $false
try {
  $svc = Get-CimInstance Win32_Service -Filter "Name='$name'"
  if (-not $svc) { throw 'Service not found' }
  $orig = $svc.PathName
  $wasRunning = ($svc.State -eq 'Running')
  Protect-Dir ${psq(d.base)} $true
  Protect-Dir ${psq(d.logs)} $true
  Stop-Svc $name
  $r = Invoke-CimMethod -InputObject $svc -MethodName Change -Arguments @{ PathName = ${psq(adopted)} }
  if ($r.ReturnValue -ne 0) { throw "Change failed ($($r.ReturnValue))" }
  Start-Service -Name $name
  exit 0
} catch {
  try {
    if ($orig) {
      $cur = Get-CimInstance Win32_Service -Filter "Name='$name'"
      Invoke-CimMethod -InputObject $cur -MethodName Change -Arguments @{ PathName = $orig } | Out-Null
    }
    if ($wasRunning) { Start-Service -Name $name }
  } catch {}
  exit 1
}
`
}

/**
 * Pure generator: replaces the service binary and restarts the services that use it.
 */
export function generateUpdateBinaryScript(opts: {
  sourceBinaryPath: string
  programDataDir: string
  servicesToRestart: string[]
}): string {
  const d = dirs(opts.programDataDir)
  const source = assertWinPath(opts.sourceBinaryPath, 'Source binary')
  opts.servicesToRestart.forEach(assertManagedServiceName)
  const list = `@(${opts.servicesToRestart.map(psq).join(', ')})`

  return `${PRELUDE}
$names = ${list}
try {
  Protect-Dir ${psq(d.base)} $true
  Protect-Dir ${psq(d.bin)} $true
  foreach ($n in $names) { Stop-Svc $n }
  Copy-Item -LiteralPath ${psq(source)} -Destination ${psq(d.svcBin)} -Force
  Assert-Signed ${psq(d.svcBin)}
  foreach ($n in $names) { Start-Service -Name $n }
  exit 0
} catch {
  foreach ($n in $names) { try { Start-Service -Name $n } catch {} }
  exit 1
}
`
}

async function defaultIsPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

export class ServiceManager {
  private programDataDir: string
  private execFile: NonNullable<ServiceManagerDeps['execFile']>
  private runElevatedScript: NonNullable<ServiceManagerDeps['runElevatedScript']>
  private isPortFree: (port: number) => Promise<boolean>

  constructor(private deps: ServiceManagerDeps) {
    this.programDataDir =
      deps.programDataDir ||
      path.win32.join(process.env.ProgramData || 'C:\\ProgramData', 'CloudflaredTunnelGUI')
    this.isPortFree = deps.isPortFree ?? defaultIsPortFree

    this.execFile =
      deps.execFile ||
      (async (file, args, options) => {
        const { execFile: cpExecFile } = await import('node:child_process')
        const { promisify } = await import('node:util')
        const res = await promisify(cpExecFile)(file, args, { ...options, windowsHide: true })
        return {
          stdout: String(res.stdout),
          stderr: String(res.stderr)
        }
      })

    this.runElevatedScript = deps.runElevatedScript || ((script) => this.defaultRunElevated(script))
  }

  /**
   * Runs a script elevated (UAC prompt). The script is passed on the command line as
   * -EncodedCommand, never written to disk, so nothing user-writable can be swapped between
   * the UAC prompt and execution. Success is the elevated process's exit code.
   */
  private async defaultRunElevated(script: string): Promise<{ success: boolean; error?: string }> {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    if (encoded.length > 14000) {
      return { success: false, error: 'Elevated script is too large' }
    }
    const outer =
      `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
      `-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; ` +
      `exit $p.ExitCode`
    try {
      await this.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], {
        timeout: 120000
      })
      return { success: true }
    } catch (err) {
      const e = err as { code?: number | string; stderr?: string; message?: string }
      const text = `${e.stderr ?? ''} ${e.message ?? ''}`
      if (/canceled by the user|cancelled by the user/i.test(text)) {
        return { success: false, error: 'The administrator prompt (UAC) was declined' }
      }
      if (typeof e.code === 'number') {
        return {
          success: false,
          error: `The elevated action failed (exit code ${e.code}); nothing was left half-installed`
        }
      }
      return { success: false, error: e.message ?? String(err) }
    }
  }

  private async elevated(script: string, failure: string): Promise<void> {
    const res = await this.runElevatedScript(script)
    if (!res.success) {
      throw new AppErrorException('INTERNAL', res.error || failure)
    }
  }

  private async queryServices(): Promise<RawService[]> {
    try {
      const psScript = `Get-CimInstance Win32_Service | Where-Object { $_.PathName -like '*cloudflared*' } | Select-Object Name, DisplayName, State, PathName | ConvertTo-Json -Compress`
      const { stdout } = await this.execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', psScript],
        { timeout: 10000 }
      )

      if (!stdout.trim()) return []

      const parsedJson = JSON.parse(stdout.trim())
      const items = Array.isArray(parsedJson) ? parsedJson : [parsedJson]

      const services: RawService[] = []
      for (const item of items) {
        if (!item || !item.Name) continue
        const commandLine = String(item.PathName || '')
        const parsedCmd = parseServiceCommandLine(commandLine)
        let state: CloudflaredService['state'] = 'unknown'
        const rawState = String(item.State || '').toLowerCase()
        if (rawState === 'running') state = 'running'
        else if (rawState === 'stopped') state = 'stopped'
        else if (rawState.includes('start')) state = 'starting'

        // The token file holds the tunnel id; it may be unreadable without elevation.
        let cfTunnelId = parsedCmd.cfTunnelId
        if (!cfTunnelId && parsedCmd.tokenPath) {
          try {
            const tokenContent = await fs.promises.readFile(parsedCmd.tokenPath, 'utf8')
            cfTunnelId = parseTokenTunnelId(tokenContent)
          } catch {
            // Service token unreadable without elevation
          }
        }

        services.push({
          serviceName: item.Name,
          displayName: item.DisplayName || item.Name,
          state,
          kind: parsedCmd.kind,
          cfTunnelId,
          metricsPort: parsedCmd.metricsPort,
          logPath: parsedCmd.logPath,
          binaryPath: parsedCmd.binaryPath,
          commandLine
        })
      }

      return services
    } catch {
      return []
    }
  }

  /**
   * List all cloudflared services on the machine (without raw command lines).
   */
  async listServices(): Promise<CloudflaredService[]> {
    const raw = await this.queryServices()
    // explicit allowlist: the raw command line can contain an inline --token
    return raw.map((s) => ({
      serviceName: s.serviceName,
      displayName: s.displayName,
      state: s.state,
      kind: s.kind,
      cfTunnelId: s.cfTunnelId,
      metricsPort: s.metricsPort,
      logPath: s.logPath,
      binaryPath: s.binaryPath,
      binaryVersion: s.binaryVersion
    }))
  }

  /** First free metrics port in the managed range that no existing cloudflared service uses. */
  private async allocateMetricsPort(existing: RawService[]): Promise<number> {
    const used = new Set(existing.map((s) => s.metricsPort).filter((p): p is number => !!p))
    for (let p = METRICS_PORT_RANGE.min; p <= METRICS_PORT_RANGE.max; p++) {
      if (!used.has(p) && (await this.isPortFree(p))) return p
    }
    throw new AppErrorException('INTERNAL', 'No free metrics port available for the service')
  }

  async startService(serviceName: string): Promise<void> {
    await this.elevated(
      generateControlScript({ action: 'start', serviceName }),
      `Failed to start ${serviceName}`
    )
  }

  async stopService(serviceName: string): Promise<void> {
    await this.elevated(
      generateControlScript({ action: 'stop', serviceName }),
      `Failed to stop ${serviceName}`
    )
  }

  async restartService(serviceName: string): Promise<void> {
    await this.elevated(
      generateControlScript({ action: 'restart', serviceName }),
      `Failed to restart ${serviceName}`
    )
  }

  private async prepareInstall(tunnelName: string): Promise<{
    slug: string
    sourceBinaryPath: string
    existing: RawService[]
  }> {
    const slug = generateServiceSlug(tunnelName)
    const binStatus = await this.deps.binaryManager.status()
    if (!binStatus.found) {
      throw new AppErrorException('NOT_FOUND', 'cloudflared binary not found')
    }
    const existing = await this.queryServices()
    if (existing.some((s) => s.serviceName.toLowerCase() === slug)) {
      throw new AppErrorException('VALIDATION', `A service named ${slug} already exists`)
    }
    return { slug, sourceBinaryPath: binStatus.path, existing }
  }

  async installRemote(opts: {
    tunnelName: string
    token: string
    cfTunnelId: string
    port?: number
  }): Promise<string> {
    const { slug, sourceBinaryPath, existing } = await this.prepareInstall(opts.tunnelName)
    const script = generateInstallRemoteScript({
      serviceName: slug,
      displayName: `Cloudflare Tunnel (${opts.tunnelName})`,
      token: opts.token,
      port: opts.port ?? (await this.allocateMetricsPort(existing)),
      programDataDir: this.programDataDir,
      sourceBinaryPath
    })
    await this.elevated(script, 'Failed to install remote service')
    return slug
  }

  async installLocal(opts: {
    tunnelName: string
    configPath: string
    cfTunnelId?: string
    port?: number
  }): Promise<string> {
    const { slug, sourceBinaryPath, existing } = await this.prepareInstall(opts.tunnelName)
    const script = generateInstallLocalScript({
      serviceName: slug,
      displayName: `Cloudflare Tunnel (${opts.tunnelName})`,
      configPath: opts.configPath,
      port: opts.port ?? (await this.allocateMetricsPort(existing)),
      programDataDir: this.programDataDir,
      sourceBinaryPath
    })
    await this.elevated(script, 'Failed to install local config service')
    return slug
  }

  async uninstall(serviceName: string): Promise<void> {
    const script = generateUninstallScript({
      serviceName,
      programDataDir: this.programDataDir
    })
    await this.elevated(script, `Failed to uninstall service ${serviceName}`)
  }

  async adopt(serviceName: string, port?: number): Promise<void> {
    assertServiceName(serviceName)
    const services = await this.queryServices()
    const target = services.find((s) => s.serviceName.toLowerCase() === serviceName.toLowerCase())
    if (!target) {
      throw new AppErrorException('NOT_FOUND', `Service ${serviceName} not found`)
    }
    if (!target.commandLine) {
      throw new AppErrorException('VALIDATION', `Service ${serviceName} has no command line`)
    }

    const script = generateAdoptScript({
      serviceName: target.serviceName,
      currentCommandLine: target.commandLine,
      port: port ?? target.metricsPort ?? (await this.allocateMetricsPort(services)),
      programDataDir: this.programDataDir
    })
    await this.elevated(script, `Failed to adopt service ${serviceName}`)
  }
}
