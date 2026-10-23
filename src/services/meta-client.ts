/**
 * Direct Meta Graph API v24.0 Client
 */

import { WatahubApiError, type MetaApiErrorBody } from './errors.js'
import type { SendMessagePayload, SendMessageResponse } from '../types/gateway.js'

export interface RetryPolicy {
  /** Total attempts including the first one */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  /** Per-attempt timeout */
  timeoutMs: number
}

export interface MetaClientConfig {
  accessToken: string
  apiVersion?: string
  baseUrl?: string
  retry?: Partial<RetryPolicy>
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  timeoutMs: 15_000,
}

/**
 * Rate-limit errors mean Meta rejected the request without processing it, so
 * they are safe to retry for every method: HTTP 429, 4 (app), 80007 (WABA),
 * 130429 (Cloud API throughput).
 */
const RATE_LIMIT_CODES = new Set([4, 80007, 130429])

/**
 * Transient server errors. The request may have been processed, so these are
 * only retried for idempotent calls (never for sending a message).
 */
const TRANSIENT_CODES = new Set([1, 2, 131000, 131016, 133004])

interface GraphResponse {
  res: Response
  data: Record<string, unknown>
}

interface RequestOptions {
  /** Safe to repeat when the outcome is unknown (timeouts, 5xx) */
  idempotent: boolean
}

function errorCode(data: Record<string, unknown>): number | undefined {
  const error = data.error as { code?: unknown } | undefined
  return typeof error?.code === 'number' ? error.code : undefined
}

function isRateLimited(res: Response, data: Record<string, unknown>): boolean {
  const code = errorCode(data)
  return res.status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))
}

function isTransient(res: Response, data: Record<string, unknown>): boolean {
  const code = errorCode(data)
  return res.status >= 500 || (code !== undefined && TRANSIENT_CODES.has(code))
}

/** Retry-After in seconds (Meta and proxies send integer seconds) */
function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after')
  if (!header) return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

