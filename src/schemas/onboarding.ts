import { z } from 'zod'
import { GraphIdSchema, PublicHttpsUrlSchema } from './common.js'

// Callers used to be able to send appId / appSecret here. Secrets in request bodies
// end up in client logs and traces, and a token for another app is useless anyway:
// this gateway can only verify webhooks signed with its own META_APP_SECRET.
const CALLER_APP_CREDENTIALS = ['appId', 'appSecret'] as const

export const ExchangeCodeSchema = z
  .object({
    code: z.string().min(1, 'Embedded signup code is required').max(2048),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const key of CALLER_APP_CREDENTIALS) {
      if (key in value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "Not accepted: the exchange always uses this gateway's META_APP_ID and META_APP_SECRET",
        })
      }
    }
  })

export const SubscribeWabaSchema = z.object({
  wabaId: GraphIdSchema,
})

export const OverrideCallbackSchema = z.object({
  phoneNumberId: GraphIdSchema,
  callbackUrl: PublicHttpsUrlSchema,
  verifyToken: z.string().min(1, 'verifyToken is required').max(256),
})
