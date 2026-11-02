import { describe, it, expect } from 'vitest'
import { commands } from './ipc'

describe('ipc command schemas', () => {
  describe('remote.updateHostname schema', () => {
    const validPayload = {
      tunnelId: 'tunnel-uuid-1',
      hostname: 'app.example.com',
      path: '/api',
      newHostname: 'new.example.com',
      zoneId: 'zone-123',
      service: 'http://localhost:3000',
      noTlsVerify: true
    }

    it('accepts a fully populated valid payload', () => {
      const res = commands['remote.updateHostname'].input.safeParse(validPayload)
      expect(res.success).toBe(true)
      if (res.success) {
        expect(res.data).toEqual(validPayload)
      }
    })

    it('accepts payload without optional path and zoneId', () => {
      const minimalPayload = {
        tunnelId: validPayload.tunnelId,
        hostname: validPayload.hostname,
        newHostname: validPayload.newHostname,
        service: validPayload.service,
        noTlsVerify: validPayload.noTlsVerify
      }
      const res = commands['remote.updateHostname'].input.safeParse(minimalPayload)
      expect(res.success).toBe(true)
      if (res.success) {
        expect(res.data.path).toBeUndefined()
        expect(res.data.zoneId).toBeUndefined()
        expect(res.data.hostname).toBe('app.example.com')
        expect(res.data.newHostname).toBe('new.example.com')
        expect(res.data.service).toBe('http://localhost:3000')
        expect(res.data.noTlsVerify).toBe(true)
      }
    })

    it('rejects empty hostname', () => {
      const res = commands['remote.updateHostname'].input.safeParse({
        ...validPayload,
        hostname: ''
      })
      expect(res.success).toBe(false)
    })

    it('rejects empty newHostname', () => {
      const res = commands['remote.updateHostname'].input.safeParse({
        ...validPayload,
        newHostname: ''
      })
      expect(res.success).toBe(false)
    })

    it('rejects empty service', () => {
      const res = commands['remote.updateHostname'].input.safeParse({
        ...validPayload,
        service: ''
      })
      expect(res.success).toBe(false)
    })

    it('rejects missing or non-boolean noTlsVerify', () => {
      const missingTls = {
        tunnelId: validPayload.tunnelId,
        hostname: validPayload.hostname,
        newHostname: validPayload.newHostname,
        service: validPayload.service
      }
      expect(commands['remote.updateHostname'].input.safeParse(missingTls).success).toBe(false)
      expect(
        commands['remote.updateHostname'].input.safeParse({
          ...validPayload,
          noTlsVerify: 'true' as unknown as boolean
        }).success
      ).toBe(false)
    })

    it('validates output schema as void (undefined)', () => {
      expect(commands['remote.updateHostname'].output.safeParse(undefined).success).toBe(true)
      expect(commands['remote.updateHostname'].output.safeParse('not-void').success).toBe(false)
    })
  })
})
