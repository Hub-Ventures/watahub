import { Hono } from 'hono'
import { DEFAULT_META_API_VERSION, getConfig, META_GRAPH_BASE_URL } from '../config.js'
import type { GatewayDeps } from '../deps.js'
import { resolveMetaAccessToken } from '../http/auth.js'
import { misconfiguredResponse } from '../http/env-guard.js'
import { errorResponse } from '../http/errors.js'
import { MISSING_META_TOKEN } from '../http/meta.js'
import { invalidEnvVars } from '../utils/env.js'

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

/** Message sends are not idempotent, so a failed one has an unknown outcome */
function isMessageSend(method: string, subPath: string): boolean {
  return method === 'POST' && /^\d+\/messages$/.test(subPath)
}

/**
 * Graph URL for an allowlisted sub-path. Only allowlisted query params are kept:
 * Graph honors ?method=delete (verb tunneling), ?fields={...} (node expansion)
 * and ?access_token=, any of which would widen the allowlist. The Graph version is
 * META_API_VERSION, the same one /v1 uses, whatever the /v24.0 path says.
 */
export function buildProxyTargetUrl(
  subPath: string,
  requestUrl: string,
  apiVersion: string = DEFAULT_META_API_VERSION
): string {
  const forwardedQuery = new URLSearchParams()
  for (const [key, value] of new URL(requestUrl).searchParams) {
    if (FORWARDED_QUERY_PARAMS.has(key)) forwardedQuery.append(key, value)
  }
  const query = forwardedQuery.size > 0 ? `?${forwardedQuery.toString()}` : ''
  return `${META_GRAPH_BASE_URL}/${apiVersion}/${subPath}${query}`
}

/**
 * Graph answers with Access-Control-Allow-Origin: * and may set cookies; neither
 * belongs to this origin, and the CORS policy is the gateway's (CORS_ALLOWED_ORIGINS)
 */
function stripForeignHeaders(headers: Headers): void {
  const foreign: string[] = []
  headers.forEach((_value, name) => {
    if (name.startsWith('access-control-') || name === 'set-cookie') foreign.push(name)
  })
  for (const name of foreign) headers.delete(name)
}

/**
 * Direct Meta Cloud API v24.0 Passthrough Proxy
 * Lets Watahub stand in for the Meta Graph API on the routes listed below.
 * Routes:
 *   POST /v24.0/:phoneNumberId/messages
 *   POST /v24.0/:phoneNumberId/media
 *   GET  /v24.0/:mediaId
 * The gateway API key is enforced by requireApiKey (src/http/auth.ts).
 */
export function createProxyRouter(deps: GatewayDeps): Hono {
  const router = new Hono()

  router.all('/v24.0/*', async (c) => {
    // Workers have no boot-time validation: a bad version answers 503 instead of reaching Graph
    const invalidEnv = invalidEnvVars(c, ['META_API_VERSION'])
    if (invalidEnv.length > 0) return misconfiguredResponse(c, deps.logger, invalidEnv)

    const subPath = c.req.path.replace(/^\/v24\.0\/?/, '')
    const accessToken = resolveMetaAccessToken(c)
    if (!accessToken) {
      return c.json({ error: MISSING_META_TOKEN }, 500)
    }
    // Without this allowlist the system user token could be used against any Graph
    // endpoint (WABA settings, phone number registration, template deletion...).
    if (!isAllowedProxyRoute(c.req.method, subPath)) {
      return c.json({ error: 'Endpoint not allowed through the Watahub proxy' }, 403)
    }

    const messageSend = isMessageSend(c.req.method, subPath)
    const headers = new Headers({ Authorization: `Bearer ${accessToken}` })
    const contentType = c.req.header('content-type')
    if (contentType) headers.set('Content-Type', contentType)

    const init: RequestInit = { method: c.req.method, headers, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      init.body = c.req.raw.body
      // @ts-expect-error duplex required in Node fetch when body is a stream
      init.duplex = 'half'
    }

    try {
      const res = await deps.fetch(buildProxyTargetUrl(subPath, c.req.url, getConfig(c).metaApiVersion), init)
      const responseHeaders = new Headers(res.headers)
      // The runtime re-encodes the body, so upstream encoding headers would be wrong
      responseHeaders.delete('content-encoding')
      responseHeaders.delete('content-length')
      stripForeignHeaders(responseHeaders)
      // Meta's body is passed through untouched, so a 5xx on a send is flagged in a header
      if (messageSend && res.status >= 500) responseHeaders.set('X-Watahub-Outcome', 'unknown')
      return new Response(res.body, { status: res.status, headers: responseHeaders })
    } catch (err: unknown) {
      return errorResponse(c, err, deps.logger, { messageSend })
    }
  })

  return router
}
