import { Hono } from 'hono'
import { getConfig } from '../config.js'
import type { GatewayDeps } from '../deps.js'
import { parseJsonBody } from '../http/body.js'
import { errorResponse } from '../http/errors.js'
import { metaClientFor } from '../http/meta.js'
import { ExchangeCodeSchema, OverrideCallbackSchema, SubscribeWabaSchema } from '../schemas/onboarding.js'

export function createOnboardingRouter(deps: GatewayDeps): Hono {
  const router = new Hono()

  /**
   * Exchange Meta Embedded Signup OAuth Code
   * POST /v1/onboarding/exchange
   */
  router.post('/v1/onboarding/exchange', async (c) => {
    const body = await parseJsonBody(c, ExchangeCodeSchema)
    if (!body.ok) return body.response

    // Always this gateway's own app: it can only verify webhooks signed with its META_APP_SECRET
    const config = getConfig(c)
    const clientId = config.metaAppId
    const clientSecret = config.metaAppSecret
    if (!clientId || !clientSecret) {
      return c.json({ error: 'Missing META_APP_ID or META_APP_SECRET configuration' }, 400)
    }

    // The code exchange authenticates with app credentials, not a bearer token.
    const client = deps.createMetaClient({ accessToken: '', apiVersion: config.metaApiVersion })

    try {
      return c.json(await client.exchangeCodeForToken(body.value.code, clientId, clientSecret), 200)
    } catch (err: unknown) {
      return errorResponse(c, err, deps.logger)
    }
  })

  /**
   * Subscribe App to WABA
   * POST /v1/onboarding/subscribe
   */
  router.post('/v1/onboarding/subscribe', async (c) => {
    const body = await parseJsonBody(c, SubscribeWabaSchema)
    if (!body.ok) return body.response

    const meta = metaClientFor(c, deps)
    if (!meta.ok) return meta.response
    const { wabaId, subscribedFields } = body.value

    try {
      const success = await meta.value.subscribeAppToWaba(wabaId, subscribedFields)
      return c.json({ success, wabaId }, 200)
    } catch (err: unknown) {
      return errorResponse(c, err, deps.logger)
    }
  })

  /**
   * Override Phone Number Webhook Callback URL
   * POST /v1/onboarding/override-callback
   */
  router.post('/v1/onboarding/override-callback', async (c) => {
    const body = await parseJsonBody(c, OverrideCallbackSchema)
    if (!body.ok) return body.response

    const { phoneNumberId, callbackUrl, verifyToken } = body.value
    const meta = metaClientFor(c, deps)
    if (!meta.ok) return meta.response

    try {
      const success = await meta.value.overridePhoneNumberCallback(phoneNumberId, callbackUrl, verifyToken)
      return c.json({ success, phoneNumberId }, 200)
    } catch (err: unknown) {
      return errorResponse(c, err, deps.logger)
    }
  })

  return router
}
