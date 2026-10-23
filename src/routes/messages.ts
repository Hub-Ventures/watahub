import { Hono } from 'hono'
import { z } from 'zod'
import { getEnvVar } from '../utils/env.js'
import { MetaClient } from '../services/meta-client.js'
import { WatahubApiError, classifyMetaError, transportFailure } from '../services/errors.js'
import { GraphIdSchema, isGraphId } from '../utils/validation.js'
import type { SendMessagePayload } from '../types/gateway.js'

export const messagesRouter = new Hono()

const MEDIA_KINDS = ['image', 'audio', 'video', 'document'] as const

const SendMessageSchema = z
  .object({
    to: z.string().min(1, 'Recipient phone number is required').max(64),
    phoneNumberId: GraphIdSchema.optional(),
    tenantId: z.string().max(128).optional(),
    kind: z.enum(['text', 'template', 'image', 'audio', 'video', 'document', 'reaction', 'interactive']),
    text: z
      .object({
        // Meta's hard limit for text message bodies
        body: z.string().min(1, 'Text body cannot be empty').max(4096),
      })
      .optional(),
    template: z
      .object({
        name: z.string().min(1).max(512),
        language: z.object({
          code: z.string().min(2).max(16),
        }),
        components: z.array(z.record(z.unknown())).optional(),
      })
      .optional(),
    media: z
      .object({
        id: GraphIdSchema.optional(),
        link: z.string().url().optional(),
        caption: z.string().max(1024).optional(),
        filename: z.string().max(240).optional(),
      })
      .optional(),
    reaction: z
      .object({
        messageId: z.string().min(1).max(256),
        emoji: z.string().min(1).max(16),
      })
      .optional(),
    interactive: z.record(z.unknown()).optional(),
    replyToMessageId: z.string().max(256).optional(),
  })
  .superRefine((value, ctx) => {
    // Each kind needs its matching content object; otherwise an empty message reaches Meta
    const isMedia = (MEDIA_KINDS as readonly string[]).includes(value.kind)
    const contentKey = isMedia ? 'media' : value.kind
    if (!value[contentKey as keyof typeof value]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [contentKey],
        message: `${contentKey} is required for kind "${value.kind}"`,
      })
    }
    if (isMedia && value.media && !value.media.id && !value.media.link) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['media'], message: 'media.id or media.link is required' })
    }
  })

/**
 * Send WhatsApp Message
 * POST /v1/messages
 */
messagesRouter.post('/v1/messages', async (c) => {
  // 1. Gateway API key is enforced by requireApiKey (src/middleware/auth.ts)

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
    payload.phoneNumberId || c.req.header('x-phone-number-id') || getEnvVar(c, 'META_DEFAULT_PHONE_NUMBER_ID')

  if (!phoneNumberId) {
    return c.json(
      {
        error:
          'Missing phoneNumberId. Specify it in body, X-Phone-Number-Id header, or META_DEFAULT_PHONE_NUMBER_ID env var.',
      },
      400
    )
  }

  // The header path bypasses the body schema, so re-check the resolved ID
  if (!isGraphId(phoneNumberId)) {
    return c.json({ error: 'Validation failed', details: { phoneNumberId: ['Must be a numeric Meta Graph ID'] } }, 422)
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

    const failure = transportFailure(err)
    return c.json({ error: { message: failure.message } }, failure.status)
  }
})
