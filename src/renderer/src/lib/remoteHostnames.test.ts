import { describe, it, expect } from 'vitest'
import {
  normalizeServiceUrl,
  findZoneForHostname,
  subdomainFor,
  computeHostname,
  getRowKey
} from './remoteHostnames'

describe('remoteHostnames helpers', () => {
  describe('normalizeServiceUrl', () => {
    it('trims input', () => {
      expect(normalizeServiceUrl('  8080  ')).toBe('http://localhost:8080')
      expect(normalizeServiceUrl('  localhost:3000  ')).toBe('http://localhost:3000')
      expect(normalizeServiceUrl('  https://example.com  ')).toBe('https://example.com')
    })

    it('prepends http://localhost: for digits-only strings', () => {
      expect(normalizeServiceUrl('3000')).toBe('http://localhost:3000')
      expect(normalizeServiceUrl('80')).toBe('http://localhost:80')
    })

    it('returns string unchanged if it has any scheme:// prefix', () => {
      expect(normalizeServiceUrl('http://localhost:3000')).toBe('http://localhost:3000')
      expect(normalizeServiceUrl('https://example.com')).toBe('https://example.com')
      expect(normalizeServiceUrl('tcp://localhost:22')).toBe('tcp://localhost:22')
      expect(normalizeServiceUrl('rdp://localhost:3389')).toBe('rdp://localhost:3389')
      expect(normalizeServiceUrl('ssh://localhost:22')).toBe('ssh://localhost:22')
      expect(normalizeServiceUrl('custom-v1.0+test://app')).toBe('custom-v1.0+test://app')
    })

    it('returns string unchanged if it matches unix: or unix+tls: prefixes', () => {
      expect(normalizeServiceUrl('unix:/var/run/app.sock')).toBe('unix:/var/run/app.sock')
      expect(normalizeServiceUrl('unix+tls:/var/run/app.sock')).toBe('unix+tls:/var/run/app.sock')
      expect(normalizeServiceUrl('UNIX:/path/to/socket')).toBe('UNIX:/path/to/socket')
      expect(normalizeServiceUrl('UNIX+TLS:/path/to/socket')).toBe('UNIX+TLS:/path/to/socket')
    })

    it('returns string unchanged if it matches http_status: prefix', () => {
      expect(normalizeServiceUrl('http_status:404')).toBe('http_status:404')
      expect(normalizeServiceUrl('HTTP_STATUS:500')).toBe('HTTP_STATUS:500')
    })

    it('returns hello_world and bastion unchanged', () => {
      expect(normalizeServiceUrl('hello_world')).toBe('hello_world')
      expect(normalizeServiceUrl('bastion')).toBe('bastion')
    })

    it('prepends http:// to anything else', () => {
      expect(normalizeServiceUrl('localhost:3000')).toBe('http://localhost:3000')
      expect(normalizeServiceUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
      expect(normalizeServiceUrl('api.local')).toBe('http://api.local')
    })

    it('handles negative cases for special keywords and digits', () => {
      // hello_world / bastion with suffixes are not exact matches
      expect(normalizeServiceUrl('hello_world_app')).toBe('http://hello_world_app')
      expect(normalizeServiceUrl('bastion_host')).toBe('http://bastion_host')
      // Non-digits are not ports
      expect(normalizeServiceUrl('3000a')).toBe('http://3000a')
    })
  })

  describe('findZoneForHostname', () => {
    const zones = [
      { id: 'z1', name: 'example.com' },
      { id: 'z2', name: 'sub.example.com' },
      { id: 'z3', name: 'otherdomain.org' }
    ]

    it('matches exact zone name (apex)', () => {
      const match = findZoneForHostname('example.com', zones)
      expect(match).toEqual({ id: 'z1', name: 'example.com' })
    })

    it('matches subdomain of a zone', () => {
      const match = findZoneForHostname('blog.example.com', zones)
      expect(match).toEqual({ id: 'z1', name: 'example.com' })
    })

    it('picks the longest matching zone when multiple zones match', () => {
      const match = findZoneForHostname('app.sub.example.com', zones)
      expect(match).toEqual({ id: 'z2', name: 'sub.example.com' })
    })

    it('does not match hostname ending with zone name without leading dot', () => {
      expect(findZoneForHostname('notexample.com', zones)).toBeUndefined()
      expect(findZoneForHostname('fakeexample.com', zones)).toBeUndefined()
    })

    it('returns undefined if hostname has zone name as prefix or infix only', () => {
      expect(findZoneForHostname('example.com.org', zones)).toBeUndefined()
      expect(findZoneForHostname('example.com.net', zones)).toBeUndefined()
    })

    it('returns undefined if no zones match or zones list is empty', () => {
      expect(findZoneForHostname('unknown.io', zones)).toBeUndefined()
      expect(findZoneForHostname('example.com', [])).toBeUndefined()
    })
  })

  describe('subdomainFor', () => {
    it('returns empty string for apex', () => {
      expect(subdomainFor('example.com', 'example.com')).toBe('')
    })

    it('returns prefix without zone name for subdomains', () => {
      expect(subdomainFor('app.example.com', 'example.com')).toBe('app')
      expect(subdomainFor('sub.app.example.com', 'example.com')).toBe('sub.app')
    })

    it('returns prefix for longer zone match', () => {
      expect(subdomainFor('api.sub.example.com', 'sub.example.com')).toBe('api')
    })

    it('returns hostname if zone does not match', () => {
      expect(subdomainFor('unrelated.org', 'example.com')).toBe('unrelated.org')
    })
  })

  describe('computeHostname', () => {
    it('returns apex when subdomain is empty or whitespace', () => {
      expect(computeHostname('', 'example.com')).toBe('example.com')
      expect(computeHostname('   ', 'example.com')).toBe('example.com')
    })

    it('returns apex when subdomain is @', () => {
      expect(computeHostname('@', 'example.com')).toBe('example.com')
      expect(computeHostname('  @  ', 'example.com')).toBe('example.com')
    })

    it('prepends subdomain when not apex', () => {
      expect(computeHostname('app', 'example.com')).toBe('app.example.com')
      expect(computeHostname('  api  ', 'example.com')).toBe('api.example.com')
      expect(computeHostname('sub.dev', 'example.com')).toBe('sub.dev.example.com')
    })

    it('returns subdomain unchanged if it already ends with .zoneName', () => {
      expect(computeHostname('app.example.com', 'example.com')).toBe('app.example.com')
      expect(computeHostname('  sub.example.com  ', 'example.com')).toBe('sub.example.com')
    })

    it('returns empty string if zoneName is empty', () => {
      expect(computeHostname('app', '')).toBe('')
      expect(computeHostname('@', '')).toBe('')
    })
  })

  describe('getRowKey', () => {
    it('combines hostname and empty path when path is undefined', () => {
      expect(getRowKey({ hostname: 'app.example.com' })).toBe('app.example.com::')
    })

    it('combines hostname and path when path is present', () => {
      expect(getRowKey({ hostname: 'app.example.com', path: '/api' })).toBe('app.example.com::/api')
    })

    it('treats empty string path identically to undefined path', () => {
      expect(getRowKey({ hostname: 'app.example.com', path: '' })).toBe('app.example.com::')
    })

    it('produces unique keys for identical hostnames with distinct paths', () => {
      const rootKey = getRowKey({ hostname: 'app.example.com' })
      const apiKey = getRowKey({ hostname: 'app.example.com', path: '/api' })
      const authKey = getRowKey({ hostname: 'app.example.com', path: '/auth' })
      expect(rootKey).not.toBe(apiKey)
      expect(apiKey).not.toBe(authKey)
      expect(rootKey).not.toBe(authKey)
    })
  })
})
