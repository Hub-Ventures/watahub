import { Hono } from 'hono'
import { z } from 'zod'
import { getEnvVar } from '../utils/env.js'
import { MetaClient } from '../services/meta-client.js'
import { WatahubApiError, classifyMetaError } from '../services/errors.js'
import { GraphIdSchema, HttpsUrlSchema } from '../utils/validation.js'

export const onboardingRouter = new Hono()

const ExchangeCodeSchema = z.object({
  code: z.string().min(1, 'Embedded signup code is required').max(2048),
  appId: GraphIdSchema.optional(),
  appSecret: z.string().max(256).optional(),
})

const SubscribeWabaSchema = z.object({
  wabaId: GraphIdSchema,
})

const OverrideCallbackSchema = z.object({
  phoneNumberId: GraphIdSchema,
  callbackUrl: HttpsUrlSchema,
  verifyToken: z.string().min(1, 'verifyToken is required').max(256),
})

/**
 * Exchange Meta Embedded Signup OAuth Code
 * POST /v1/onboarding/exchange
 */
onboardingRouter.post('/v1/onboarding/exchange', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Malformed JSON payload' }, 400)
  }

  const parsed = ExchangeCodeSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, 422)
  }

  const clientId = parsed.data.appId || getEnvVar(c, 'META_APP_ID')
  const clientSecret = parsed.data.appSecret || getEnvVar(c, 'META_APP_SECRET')

  if (!clientId || !clientSecret) {
    return c.json({ error: 'Missing META_APP_ID or META_APP_SECRET configuration' }, 400)
  }

  const apiVersion = getEnvVar(c, 'META_API_VERSION') || 'v24.0'
  const client = new MetaClient({ accessToken: '', apiVersion })

  try {
    const result = await client.exchangeCodeForToken(parsed.data.code, clientId, clientSecret)
    return c.json(result, 200)
  } catch (err: unknown) {
    if (err instanceof WatahubApiError) {
      const classification = classifyMetaError(err)
      return c.json(
        {
          error: {
            message: err.message,
            code: err.metaCode,
            subcode: err.metaSubcode,
            category: classification.category,
            retryable: classification.retryable,
            action: classification.action,
          },
        },
        (err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502) as 502
      )
    }

    const message = err instanceof Error ? err.message : 'Unknown gateway error'
    return c.json({ error: { message } }, 500)
  }
})

/**
 * Subscribe App to WABA
 * POST /v1/onboarding/subscribe
 */
onboardingRouter.post('/v1/onboarding/subscribe', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Malformed JSON payload' }, 400)
  }

  const parsed = SubscribeWabaSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, 422)
  }

  const defaultToken = getEnvVar(c, 'META_SYSTEM_USER_TOKEN')
  const overrideToken = c.req.header('x-meta-access-token')
  const accessToken = overrideToken || defaultToken

  if (!accessToken) {
    return c.json({ error: 'Missing Meta access token' }, 500)
  }

  const apiVersion = getEnvVar(c, 'META_API_VERSION') || 'v24.0'
  const client = new MetaClient({ accessToken, apiVersion })

  try {
    const success = await client.subscribeAppToWaba(parsed.data.wabaId)
    return c.json({ success, wabaId: parsed.data.wabaId }, 200)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown gateway error'
    return c.json({ error: { message } }, 500)
  }
})

/**
 * Override Phone Number Webhook Callback URL
 * POST /v1/onboarding/override-callback
 */
onboardingRouter.post('/v1/onboarding/override-callback', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Malformed JSON payload' }, 400)
  }

  const parsed = OverrideCallbackSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, 422)
  }

  const defaultToken = getEnvVar(c, 'META_SYSTEM_USER_TOKEN')
  const overrideToken = c.req.header('x-meta-access-token')
  const accessToken = overrideToken || defaultToken

  if (!accessToken) {
    return c.json({ error: 'Missing Meta access token' }, 500)
  }

  const apiVersion = getEnvVar(c, 'META_API_VERSION') || 'v24.0'
  const client = new MetaClient({ accessToken, apiVersion })

  try {
    const success = await client.overridePhoneNumberCallback(
      parsed.data.phoneNumberId,
      parsed.data.callbackUrl,
      parsed.data.verifyToken
    )
    return c.json({ success, phoneNumberId: parsed.data.phoneNumberId }, 200)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown gateway error'
    return c.json({ error: { message } }, 500)
  }
})
