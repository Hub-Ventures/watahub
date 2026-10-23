import { Hono } from 'hono'
import { getEnvVar } from '../utils/env.js'
import { transportFailure } from '../services/errors.js'

export const proxyRouter = new Hono()

// Upper bound for a single Graph call; media uploads can take a while on slow links
const PROXY_TIMEOUT_MS = 60_000

const ALLOWED_PROXY_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\d+\/messages$/ },
  { method: 'POST', pattern: /^\d+\/media$/ },
  { method: 'GET', pattern: /^\d+$/ },
]

// GET /:mediaId accepts phone_number_id to scope the lookup; nothing else is needed by the drop-in routes
const FORWARDED_QUERY_PARAMS = new Set(['phone_number_id'])

export function isAllowedProxyRoute(method: string, subPath: string): boolean {
  return ALLOWED_PROXY_ROUTES.some((route) => route.method === method && route.pattern.test(subPath))
}

/**
 * Direct Meta Cloud API v24.0 Passthrough Proxy
 * Allows Watahub to act as a 100% drop-in replacement for Meta Graph API / Kapso proxy.
 * Routes:
 *   POST /v24.0/:phoneNumberId/messages
 *   POST /v24.0/:phoneNumberId/media
 *   GET  /v24.0/:mediaId
 */
proxyRouter.all('/v24.0/*', async (c) => {
  // Gateway API key is enforced by requireApiKey (src/middleware/auth.ts)
  const defaultToken = getEnvVar(c, 'META_SYSTEM_USER_TOKEN')
  const overrideToken = c.req.header('x-meta-access-token')
  const accessToken = overrideToken || defaultToken

  if (!accessToken) {
    return c.json({ error: 'Missing Meta access token' }, 500)
  }

  // Extract path suffix after /v24.0/
  const subPath = c.req.path.replace(/^\/v24\.0\/?/, '')

  // Only the documented drop-in routes are forwarded. Without this allowlist the
  // system user token could be used against any Graph endpoint (WABA settings,
  // phone number registration, template deletion, business assets...).
  if (!isAllowedProxyRoute(c.req.method, subPath)) {
    return c.json({ error: 'Endpoint not allowed through the Watahub proxy' }, 403)
  }
  // Forward only allowlisted query params. Graph honors ?method=delete (verb tunneling),
  // ?fields={...} (node expansion) and ?access_token=, any of which would widen the allowlist.
  const forwardedQuery = new URLSearchParams()
  for (const [key, value] of new URL(c.req.url).searchParams) {
    if (FORWARDED_QUERY_PARAMS.has(key)) forwardedQuery.append(key, value)
  }
  const queryString = forwardedQuery.toString()
  const query = queryString ? `?${queryString}` : ''
  const targetUrl = `https://graph.facebook.com/v24.0/${subPath}${query}`

  const headers = new Headers()
  headers.set('Authorization', `Bearer ${accessToken}`)

  const contentType = c.req.header('content-type')
  if (contentType) {
    headers.set('Content-Type', contentType)
  }

  const reqInit: RequestInit = {
    method: c.req.method,
    headers,
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  }

  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    reqInit.body = await c.req.raw.arrayBuffer()
  }

  try {
    const res = await fetch(targetUrl, reqInit)
    const responseHeaders = new Headers(res.headers)
    // Avoid conflicting encoding headers
    responseHeaders.delete('content-encoding')
    responseHeaders.delete('content-length')
    // Graph answers with Access-Control-Allow-Origin: * and may set cookies; neither
    // belongs to this origin, and the CORS policy is the gateway's (CORS_ALLOWED_ORIGINS)
    const foreignHeaders: string[] = []
    responseHeaders.forEach((_value, name) => {
      if (name.startsWith('access-control-') || name === 'set-cookie') foreignHeaders.push(name)
    })
    for (const name of foreignHeaders) responseHeaders.delete(name)

    return new Response(res.body, {
      status: res.status,
      headers: responseHeaders,
    })
  } catch (err: unknown) {
    const failure = transportFailure(err)
    return c.json({ error: { message: failure.message } }, failure.status)
  }
})
