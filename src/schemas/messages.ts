import { z } from 'zod'
import { isMediaKind, OUTBOUND_MESSAGE_KINDS } from '../types/gateway.js'
import { GraphIdSchema } from './common.js'

export const ContactSchema = z.object({
  name: z.object({
    formatted_name: z.string().min(1, 'formatted_name is required').max(256),
    first_name: z.string().max(128).optional(),
    last_name: z.string().max(128).optional(),
    middle_name: z.string().max(128).optional(),
    suffix: z.string().max(64).optional(),
    prefix: z.string().max(64).optional(),
  }),
  phones: z
    .array(
      z.object({
        phone: z.string().max(64),
        type: z.string().max(32).optional(),
        wa_id: z.string().max(64).optional(),
      })
    )
    .max(10)
    .optional(),
  emails: z
    .array(
      z.object({
        email: z.string().max(128),
        type: z.string().max(32).optional(),
      })
    )
    .max(10)
    .optional(),
  addresses: z
    .array(
      z.object({
        street: z.string().max(256).optional(),
        city: z.string().max(128).optional(),
        state: z.string().max(128).optional(),
        zip: z.string().max(32).optional(),
        country: z.string().max(128).optional(),
        country_code: z.string().max(8).optional(),
        type: z.string().max(32).optional(),
      })
    )
    .max(5)
    .optional(),
  org: z
    .object({
      company: z.string().max(128).optional(),
      department: z.string().max(128).optional(),
      title: z.string().max(128).optional(),
    })
    .optional(),
  urls: z
    .array(
      z.object({
        url: z.string().max(256),
        type: z.string().max(32).optional(),
      })
    )
    .max(5)
    .optional(),
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'birthday must be in YYYY-MM-DD format')
    .optional(),
})

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
        voice: z.boolean().optional(),
      })
      .optional(),
    reaction: z
      .object({
        messageId: z.string().min(1).max(256),
        emoji: z.string().max(16),
      })
      .optional(),
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        name: z.string().max(256).optional(),
        address: z.string().max(512).optional(),
      })
      .optional(),
    contacts: z.array(ContactSchema).min(1, 'contacts must contain at least 1 contact').max(10).optional(),
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
    if (kind !== 'audio' && value.media?.voice !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['media'],
        message: 'voice is only supported for audio messages',
      })
    }
    if (kind === 'audio' && value.media && (value.media.caption || value.media.filename)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['media'],
        message: 'Audio messages do not support caption or filename',
      })
    }
    if (kind === 'video' && value.media?.filename) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['media'],
        message: 'Video messages do not support filename',
      })
    }
    if (kind === 'sticker' && value.media && (value.media.caption || value.media.filename)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['media'],
        message: 'Stickers do not support caption or filename',
      })
    }
  })

export type SendMessageInput = z.infer<typeof SendMessageSchema>
