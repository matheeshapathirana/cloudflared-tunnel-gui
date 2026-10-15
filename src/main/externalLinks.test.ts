import { describe, it, expect } from 'vitest'
import { isAllowedExternalUrl } from './externalLinks'

describe('isAllowedExternalUrl', () => {
  it('allows quick tunnel URLs (the Open button)', () => {
    expect(
      isAllowedExternalUrl('https://experienced-currencies-corporations-seminars.trycloudflare.com')
    ).toBe(true)
    expect(isAllowedExternalUrl('https://a-b.trycloudflare.com/some/path?x=1')).toBe(true)
  })

  it('allows the Cloudflare dashboard, docs and GitHub', () => {
    expect(isAllowedExternalUrl('https://dash.cloudflare.com/profile/api-tokens')).toBe(true)
    expect(isAllowedExternalUrl('https://developers.cloudflare.com/cloudflare-one/')).toBe(true)
    expect(isAllowedExternalUrl('https://github.com/cloudflare/cloudflared/releases')).toBe(true)
  })

  it('rejects look-alike hosts, other protocols and embedded credentials', () => {
    for (const url of [
      'https://evil-trycloudflare.com',
      'https://trycloudflare.com.evil.example',
      'https://trycloudflare.com',
      'http://abc.trycloudflare.com',
      'https://user:pass@abc.trycloudflare.com',
      'https://abc.trycloudflare.com@evil.example',
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'ms-msdt:/id',
      'https://example.com',
      'not a url',
      ''
    ]) {
      expect(isAllowedExternalUrl(url), url).toBe(false)
    }
  })
})
