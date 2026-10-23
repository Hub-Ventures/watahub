import { z } from 'zod'
import { isMediaKind, OUTBOUND_MESSAGE_KINDS } from '../types/gateway.js'
import { GraphIdSchema } from './common.js'

/** POST /v1/messages body. Limits follow Meta's documented maximums. */
export const SendMessageSchema = z
  .object({
    to: z.string().min(1, 'Recipient phone number is required').max(64),
    phoneNumberId: GraphIdSchema.optional(),
    tenantId: z.string().max(128).optional(),
    kind: z.enum(OUTBOUND_MESSAGE_KINDS),
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
    const { kind } = value
    const isMedia = isMediaKind(kind)
    const contentKey = isMediaKind(kind) ? 'media' : kind
    if (!value[contentKey]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [contentKey],
        message: `${contentKey} is required for kind "${kind}"`,
      })
    }
    if (isMedia && value.media && !value.media.id && !value.media.link) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['media'], message: 'media.id or media.link is required' })
    }
  })

export type SendMessageInput = z.infer<typeof SendMessageSchema>
