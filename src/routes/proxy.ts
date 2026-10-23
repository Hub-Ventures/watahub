import { Hono } from 'hono'
import { DEFAULT_META_API_VERSION, META_GRAPH_BASE_URL } from '../config.js'
import type { GatewayDeps } from '../deps.js'
import { resolveMetaAccessToken } from '../http/auth.js'
import { errorResponse } from '../http/errors.js'
import { MISSING_META_TOKEN } from '../http/meta.js'

// Upper bound for a single Graph call; media uploads can take a while on slow links
const PROXY_TIMEOUT_MS = 60_000

const ALLOWED_PROXY_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\d+\/messages$/ },
  { method: 'POST', pattern: /^\d+\/media$/ },
  { method: 'GET', pattern: /^\d+$/ },
]

// GET /:mediaId accepts phone_number_id to scope the lookup; nothing else is needed by the drop-in routes
const FORWARDED_QUERY_PARAMS: ReadonlySet<string> = new Set(['phone_number_id'])

export function isAllowedProxyRoute(method: string, subPath: string): boolean {
  return ALLOWED_PROXY_ROUTES.some((route) => route.method === method && route.pattern.test(subPath))
}

/**
 * Graph URL for an allowlisted sub-path. Only allowlisted query params are kept:
 * Graph honors ?method=delete (verb tunneling), ?fields={...} (node expansion)
 * and ?access_token=, any of which would widen the allowlist.
 */
export function buildProxyTargetUrl(subPath: string, requestUrl: string): string {
  const forwardedQuery = new URLSearchParams()
  for (const [key, value] of new URL(requestUrl).searchParams) {
    if (FORWARDED_QUERY_PARAMS.has(key)) forwardedQuery.append(key, value)
  }
  const query = forwardedQuery.size > 0 ? `?${forwardedQuery.toString()}` : ''
  return `${META_GRAPH_BASE_URL}/${DEFAULT_META_API_VERSION}/${subPath}${query}`
}

/**
 * Direct Meta Cloud API v24.0 Passthrough Proxy
 * Allows Watahub to act as a 100% drop-in replacement for Meta Graph API / Kapso proxy.
 * Routes:
 *   POST /v24.0/:phoneNumberId/messages
 *   POST /v24.0/:phoneNumberId/media
 *   GET  /v24.0/:mediaId
 * The gateway API key is enforced by requireApiKey (src/http/auth.ts).
 */
export function createProxyRouter(deps: GatewayDeps): Hono {
  const router = new Hono()

  router.all('/v24.0/*', async (c) => {
    const accessToken = resolveMetaAccessToken(c)
    if (!accessToken) {
      return c.json({ error: MISSING_META_TOKEN }, 500)
    }

    const subPath = c.req.path.replace(/^\/v24\.0\/?/, '')
    // Without this allowlist the system user token could be used against any Graph
    // endpoint (WABA settings, phone number registration, template deletion...).
    if (!isAllowedProxyRoute(c.req.method, subPath)) {
      return c.json({ error: 'Endpoint not allowed through the Watahub proxy' }, 403)
    }

    const headers = new Headers({ Authorization: `Bearer ${accessToken}` })
    const contentType = c.req.header('content-type')
    if (contentType) headers.set('Content-Type', contentType)

    const init: RequestInit = { method: c.req.method, headers, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      init.body = await c.req.raw.arrayBuffer()
    }

    try {
      const res = await deps.fetch(buildProxyTargetUrl(subPath, c.req.url), init)
      const responseHeaders = new Headers(res.headers)
      // The runtime re-encodes the body, so upstream encoding headers would be wrong
      responseHeaders.delete('content-encoding')
      responseHeaders.delete('content-length')
      return new Response(res.body, { status: res.status, headers: responseHeaders })
    } catch (err: unknown) {
      return errorResponse(c, err, deps.logger)
    }
  })

  return router
}
