export interface ZoneLike {
  name: string
  [key: string]: unknown
}

/**
 * Normalizes a service target URL.
 * Digits only => http://localhost:<n>
 * Returned unchanged if it has a scheme:// prefix, or unix/unix+tls socket, or http_status, or hello_world/bastion.
 * Anything else => http://<value>
 */
export function normalizeServiceUrl(input: string): string {
  const trimmed = input.trim()
  if (/^\d+$/.test(trimmed)) {
    return `http://localhost:${trimmed}`
  }
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ||
    /^unix(\+tls)?:/i.test(trimmed) ||
    /^http_status:/i.test(trimmed) ||
    trimmed === 'hello_world' ||
    trimmed === 'bastion'
  ) {
    return trimmed
  }
  return `http://${trimmed}`
}

/**
 * Returns the matching zone where hostname equals zone.name or ends with .${zone.name}.
 * Picks the longest matching zone name, or undefined if no match.
 */
export function findZoneForHostname<T extends ZoneLike>(
  hostname: string,
  zones: T[]
): T | undefined {
  const matches = zones.filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`))
  if (matches.length === 0) {
    return undefined
  }
  return matches.reduce((longest, current) =>
    current.name.length > longest.name.length ? current : longest
  )
}

/**
 * Extracts subdomain prefix from hostname for a given zone name.
 * Returns '' for apex, otherwise the prefix without .${zoneName}.
 */
export function subdomainFor(hostname: string, zoneName: string): string {
  if (hostname === zoneName) {
    return ''
  }
  if (hostname.endsWith(`.${zoneName}`)) {
    return hostname.slice(0, -(zoneName.length + 1))
  }
  return hostname
}

/**
 * Computes full hostname from subdomain and zone name.
 * Apex (@ or empty) returns zoneName.
 * Subdomain already ending with .${zoneName} returns trimmed subdomain.
 * Otherwise returns ${trimmed}.${zoneName}.
 */
export function computeHostname(subdomain: string, zoneName: string): string {
  if (!zoneName) return ''
  const trimmed = subdomain.trim()
  if (!trimmed || trimmed === '@') {
    return zoneName
  }
  if (trimmed.endsWith(`.${zoneName}`)) {
    return trimmed
  }
  return `${trimmed}.${zoneName}`
}

/**
 * Returns a composite row key for identifying a hostname rule by hostname and optional path.
 */
export function getRowKey(item: { hostname: string; path?: string }): string {
  return `${item.hostname}::${item.path ?? ''}`
}
