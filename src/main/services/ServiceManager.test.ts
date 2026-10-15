import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isValidServiceName,
  isManagedServiceName,
  generateServiceSlug,
  parseTokenTunnelId,
  parseServiceCommandLine,
  buildAdoptedCommandLine,
  psq,
  generateInstallRemoteScript,
  generateInstallLocalScript,
  generateUninstallScript,
  generateControlScript,
  generateAdoptScript,
  PRELUDE,
  ServiceManager
} from './ServiceManager'
import type { BinaryStatus } from '../../shared/schemas'

const PD = 'C:\\ProgramData\\CloudflaredTunnelGUI'
// Same shape as a real `cloudflared service install --token-file` service; no secrets.
const STOCK_SERVICE_CMD =
  '"C:\\Program Files (x86)\\cloudflared\\cloudflared.exe" tunnel run --token-file C:\\ProgramData\\cloudflared\\token'
const TOKEN = Buffer.from(JSON.stringify({ a: 'acct', t: 'tunnel-id', s: 'secret' })).toString(
  'base64'
)

describe('ServiceManager pure helpers', () => {
  it('isValidServiceName validates correctly', () => {
    expect(isValidServiceName('cftunnel-my-tunnel')).toBe(true)
    expect(isValidServiceName('cftunnel-12345')).toBe(true)
    expect(isValidServiceName('Cloudflared')).toBe(true)
    expect(isValidServiceName('cloudflared')).toBe(true)

    expect(isValidServiceName('cftunnel_invalid')).toBe(false)
    expect(isValidServiceName('cftunnel-')).toBe(false)
    expect(isValidServiceName('cftunnel-with space')).toBe(false)
    expect(isValidServiceName('cftunnel-' + 'a'.repeat(45))).toBe(false)
    expect(isValidServiceName('randomService')).toBe(false)
  })

  it('isManagedServiceName only accepts names this app creates', () => {
    expect(isManagedServiceName('cftunnel-web')).toBe(true)
    expect(isManagedServiceName('Cloudflared')).toBe(false)
  })

  it('generateServiceSlug creates valid slugs', () => {
    expect(generateServiceSlug('My Prod Tunnel')).toBe('cftunnel-my-prod-tunnel')
    expect(generateServiceSlug('app_v2!@#')).toBe('cftunnel-app-v2')
    expect(generateServiceSlug('---')).toBe('cftunnel-tunnel')
    expect(isManagedServiceName(generateServiceSlug('x'.repeat(200)))).toBe(true)
  })

  it('parseTokenTunnelId decodes base64 JWT payload', () => {
    const payload = JSON.stringify({ a: 'acc-123', t: 'tunnel-uuid-456', s: 'secret' })
    const base64 = Buffer.from(payload).toString('base64')
    expect(parseTokenTunnelId(base64)).toBe('tunnel-uuid-456')
    expect(parseTokenTunnelId('invalid-base64-json')).toBeUndefined()
  })

  it('parseServiceCommandLine extracts parameters from command line strings', () => {
    const cmd1 =
      '"C:\\Program Files\\cloudflared\\cloudflared.exe" tunnel --no-autoupdate --metrics 127.0.0.1:40123 --logfile "C:\\ProgramData\\logs\\test.log" run --token-file "C:\\ProgramData\\tokens\\cftunnel-1"'
    const res1 = parseServiceCommandLine(cmd1)
    expect(res1.binaryPath).toBe('C:\\Program Files\\cloudflared\\cloudflared.exe')
    expect(res1.metricsPort).toBe(40123)
    expect(res1.logPath).toBe('C:\\ProgramData\\logs\\test.log')
    expect(res1.tokenPath).toBe('C:\\ProgramData\\tokens\\cftunnel-1')
    expect(res1.kind).toBe('remote')

    const cmd2 =
      'cloudflared.exe tunnel --no-autoupdate --metrics 127.0.0.1:40124 --logfile C:\\logs\\app.log --config "C:\\Users\\user\\.cloudflared\\config.yml" run'
    const res2 = parseServiceCommandLine(cmd2)
    expect(res2.metricsPort).toBe(40124)
    expect(res2.logPath).toBe('C:\\logs\\app.log')
    expect(res2.configPath).toBe('C:\\Users\\user\\.cloudflared\\config.yml')
    expect(res2.kind).toBe('local')

    const cmd3 = 'cloudflared.exe tunnel run'
    expect(parseServiceCommandLine(cmd3).kind).toBe('unlinked')
  })

  it('psq makes values literal and rejects characters PowerShell treats specially', () => {
    expect(psq('plain')).toBe("'plain'")
    expect(psq("it's")).toBe("'it''s'")
    expect(psq('$(calc) `x` "y"')).toBe('\'$(calc) `x` "y"\'')
    expect(() => psq('line1\nline2')).toThrow()
    expect(() => psq('a\u2019b')).toThrow() // typographic quote closes a PowerShell string
    expect(() => psq('a\u0000b')).toThrow()
  })
})

