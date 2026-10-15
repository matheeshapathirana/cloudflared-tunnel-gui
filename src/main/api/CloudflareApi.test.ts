import { describe, it, expect, vi } from 'vitest'
import { CloudflareApi } from './CloudflareApi'
import { AppErrorException } from '../../shared/result'

function jsonResponse(data: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(data), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' }
  })
}

function textResponse(text: string, status = 200, statusText = 'OK'): Response {
  return new Response(text, {
    status,
    statusText,
    headers: { 'Content-Type': 'text/plain' }
  })
}

describe('CloudflareApi', () => {
  const token = 'test-cf-token-abc'
  const accountId = 'acc-123'
  const zoneId = 'zone-456'
  const tunnelId = 'tun-789'

  describe('verifyToken', () => {
    it('returns valid true and id when token is verified successfully', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          errors: [],
          messages: [],
          result: { id: 'token-id-999', status: 'active' }
        })
      )

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      const res = await api.verifyToken(token)

      expect(res).toEqual({ valid: true, id: 'token-id-999' })
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/user/tokens/verify',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`
          })
        })
      )
    })

    it('returns valid false when API returns 401 unauthorized', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            errors: [{ code: 1000, message: 'Invalid API Token' }],
            messages: []
          },
          401,
          'Unauthorized'
        )
      )

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      const res = await api.verifyToken(token)

      expect(res).toEqual({ valid: false, error: 'Invalid API Token' })
    })

    it('returns valid false when API returns 200 with success: false', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          success: false,
          errors: [{ code: 1001, message: 'This token has expired' }],
          messages: []
        })
      )

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      const res = await api.verifyToken(token)

      expect(res).toEqual({ valid: false, error: 'This token has expired' })
    })

    it('throws AppErrorException INTERNAL when endpoint fails with 500', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            errors: [{ message: 'Internal Server Error' }]
          },
          500,
          'Internal Server Error'
        )
      )

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      await expect(api.verifyToken(token)).rejects.toThrow('Internal Server Error')
    })
  })

  describe('listAccounts & listZones', () => {
    it('listAccounts fetches and maps account records', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          result: [
            { id: 'acc-1', name: 'Personal Account', type: 'standard' },
            { id: 'acc-2', name: 'Work Account' }
          ]
        })
      )

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      const accounts = await api.listAccounts(token)

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: `Bearer ${token}` })
        })
      )
      expect(accounts).toEqual([
        { id: 'acc-1', name: 'Personal Account', type: 'standard' },
        { id: 'acc-2', name: 'Work Account', type: 'standard' }
      ])
    })

    it('listZones queries zones for specific account with status=active', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          result: [
            { id: 'zone-1', name: 'example.com', status: 'active' },
            { id: 'zone-2', name: 'mysite.dev', status: 'active' }
          ]
        })
      )

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      const zones = await api.listZones(token, accountId)

      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.cloudflare.com/client/v4/zones?account.id=${accountId}&status=active&per_page=50`,
        expect.anything()
      )
      expect(zones).toEqual([
        { id: 'zone-1', name: 'example.com', status: 'active' },
        { id: 'zone-2', name: 'mysite.dev', status: 'active' }
      ])
    })
  })

  describe('listTunnels', () => {
    it('listTunnels queries non-deleted tunnels and normalizes configSrc', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          result: [
            {
              id: 'tun-1',
              name: 'web-app',
              status: 'healthy',
              config_src: 'cloudflare'
            },
            {
              id: 'tun-2',
              name: 'local-app',
              status: 'inactive',
              configSrc: 'local'
            }
          ]
        })
      )

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      const tunnels = await api.listTunnels(token, accountId)

      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel?is_deleted=false`,
        expect.anything()
      )
      expect(tunnels).toEqual([
        { id: 'tun-1', name: 'web-app', status: 'healthy', configSrc: 'cloudflare' },
        { id: 'tun-2', name: 'local-app', status: 'inactive', configSrc: 'local' }
      ])
    })
  })

  describe('createTunnel & catch-all rule initialization', () => {
    it('createTunnel calls POST then initializes configuration with catch-all 404 rule', async () => {
      const mockFetch = vi
        .fn()
        // First call: POST cfd_tunnel
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            result: {
              id: 'tun-new-1',
              name: 'prod-tunnel',
              credentials_file: { AccountTag: accountId, TunnelID: 'tun-new-1' }
            }
          })
        )
        // Second call: PUT configurations with catch-all
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            result: {}
          })
        )

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      const created = await api.createTunnel(token, accountId, 'prod-tunnel')

      expect(created.id).toBe('tun-new-1')
      expect(created.name).toBe('prod-tunnel')
      expect(created.credentialsFile).toContain('AccountTag')

      expect(mockFetch).toHaveBeenCalledTimes(2)

      // Verify POST call
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'prod-tunnel', config_src: 'cloudflare' })
        })
      )

      // Verify PUT configurations call with catch-all
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/tun-new-1/configurations`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            config: {
              ingress: [{ service: 'http_status:404' }]
            }
          })
        })
      )
    })
  })

  describe('deleteTunnel & getTunnelToken', () => {
    it('deleteTunnel sends DELETE request to tunnel endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: {} }))

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      await api.deleteTunnel(token, accountId, tunnelId)

      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}`,
        expect.objectContaining({ method: 'DELETE' })
      )
    })

    it('getTunnelToken returns base64 token string', async () => {
      const tokenResult = 'eyJhIjoiMTIzNCIsInQiOiI1Njc4In0='
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          result: tokenResult
        })
      )

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      const result = await api.getTunnelToken(token, accountId, tunnelId)

      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`,
        expect.anything()
      )
      expect(result).toBe(tokenResult)
    })
  })

  describe('getConfiguration & putConfiguration', () => {
    it('getConfiguration returns ingress rules from config.ingress', async () => {
      const rules = [
        { hostname: 'api.example.com', service: 'http://localhost:8080' },
        { service: 'http_status:404' }
      ]
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          result: {
            config: {
              ingress: rules
            }
          }
        })
      )

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      const config = await api.getConfiguration(token, accountId, tunnelId)

      expect(config.ingress).toEqual(rules)
    })

    it('getConfiguration handles missing config or empty ingress gracefully', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          result: {}
        })
      )

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      const config = await api.getConfiguration(token, accountId, tunnelId)

      expect(config.ingress).toEqual([])
    })

    it('putConfiguration enforces catch-all rule if omitted', async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: {} }))

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      await api.putConfiguration(token, accountId, tunnelId, [
        { hostname: 'api.example.com', service: 'http://localhost:8080' }
      ])

      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            config: {
              ingress: [
                { hostname: 'api.example.com', service: 'http://localhost:8080' },
                { service: 'http_status:404' }
              ]
            }
          })
        })
      )
    })

    it('putConfiguration does not append redundant catch-all if already present', async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: {} }))

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      const inputRules = [
        { hostname: 'api.example.com', service: 'http://localhost:8080' },
        { service: 'http_status:404' }
      ]
      await api.putConfiguration(token, accountId, tunnelId, inputRules)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: JSON.stringify({
            config: {
              ingress: inputRules
            }
          })
        })
      )
    })
  })

  describe('listDnsRecords, createDnsCname, deleteDnsRecord', () => {
    it('listDnsRecords queries CNAME records with optional hostname filter', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        jsonResponse({
          success: true,
          result: [
            {
              id: 'rec-1',
              name: 'app.example.com',
              type: 'CNAME',
              content: `${tunnelId}.cfargotunnel.com`,
              proxied: true
            }
          ]
        })
      )

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      const recordsWithoutName = await api.listDnsRecords(token, zoneId)
      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=CNAME`,
        expect.anything()
      )
      expect(recordsWithoutName).toHaveLength(1)
      expect(recordsWithoutName[0].proxied).toBe(true)

      await api.listDnsRecords(token, zoneId, 'app.example.com')
      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=CNAME&name=app.example.com`,
        expect.anything()
      )
    })

    it('createDnsCname creates a proxied CNAME record', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          result: { id: 'rec-new-123' }
        })
      )

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      const res = await api.createDnsCname(
        token,
        zoneId,
        'app.example.com',
        `${tunnelId}.cfargotunnel.com`
      )

      expect(res).toEqual({ id: 'rec-new-123' })
      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            type: 'CNAME',
            name: 'app.example.com',
            content: `${tunnelId}.cfargotunnel.com`,
            proxied: true,
            ttl: 1
          })
        })
      )
    })

    it('deleteDnsRecord calls DELETE on DNS record endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: {} }))

      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)
      await api.deleteDnsRecord(token, zoneId, 'rec-123')

      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/rec-123`,
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('Error Mapping', () => {
    it('maps 401 and 403 to UNAUTHORIZED AppErrorException', async () => {
      const mockFetch401 = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            errors: [{ code: 1000, message: 'Invalid token authentication' }]
          },
          401,
          'Unauthorized'
        )
      )
      const api401 = new CloudflareApi(mockFetch401 as unknown as typeof fetch)

      await expect(api401.listAccounts(token)).rejects.toSatisfy((err: unknown) => {
        return err instanceof AppErrorException && err.code === 'UNAUTHORIZED'
      })

      const mockFetch403 = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }]
          },
          403,
          'Forbidden'
        )
      )
      const api403 = new CloudflareApi(mockFetch403 as unknown as typeof fetch)

      await expect(api403.listAccounts(token)).rejects.toSatisfy((err: unknown) => {
        return err instanceof AppErrorException && err.code === 'UNAUTHORIZED'
      })
    })

    it('maps 404 to NOT_FOUND AppErrorException', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            errors: [{ message: 'Tunnel not found' }]
          },
          404,
          'Not Found'
        )
      )
      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)

      await expect(api.deleteTunnel(token, accountId, 'nonexistent')).rejects.toSatisfy(
        (err: unknown) => {
          return (
            err instanceof AppErrorException &&
            err.code === 'NOT_FOUND' &&
            err.message.includes('Tunnel not found')
          )
        }
      )
    })

    it('maps 400 and 422 to VALIDATION AppErrorException', async () => {
      const mockFetch400 = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            errors: [{ message: 'Invalid tunnel name format' }]
          },
          400,
          'Bad Request'
        )
      )
      const api400 = new CloudflareApi(mockFetch400 as unknown as typeof fetch)

      await expect(api400.createTunnel(token, accountId, 'invalid name!')).rejects.toSatisfy(
        (err: unknown) => {
          return (
            err instanceof AppErrorException &&
            err.code === 'VALIDATION' &&
            err.message.includes('Invalid tunnel name')
          )
        }
      )

      const mockFetch422 = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            errors: [{ message: 'CNAME record already exists' }]
          },
          422,
          'Unprocessable Entity'
        )
      )
      const api422 = new CloudflareApi(mockFetch422 as unknown as typeof fetch)

      await expect(
        api422.createDnsCname(token, zoneId, 'app.example.com', 'target.com')
      ).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof AppErrorException &&
          err.code === 'VALIDATION' &&
          err.message.includes('CNAME record already exists')
        )
      })
    })

    it('maps 429 and 500 to INTERNAL AppErrorException', async () => {
      const mockFetch429 = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            errors: [{ message: 'Rate limit exceeded' }]
          },
          429,
          'Too Many Requests'
        )
      )
      const api429 = new CloudflareApi(mockFetch429 as unknown as typeof fetch)

      await expect(api429.listAccounts(token)).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof AppErrorException &&
          err.code === 'INTERNAL' &&
          err.message.includes('Rate limit exceeded')
        )
      })

      const mockFetch500 = vi
        .fn()
        .mockResolvedValue(textResponse('Bad Gateway from Cloudflare edge', 502, 'Bad Gateway'))
      const api500 = new CloudflareApi(mockFetch500 as unknown as typeof fetch)

      await expect(api500.listAccounts(token)).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof AppErrorException &&
          err.code === 'INTERNAL' &&
          err.message.includes('Bad Gateway')
        )
      })
    })

    it('handles network throw by wrapping in INTERNAL AppErrorException', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.cloudflare.com'))
      const api = new CloudflareApi(mockFetch as unknown as typeof fetch)

      await expect(api.listAccounts(token)).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof AppErrorException &&
          err.code === 'INTERNAL' &&
          err.message.includes('getaddrinfo ENOTFOUND')
        )
      })
    })
  })
})
