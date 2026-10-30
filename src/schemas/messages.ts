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

export const InteractiveFlowParametersSchema = z.object({
  flow_token: z.string().min(1, 'flow_token is required').max(512),
  flow_id: GraphIdSchema,
  flow_cta: z.string().min(1, 'flow_cta is required').max(20, 'flow_cta cannot exceed 20 characters'),
  flow_action: z.enum(['navigate', 'data_exchange']),
  flow_action_payload: z
    .object({
      screen: z.string().max(128).optional(),
      data: z.record(z.unknown()).optional(),
    })
    .optional(),
  flow_message_version: z.string().max(16).optional(),
  mode: z.enum(['draft', 'published']).optional(),
})

export const InteractiveFlowSchema = z.object({
  type: z.literal('flow'),
  header: z
    .object({
      type: z.enum(['text', 'image', 'video', 'document']),
      text: z.string().max(60).optional(),
      image: z.record(z.unknown()).optional(),
      video: z.record(z.unknown()).optional(),
      document: z.record(z.unknown()).optional(),
    })
    .optional(),
  body: z.object({
    text: z.string().min(1, 'body.text is required').max(1024),
  }),
  footer: z
    .object({
      text: z.string().max(60),
    })
    .optional(),
  action: z.object({
    name: z.literal('flow'),
    parameters: InteractiveFlowParametersSchema,
  }),
})

export const InteractiveLocationRequestSchema = z.object({
  type: z.literal('location_request_message'),
  body: z.object({
    text: z.string().min(1, 'body.text is required').max(1024),
  }),
  action: z.object({
    name: z.literal('send_location'),
  }),
})

export const InteractiveCtaUrlSchema = z.object({
  type: z.literal('cta_url'),
  header: z
    .object({
      type: z.enum(['text', 'image', 'video', 'document']),
      text: z.string().max(60).optional(),
      image: z.record(z.unknown()).optional(),
      video: z.record(z.unknown()).optional(),
      document: z.record(z.unknown()).optional(),
    })
    .optional(),
  body: z.object({
    text: z.string().min(1, 'body.text is required').max(1024),
  }),
  footer: z
    .object({
      text: z.string().max(60),
    })
    .optional(),
  action: z.object({
    name: z.literal('cta_url'),
    parameters: z.object({
      display_text: z.string().min(1, 'display_text is required').max(20, 'display_text cannot exceed 20 characters'),
      url: z.string().url('url must be a valid URL'),
    }),
  }),
})

export const InteractiveProductSchema = z.object({
  type: z.literal('product'),
  body: z.object({ text: z.string().max(1024) }).optional(),
  footer: z.object({ text: z.string().max(60) }).optional(),
  action: z.object({
    catalog_id: z.string().min(1, 'catalog_id is required').max(128),
    product_retailer_id: z.string().min(1, 'product_retailer_id is required').max(128),
  }),
})

export const InteractiveProductListSchema = z.object({
  type: z.literal('product_list'),
  header: z.object({
    type: z.literal('text'),
    text: z.string().min(1, 'header.text is required').max(60),
  }),
  body: z.object({
    text: z.string().min(1, 'body.text is required').max(1024),
  }),
  footer: z.object({ text: z.string().max(60) }).optional(),
  action: z.object({
    catalog_id: z.string().min(1, 'catalog_id is required').max(128),
    sections: z
      .array(
        z.object({
          title: z.string().min(1, 'section title is required').max(24),
          product_items: z
            .array(
              z.object({
                product_retailer_id: z.string().min(1, 'product_retailer_id is required').max(128),
              })
            )
            .min(1, 'section must contain at least 1 product'),
        })
      )
      .min(1, 'product_list must have at least 1 section')
      .max(10, 'product_list can have at most 10 sections'),
  }),
})

export const InteractiveOrderDetailsSchema = z.object({
  type: z.literal('order_details'),
  header: z
    .object({
      type: z.string().max(32).optional(),
      text: z.string().max(60).optional(),
    })
    .optional(),
  body: z.object({ text: z.string().max(1024) }).optional(),
  footer: z.object({ text: z.string().max(60) }).optional(),
  action: z.object({
    name: z.string().min(1, 'action.name is required').max(64),
    parameters: z.record(z.unknown()),
  }),
})

/** POST /v1/messages body. Limits follow Meta's documented maximums. */
export const SendMessageSchema = z
  .object({
    // A phone number, or a business-scoped user ID (BSUID); a parent BSUID is up to 135 characters
    to: z.string().min(1, 'Recipient phone number or BSUID is required').max(135),
    phoneNumberId: GraphIdSchema.optional(),
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
    if (kind === 'interactive' && value.interactive) {
      if (value.interactive.type === 'flow') {
        const flowResult = InteractiveFlowSchema.safeParse(value.interactive)
        if (!flowResult.success) {
          for (const issue of flowResult.error.issues) {
            ctx.addIssue({
              ...issue,
              path: ['interactive', ...issue.path],
            })
          }
        }
      } else if (value.interactive.type === 'location_request_message') {
        const locResult = InteractiveLocationRequestSchema.safeParse(value.interactive)
        if (!locResult.success) {
          for (const issue of locResult.error.issues) {
            ctx.addIssue({
              ...issue,
              path: ['interactive', ...issue.path],
            })
          }
        }
      } else if (value.interactive.type === 'cta_url') {
        const ctaResult = InteractiveCtaUrlSchema.safeParse(value.interactive)
        if (!ctaResult.success) {
          for (const issue of ctaResult.error.issues) {
            ctx.addIssue({
              ...issue,
              path: ['interactive', ...issue.path],
            })
          }
        }
      } else if (value.interactive.type === 'poll') {
        // Meta's Message API has no poll type: it would only reject the send later
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['interactive', 'type'],
          message: "The WhatsApp Cloud API cannot send polls: interactive.type 'poll' is not supported",
        })
      } else if (value.interactive.type === 'product') {
        const prodResult = InteractiveProductSchema.safeParse(value.interactive)
        if (!prodResult.success) {
          for (const issue of prodResult.error.issues) {
            ctx.addIssue({
              ...issue,
              path: ['interactive', ...issue.path],
            })
          }
        }
      } else if (value.interactive.type === 'product_list') {
        const listResult = InteractiveProductListSchema.safeParse(value.interactive)
        if (!listResult.success) {
          for (const issue of listResult.error.issues) {
            ctx.addIssue({
              ...issue,
              path: ['interactive', ...issue.path],
            })
          }
        }
      } else if (value.interactive.type === 'order_details') {
        const orderResult = InteractiveOrderDetailsSchema.safeParse(value.interactive)
        if (!orderResult.success) {
          for (const issue of orderResult.error.issues) {
            ctx.addIssue({
              ...issue,
              path: ['interactive', ...issue.path],
            })
          }
        }
      }
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
