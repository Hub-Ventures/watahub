import type { Context } from 'hono'

export interface WatahubEnv {
  PORT?: string
  META_APP_ID?: string
  META_APP_SECRET?: string
  META_SYSTEM_USER_TOKEN?: string
  META_WEBHOOK_VERIFY_TOKEN?: string
  META_DEFAULT_PHONE_NUMBER_ID?: string
  META_DEFAULT_WABA_ID?: string
  META_API_VERSION?: string
  SUBSCRIBER_WEBHOOK_URL?: string
  SUBSCRIBER_WEBHOOK_SECRET?: string
  WATAHUB_API_KEY?: string
}

export function getEnvVar(c: Context, key: keyof WatahubEnv): string | undefined {
  // Check Cloudflare Workers / Hono context bindings
  const fromEnv = (c.env as Record<string, unknown> | undefined)?.[key]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv
  }

  // Check Node.js process.env
  if (typeof process !== 'undefined' && process.env && process.env[key]) {
    return process.env[key]
  }

  return undefined
}
