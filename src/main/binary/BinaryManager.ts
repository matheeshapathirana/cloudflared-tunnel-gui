import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFile as cpExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { BinaryStatus, BinaryRelease, DownloadProgressPayload } from '@shared/schemas'
import { AppErrorException } from '@shared/result'

const pExecFile = promisify(cpExecFile)

export type BinarySource = 'override' | 'managed' | 'path' | 'programFiles'

export interface Candidate {
  path: string
  source: BinarySource
}

export interface BinaryManagerDependencies {
  exists: (p: string) => Promise<boolean>
  execFile: (
    p: string,
    args: string[],
    options: { timeout: number }
  ) => Promise<{ stdout: string; stderr: string }>
  env: {
    PATH?: string
    LOCALAPPDATA?: string
    ProgramFiles?: string
    'ProgramFiles(x86)'?: string
    [key: string]: string | undefined
  }
  getOverride: () => string | undefined
  fetchFn?: typeof fetch
  /** True when the file carries a valid signature from Cloudflare, Inc. Skipped when not provided. */
  verifySignature?: (file: string) => Promise<boolean>
}

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024

/** Only release assets of the official cloudflared repository may be downloaded. */
export function isOfficialDownloadUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      u.hostname.toLowerCase() === 'github.com' &&
      u.pathname.startsWith('/cloudflare/cloudflared/releases/download/')
    )
  } catch {
    return false
  }
}

export function parseVersion(stdout: string): string | null {
  const match = stdout.match(/cloudflared version (\d+\.\d+\.\d+)/)
  return match ? match[1] : null
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const partsA = a.split('.').map((s) => parseInt(s, 10) || 0)
  const partsB = b.split('.').map((s) => parseInt(s, 10) || 0)
  const len = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < len; i++) {
    const numA = partsA[i] ?? 0
    const numB = partsB[i] ?? 0
    if (numA < numB) return -1
    if (numA > numB) return 1
  }
  return 0
}

export function extractSha256(
  text: string,
  filename = 'cloudflared-windows-amd64.exe'
): string | null {
  if (!text) return null
  const lines = text.split(/\r?\n/)
  const lowerFile = filename.toLowerCase()

  for (const line of lines) {
    if (line.toLowerCase().includes(lowerFile)) {
      const match = line.match(/\b([a-fA-F0-9]{64})\b/)
      if (match) return match[1].toLowerCase()
    }
  }

  // Also check standalone single-line sha256 or <hash>  <filename>
  const singleMatch = text.trim().match(/^([a-fA-F0-9]{64})(\s+.*)?$/)
  if (singleMatch) return singleMatch[1].toLowerCase()

  return null
}

export function findWindowsAsset(
  assets: Array<{ name: string; browser_download_url: string }>
): { name: string; browser_download_url: string } | null {
  return assets.find((a) => a.name.toLowerCase() === 'cloudflared-windows-amd64.exe') ?? null
}

export class BinaryManager {
  constructor(private deps: BinaryManagerDependencies) {}

  candidates(): Candidate[] {
    const raw: Candidate[] = []

    // 1. Override (if defined)
    const override = this.deps.getOverride()?.trim()
    if (override && override.length > 0) {
      raw.push({
        path: path.win32.normalize(override),
        source: 'override'
      })
    }

    // 2. Managed
    if (this.deps.env.LOCALAPPDATA) {
      raw.push({
        path: path.win32.join(
          this.deps.env.LOCALAPPDATA,
          'CloudflaredTunnelGUI',
          'bin',
          'cloudflared.exe'
        ),
        source: 'managed'
      })
    }

    // 3. PATH
    if (this.deps.env.PATH) {
      const entries = this.deps.env.PATH.split(';')
        .map((p) => p.replace(/^"(.*)"$/, '$1').trim())
        .filter((p) => p.length > 0)

      for (const entry of entries) {
        raw.push({
          path: path.win32.join(entry, 'cloudflared.exe'),
          source: 'path'
        })
      }
    }

    // 4. %ProgramFiles(x86)%, then %ProgramFiles%
    if (this.deps.env['ProgramFiles(x86)']) {
      raw.push({
        path: path.win32.join(this.deps.env['ProgramFiles(x86)'], 'cloudflared', 'cloudflared.exe'),
        source: 'programFiles'
      })
    }

    if (this.deps.env.ProgramFiles) {
      raw.push({
        path: path.win32.join(this.deps.env.ProgramFiles, 'cloudflared', 'cloudflared.exe'),
        source: 'programFiles'
      })
    }

    // Deduplicate case-insensitively, keeping first occurrence
    const seen = new Set<string>()
    const deduplicated: Candidate[] = []
    for (const cand of raw) {
      const key = cand.path.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        deduplicated.push(cand)
      }
    }

