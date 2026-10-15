import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import child_process from 'node:child_process'
import YAML from 'yaml'
import type { BinaryStatus, IngressRule, BackupInfo, Tunnel } from '../../shared/schemas'
import { AppErrorException } from '../../shared/result'
import { atomicWrite } from '../util/atomicWrite'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface LocalConfigStoreDeps {
  binaryManager: { status: () => Promise<BinaryStatus> }
  defaultConfigDir?: string
  execFile?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
}

export class LocalConfigStore {
  private configDir: string
  private execFileFn: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

  constructor(private deps: LocalConfigStoreDeps) {
    this.configDir = deps.defaultConfigDir ?? path.join(os.homedir(), '.cloudflared')
    this.execFileFn =
      deps.execFile ??
      ((file, args) => {
        return new Promise((resolve, reject) => {
          child_process.execFile(file, args, (err, stdout, stderr) => {
            if (err) reject(err)
            else resolve({ stdout, stderr })
          })
        })
      })
  }

  public getConfigDir(): string {
    return this.configDir
  }

  public async scanConfigs(dirPath?: string): Promise<Tunnel[]> {
    const dir = dirPath ?? this.configDir
    if (!fs.existsSync(dir)) {
      return []
    }

    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    const tunnels: Tunnel[] = []

    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (ext !== '.yml' && ext !== '.yaml') continue

      const fullPath = path.join(dir, entry.name)
      try {
        const content = await fs.promises.readFile(fullPath, 'utf8')
        const parsed = YAML.parse(content) as Record<string, unknown> | null
        if (!parsed || typeof parsed !== 'object') continue

        const cfTunnelId = parsed['tunnel']
        const hasCreds =
          parsed['credentials-file'] || parsed['credentials_file'] || parsed['ingress']

        if (cfTunnelId && typeof cfTunnelId === 'string' && hasCreds) {
          const name = path.basename(entry.name, ext)
          tunnels.push({
            id: crypto.randomUUID(),
            name,
            kind: 'local',
            cfTunnelId,
            runMode: 'app',
            autoStart: false,
            local: { configPath: fullPath }
          })
        }
      } catch {
        // Skip unparseable files
      }
    }

