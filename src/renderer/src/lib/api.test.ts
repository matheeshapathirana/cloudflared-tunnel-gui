import { describe, expect, it } from 'vitest'
import type { BinaryRelease, BinaryStatus } from '@shared/schemas'
import { releaseAfterInstall } from './api'

const release: BinaryRelease = {
  version: '2026.10.4',
  releaseUrl: 'https://github.com/cloudflare/cloudflared/releases/tag/2026.10.4',
  downloadUrl:
    'https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-windows-amd64.exe',
  hasChecksum: true,
  isUpdateAvailable: true
}

const active = (version: string | null): BinaryStatus => ({
  found: true,
  path: 'C:\\Users\\u\\AppData\\Local\\CloudflaredTunnelGUI\\bin\\cloudflared.exe',
  source: 'managed',
  version,
  overrideInvalid: false
})

describe('releaseAfterInstall', () => {
  it('stops offering the release once the active binary is that version', () => {
    expect(releaseAfterInstall(release, active('2026.10.4'))).toEqual({
      ...release,
      isUpdateAvailable: false
    })
  })

  it('keeps offering it when another binary is still the active one', () => {
    expect(releaseAfterInstall(release, active('2026.10.0'))).toBe(release)
    expect(releaseAfterInstall(release, active(null))).toBe(release)
    expect(
      releaseAfterInstall(release, { found: false, searched: [], overrideInvalid: false })
    ).toBe(release)
  })

  it('leaves an empty cache empty', () => {
    expect(releaseAfterInstall(undefined, active('2026.10.4'))).toBeUndefined()
  })
})
