import { Hono } from 'hono'
import { z } from 'zod'
import { getEnvVar } from '../utils/env.js'
import { MetaClient } from '../services/meta-client.js'
import { WatahubApiError, classifyMetaError } from '../services/errors.js'
import type { SendMessagePayload } from '../types/gateway.js'

export const messagesRouter = new Hono()

const SendMessageSchema = z.object({
  to: z.string().min(1, 'Recipient phone number is required'),
  phoneNumberId: z.string().optional(),
  tenantId: z.string().optional(),
  kind: z.enum(['text', 'template', 'image', 'audio', 'video', 'document', 'reaction', 'interactive']),
  text: z
    .object({
      body: z.string().min(1, 'Text body cannot be empty'),
    })
    .optional(),
  template: z
    .object({
      name: z.string().min(1),
      language: z.object({
        code: z.string().min(2),
      }),
      components: z.array(z.record(z.unknown())).optional(),
    })
    .optional(),
  media: z
    .object({
      id: z.string().optional(),
      link: z.string().optional(),
      caption: z.string().optional(),
      filename: z.string().optional(),
    })
    .optional(),
  reaction: z
    .object({
      messageId: z.string().min(1),
      emoji: z.string().min(1),
    })
    .optional(),
  interactive: z.record(z.unknown()).optional(),
  replyToMessageId: z.string().optional(),
})

/**
 * Send WhatsApp Message
 * POST /v1/messages
 */
messagesRouter.post('/v1/messages', async (c) => {
  // 1. Check Gateway API Key if configured
  const apiKey = getEnvVar(c, 'WATAHUB_API_KEY')
  if (apiKey) {
    const authHeader = c.req.header('authorization')
    const headerKey = c.req.header('x-api-key')
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

    if (bearer !== apiKey && headerKey !== apiKey) {
      return c.json({ error: 'Unauthorized: Invalid Watahub API key' }, 401)
    }
  }

  // 2. Parse & Validate Body
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Malformed JSON payload' }, 400)
  }

  const parsed = SendMessageSchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      },
      422
    )
  }

  const payload: SendMessagePayload = parsed.data as SendMessagePayload

  // 3. Resolve Phone Number ID & Access Token
  const phoneNumberId =
    payload.phoneNumberId ||
    c.req.header('x-phone-number-id') ||
    getEnvVar(c, 'META_DEFAULT_PHONE_NUMBER_ID')

  if (!phoneNumberId) {
    return c.json(
      {
        error: 'Missing phoneNumberId. Specify it in body, X-Phone-Number-Id header, or META_DEFAULT_PHONE_NUMBER_ID env var.',
      },
      400
    )
  }

  const defaultToken = getEnvVar(c, 'META_SYSTEM_USER_TOKEN')
  const overrideToken = c.req.header('x-meta-access-token')
  const accessToken = overrideToken || defaultToken

  if (!accessToken) {
    return c.json(
      {
        error: 'Missing Meta access token. Set META_SYSTEM_USER_TOKEN or pass X-Meta-Access-Token header.',
      },
      500
    )
  }

  const apiVersion = getEnvVar(c, 'META_API_VERSION') || 'v24.0'
  const client = new MetaClient({ accessToken, apiVersion })

  // 4. Send Message via Meta Graph API
  try {
    const result = await client.sendMessage(phoneNumberId, payload)
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
            type: err.metaType,
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
