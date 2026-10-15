import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import type { DownloadProgressPayload } from '@shared/schemas'
import {
  BinaryManager,
  parseVersion,
  compareVersions,
  extractSha256,
  findWindowsAsset,
  BinaryManagerDependencies
} from './BinaryManager'

describe('BinaryManager', () => {
  describe('parseVersion', () => {
    it('parses real sample version output', () => {
      const stdout = 'cloudflared version 2026.10.0 (built 2026-10-05T08:39 UTC)'
      expect(parseVersion(stdout)).toBe('2026.10.0')
    })

    it('parses version with different minor and patch', () => {
      const stdout = 'cloudflared version 2024.1.5'
      expect(parseVersion(stdout)).toBe('2024.1.5')
    })

    it('returns null on garbage input', () => {
      expect(parseVersion('command not found: cloudflared')).toBeNull()
      expect(parseVersion('')).toBeNull()
      expect(parseVersion('cloudflared v2026.10.0')).toBeNull()
    })
  })

  describe('compareVersions', () => {
    it('compares identical versions', () => {
      expect(compareVersions('2026.10.0', '2026.10.0')).toBe(0)
    })

    it('compares older vs newer versions', () => {
      expect(compareVersions('2026.9.0', '2026.10.0')).toBe(-1)
      expect(compareVersions('2026.10.0', '2026.9.0')).toBe(1)
      expect(compareVersions('2024.12.9', '2026.1.0')).toBe(-1)
      expect(compareVersions('2026.1.0', '2024.12.9')).toBe(1)
    })

    it('compares patch versions', () => {
      expect(compareVersions('2026.10.0', '2026.10.1')).toBe(-1)
      expect(compareVersions('2026.10.2', '2026.10.1')).toBe(1)
    })

    it('handles differing segment lengths', () => {
      expect(compareVersions('2026.10', '2026.10.0')).toBe(0)
      expect(compareVersions('2026.10.1', '2026.10')).toBe(1)
      expect(compareVersions('2026.9', '2026.10.0')).toBe(-1)
    })
  })

  describe('candidates', () => {
    it('respects candidate order and deduplicates case-insensitively', () => {
      const deps: BinaryManagerDependencies = {
        exists: vi.fn(),
        execFile: vi.fn(),
        env: {
          LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
          PATH: 'C:\\Tools;C:\\CUSTOM;C:\\tools',
          'ProgramFiles(x86)': 'C:\\Program Files (x86)',
          ProgramFiles: 'C:\\Program Files'
        },
        getOverride: () => 'C:\\custom\\cloudflared.exe'
      }

      const mgr = new BinaryManager(deps)
      const cands = mgr.candidates()

      expect(cands).toEqual([
        {
          path: 'C:\\custom\\cloudflared.exe',
          source: 'override'
        },
        {
          path: 'C:\\Users\\alice\\AppData\\Local\\CloudflaredTunnelGUI\\bin\\cloudflared.exe',
          source: 'managed'
        },
        {
          path: 'C:\\Tools\\cloudflared.exe',
          source: 'path'
        },
        {
          path: 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
          source: 'programFiles'
        },
        {
          path: 'C:\\Program Files\\cloudflared\\cloudflared.exe',
          source: 'programFiles'
        }
      ])
    })

    it('omits override when not set or empty', () => {
      const deps: BinaryManagerDependencies = {
        exists: vi.fn(),
        execFile: vi.fn(),
        env: {
          LOCALAPPDATA: 'C:\\AppData',
          PATH: 'C:\\bin'
        },
        getOverride: () => undefined
      }

      const mgr = new BinaryManager(deps)
      const cands = mgr.candidates()

      expect(cands[0]).toEqual({
        path: 'C:\\AppData\\CloudflaredTunnelGUI\\bin\\cloudflared.exe',
        source: 'managed'
      })
      expect(cands[1]).toEqual({
        path: 'C:\\bin\\cloudflared.exe',
        source: 'path'
      })
      expect(cands).toHaveLength(2)
    })
  })

  describe('status', () => {
    it('returns candidate when override exists and parses version', async () => {
      const deps: BinaryManagerDependencies = {
        exists: vi.fn(async (p: string) => p === 'C:\\custom\\cloudflared.exe'),
        execFile: vi.fn(async () => ({
          stdout: 'cloudflared version 2026.10.0 (built 2026-10-05T08:39 UTC)',
          stderr: ''
        })),
        env: {
          LOCALAPPDATA: 'C:\\AppData',
          PATH: 'C:\\bin'
        },
        getOverride: () => 'C:\\custom\\cloudflared.exe'
      }

      const mgr = new BinaryManager(deps)
      const status = await mgr.status()

      expect(status).toEqual({
        found: true,
        path: 'C:\\custom\\cloudflared.exe',
        source: 'override',
        version: '2026.10.0',
        overrideInvalid: false
      })
      expect(deps.execFile).toHaveBeenCalledWith('C:\\custom\\cloudflared.exe', ['--version'], {
        timeout: 5000
      })
    })

    it('missing override falls through with overrideInvalid: true', async () => {
      const deps: BinaryManagerDependencies = {
        exists: vi.fn(async (p: string) => p === 'C:\\bin\\cloudflared.exe'),
        execFile: vi.fn(async () => ({
          stdout: 'cloudflared version 2026.10.0',
          stderr: ''
        })),
        env: {
          LOCALAPPDATA: 'C:\\AppData',
          PATH: 'C:\\bin'
        },
        getOverride: () => 'C:\\missing\\cloudflared.exe'
      }

      const mgr = new BinaryManager(deps)
      const status = await mgr.status()

      expect(status).toEqual({
        found: true,
        path: 'C:\\bin\\cloudflared.exe',
        source: 'path',
        version: '2026.10.0',
        overrideInvalid: true
      })
    })

    it('not found returns searched list and overrideInvalid: true if override was set', async () => {
      const deps: BinaryManagerDependencies = {
        exists: vi.fn(async () => false),
        execFile: vi.fn(),
        env: {
          LOCALAPPDATA: 'C:\\AppData',
          PATH: 'C:\\bin'
        },
        getOverride: () => 'C:\\missing\\cloudflared.exe'
      }

      const mgr = new BinaryManager(deps)
      const status = await mgr.status()

      expect(status).toEqual({
        found: false,
        searched: [
          'C:\\missing\\cloudflared.exe',
          'C:\\AppData\\CloudflaredTunnelGUI\\bin\\cloudflared.exe',
          'C:\\bin\\cloudflared.exe'
        ],
        overrideInvalid: true
      })
      expect(deps.execFile).not.toHaveBeenCalled()
    })

    it('not found returns overrideInvalid: false when override was not set', async () => {
      const deps: BinaryManagerDependencies = {
        exists: vi.fn(async () => false),
        execFile: vi.fn(),
        env: {
          LOCALAPPDATA: 'C:\\AppData',
          PATH: 'C:\\bin'
        },
        getOverride: () => undefined
      }

      const mgr = new BinaryManager(deps)
      const status = await mgr.status()

      expect(status).toEqual({
        found: false,
        searched: [
          'C:\\AppData\\CloudflaredTunnelGUI\\bin\\cloudflared.exe',
          'C:\\bin\\cloudflared.exe'
        ],
        overrideInvalid: false
      })
    })

    it('handles execFile failure gracefully with version: null', async () => {
      const deps: BinaryManagerDependencies = {
        exists: vi.fn(async () => true),
        execFile: vi.fn(async () => {
          throw new Error('Command timed out')
        }),
        env: {
          LOCALAPPDATA: 'C:\\AppData'
        },
        getOverride: () => undefined
      }

      const mgr = new BinaryManager(deps)
      const status = await mgr.status()

      expect(status).toEqual({
        found: true,
        path: 'C:\\AppData\\CloudflaredTunnelGUI\\bin\\cloudflared.exe',
        source: 'managed',
        version: null,
        overrideInvalid: false
      })
    })
  })

  describe('extractSha256', () => {
    it('extracts sha256 from markdown table line', () => {
      const text = `
## Checksums
| File | SHA-256 |
|---|---|
| cloudflared-windows-amd64.exe | 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 |
| cloudflared-linux-amd64 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
`
      expect(extractSha256(text, 'cloudflared-windows-amd64.exe')).toBe(
        '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
      )
    })

    it('extracts sha256 from colon/space separated line', () => {
      const text =
        'cloudflared-windows-amd64.exe: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
      expect(extractSha256(text)).toBe(
        '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
      )
    })

    it('extracts sha256 from standalone sha256 checksum file format', () => {
      const text =
        '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  cloudflared-windows-amd64.exe\n'
      expect(extractSha256(text)).toBe(
        '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
      )
    })

    it('returns null if filename not found or invalid sha', () => {
      expect(extractSha256('cloudflared-darwin-amd64.tgz 12345')).toBeNull()
      expect(extractSha256('')).toBeNull()
    })
  })

  describe('findWindowsAsset', () => {
    it('finds cloudflared-windows-amd64.exe asset case-insensitively', () => {
      const assets = [
        { name: 'cloudflared-linux-amd64', browser_download_url: 'https://example.com/linux' },
        {
          name: 'cloudflared-windows-amd64.exe',
          browser_download_url: 'https://example.com/windows'
        }
      ]
      expect(findWindowsAsset(assets)).toEqual({
        name: 'cloudflared-windows-amd64.exe',
        browser_download_url: 'https://example.com/windows'
      })
    })

    it('returns null when windows asset is missing', () => {
      expect(findWindowsAsset([])).toBeNull()
    })
  })

  describe('checkUpdate', () => {
    it('returns release info with isUpdateAvailable: true for newer version', async () => {
      const mockFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v2026.10.1',
          html_url: 'https://github.com/cloudflare/cloudflared/releases/tag/2026.10.1',
          published_at: '2026-10-14T00:00:00Z',
          body: '| cloudflared-windows-amd64.exe | 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 |',
          assets: [
            {
              name: 'cloudflared-windows-amd64.exe',
              browser_download_url: 'https://github.com/download/cloudflared-windows-amd64.exe'
            }
          ]
        })
      })) as unknown as typeof fetch

      const mgr = new BinaryManager({
        exists: vi.fn(),
        execFile: vi.fn(),
        env: {},
        getOverride: () => undefined,
        fetchFn: mockFetch
      })

      const release = await mgr.checkUpdate('2026.10.0')
      expect(release).toEqual({
        version: '2026.10.1',
        releaseUrl: 'https://github.com/cloudflare/cloudflared/releases/tag/2026.10.1',
        publishedAt: '2026-10-14T00:00:00Z',
        downloadUrl: 'https://github.com/download/cloudflared-windows-amd64.exe',
        sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        hasChecksum: true,
        isUpdateAvailable: true
      })
    })

    it('returns isUpdateAvailable: false for equal or older version', async () => {
      const mockFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: '2026.10.0',
          html_url: 'https://github.com/releases/2026.10.0',
          body: '',
          assets: [
            {
              name: 'cloudflared-windows-amd64.exe',
              browser_download_url: 'https://github.com/download/cloudflared-windows-amd64.exe'
            }
          ]
        })
      })) as unknown as typeof fetch

      const mgr = new BinaryManager({
        exists: vi.fn(),
        execFile: vi.fn(),
        env: {},
        getOverride: () => undefined,
        fetchFn: mockFetch
      })

      const release = await mgr.checkUpdate('2026.10.0')
      expect(release.isUpdateAvailable).toBe(false)
      expect(release.hasChecksum).toBe(false)
    })

    it('throws when windows asset is missing from release', async () => {
      const mockFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: '2026.10.1',
          html_url: 'https://github.com/releases/2026.10.1',
          assets: []
        })
      })) as unknown as typeof fetch

      const mgr = new BinaryManager({
        exists: vi.fn(),
        execFile: vi.fn(),
        env: {},
        getOverride: () => undefined,
        fetchFn: mockFetch
      })

      await expect(mgr.checkUpdate()).rejects.toThrow(
        'cloudflared-windows-amd64.exe asset not found'
      )
    })
  })

  describe('download', () => {
    it('downloads binary, validates sha256, and reports progress', async () => {
      const fakeBinaryContent = Buffer.from('fake-cloudflared-exe-content-12345')
      const fakeSha256 = crypto.createHash('sha256').update(fakeBinaryContent).digest('hex')

      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes('releases/latest')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              tag_name: '2026.10.5',
              html_url: 'https://github.com/releases/2026.10.5',
              body: `cloudflared-windows-amd64.exe: ${fakeSha256}`,
              assets: [
                {
                  name: 'cloudflared-windows-amd64.exe',
                  browser_download_url: 'https://github.com/download/cloudflared-windows-amd64.exe'
                }
              ]
            })
          }
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(fakeBinaryContent.length) }),
          arrayBuffer: async () =>
            fakeBinaryContent.buffer.slice(
              fakeBinaryContent.byteOffset,
              fakeBinaryContent.byteOffset + fakeBinaryContent.byteLength
            )
        }
      }) as unknown as typeof fetch

      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'binary-mgr-test-'))

      const mgr = new BinaryManager({
        exists: vi.fn(async () => false),
        execFile: vi.fn(),
        env: {
          LOCALAPPDATA: tempDir
        },
        getOverride: () => undefined,
        fetchFn: mockFetch
      })

      const progressEvents: DownloadProgressPayload[] = []
      const targetPath = await mgr.download({
        onProgress: (p) => progressEvents.push(p)
      })

      expect(targetPath).toContain('cloudflared.exe')
      expect(progressEvents.length).toBeGreaterThan(0)
      expect(progressEvents[progressEvents.length - 1].percent).toBe(100)

      const exists = await fs.promises
        .access(targetPath)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)

      await fs.promises.rm(tempDir, { recursive: true, force: true })
    })

    it('rejects download when checksum mismatch occurs', async () => {
      const fakeBinaryContent = Buffer.from('bad-content')
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes('releases/latest')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              tag_name: '2026.10.5',
              html_url: 'https://github.com/releases/2026.10.5',
              body: `cloudflared-windows-amd64.exe: 0000000000000000000000000000000000000000000000000000000000000000`,
              assets: [
                {
                  name: 'cloudflared-windows-amd64.exe',
                  browser_download_url: 'https://github.com/download/cloudflared-windows-amd64.exe'
                }
              ]
            })
          }
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(fakeBinaryContent.length) }),
          arrayBuffer: async () =>
            fakeBinaryContent.buffer.slice(
              fakeBinaryContent.byteOffset,
              fakeBinaryContent.byteOffset + fakeBinaryContent.byteLength
            )
        }
      }) as unknown as typeof fetch

      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'binary-mgr-test-fail-'))

      const mgr = new BinaryManager({
        exists: vi.fn(async () => false),
        execFile: vi.fn(),
        env: {
          LOCALAPPDATA: tempDir
        },
        getOverride: () => undefined,
        fetchFn: mockFetch
      })

      await expect(mgr.download()).rejects.toThrow('Checksum verification failed')
      await fs.promises.rm(tempDir, { recursive: true, force: true })
    })

    it('requires confirmation when checksum is missing', async () => {
      const mockFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: '2026.10.5',
          html_url: 'https://github.com/releases/2026.10.5',
          body: 'No checksums provided in this release notes',
          assets: [
            {
              name: 'cloudflared-windows-amd64.exe',
              browser_download_url: 'https://github.com/download/cloudflared-windows-amd64.exe'
            }
          ]
        })
      })) as unknown as typeof fetch

      const mgr = new BinaryManager({
        exists: vi.fn(),
        execFile: vi.fn(),
        env: {
          LOCALAPPDATA: 'C:\\test'
        },
        getOverride: () => undefined,
        fetchFn: mockFetch
      })

      await expect(mgr.download()).rejects.toThrow(
        'No SHA-256 checksum found for this release. Confirmation required'
      )
    })
  })
})