    return tunnels
  }

  public async readConfig(filePath: string): Promise<{ rawYaml: string; ingress: IngressRule[] }> {
    if (!fs.existsSync(filePath)) {
      throw new AppErrorException('NOT_FOUND', `Config file not found: ${filePath}`)
    }

    const rawYaml = await fs.promises.readFile(filePath, 'utf8')
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = YAML.parse(rawYaml) as Record<string, unknown> | null
    } catch (err) {
      throw new AppErrorException(
        'VALIDATION',
        `YAML parse error: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    const ingress = Array.isArray(parsed?.ingress) ? (parsed.ingress as IngressRule[]) : []
    return { rawYaml, ingress }
  }

  public async validateYaml(rawYaml: string): Promise<{ valid: boolean; error?: string }> {
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = YAML.parse(rawYaml) as Record<string, unknown> | null
    } catch (err) {
      return {
        valid: false,
        error: `YAML syntax error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (!parsed || typeof parsed !== 'object') {
      return { valid: false, error: 'YAML must define a root object' }
    }

    if (!parsed['tunnel'] || typeof parsed['tunnel'] !== 'string') {
      return { valid: false, error: "Configuration must include a 'tunnel' ID" }
    }

    const ingress = parsed['ingress']
    if (!Array.isArray(ingress) || ingress.length === 0) {
      return { valid: false, error: "Configuration must include an 'ingress' array" }
    }

    for (let i = 0; i < ingress.length; i++) {
      const rule = ingress[i]
      if (!rule || typeof rule !== 'object' || !rule.service) {
        return {
          valid: false,
          error: `Ingress rule at index ${i} must specify a 'service'`
        }
      }
    }

    const lastRule = ingress[ingress.length - 1] as IngressRule
    if (lastRule.hostname || lastRule.path) {
      return {
        valid: false,
        error:
          "The final ingress rule must be a catch-all with no 'hostname' or 'path' (e.g. service: http_status:404)"
      }
    }

    // Try cloudflared ingress validate if binary is found
    try {
      const binStatus = await this.deps.binaryManager.status()
      if (binStatus.found) {
        const tmpFile = path.join(
          os.tmpdir(),
          `cf-validate-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`
        )
        try {
          await fs.promises.writeFile(tmpFile, rawYaml, 'utf8')
          await this.execFileFn(binStatus.path, [
            'tunnel',
            'ingress',
            'validate',
            '--config',
            tmpFile
          ])
        } finally {
          try {
            await fs.promises.unlink(tmpFile)
          } catch {
            // Ignore
          }
        }
      }
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string }).stderr
      return {
        valid: false,
        error: stderr?.trim() || (err instanceof Error ? err.message : String(err))
      }
    }

    return { valid: true }
  }

  public async createBackup(filePath: string): Promise<string | null> {
    if (!fs.existsSync(filePath)) {
      return null
    }

    const backupDir = path.join(path.dirname(filePath), 'backups')
    await fs.promises.mkdir(backupDir, { recursive: true })

    const baseName = path.basename(filePath)
    const backupFile = path.join(backupDir, `${baseName}.bak-${Date.now()}.yml`)

    await fs.promises.copyFile(filePath, backupFile)

    // Keep only the newest 5 backups
    try {
      const files = await fs.promises.readdir(backupDir)
      const matching = files
        .filter((f) => f.startsWith(`${baseName}.bak-`))
        .map((f) => path.join(backupDir, f))

      if (matching.length > 5) {
        const stats = await Promise.all(
          matching.map(async (p) => ({
            p,
            stat: await fs.promises.stat(p)
          }))
        )
        stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
        const toDelete = stats.slice(5)
        for (const item of toDelete) {
          await fs.promises.unlink(item.p).catch(() => {})
        }
      }
    } catch {
      // Ignore rotation errors
    }

    return backupFile
  }

  public async listBackups(filePath: string): Promise<BackupInfo[]> {
    const backupDir = path.join(path.dirname(filePath), 'backups')
    if (!fs.existsSync(backupDir)) {
      return []
    }

    const baseName = path.basename(filePath)
    const files = await fs.promises.readdir(backupDir)
    const matching = files.filter((f) => f.startsWith(`${baseName}.bak-`))

    const backups: BackupInfo[] = []
    for (const f of matching) {
      const fullPath = path.join(backupDir, f)
      try {
        const st = await fs.promises.stat(fullPath)
        const match = f.match(/\.bak-(\d+)\.yml$/)
        const timestamp = match ? parseInt(match[1], 10) : st.mtimeMs
        backups.push({
          fileName: f,
          timestamp,
          path: fullPath,
          size: st.size
        })
      } catch {
        // Skip unreadable
      }
    }

    backups.sort((a, b) => b.timestamp - a.timestamp)
    return backups
  }

  public async restoreBackup(filePath: string, backupPath: string): Promise<void> {
    // Only this config's own backups: <dir>/backups/<name>.bak-<digits>.yml
    const expectedDir = path.resolve(path.dirname(filePath), 'backups').toLowerCase()
    const resolvedBackup = path.resolve(backupPath)
    const name = path.basename(resolvedBackup)
    const validName =
      name.toLowerCase().startsWith(`${path.basename(filePath).toLowerCase()}.bak-`) &&
      /\.bak-\d+\.yml$/i.test(name)
    if (path.dirname(resolvedBackup).toLowerCase() !== expectedDir || !validName) {
      throw new AppErrorException('VALIDATION', 'Not a backup of this config file')
    }

    if (!fs.existsSync(backupPath)) {
      throw new AppErrorException('NOT_FOUND', `Backup file not found: ${backupPath}`)
    }

    if (fs.existsSync(filePath)) {
      await this.createBackup(filePath)
    }

    const content = await fs.promises.readFile(backupPath, 'utf8')
    await atomicWrite(filePath, content)
  }

  public async saveConfig(filePath: string, rawYaml: string): Promise<void> {
    const validation = await this.validateYaml(rawYaml)
    if (!validation.valid) {
      throw new AppErrorException('VALIDATION', validation.error ?? 'Invalid YAML configuration')
    }

    if (fs.existsSync(filePath)) {
      await this.createBackup(filePath)
    }

    await atomicWrite(filePath, rawYaml)
  }

  public async checkCert(): Promise<{ hasCert: boolean; certPath?: string }> {
    const certPath = path.join(this.configDir, 'cert.pem')
    return {
      hasCert: fs.existsSync(certPath),
      certPath
    }
  }

  public async login(): Promise<void> {
    const binStatus = await this.deps.binaryManager.status()
    if (!binStatus.found) {
      throw new AppErrorException('BINARY_NOT_FOUND', 'cloudflared binary not found')
    }

    await this.execFileFn(binStatus.path, ['tunnel', 'login'])
  }

  public async createTunnel(name: string): Promise<Tunnel> {
    const cert = await this.checkCert()
    if (!cert.hasCert) {
      throw new AppErrorException(
        'VALIDATION',
        'Cloudflare certificate (cert.pem) not found. Please log in first.'
      )
    }

    const binStatus = await this.deps.binaryManager.status()
    if (!binStatus.found) {
      throw new AppErrorException('BINARY_NOT_FOUND', 'cloudflared binary not found')
    }

    const result = await this.execFileFn(binStatus.path, ['tunnel', 'create', name])
    const match = result.stdout.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    )
    if (!match) {
      throw new AppErrorException(
        'INTERNAL',
        `Failed to parse tunnel ID from cloudflared output: ${result.stdout}`
      )
    }

    const cfTunnelId = match[1]
    const credentialsPath = path.join(this.configDir, `${cfTunnelId}.json`)
    const configPath = path.join(this.configDir, `${name}.yml`)

    const initialYaml = `tunnel: ${cfTunnelId}\ncredentials-file: ${credentialsPath}\n\ningress:\n  - service: http_status:404\n`
    await atomicWrite(configPath, initialYaml)

    return {
      id: crypto.randomUUID(),
      name,
      kind: 'local',
      cfTunnelId,
      runMode: 'app',
      autoStart: false,
      local: { configPath }
    }
  }

  /**
   * Deletes the tunnel in Cloudflare with `cloudflared tunnel delete` (uses cert.pem, so it works
   * without an API token). Cloudflare refuses while the tunnel still has live connections.
   */
  public async deleteTunnelViaCli(cfTunnelId: string): Promise<void> {
    if (!UUID_RE.test(cfTunnelId)) {
      throw new AppErrorException('VALIDATION', 'Invalid Cloudflare tunnel id')
    }
    const cert = await this.checkCert()
    if (!cert.hasCert) {
      throw new AppErrorException(
        'VALIDATION',
        'Cloudflare certificate (cert.pem) not found. Log in first, or connect a Cloudflare API token in Settings.'
      )
    }
    const binStatus = await this.deps.binaryManager.status()
    if (!binStatus.found) {
      throw new AppErrorException('BINARY_NOT_FOUND', 'cloudflared binary not found')
    }
    await this.execFileFn(binStatus.path, ['tunnel', 'delete', cfTunnelId])
  }

  /**
   * Removes only this tunnel's own files from the cloudflared config directory: its config file
   * (and that file's backups) and its <tunnel-id>.json credentials. Never touches cert.pem, other
   * tunnels' files, or anything outside the config directory. Returns the files removed.
   */
  public async deleteLocalFiles(tunnel: {
    cfTunnelId?: string
    local?: { configPath: string }
  }): Promise<string[]> {
    const dir = path.resolve(this.configDir)
    const sameDir = (a: string): boolean => path.resolve(a).toLowerCase() === dir.toLowerCase()
    const targets: string[] = []

    const configPath = tunnel.local?.configPath
    if (configPath && /\.ya?ml$/i.test(configPath) && sameDir(path.dirname(configPath))) {
      targets.push(path.resolve(configPath))
      const backupsDir = path.join(dir, 'backups')
      const prefix = `${path.basename(configPath).toLowerCase()}.bak-`
      const backups = await fs.promises.readdir(backupsDir).catch(() => [] as string[])
      for (const file of backups) {
        if (file.toLowerCase().startsWith(prefix) && /\.bak-\d+\.yml$/i.test(file)) {
          targets.push(path.join(backupsDir, file))
        }
      }
    }
    if (tunnel.cfTunnelId && UUID_RE.test(tunnel.cfTunnelId)) {
      targets.push(path.join(dir, `${tunnel.cfTunnelId}.json`))
    }

    const removed: string[] = []
    for (const target of targets) {
      try {
        await fs.promises.unlink(target)
        removed.push(target)
      } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') throw err
      }
    }
    return removed
  }
}
