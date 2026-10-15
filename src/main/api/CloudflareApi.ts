import type { IngressRule } from '../../shared/schemas'
import { AppErrorException } from '../../shared/result'

export interface ICloudflareApi {
  verifyToken(token: string): Promise<{ valid: boolean; id?: string; error?: string }>
  listAccounts(token: string): Promise<Array<{ id: string; name: string; type: string }>>
  listZones(
    token: string,
    accountId: string
  ): Promise<Array<{ id: string; name: string; status: string }>>
  listTunnels(
    token: string,
    accountId: string
  ): Promise<Array<{ id: string; name: string; status: string; configSrc: string }>>
  createTunnel(
    token: string,
    accountId: string,
    name: string
  ): Promise<{ id: string; name: string; credentialsFile: string }>
  deleteTunnel(token: string, accountId: string, tunnelId: string): Promise<void>
  getTunnelToken(token: string, accountId: string, tunnelId: string): Promise<string>
  getConfiguration(
    token: string,
    accountId: string,
    tunnelId: string
  ): Promise<{ ingress: IngressRule[] }>
  putConfiguration(
    token: string,
    accountId: string,
    tunnelId: string,
    ingress: IngressRule[]
  ): Promise<void>
  listDnsRecords(
    token: string,
    zoneId: string,
    name?: string
  ): Promise<Array<{ id: string; name: string; type: string; content: string; proxied: boolean }>>
  createDnsCname(
    token: string,
    zoneId: string,
    hostname: string,
    target: string
  ): Promise<{ id: string }>
  deleteDnsRecord(token: string, zoneId: string, recordId: string): Promise<void>
}

interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

interface CfEnvelope<T> {
  success?: boolean
  errors?: Array<{ code?: number; message: string }>
  messages?: Array<{ code?: number; message: string }>
  result?: T
}

export class CloudflareApi implements ICloudflareApi {
  constructor(
    private fetchFn: typeof fetch = fetch,
    private baseUrl: string = 'https://api.cloudflare.com/client/v4'
  ) {}

  private async request<T>(
    token: string,
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }

