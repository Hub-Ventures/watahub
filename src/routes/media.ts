import type { Context } from 'hono'
import { Hono } from 'hono'
import { getConfig } from '../config.js'
import type { GatewayDeps } from '../deps.js'
import { resolveMetaAccessToken } from '../http/auth.js'
import { validationError } from '../http/body.js'
import { errorResponse } from '../http/errors.js'
import { metaClientFor } from '../http/meta.js'
import { isGraphId } from '../schemas/common.js'

// Upper bound for one media download from Meta's CDN; large videos can take a while
const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000

// Only these headers describe the bytes; encoding and length are recomputed by the runtime
const FORWARDED_MEDIA_HEADERS = ['content-type', 'content-disposition'] as const

export function createMediaRouter(deps: GatewayDeps): Hono {
  const router = new Hono()

  /**
   * Download media bytes through the gateway
   * GET /v1/media/:mediaId/content
   * Meta's CDN URL only answers with the access token, so redirecting the caller to
   * it cannot work; the gateway fetches it with the token and streams it back.
   */
  router.get('/v1/media/:mediaId/content', async (c) => {
    const mediaId = c.req.param('mediaId')
    if (!isGraphId(mediaId)) {
      return validationError(c, { mediaId: ['Must be a numeric Meta Graph ID'] })
    }

    const meta = metaClientFor(c, deps)
    if (!meta.ok) return meta.response
    const accessToken = resolveMetaAccessToken(c) ?? ''

    try {
      const url = await meta.value.getMediaUrl(mediaId)
      // The token only ever goes to an https URL that Meta itself returned
      if (!url.startsWith('https://')) {
        deps.logger.error(`[watahub] Meta returned a non-https URL for media ${mediaId}; not downloading`)
        return c.json({ error: { message: 'Meta returned an unexpected media URL' } }, 502)
      }

      const res = await deps.fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
      })
      if (!res.ok) {
        deps.logger.error(`[watahub] Media download for ${mediaId} failed with status ${res.status}`)
        return c.json({ error: { message: 'Media download from Meta failed' } }, 502)
      }

      const headers = new Headers()
      for (const name of FORWARDED_MEDIA_HEADERS) {
        const value = res.headers.get(name)
        if (value) headers.set(name, value)
      }
      return new Response(res.body, { status: 200, headers })
    } catch (err: unknown) {
      return errorResponse(c, err, deps.logger)
    }
  })

  /**
   * Resolve media ID to temporary CDN download URL
   * GET /v1/media/:mediaId
   */
  router.get('/v1/media/:mediaId', async (c) => {
    const mediaId = c.req.param('mediaId')
    if (!isGraphId(mediaId)) {
      return validationError(c, { mediaId: ['Must be a numeric Meta Graph ID'] })
    }

    const meta = metaClientFor(c, deps)
    if (!meta.ok) return meta.response

    try {
      const url = await meta.value.getMediaUrl(mediaId)
      if (c.req.query('redirect') === 'true') {
        return c.redirect(url, 302)
      }
      return c.json({ mediaId, url }, 200)
    } catch (err: unknown) {
      return errorResponse(c, err, deps.logger)
    }
  })

  /**
   * Upload media file (multipart/form-data) to Meta WhatsApp Cloud API
   * POST /v1/media
   * POST /v1/media/:phoneNumberId
   */
  const handleUpload = async (c: Context) => {
    const phoneNumberId =
      c.req.param('phoneNumberId') ||
      c.req.header('x-phone-number-id') ||
      c.req.query('phone_number_id') ||
      getConfig(c).metaDefaultPhoneNumberId

    if (!phoneNumberId) {
      return c.json(
        {
          error:
            'Missing phoneNumberId. Specify it in path, query, X-Phone-Number-Id header, or META_DEFAULT_PHONE_NUMBER_ID env var.',
        },
        400
      )
    }

    if (!isGraphId(phoneNumberId)) {
      return validationError(c, { phoneNumberId: ['Must be a numeric Meta Graph ID'] })
    }

    const contentType = c.req.header('content-type')
    if (!contentType?.includes('multipart/form-data')) {
      return c.json({ error: 'Content-Type must be multipart/form-data' }, 400)
    }

    const meta = metaClientFor(c, deps)
    if (!meta.ok) return meta.response

    try {
      const res = await meta.value.uploadMedia(phoneNumberId, c.req.raw.body as BodyInit, contentType)
      return c.json(res, 200)
    } catch (err: unknown) {
      return errorResponse(c, err, deps.logger)
    }
  }

  router.post('/v1/media', handleUpload)
  router.post('/v1/media/:phoneNumberId', handleUpload)

  return router
}