describe('buildAdoptedCommandLine', () => {
  it('keeps the stock service arguments and only adds metrics + logfile before run', () => {
    const out = buildAdoptedCommandLine(
      STOCK_SERVICE_CMD,
      40501,
      'C:\\ProgramData\\CloudflaredTunnelGUI\\logs\\Cloudflared.log'
    )
    expect(out).toBe(
      '"C:\\Program Files (x86)\\cloudflared\\cloudflared.exe" tunnel --metrics 127.0.0.1:40501 --logfile "C:\\ProgramData\\CloudflaredTunnelGUI\\logs\\Cloudflared.log" run --token-file C:\\ProgramData\\cloudflared\\token'
    )
  })

  it('replaces existing metrics/logfile flags instead of duplicating them', () => {
    const once = buildAdoptedCommandLine(STOCK_SERVICE_CMD, 40501, 'C:\\logs\\a.log')
    const twice = buildAdoptedCommandLine(once, 40502, 'C:\\logs\\b.log')
    expect(twice.match(/--metrics/g)).toHaveLength(1)
    expect(twice.match(/--logfile/g)).toHaveLength(1)
    expect(twice).toContain('127.0.0.1:40502')
    expect(twice).toContain('--token-file C:\\ProgramData\\cloudflared\\token')
  })

  it('refuses a command line without a run subcommand', () => {
    expect(() =>
      buildAdoptedCommandLine('"C:\\x\\cloudflared.exe" tunnel', 40501, 'C:\\l.log')
    ).toThrow(/no "run"/)
  })
})

