import { z } from 'zod'

/**
 * Meta Graph object IDs (phone number IDs, WABA IDs, media IDs, app IDs) are
 * numeric. Enforcing that is what keeps caller input from turning into Graph
 * path segments such as `../../me?fields=...` signed with the system token.
 */
export const GraphIdSchema = z.string().regex(/^\d{1,32}$/, 'Must be a numeric Meta Graph ID')

export function isGraphId(value: string): boolean {
  return GraphIdSchema.safeParse(value).success
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa']

function ipv4Octets(host: string): number[] | undefined {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return undefined
  const octets = host.split('.').map(Number)
  return octets.every((octet) => octet <= 255) ? octets : undefined
}

/** Loopback, private (RFC 1918), CGNAT, link-local, benchmarking, multicast and reserved IPv4 ranges */
function isNonPublicIpv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

/** Only global unicast (2000::/3) is public; documentation and IPv4-embedding prefixes are not accepted */
function isNonPublicIpv6(host: string): boolean {
  const address = host.slice(1, -1).toLowerCase()
  const first = parseInt(address.split(':')[0] || '0', 16)
  if (!(first >= 0x2000 && first <= 0x3fff)) return true
  return address.startsWith('2001:db8:') || address.startsWith('2002:') || address.startsWith('2001:0:')
}

/**
 * True when the URL is https, carries no credentials and does not point at a
 * loopback, private, link-local or internal host. Hostnames are checked as
 * written: the gateway does not resolve DNS, so a public name that resolves to
 * a private address is not caught here (the URL is fetched by Meta, not by us).
 */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false

  // WHATWG URL normalizes IPv4 shorthands (0x7f.1, 2130706433) to dotted decimal
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  // Single-label names (intranet, metadata) only resolve inside private networks
  if (!host || host === 'localhost' || (!host.includes('.') && !host.startsWith('['))) return false
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false

  const octets = ipv4Octets(host)
  if (octets) return !isNonPublicIpv4(octets)
  if (host.startsWith('[')) return !isNonPublicIpv6(host)
  return true
}

/** Callback URLs handed to Meta: https and a public host only */
export const PublicHttpsUrlSchema = z
  .string()
  .max(2048)
  .refine(isPublicHttpsUrl, 'URL must be https:// on a public host (no IPs in private, loopback or link-local ranges)')