    let response: Response
    try {
      response = await this.fetchFn(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined
      })
    } catch (err: unknown) {
      throw new AppErrorException(
        'INTERNAL',
        `Cloudflare API request failed: ${(err as Error).message || String(err)}`
      )
    }

    const text = await response.text()
    let envelope: CfEnvelope<T> | null = null
    if (text) {
      try {
        envelope = JSON.parse(text)
      } catch {
        envelope = null
      }
    }

    if (!response.ok) {
      const errorMsg =
        envelope?.errors
          ?.map((e) => e.message)
          .filter(Boolean)
          .join('; ') ||
        (text && !envelope
          ? text
          : `Cloudflare API error (${response.status}: ${response.statusText})`)

      if (response.status === 401 || response.status === 403) {
        throw new AppErrorException('UNAUTHORIZED', errorMsg)
      }
      if (response.status === 404) {
        throw new AppErrorException('NOT_FOUND', errorMsg)
      }
      if (response.status === 400 || response.status === 422) {
        throw new AppErrorException('VALIDATION', errorMsg)
      }
      throw new AppErrorException('INTERNAL', errorMsg)
    }

    if (envelope && envelope.success === false) {
      const errorMsg =
        envelope.errors
          ?.map((e) => e.message)
          .filter(Boolean)
          .join('; ') || 'Cloudflare API operation was unsuccessful'
      throw new AppErrorException('INTERNAL', errorMsg)
    }

    if (envelope && envelope.result !== undefined) {
      return envelope.result
    }

    return (envelope ?? ({} as unknown)) as T
  }

  async verifyToken(token: string): Promise<{ valid: boolean; id?: string; error?: string }> {
    const url = `${this.baseUrl}/user/tokens/verify`
    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      })

      const text = await response.text()
      let envelope: CfEnvelope<{ id: string; status: string }> | null = null
      try {
        envelope = JSON.parse(text)
      } catch {
        envelope = null
      }

      if (response.status === 401 || response.status === 403) {
        const errorMsg =
          envelope?.errors
            ?.map((e) => e.message)
            .filter(Boolean)
            .join('; ') || 'Invalid or unauthorized Cloudflare API token'
        return { valid: false, error: errorMsg }
      }

      if (!response.ok) {
        const errorMsg =
          envelope?.errors
            ?.map((e) => e.message)
            .filter(Boolean)
            .join('; ') || `Verification failed (${response.status})`
        if (response.status === 404) {
          throw new AppErrorException('NOT_FOUND', errorMsg)
        }
        if (response.status === 400 || response.status === 422) {
          throw new AppErrorException('VALIDATION', errorMsg)
        }
        throw new AppErrorException('INTERNAL', errorMsg)
      }

      if (envelope && envelope.success === false) {
        const errorMsg =
          envelope.errors
            ?.map((e) => e.message)
            .filter(Boolean)
            .join('; ') || 'Invalid Cloudflare API token'
        return { valid: false, error: errorMsg }
      }

      return {
        valid: true,
        id: envelope?.result?.id
      }
    } catch (err: unknown) {
      if (err instanceof AppErrorException) {
        if (err.code === 'UNAUTHORIZED') {
          return { valid: false, error: err.message }
        }
        throw err
      }
      throw new AppErrorException(
        'INTERNAL',
        `Failed to verify Cloudflare token: ${(err as Error).message || String(err)}`
      )
    }
  }

  async listAccounts(token: string): Promise<Array<{ id: string; name: string; type: string }>> {
    interface AccountResult {
      id: string
      name: string
      type?: string
    }
    let direct: AccountResult[] = []
    try {
      const result = await this.request<AccountResult[]>(token, '/accounts')
      if (Array.isArray(result)) direct = result
    } catch (err) {
      // /accounts needs account-read access; fall through to the zones lookup below
      if (!(err instanceof AppErrorException && err.code === 'UNAUTHORIZED')) throw err
    }
    if (direct.length > 0) {
      return direct.map((a) => ({ id: a.id, name: a.name, type: a.type || 'standard' }))
    }
    return this.accountsFromZones(token)
  }

  /**
   * A token that can manage tunnels and DNS but cannot read account settings gets an empty list
   * from /accounts. Its zones still say which account they belong to, so use those.
   */
  private async accountsFromZones(
    token: string
  ): Promise<Array<{ id: string; name: string; type: string }>> {
    interface ZoneWithAccount {
      account?: { id?: string; name?: string }
    }
    const zones = await this.request<ZoneWithAccount[]>(token, '/zones?status=active&per_page=50')
    if (!Array.isArray(zones)) return []
    const byId = new Map<string, { id: string; name: string; type: string }>()
    for (const zone of zones) {
      const id = zone.account?.id
      if (id && !byId.has(id)) {
        byId.set(id, { id, name: zone.account?.name || id, type: 'standard' })
      }
    }
    return [...byId.values()]
  }

  async listZones(
    token: string,
    accountId: string
  ): Promise<Array<{ id: string; name: string; status: string }>> {
    interface ZoneResult {
      id: string
      name: string
      status: string
    }
    const result = await this.request<ZoneResult[]>(
      token,
      `/zones?account.id=${encodeURIComponent(accountId)}&status=active&per_page=50`
    )
    if (!Array.isArray(result)) return []
    return result.map((z) => ({
      id: z.id,
      name: z.name,
      status: z.status
    }))
  }

  async listTunnels(
    token: string,
    accountId: string
  ): Promise<Array<{ id: string; name: string; status: string; configSrc: string }>> {
    interface TunnelResult {
      id: string
      name: string
      status: string
      config_src?: string
      configSrc?: string
    }
    const result = await this.request<TunnelResult[]>(
      token,
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?is_deleted=false`
    )
    if (!Array.isArray(result)) return []
    return result.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      configSrc: t.config_src || t.configSrc || ''
    }))
  }

  async createTunnel(
    token: string,
    accountId: string,
    name: string
  ): Promise<{ id: string; name: string; credentialsFile: string }> {
    interface CreatedTunnelResult {
      id: string
      name: string
      credentials_file?: unknown
      credentialsFile?: string
    }

    const created = await this.request<CreatedTunnelResult>(
      token,
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`,
      {
        method: 'POST',
        body: {
          name,
          config_src: 'cloudflare'
        }
      }
    )

    // Initialize remote configuration with default catch-all rule
    await this.putConfiguration(token, accountId, created.id, [{ service: 'http_status:404' }])

    let creds = ''
    if (typeof created.credentials_file === 'string') {
      creds = created.credentials_file
    } else if (created.credentials_file) {
      creds = JSON.stringify(created.credentials_file)
    } else if (created.credentialsFile) {
      creds = created.credentialsFile
    }

    return {
      id: created.id,
      name: created.name,
      credentialsFile: creds
    }
  }

  async deleteTunnel(token: string, accountId: string, tunnelId: string): Promise<void> {
    await this.request(
      token,
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
      {
        method: 'DELETE'
      }
    )
  }

  async getTunnelToken(token: string, accountId: string, tunnelId: string): Promise<string> {
    const result = await this.request<unknown>(
      token,
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`
    )

    if (typeof result === 'string') {
      return result
    }
    if (result && typeof result === 'object' && 'token' in result) {
      return String((result as { token: unknown }).token ?? '')
    }
    return String(result ?? '')
  }

  async getConfiguration(
    token: string,
    accountId: string,
    tunnelId: string
  ): Promise<{ ingress: IngressRule[] }> {
    interface ConfigResult {
      config?: {
        ingress?: IngressRule[]
      }
    }

    const result = await this.request<ConfigResult>(
      token,
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`
    )

    const ingress = Array.isArray(result?.config?.ingress) ? result.config.ingress : []
    return { ingress }
  }

  async putConfiguration(
    token: string,
    accountId: string,
    tunnelId: string,
    ingress: IngressRule[]
  ): Promise<void> {
    const rules = [...ingress]
    const lastRule = rules[rules.length - 1]
    if (!lastRule || lastRule.service !== 'http_status:404') {
      rules.push({ service: 'http_status:404' })
    }

    await this.request(
      token,
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      {
        method: 'PUT',
        body: {
          config: {
            ingress: rules
          }
        }
      }
    )
  }

  async listDnsRecords(
    token: string,
    zoneId: string,
    name?: string
  ): Promise<Array<{ id: string; name: string; type: string; content: string; proxied: boolean }>> {
    interface DnsRecordResult {
      id: string
      name: string
      type: string
      content: string
      proxied?: boolean
    }

    const query = name ? `&name=${encodeURIComponent(name)}` : ''
    const result = await this.request<DnsRecordResult[]>(
      token,
      `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME${query}`
    )

    if (!Array.isArray(result)) return []
    return result.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      content: r.content,
      proxied: Boolean(r.proxied)
    }))
  }

  async createDnsCname(
    token: string,
    zoneId: string,
    hostname: string,
    target: string
  ): Promise<{ id: string }> {
    interface CreateDnsResult {
      id: string
    }

    const result = await this.request<CreateDnsResult>(
      token,
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      {
        method: 'POST',
        body: {
          type: 'CNAME',
          name: hostname,
          content: target,
          proxied: true,
          ttl: 1
        }
      }
    )

    return { id: result.id }
  }

  async deleteDnsRecord(token: string, zoneId: string, recordId: string): Promise<void> {
    await this.request(
      token,
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      {
        method: 'DELETE'
      }
    )
  }
}