describe('PowerShell script generators', () => {
  const baseInstall = {
    serviceName: 'cftunnel-prod',
    displayName: 'Cloudflare Tunnel (Prod)',
    port: 40500,
    programDataDir: PD,
    sourceBinaryPath: 'C:\\bin\\cloudflared.exe'
  }

  it('install (remote) builds an admin-only layout, checks the signature, and creates the service', () => {
    const script = generateInstallRemoteScript({ ...baseInstall, token: TOKEN })

    expect(script).toContain("Protect-Dir 'C:\\ProgramData\\CloudflaredTunnelGUI' $true")
    expect(script).toContain("Protect-Dir 'C:\\ProgramData\\CloudflaredTunnelGUI\\tokens' $false")
    expect(script).toContain('S-1-5-32-544')
    expect(script).toContain('Assert-Signed')
    expect(script).toContain("New-Service -Name 'cftunnel-prod'")
    expect(script).toContain(
      '--token-file "C:\\ProgramData\\CloudflaredTunnelGUI\\tokens\\cftunnel-prod"'
    )
    expect(script).toContain('delayed-auto')
    expect(script).toContain('restart/5000/restart/5000/restart/5000')
    expect(script).toContain("Start-Service -Name 'cftunnel-prod'")
    // never writes the token through a command line
    expect(script).not.toMatch(/sc\.exe create/)
  })

  it('install (remote) cleans up only what it created if a step fails', () => {
    const script = generateInstallRemoteScript({ ...baseInstall, token: TOKEN })
    expect(script).toContain(
      "if (Get-Service -Name 'cftunnel-prod' -ErrorAction SilentlyContinue) { throw"
    )
    expect(script).toContain('if ($created)')
    expect(script).toContain('if ($wroteToken)')
  })

  it('install (local) uses --config and writes no token', () => {
    const script = generateInstallLocalScript({
      ...baseInstall,
      serviceName: 'cftunnel-local',
      configPath: 'C:\\Configs\\my-tunnel.yml'
    })
    expect(script).toContain('--config "C:\\Configs\\my-tunnel.yml" run')
    expect(script).not.toContain('WriteAllText')
  })

  it('install refuses names this app does not manage (e.g. the stock Cloudflared service)', () => {
    expect(() =>
      generateInstallRemoteScript({ ...baseInstall, serviceName: 'Cloudflared', token: TOKEN })
    ).toThrow()
    expect(() =>
      generateInstallRemoteScript({ ...baseInstall, serviceName: 'invalid name', token: TOKEN })
    ).toThrow()
  })

  it('install never lets user text break out of the script', () => {
    // display name is stripped to a safe character set
    const script = generateInstallRemoteScript({
      ...baseInstall,
      displayName: 'x$(Start-Process calc)"; calc; "`',
      token: TOKEN
    })
    expect(script).not.toContain('$(Start-Process')
    expect(script).toContain("-DisplayName 'x(Start-Process calc) calc'")

    // token and paths that are not what they claim to be are rejected outright
    expect(() =>
      generateInstallRemoteScript({ ...baseInstall, token: "abc'; Start-Process calc; '" })
    ).toThrow(/token/i)
    expect(() =>
      generateInstallLocalScript({
        ...baseInstall,
        configPath: 'C:\\x\\a" ; calc ; "b.yml'
      })
    ).toThrow(/absolute Windows path/)
    expect(() =>
      generateInstallLocalScript({ ...baseInstall, configPath: '..\\..\\evil.yml' })
    ).toThrow()
    expect(() =>
      generateInstallLocalScript({ ...baseInstall, configPath: 'C:\\a\\..\\b\\c.yml' })
    ).toThrow()
    expect(() => generateInstallRemoteScript({ ...baseInstall, token: TOKEN, port: 80 })).toThrow(
      /port/i
    )
  })

  it('uninstall removes the token file only for services this app created', () => {
    const managed = generateUninstallScript({ serviceName: 'cftunnel-old', programDataDir: PD })
    expect(managed).toContain("Stop-Svc 'cftunnel-old'")
    expect(managed).toContain("sc.exe delete 'cftunnel-old'")
    expect(managed).toContain("tokens\\cftunnel-old' -Force")
    expect(managed).toContain("logs\\cftunnel-old.log' -Force")

    const stock = generateUninstallScript({ serviceName: 'Cloudflared', programDataDir: PD })
    expect(stock).toContain("sc.exe delete 'Cloudflared'")
    expect(stock).not.toContain('Remove-Item')
  })

  it('control script supports start/stop/restart and validates the name', () => {
    expect(generateControlScript({ action: 'start', serviceName: 'Cloudflared' })).toContain(
      "Start-Service -Name 'Cloudflared'"
    )
    const restart = generateControlScript({ action: 'restart', serviceName: 'cftunnel-a' })
    expect(restart.indexOf("Stop-Svc 'cftunnel-a'")).toBeLessThan(
      restart.indexOf("Start-Service -Name 'cftunnel-a'")
    )
    expect(() => generateControlScript({ action: 'stop', serviceName: "x'; calc; '" })).toThrow()
  })

  it('adopt keeps the original arguments and restores the original command line on failure', () => {
    const script = generateAdoptScript({
      serviceName: 'Cloudflared',
      currentCommandLine: STOCK_SERVICE_CMD,
      port: 40501,
      programDataDir: PD
    })
    expect(script).toContain('run --token-file C:\\ProgramData\\cloudflared\\token')
    expect(script).toContain('--metrics 127.0.0.1:40501')
    expect(script).toContain('$orig = $svc.PathName')
    expect(script).toContain('PathName = $orig')
    expect(script).toContain('$wasRunning')
  })

  // Parse-only check with PowerShell's own parser: catches quoting and syntax mistakes without
  // executing anything (no service, ACL or file is touched).
  describe.runIf(process.platform === 'win32')(
    'generated scripts are syntactically valid PowerShell',
    () => {
      const parse = (script: string): string => {
        const b64 = Buffer.from(script, 'utf16le').toString('base64')
        try {
          return execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              '$s=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:SCRIPT_B64)); $e=$null; $t=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e); $e | ForEach-Object { $_.Message + " @" + $_.Extent.StartLineNumber }; exit $e.Count'
            ],
            { env: { ...process.env, SCRIPT_B64: b64 }, encoding: 'utf8' }
          )
        } catch (err) {
          return `PARSE ERRORS:\n${(err as { stdout?: string }).stdout ?? String(err)}`
        }
      }

      const scripts: Record<string, string> = {
        'install remote': generateInstallRemoteScript({
          serviceName: 'cftunnel-prod',
          displayName: "Tunnel (it's mine)",
          token: TOKEN,
          port: 40500,
          programDataDir: PD,
          sourceBinaryPath: 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'
        }),
        'install local': generateInstallLocalScript({
          serviceName: 'cftunnel-local',
          displayName: 'Local',
          configPath: "C:\\Users\\a b\\.cloudflared\\it's.yml",
          port: 40501,
          programDataDir: PD,
          sourceBinaryPath: 'C:\\bin\\cloudflared.exe'
        }),
        uninstall: generateUninstallScript({ serviceName: 'cftunnel-x', programDataDir: PD }),
        'uninstall stock': generateUninstallScript({
          serviceName: 'Cloudflared',
          programDataDir: PD
        }),
        start: generateControlScript({ action: 'start', serviceName: 'Cloudflared' }),
        restart: generateControlScript({ action: 'restart', serviceName: 'cftunnel-x' }),
        adopt: generateAdoptScript({
          serviceName: 'Cloudflared',
          currentCommandLine: STOCK_SERVICE_CMD,
          port: 40502,
          programDataDir: PD
        })
      }

      for (const [label, script] of Object.entries(scripts)) {
        it(label, () => {
          expect(parse(script)).toBe('')
        })
      }
    }
  )
})

