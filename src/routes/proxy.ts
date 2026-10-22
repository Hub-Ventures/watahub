import { Hono } from 'hono'
import { getEnvVar } from '../utils/env.js'

export const proxyRouter = new Hono()

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
  const query = c.req.url.includes('?') ? c.req.url.slice(c.req.url.indexOf('?')) : ''
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

    return new Response(res.body, {
      status: res.status,
      headers: responseHeaders,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Meta proxy failure'
    return c.json({ error: { message } }, 502)
  }
})
