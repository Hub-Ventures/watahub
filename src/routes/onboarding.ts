import { Hono } from 'hono'
import { getConfig } from '../config.js'
import type { GatewayDeps } from '../deps.js'
import { parseJsonBody } from '../http/body.js'
import { errorResponse } from '../http/errors.js'
import { metaClientFor } from '../http/meta.js'
import {
  ConnectLineSchema,
  ExchangeCodeSchema,
  OverrideCallbackSchema,
  SubscribeWabaSchema,
} from '../schemas/onboarding.js'
import { connectLine, LineConnectError } from '../services/line-connect.js'

const NUMERIC_GRAPH_ID = /^\d+$/

function configuredGraphId(value: string | undefined): value is string {
  return typeof value === 'string' && NUMERIC_GRAPH_ID.test(value)
}

export function createOnboardingRouter(deps: GatewayDeps): Hono {
  const router = new Hono()

  /**
   * Public Embedded Signup parameters for FB.login. Never the app secret.
   * GET /v1/onboarding/launch
   */
  router.get('/v1/onboarding/launch', (c) => {
    const { metaAppId, metaConfigurationId, metaApiVersion } = getConfig(c)
    if (!configuredGraphId(metaAppId) || !configuredGraphId(metaConfigurationId)) {
      deps.logger.error(
        '[watahub] META_APP_ID or META_CONFIGURATION_ID is missing or not numeric; refusing launch config'
      )
      return c.json({ error: 'Gateway misconfigured: META_APP_ID and META_CONFIGURATION_ID are required' }, 503)
    }
    return c.json({ appId: metaAppId, configurationId: metaConfigurationId, apiVersion: metaApiVersion })
  })

  /**
   * Connect one phone line: exchange, store the business token, subscribe, register.
   * The token is not returned.
   * POST /v1/onboarding/connect
   */
  router.post('/v1/onboarding/connect', async (c) => {
    const body = await parseJsonBody(c, ConnectLineSchema)
    if (!body.ok) return body.response

    const config = getConfig(c)
    if (!config.metaAppId || !config.metaAppSecret) {
      return c.json({ error: 'Missing META_APP_ID or META_APP_SECRET configuration' }, 400)
    }

    try {
      return c.json(
        await connectLine(
          {
            code: body.value.code,
            wabaId: body.value.wabaId,
            phoneNumberId: body.value.phoneNumberId,
            pin: body.value.pin,
            appId: config.metaAppId,
            appSecret: config.metaAppSecret,
            apiVersion: config.metaApiVersion,
          },
          { createMetaClient: deps.createMetaClient, lineStore: deps.lineStore }
        )
      )
    } catch (err: unknown) {
      if (err instanceof LineConnectError) {
        deps.logger.error(`[watahub] WhatsApp line connect failed during ${err.step}`)
        return errorResponse(c, err.cause, deps.logger, { step: err.step })
      }
      return errorResponse(c, err, deps.logger)
    }
  })

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

    const meta = await metaClientFor(c, deps)
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
    const meta = await metaClientFor(c, deps, phoneNumberId)
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