/** Exponential backoff with full jitter: random(0, min(max, base * 2^attempt)) */
export function backoffDelayMs(attempt: number, policy: RetryPolicy): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt)
  return Math.floor(Math.random() * ceiling)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class MetaClient {
  private accessToken: string
  private apiVersion: string
  private baseUrl: string
  private retryPolicy: RetryPolicy

  constructor(config: MetaClientConfig) {
    this.accessToken = config.accessToken
    this.apiVersion = config.apiVersion || 'v24.0'
    this.baseUrl = config.baseUrl || 'https://graph.facebook.com'
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...config.retry }
  }

  /**
   * fetch with a per-attempt timeout and bounded retries.
   * - Rate limits (429 / 4 / 80007 / 130429) are retried for every call, honoring Retry-After.
   * - Timeouts, network errors and 5xx are retried only for idempotent calls.
   * Returns the last response; callers decide how to surface non-2xx results.
   */
  private async request(url: string, init: RequestInit, options: RequestOptions): Promise<GraphResponse> {
    const policy = this.retryPolicy

    for (let attempt = 0; ; attempt++) {
      const isLastAttempt = attempt >= policy.maxAttempts - 1

      let res: Response
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(policy.timeoutMs) })
      } catch (err) {
        if (!options.idempotent || isLastAttempt) throw err
        await sleep(backoffDelayMs(attempt, policy))
        continue
      }

      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (res.ok || isLastAttempt) return { res, data }

      if (isRateLimited(res, data)) {
        const hinted = retryAfterMs(res)
        await sleep(Math.min(policy.maxDelayMs, hinted ?? backoffDelayMs(attempt, policy)))
        continue
      }

      if (options.idempotent && isTransient(res, data)) {
        await sleep(backoffDelayMs(attempt, policy))
        continue
      }

      return { res, data }
    }
  }

  private url(endpoint: string): string {
    const clean = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
    return `${this.baseUrl}/${this.apiVersion}/${clean}`
  }

  private headers(customAuth?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${customAuth || this.accessToken}`,
      'Content-Type': 'application/json',
    }
  }

  /**
   * Send a WhatsApp message (Text, Template, Media, Interactive)
   */
  async sendMessage(
    phoneNumberId: string,
    payload: SendMessagePayload,
    overrideToken?: string
  ): Promise<SendMessageResponse> {
    const endpoint = this.url(`${phoneNumberId}/messages`)

    const cleanTo = payload.to.replace(/^\+/, '').trim()
    const metaBody: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
    }

    if (payload.replyToMessageId) {
      metaBody.context = { message_id: payload.replyToMessageId }
    }

    switch (payload.kind) {
      case 'text':
        metaBody.type = 'text'
        metaBody.text = { body: payload.text?.body || '' }
        break

      case 'template':
        metaBody.type = 'template'
        metaBody.template = payload.template
        break

      case 'reaction':
        metaBody.type = 'reaction'
        metaBody.reaction = {
          message_id: payload.reaction?.messageId,
          emoji: payload.reaction?.emoji,
        }
        break

      case 'image':
      case 'audio':
      case 'video':
      case 'document': {
        metaBody.type = payload.kind
        const mediaObj: Record<string, unknown> = {}
        if (payload.media?.id) mediaObj.id = payload.media.id
        if (payload.media?.link) mediaObj.link = payload.media.link
        if (payload.media?.caption) mediaObj.caption = payload.media.caption
        if (payload.kind === 'document' && payload.media?.filename) {
          mediaObj.filename = payload.media.filename
        }
        metaBody[payload.kind] = mediaObj
        break
      }

      case 'interactive':
        metaBody.type = 'interactive'
        metaBody.interactive = payload.interactive
        break

      default:
        throw new Error(`Unsupported message kind: ${payload.kind}`)
    }

    // Not idempotent: a timeout or 5xx may already have delivered the message
    const { res, data } = await this.request(
      endpoint,
      {
        method: 'POST',
        headers: this.headers(overrideToken),
        body: JSON.stringify(metaBody),
      },
      { idempotent: false }
    )

    if (!res.ok) {
      throw new WatahubApiError(data as unknown as MetaApiErrorBody, res.status)
    }

    const messages = Array.isArray(data.messages) ? data.messages : []
    const firstMsg = messages[0] as { id?: string } | undefined
    const messageId = firstMsg?.id || ''

    return {
      success: true,
      messageId,
      recipient: cleanTo,
      phoneNumberId,
    }
  }

  /**
   * List approved message templates from WABA
   */
  async listTemplates(wabaId: string, overrideToken?: string): Promise<unknown[]> {
    const endpoint = this.url(`${wabaId}/message_templates`)
    const { res, data } = await this.request(endpoint, { headers: this.headers(overrideToken) }, { idempotent: true })

    if (!res.ok) {
      throw new WatahubApiError(data as unknown as MetaApiErrorBody, res.status)
    }

    return Array.isArray(data.data) ? data.data : []
  }

  /**
   * Exchange Embedded Signup code for permanent System User / Page Access Token
   */
  async exchangeCodeForToken(code: string, clientId: string, clientSecret: string): Promise<{ accessToken: string }> {
    const endpoint = this.url('oauth/access_token')
    // Sent as a form body, not a query string: URLs end up in proxy and access
    // logs, and this one would carry the app secret and the signup code
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code })

    // Signup codes are single-use, so an ambiguous failure must not be replayed
    const { res, data } = await this.request(
      endpoint,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      { idempotent: false }
    )

    if (!res.ok || typeof data.access_token !== 'string') {
      throw new WatahubApiError(data as unknown as MetaApiErrorBody, res.status)
    }

    return { accessToken: data.access_token }
  }

  /**
   * Subscribe App to WABA
   */
  async subscribeAppToWaba(wabaId: string, overrideToken?: string): Promise<boolean> {
    const endpoint = this.url(`${wabaId}/subscribed_apps`)
    // Subscribing is a set operation: repeating it yields the same state
    const { res } = await this.request(
      endpoint,
      {
        method: 'POST',
        headers: this.headers(overrideToken),
        body: JSON.stringify({
          subscribed_fields: ['messages', 'smb_message_echoes', 'history', 'smb_app_state_sync'],
        }),
      },
      { idempotent: true }
    )

    return res.ok
  }

  /**
   * Override phone number webhook callback URL (Meta Phone-Level Routing)
   */
  async overridePhoneNumberCallback(
    phoneNumberId: string,
    callbackUrl: string,
    verifyToken: string,
    overrideToken?: string
  ): Promise<boolean> {
    const endpoint = this.url(phoneNumberId)
    // Overwrites a single setting, so repeating it is safe
    const { res } = await this.request(
      endpoint,
      {
        method: 'POST',
        headers: this.headers(overrideToken),
        body: JSON.stringify({
          webhook_configuration: {
            override_callback_uri: callbackUrl,
            verify_token: verifyToken,
          },
        }),
      },
      { idempotent: true }
    )

    return res.ok
  }

  /**
   * Resolve media ID to temporary downloadable CDN URL
   */
  async getMediaUrl(mediaId: string, overrideToken?: string): Promise<string> {
    const endpoint = this.url(mediaId)
    const { res, data } = await this.request(endpoint, { headers: this.headers(overrideToken) }, { idempotent: true })

    if (!res.ok || typeof data.url !== 'string') {
      throw new WatahubApiError(data as unknown as MetaApiErrorBody, res.status)
    }

    return data.url
  }
}
