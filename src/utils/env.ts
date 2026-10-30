import type { Context } from 'hono'
import { z } from 'zod'
import { isRecord } from './guards.js'

/** Every variable the gateway reads; derived from EnvSchema so the two never drift */
export type WatahubEnv = Partial<Record<keyof z.input<typeof EnvSchema>, string>>

export function getEnvVar(c: Context, key: keyof WatahubEnv): string | undefined {
  // Check Cloudflare Workers / Hono context bindings
  const bindings: unknown = c.env
  const fromEnv = isRecord(bindings) ? bindings[key] : undefined
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv
  }

  // Check Node.js process.env
  if (typeof process !== 'undefined' && process.env?.[key]) {
    return process.env[key]
  }

  return undefined
}

const MIN_API_KEY_LENGTH = 32

const PLACEHOLDER_VALUES = new Set(['wata_sk_live_secret_key_here', 'your_secure_verify_token_here', 'changeme'])

/** Same rule validateEnv applies at boot: 32+ characters and not the .env.example placeholder */
export function isStrongApiKey(value: string): boolean {
  return value.length >= MIN_API_KEY_LENGTH && notPlaceholder(value)
}

const numericId = z.string().regex(/^\d+$/, 'must be a numeric Meta Graph ID')
const notPlaceholder = (value: string) => !PLACEHOLDER_VALUES.has(value)

/**
 * Production configuration contract. Secrets that gate authentication are
 * required: without them the gateway fails closed on the matching routes.
 */
const EnvObject = z.object({
  PORT: z
    .string()
    .regex(/^\d{1,5}$/, 'must be a port number')
    .optional(),
  META_APP_ID: numericId.optional(),
  META_APP_SECRET: z.string().min(1, 'is required to verify Meta webhook signatures'),
  META_SYSTEM_USER_TOKEN: z.string().min(1).optional(),
  META_WEBHOOK_VERIFY_TOKEN: z
    .string()
    .min(16, 'must be at least 16 characters')
    .refine(notPlaceholder, 'still has the .env.example placeholder'),
  META_DEFAULT_PHONE_NUMBER_ID: numericId.optional(),
  META_DEFAULT_WABA_ID: numericId.optional(),
  META_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'must look like v24.0')
    .optional(),
  SUBSCRIBER_WEBHOOK_URL: z.string().url().optional(),
  SUBSCRIBER_WEBHOOK_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  WEBHOOK_DELIVERY_MODE: z.enum(['sync', 'async']).optional(),
  META_WEBHOOK_MAX_AGE_SECONDS: z
    .string()
    .regex(/^[1-9]\d*$/, 'must be a positive number of seconds')
    .optional(),
  RATE_LIMIT_PER_MINUTE: z
    .string()
    .regex(/^[1-9]\d*$/, 'must be a positive integer')
    .optional(),
  TRUSTED_CLIENT_IP_HEADER: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/, 'must be a header name such as X-Real-IP')
    .optional(),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .refine(
      (value) => value.split(',').every((origin) => /^https?:\/\/[^/*\s]+$/.test(origin.trim())),
      'must be a comma-separated list of exact origins such as https://app.example.com (no wildcards)'
    )
    .optional(),
  WATAHUB_API_KEY: z
    .string()
    .min(MIN_API_KEY_LENGTH, 'must be at least 32 characters (e.g. openssl rand -hex 32)')
    .refine(notPlaceholder, 'still has the .env.example placeholder'),
})

const EnvSchema = EnvObject.superRefine((env, ctx) => {
  if (env.SUBSCRIBER_WEBHOOK_URL) {
    const url = new URL(env.SUBSCRIBER_WEBHOOK_URL)
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'https:' && !isLocal) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['SUBSCRIBER_WEBHOOK_URL'], message: 'must use https://' })
    }
    if (!env.SUBSCRIBER_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUBSCRIBER_WEBHOOK_SECRET'],
        message: 'is required when SUBSCRIBER_WEBHOOK_URL is set',
      })
    }
  }
})

export type EnvValidationResult = { ok: true } | { ok: false; errors: string[] }

/**
 * Validates the environment at boot. Error messages name the variable and the
 * rule, never the value, so they are safe to log.
 */
export function validateEnv(env: Record<string, string | undefined>): EnvValidationResult {
  // Treat empty strings (KEY= in .env files) as unset
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''))
  const parsed = EnvSchema.safeParse(present)
  if (parsed.success) return { ok: true }
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
  }
}

/** Optional variables with a format rule, read by a specific surface */
export type FormattedEnvVar =
  | 'RATE_LIMIT_PER_MINUTE'
  | 'TRUSTED_CLIENT_IP_HEADER'
  | 'WEBHOOK_DELIVERY_MODE'
  | 'META_WEBHOOK_MAX_AGE_SECONDS'
  | 'META_API_VERSION'
  | 'CORS_ALLOWED_ORIGINS'

/**
 * The listed variables whose current value breaks the rule validateEnv applies at
 * boot. Node refuses to start on a bad value; Workers have no boot step, so each
 * surface checks the variables it reads and fails closed instead of silently
 * falling back.
 */
export function invalidEnvVars(c: Context, keys: readonly FormattedEnvVar[]): FormattedEnvVar[] {
  return keys.filter((key) => {
    const value = getEnvVar(c, key)
    return value !== undefined && !EnvObject.shape[key].safeParse(value).success
  })
}
