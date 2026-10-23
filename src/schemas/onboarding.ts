import { z } from 'zod'
import { GraphIdSchema, HttpsUrlSchema } from './common.js'

export const ExchangeCodeSchema = z.object({
  code: z.string().min(1, 'Embedded signup code is required').max(2048),
  appId: GraphIdSchema.optional(),
  appSecret: z.string().max(256).optional(),
})

export const SubscribeWabaSchema = z.object({
  wabaId: GraphIdSchema,
})

export const OverrideCallbackSchema = z.object({
  phoneNumberId: GraphIdSchema,
  callbackUrl: HttpsUrlSchema,
  verifyToken: z.string().min(1, 'verifyToken is required').max(256),
})