// Runs the real helper functions that the elevated scripts rely on, in real PowerShell, against
// real files. They need no admin rights and change nothing on the machine.
describe.runIf(process.platform === 'win32')(
  'elevated script safety helpers (real PowerShell)',
  () => {
    const ps = (command: string): string => {
      try {
        execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `${PRELUDE}\n${command}\nexit 0`],
          { stdio: 'pipe' }
        )
        return 'accepted'
      } catch {
        return 'rejected'
      }
    }
    const isElevated = (): boolean =>
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
        ],
        { encoding: 'utf8' }
      ).trim() === 'True'
    const cloudflared = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'

    it('Assert-Signed rejects a Microsoft-signed binary and an unsigned file', () => {
      expect(ps(`Assert-Signed '${process.env.SystemRoot}\\System32\\cmd.exe'`)).toBe('rejected')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-test-'))
      try {
        const fake = path.join(dir, 'cloudflared.exe')
        fs.writeFileSync(fake, 'not a program')
        expect(ps(`Assert-Signed '${fake}'`)).toBe('rejected')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it.runIf(fs.existsSync(cloudflared))(
      'Assert-Signed accepts the genuine cloudflared.exe',
      () => {
        expect(ps(`Assert-Signed '${cloudflared}'`)).toBe('accepted')
      }
    )

    it.runIf(!isElevated())('Assert-AdminOwned rejects a folder owned by the current user', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-test-'))
      try {
        expect(ps(`Assert-AdminOwned '${dir}'`)).toBe('rejected')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    // Assumes C:\ProgramData is owned by SYSTEM/Administrators, which does not hold on GitHub-hosted
    // runners (the test came back 'rejected' there), so it only runs on a real machine.
    it.skipIf(process.env.CI === 'true')(
      'Assert-AdminOwned accepts a folder owned by SYSTEM or Administrators',
      () => {
        expect(ps(`Assert-AdminOwned 'C:\\ProgramData'`)).toBe('accepted')
      }
    )
  }
)

describe('ServiceManager operations', () => {
  const fakeBinaryManager = {
    status: vi.fn(async (): Promise<BinaryStatus> => ({
      found: true,
      path: 'C:\\app\\cloudflared.exe',
      source: 'managed',
      version: '2026.10.0',
      overrideInvalid: false
    }))
  } as unknown as import('../binary/BinaryManager').BinaryManager

  const listing = (
    items: unknown[]
  ): ((...a: unknown[]) => Promise<{ stdout: string; stderr: string }>) =>
    vi.fn(async () => ({ stdout: JSON.stringify(items), stderr: '' }))

  it('listServices parses services and does not expose raw command lines or tokens', async () => {
    const manager = new ServiceManager({
      binaryManager: fakeBinaryManager,
      execFile: listing([
        {
          Name: 'cftunnel-web',
          DisplayName: 'Cloudflare Tunnel (Web)',
          State: 'Running',
          PathName:
            '"C:\\ProgramData\\CloudflaredTunnelGUI\\bin\\cloudflared.exe" tunnel --no-autoupdate --metrics 127.0.0.1:40500 --logfile "C:\\ProgramData\\logs\\cftunnel-web.log" run --token ' +
            TOKEN
        }
      ]),
      runElevatedScript: vi.fn()
    })

    const services = await manager.listServices()
    expect(services).toHaveLength(1)
    expect(services[0].serviceName).toBe('cftunnel-web')
    expect(services[0].state).toBe('running')
    expect(services[0].metricsPort).toBe(40500)
    expect(services[0].kind).toBe('remote')
    expect(services[0].cfTunnelId).toBe('tunnel-id')
    expect(JSON.stringify(services)).not.toContain(TOKEN)
    expect(services[0]).not.toHaveProperty('commandLine')
  })

  it('defaults the data directory to a dedicated CloudflaredTunnelGUI folder', () => {
    const manager = new ServiceManager({ binaryManager: fakeBinaryManager })
    const dir = (manager as unknown as { programDataDir: string }).programDataDir
    expect(dir.endsWith('\\CloudflaredTunnelGUI')).toBe(true)
  })

  it('start / stop / restart run elevated control scripts', async () => {
    const run = vi.fn(async () => ({ success: true }))
    const manager = new ServiceManager({
      binaryManager: fakeBinaryManager,
      execFile: vi.fn(),
      runElevatedScript: run
    })

    await manager.startService('cftunnel-test')
    await manager.stopService('cftunnel-test')
    await manager.restartService('Cloudflared')
    const scripts = run.mock.calls.map((c) => (c as unknown as [string])[0])
    expect(scripts[0]).toContain("Start-Service -Name 'cftunnel-test'")
    expect(scripts[1]).toContain("Stop-Svc 'cftunnel-test'")
    expect(scripts[2]).toContain("Stop-Svc 'Cloudflared'")
    await expect(manager.startService("x'; calc; '")).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('install allocates a metrics port no other cloudflared service uses', async () => {
    const run = vi.fn(async () => ({ success: true }))
    const manager = new ServiceManager({
      binaryManager: fakeBinaryManager,
      execFile: listing([
        {
          Name: 'cftunnel-a',
          DisplayName: 'a',
          State: 'Running',
          PathName:
            '"C:\\x\\cloudflared.exe" tunnel --metrics 127.0.0.1:40500 run --token-file C:\\t'
        },
        {
          Name: 'cftunnel-b',
          DisplayName: 'b',
          State: 'Running',
          PathName:
            '"C:\\x\\cloudflared.exe" tunnel --metrics 127.0.0.1:40501 run --token-file C:\\t2'
        }
      ]),
      runElevatedScript: run,
      isPortFree: async (p) => p !== 40502 // simulate something else holding 40502
    })

    const slug = await manager.installRemote({
      tunnelName: 'My Remote',
      token: TOKEN,
      cfTunnelId: 'x'
    })
    expect(slug).toBe('cftunnel-my-remote')
    const script = (run.mock.calls[0] as unknown as [string])[0]
    expect(script).toContain('--metrics 127.0.0.1:40503')
  })

  it('install refuses a tunnel whose service name already exists', async () => {
    const run = vi.fn(async () => ({ success: true }))
    const manager = new ServiceManager({
      binaryManager: fakeBinaryManager,
      execFile: listing([
        {
          Name: 'cftunnel-my-remote',
          DisplayName: 'x',
          State: 'Stopped',
          PathName: '"C:\\c.exe" tunnel run'
        }
      ]),
      runElevatedScript: run
    })
    await expect(
      manager.installRemote({ tunnelName: 'My Remote', token: TOKEN, cfTunnelId: 'x' })
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(run).not.toHaveBeenCalled()
  })

  it('install fails clearly when cloudflared is not found', async () => {
    const manager = new ServiceManager({
      binaryManager: {
        status: async () => ({ found: false, searched: [], overrideInvalid: false })
      } as unknown as import('../binary/BinaryManager').BinaryManager,
      execFile: listing([]),
      runElevatedScript: vi.fn()
    })
    await expect(
      manager.installRemote({ tunnelName: 't', token: TOKEN, cfTunnelId: 'x' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('adopt rewrites the full original command line, not just the binary path', async () => {
    const run = vi.fn(async () => ({ success: true }))
    const manager = new ServiceManager({
      binaryManager: fakeBinaryManager,
      execFile: listing([
        {
          Name: 'Cloudflared',
          DisplayName: 'Cloudflared agent',
          State: 'Running',
          PathName: STOCK_SERVICE_CMD
        }
      ]),
      runElevatedScript: run,
      isPortFree: async () => true
    })
    await manager.adopt('Cloudflared')
    const script = (run.mock.calls[0] as unknown as [string])[0]
    expect(script).toContain('run --token-file C:\\ProgramData\\cloudflared\\token')
    expect(script).toContain('--metrics 127.0.0.1:40500')
  })

  it('uninstall runs an elevated script and reports failures', async () => {
    const ok = new ServiceManager({
      binaryManager: fakeBinaryManager,
      execFile: vi.fn(),
      runElevatedScript: vi.fn(async () => ({ success: true }))
    })
    await expect(ok.uninstall('cftunnel-to-delete')).resolves.toBeUndefined()

    const failing = new ServiceManager({
      binaryManager: fakeBinaryManager,
      execFile: vi.fn(),
      runElevatedScript: vi.fn(async () => ({ success: false, error: 'boom' }))
    })
    await expect(failing.uninstall('cftunnel-to-delete')).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'boom'
    })
  })

  describe('default elevated runner', () => {
    const setup = (
      elevatedResult: 'ok' | { code?: number; message?: string; stderr?: string }
    ): { manager: ServiceManager; calls: string[][] } => {
      const calls: string[][] = []
      const execFile = vi.fn(async (_file: string, args: string[]) => {
        calls.push(args)
        if (args.join(' ').includes('Get-CimInstance')) return { stdout: '', stderr: '' }
        if (elevatedResult === 'ok') return { stdout: '', stderr: '' }
        throw Object.assign(new Error(elevatedResult.message ?? 'failed'), elevatedResult)
      })
      const manager = new ServiceManager({
        binaryManager: fakeBinaryManager,
        execFile,
        isPortFree: async () => true
      })
      return { manager, calls }
    }

    it('passes the script as -EncodedCommand (never as a file) and waits for the exit code', async () => {
      const { manager, calls } = setup('ok')
      await manager.startService('Cloudflared')
      const elevated = calls.find((a) => a.join(' ').includes('EncodedCommand'))!
      const command = elevated[elevated.length - 1]
      expect(command).toContain('-Verb RunAs')
      expect(command).toContain('-PassThru')
      expect(command).toContain('exit $p.ExitCode')
      expect(command).not.toMatch(/'-File'/)
      const encoded = /'-EncodedCommand','([^']+)'/.exec(command)![1]
      const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
      expect(decoded).toContain("Start-Service -Name 'Cloudflared'")
    })

    it('reports a declined UAC prompt', async () => {
      const { manager } = setup({ message: 'The operation was canceled by the user.' })
      await expect(manager.startService('Cloudflared')).rejects.toMatchObject({
        code: 'INTERNAL',
        message: expect.stringContaining('declined')
      })
    })

    it('reports a failing elevated script by exit code', async () => {
      const { manager } = setup({ code: 1 })
      await expect(manager.stopService('cftunnel-x')).rejects.toMatchObject({
        message: expect.stringContaining('exit code 1')
      })
    })
  })
})
