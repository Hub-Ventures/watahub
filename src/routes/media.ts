import type { Context } from 'hono'
import { Hono } from 'hono'
import { getConfig } from '../config.js'
import type { GatewayDeps } from '../deps.js'
import { validationError } from '../http/body.js'
import { errorResponse } from '../http/errors.js'
import { metaClientFor } from '../http/meta.js'
import { isGraphId } from '../schemas/common.js'

export function createMediaRouter(deps: GatewayDeps): Hono {
  const router = new Hono()

  /**
   * Resolve media ID to temporary CDN download URL
   * GET /v1/media/:mediaId
   */
  router.get('/v1/media/:mediaId', async (c) => {
    const mediaId = c.req.param('mediaId')
    if (!isGraphId(mediaId)) {
      return validationError(c, { mediaId: ['Must be a numeric Meta Graph ID'] })
    }

    const meta = await metaClientFor(c, deps)
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

    const meta = await metaClientFor(c, deps, phoneNumberId)
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
