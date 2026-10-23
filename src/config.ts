import type { Context } from 'hono'
import { getEnvVar } from './utils/env.js'

export const GATEWAY_NAME = 'watahub'
export const GATEWAY_VERSION = '0.1.0'
export const GATEWAY_USER_AGENT = `Watahub-Gateway/${GATEWAY_VERSION}`

export const META_GRAPH_BASE_URL = 'https://graph.facebook.com'
export const DEFAULT_META_API_VERSION = 'v24.0'

/**
 * Typed view of the gateway configuration for the current request.
 * Values come from Worker bindings first, then process.env (see getEnvVar).
 * Boot-time rules live in utils/env.ts (validateEnv).
 */
export interface GatewayConfig {
  apiKey?: string
  metaAppId?: string
  metaAppSecret?: string
  metaSystemUserToken?: string
  metaWebhookVerifyToken?: string
  metaDefaultPhoneNumberId?: string
  metaDefaultWabaId?: string
  metaApiVersion: string
  subscriberWebhookUrl?: string
  subscriberWebhookSecret?: string
  metaWebhookMaxAgeSeconds?: string
  corsAllowedOrigins?: string
  rateLimitPerMinute?: string
  trustedClientIpHeader?: string
}

export function getConfig(c: Context): GatewayConfig {
  return {
    apiKey: getEnvVar(c, 'WATAHUB_API_KEY'),
    metaAppId: getEnvVar(c, 'META_APP_ID'),
    metaAppSecret: getEnvVar(c, 'META_APP_SECRET'),
    metaSystemUserToken: getEnvVar(c, 'META_SYSTEM_USER_TOKEN'),
    metaWebhookVerifyToken: getEnvVar(c, 'META_WEBHOOK_VERIFY_TOKEN'),
    metaDefaultPhoneNumberId: getEnvVar(c, 'META_DEFAULT_PHONE_NUMBER_ID'),
    metaDefaultWabaId: getEnvVar(c, 'META_DEFAULT_WABA_ID'),
    metaApiVersion: getEnvVar(c, 'META_API_VERSION') || DEFAULT_META_API_VERSION,
    subscriberWebhookUrl: getEnvVar(c, 'SUBSCRIBER_WEBHOOK_URL'),
    subscriberWebhookSecret: getEnvVar(c, 'SUBSCRIBER_WEBHOOK_SECRET'),
    metaWebhookMaxAgeSeconds: getEnvVar(c, 'META_WEBHOOK_MAX_AGE_SECONDS'),
    corsAllowedOrigins: getEnvVar(c, 'CORS_ALLOWED_ORIGINS'),
    rateLimitPerMinute: getEnvVar(c, 'RATE_LIMIT_PER_MINUTE'),
    trustedClientIpHeader: getEnvVar(c, 'TRUSTED_CLIENT_IP_HEADER'),
  }
}