    return deduplicated
  }

  async status(): Promise<BinaryStatus> {
    const override = this.deps.getOverride()?.trim()
    let overrideInvalid = false
    if (override && override.length > 0) {
      const overrideExists = await this.deps.exists(path.win32.normalize(override))
      if (!overrideExists) {
        overrideInvalid = true
      }
    }

    const cands = this.candidates()
    for (const cand of cands) {
      const exists =
        cand.source === 'override' && overrideInvalid ? false : await this.deps.exists(cand.path)
      if (exists) {
        let version: string | null = null
        try {
          const { stdout } = await this.deps.execFile(cand.path, ['--version'], { timeout: 5000 })
          version = parseVersion(stdout)
        } catch {
          version = null
        }
        return {
          found: true,
          path: cand.path,
          source: cand.source,
          version,
          overrideInvalid
        }
      }
    }

    return {
      found: false,
      searched: cands.map((c) => c.path),
      overrideInvalid
    }
  }

  async checkUpdate(currentVersion?: string | null): Promise<BinaryRelease> {
    const fetcher = this.deps.fetchFn ?? fetch
    const res = await fetcher(
      'https://api.github.com/repos/cloudflare/cloudflared/releases/latest',
      {
        headers: {
          'User-Agent': 'Cloudflared-Tunnel-GUI',
          Accept: 'application/vnd.github.v3+json'
        }
      }
    )

    if (!res.ok) {
      throw new AppErrorException(
        'INTERNAL',
        `Failed to check for updates: GitHub API returned HTTP ${res.status}`
      )
    }

    const data = (await res.json()) as {
      tag_name: string
      html_url: string
      published_at?: string
      body?: string
      assets?: Array<{ name: string; browser_download_url: string }>
    }

    const version = data.tag_name ? data.tag_name.replace(/^v/, '') : ''
    const assets = data.assets ?? []
    const windowsAsset = findWindowsAsset(assets)

    if (!windowsAsset) {
      throw new AppErrorException(
        'NOT_FOUND',
        'cloudflared-windows-amd64.exe asset not found in latest release'
      )
    }

    let sha256 = extractSha256(data.body ?? '', 'cloudflared-windows-amd64.exe')
    if (!sha256) {
      const checksumAsset = assets.find(
        (a) =>
          a.name.toLowerCase() === 'cloudflared-windows-amd64.exe.sha256' ||
          a.name.toLowerCase() === 'checksums.txt'
      )
      if (checksumAsset) {
        try {
          const cRes = await fetcher(checksumAsset.browser_download_url, {
            headers: { 'User-Agent': 'Cloudflared-Tunnel-GUI' }
          })
          if (cRes.ok) {
            const cText = await cRes.text()
            sha256 = extractSha256(cText, 'cloudflared-windows-amd64.exe')
          }
        } catch {
          // Ignore checksum asset fetch failure
        }
      }
    }

    const isUpdateAvailable = currentVersion ? compareVersions(version, currentVersion) > 0 : true

    return {
      version,
      releaseUrl: data.html_url,
      publishedAt: data.published_at,
      downloadUrl: windowsAsset.browser_download_url,
      sha256: sha256 ?? undefined,
      hasChecksum: Boolean(sha256),
      isUpdateAvailable
    }
  }

  async download(
    options: {
      onProgress?: (p: DownloadProgressPayload) => void
      confirmWithoutChecksum?: boolean
    } = {}
  ): Promise<string> {
    const release = await this.checkUpdate()

    if (!release.hasChecksum && !options.confirmWithoutChecksum) {
      throw new AppErrorException(
        'VALIDATION',
        'No SHA-256 checksum found for this release. Confirmation required to proceed.',
        { reason: 'NO_CHECKSUM' }
      )
    }

    if (!isOfficialDownloadUrl(release.downloadUrl)) {
      throw new AppErrorException(
        'VALIDATION',
        'Refusing to download cloudflared from an unexpected location'
      )
    }

    const localAppData = this.deps.env.LOCALAPPDATA || process.env.LOCALAPPDATA
    if (!localAppData) {
      throw new AppErrorException('INTERNAL', 'LOCALAPPDATA environment variable is missing')
    }

    const binDir = path.win32.join(localAppData, 'CloudflaredTunnelGUI', 'bin')
    await fs.promises.mkdir(binDir, { recursive: true })

    const tempFile = path.win32.join(
      binDir,
      `cloudflared-download.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
    )
    const targetFile = path.win32.join(binDir, 'cloudflared.exe')

    const fetcher = this.deps.fetchFn ?? fetch
    const res = await fetcher(release.downloadUrl, {
      headers: { 'User-Agent': 'Cloudflared-Tunnel-GUI' }
    })

    if (!res.ok) {
      throw new AppErrorException('INTERNAL', `Failed to download binary: HTTP ${res.status}`)
    }

    const contentLengthHeader = res.headers.get('content-length')
    const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0
    if (totalBytes > MAX_DOWNLOAD_BYTES) {
      throw new AppErrorException('VALIDATION', 'The cloudflared download is unexpectedly large')
    }

    const hash = crypto.createHash('sha256')
    const fileStream = fs.createWriteStream(tempFile)

    try {
      if (
        res.body &&
        typeof (res.body as unknown as { getReader?: () => unknown }).getReader === 'function'
      ) {
        const reader = (
          res.body as unknown as { getReader: () => ReadableStreamDefaultReader<Uint8Array> }
        ).getReader()
        let transferred = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            const chunk = Buffer.from(value)
            transferred += chunk.length
            if (transferred > MAX_DOWNLOAD_BYTES) {
              throw new AppErrorException(
                'VALIDATION',
                'The cloudflared download is unexpectedly large'
              )
            }
            fileStream.write(chunk)
            hash.update(chunk)
            const percent = totalBytes > 0 ? Math.round((transferred / totalBytes) * 1000) / 10 : 0
            options.onProgress?.({ percent, transferred, total: totalBytes })
          }
        }
      } else {
        const arrayBuf = await res.arrayBuffer()
        const buffer = Buffer.from(arrayBuf)
        if (buffer.length > MAX_DOWNLOAD_BYTES) {
          throw new AppErrorException(
            'VALIDATION',
            'The cloudflared download is unexpectedly large'
          )
        }
        fileStream.write(buffer)
        hash.update(buffer)
        options.onProgress?.({ percent: 100, transferred: buffer.length, total: buffer.length })
      }

      await new Promise<void>((resolve, reject) => {
        fileStream.end((err?: Error | null) => {
          if (err) reject(err)
          else resolve()
        })
      })
    } catch (err) {
      fileStream.close()
      await fs.promises.unlink(tempFile).catch(() => {})
      throw err instanceof AppErrorException
        ? err
        : new AppErrorException(
            'INTERNAL',
            `Download failed: ${err instanceof Error ? err.message : String(err)}`
          )
    }

    const calculatedSha256 = hash.digest('hex').toLowerCase()
    if (release.sha256) {
      if (calculatedSha256 !== release.sha256.toLowerCase()) {
        await fs.promises.unlink(tempFile).catch(() => {})
        throw new AppErrorException(
          'VALIDATION',
          `Checksum verification failed: expected ${release.sha256}, got ${calculatedSha256}`
        )
      }
    }

    // The checksum comes from the same release page, so it only catches a corrupted download. The
    // signature proves the file really was built and signed by Cloudflare.
    if (this.deps.verifySignature && !(await this.deps.verifySignature(tempFile))) {
      await fs.promises.unlink(tempFile).catch(() => {})
      throw new AppErrorException(
        'VALIDATION',
        'The downloaded file is not signed by Cloudflare, Inc. and was discarded.'
      )
    }

    try {
      await fs.promises.rm(targetFile, { force: true })
      await fs.promises.rename(tempFile, targetFile)
    } catch (err) {
      await fs.promises.unlink(tempFile).catch(() => {})
      throw new AppErrorException(
        'INTERNAL',
        `Could not replace ${targetFile}. If a tunnel is running from it, stop the tunnel and try again. (${err instanceof Error ? err.message : String(err)})`
      )
    }

    return targetFile
  }
}

/** True when the file has a valid Authenticode signature issued to Cloudflare, Inc. */
export async function verifyCloudflareSignature(file: string): Promise<boolean> {
  try {
    await pExecFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // the path travels in an environment variable, never inside the script text
        "$s = Get-AuthenticodeSignature -LiteralPath $env:CFTG_VERIFY_FILE; if ($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match 'O=\"?Cloudflare, Inc\\.') { exit 0 } else { exit 1 }"
      ],
      { timeout: 60000, windowsHide: true, env: { ...process.env, CFTG_VERIFY_FILE: file } }
    )
    return true
  } catch {
    return false
  }
}

export function createDefaultBinaryManager(getOverride: () => string | undefined): BinaryManager {
  return new BinaryManager({
    exists: async (p: string) => {
      try {
        await fs.promises.access(p, fs.constants.F_OK)
        return true
      } catch {
        return false
      }
    },
    execFile: async (p, args, options) => {
      const res = await pExecFile(p, args, { timeout: options.timeout })
      return { stdout: res.stdout.toString(), stderr: res.stderr.toString() }
    },
    env: process.env,
    getOverride,
    verifySignature: verifyCloudflareSignature
  })
}
