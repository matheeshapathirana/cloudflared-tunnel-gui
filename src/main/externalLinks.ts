const ALLOWED_EXTERNAL_HOSTS = new Set([
  'dash.cloudflare.com',
  'developers.cloudflare.com',
  'github.com'
])

// Quick tunnels get a random <words>.trycloudflare.com hostname.
const QUICK_TUNNEL_SUFFIX = '.trycloudflare.com'

/** Only https links to known hosts may be handed to the system browser. */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false
    const host = parsed.hostname.toLowerCase()
    return ALLOWED_EXTERNAL_HOSTS.has(host) || host.endsWith(QUICK_TUNNEL_SUFFIX)
  } catch {
    return false
  }
}
