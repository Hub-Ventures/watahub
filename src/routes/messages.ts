import { Hono } from 'hono'
import { getConfig } from '../config.js'
import type { GatewayDeps } from '../deps.js'
import { parseJsonBody, validationError } from '../http/body.js'
import { errorResponse } from '../http/errors.js'
import { metaClientFor } from '../http/meta.js'
import { isGraphId } from '../schemas/common.js'
import { SendMessageSchema } from '../schemas/messages.js'

export function createMessagesRouter(deps: GatewayDeps): Hono {
  const router = new Hono()

  /**
   * Send WhatsApp Message
   * POST /v1/messages
   * The gateway API key is enforced by requireApiKey (src/http/auth.ts).
   */
  router.post('/v1/messages', async (c) => {
    const body = await parseJsonBody(c, SendMessageSchema)
    if (!body.ok) return body.response
    const payload = body.value

    const phoneNumberId =
      payload.phoneNumberId || c.req.header('x-phone-number-id') || getConfig(c).metaDefaultPhoneNumberId
    if (!phoneNumberId) {
      return c.json(
        {
          error:
            'Missing phoneNumberId. Specify it in body, X-Phone-Number-Id header, or META_DEFAULT_PHONE_NUMBER_ID env var.',
        },
        400
      )
    }
    // The header and env paths bypass the body schema, so re-check the resolved ID
    if (!isGraphId(phoneNumberId)) {
      return validationError(c, { phoneNumberId: ['Must be a numeric Meta Graph ID'] })
    }

    const meta = metaClientFor(c, deps)
    if (!meta.ok) return meta.response

    try {
      return c.json(await meta.value.sendMessage(phoneNumberId, payload), 200)
    } catch (err: unknown) {
      return errorResponse(c, err, deps.logger, { includeType: true })
    }
  })

  return router
}
