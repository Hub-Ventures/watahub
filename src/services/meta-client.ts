/**
 * Direct Meta Graph API client: one request path with timeouts and safe retries.
 */

import { DEFAULT_META_API_VERSION, META_GRAPH_BASE_URL } from '../config.js'
import { WatahubApiError, isRateLimit, isTransient, metaErrorCode } from './errors.js'
import { backoffDelayMs, sleep, type RetryPolicy, type Sleep } from './retry.js'
import { isRecord } from '../utils/guards.js'
import type { MetaMessageTemplate, SendMessagePayload, SendMessageResponse } from '../types/gateway.js'

export type { RetryPolicy } from './retry.js'
export { backoffDelayMs } from './retry.js'

export interface MetaClientConfig {
  accessToken: string
  apiVersion?: string
  baseUrl?: string
  retry?: Partial<RetryPolicy>
  /** HTTP transport. Defaults to the global `fetch`, resolved on every call. */
  fetch?: typeof fetch
  /** Delay between retries. Injected by tests to run without waiting. */
  sleep?: Sleep
}

/**
 * What the HTTP layer needs from Meta. Routes depend on this interface, not on
 * the class, so tests and alternative transports can provide their own.
 */
export interface MetaGraphClient {
  sendMessage(phoneNumberId: string, payload: SendMessagePayload): Promise<SendMessageResponse>
  listTemplates(wabaId: string): Promise<MetaMessageTemplate[]>
  exchangeCodeForToken(code: string, clientId: string, clientSecret: string): Promise<{ accessToken: string }>
  subscribeAppToWaba(wabaId: string, subscribedFields?: readonly string[], overrideToken?: string): Promise<boolean>
  overridePhoneNumberCallback(phoneNumberId: string, callbackUrl: string, verifyToken: string): Promise<boolean>
  getMediaUrl(mediaId: string): Promise<string>
  uploadMedia(
    phoneNumberId: string,
    body: BodyInit,
    contentType?: string,
    overrideToken?: string
  ): Promise<{ id: string }>
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  timeoutMs: 15_000,
}

/** Default fields subscribed when an app is attached to a WABA. */
export const DEFAULT_WABA_SUBSCRIBED_FIELDS = ['messages'] as const

type GraphBody = Record<string, unknown>

interface GraphResponse {
  ok: boolean
  status: number
  data: GraphBody
}

interface RequestOptions {
  /** Safe to repeat when the outcome is unknown (timeouts, 5xx) */
  idempotent: boolean
}

/** Retry-After in seconds (Meta and proxies send integer seconds) */
function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after')
  if (!header) return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

export class MetaClient implements MetaGraphClient {
  private readonly accessToken: string
  private readonly apiVersion: string
  private readonly baseUrl: string
  private readonly retryPolicy: RetryPolicy
  private readonly fetchFn: typeof fetch
  private readonly sleep: Sleep

  constructor(config: MetaClientConfig) {
    this.accessToken = config.accessToken
    this.apiVersion = config.apiVersion || DEFAULT_META_API_VERSION
    this.baseUrl = config.baseUrl || META_GRAPH_BASE_URL
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...config.retry }
    this.fetchFn = config.fetch ?? ((input, init) => fetch(input, init))
    this.sleep = config.sleep ?? sleep
  }

  /**
   * Send a WhatsApp message (Text, Template, Media, Interactive)
   */
  async sendMessage(
    phoneNumberId: string,
    payload: SendMessagePayload,
    overrideToken?: string
  ): Promise<SendMessageResponse> {
    const metaBody = buildMetaMessageBody(payload)
    // Not idempotent: a timeout or 5xx may already have delivered the message
    const { data } = ensureOk(
      await this.post(`${phoneNumberId}/messages`, metaBody, { idempotent: false }, overrideToken)
    )

    const firstMsg: unknown = Array.isArray(data.messages) ? data.messages[0] : undefined
    const messageId = isRecord(firstMsg) && typeof firstMsg.id === 'string' ? firstMsg.id : ''

    return {
      success: true,
      messageId,
      recipient: metaBody.to,
      phoneNumberId,
    }
  }

  /**
   * List approved message templates from WABA
   */
  async listTemplates(wabaId: string, overrideToken?: string): Promise<MetaMessageTemplate[]> {
    const { data } = ensureOk(await this.get(`${wabaId}/message_templates`, overrideToken))
    return Array.isArray(data.data) ? data.data.filter(isRecord) : []
  }

  /**
   * Exchange Embedded Signup code for permanent System User / Page Access Token.
   * Unauthenticated: app credentials authenticate the call, no bearer token is sent.
   */
  async exchangeCodeForToken(code: string, clientId: string, clientSecret: string): Promise<{ accessToken: string }> {
    // Sent as a form body, not a query string: URLs end up in proxy and access
    // logs, and this one would carry the app secret and the signup code
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code })

    // Signup codes are single-use, so an ambiguous failure must not be replayed
    const { data, status } = ensureOk(
      await this.request(
        this.url('oauth/access_token'),
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
        { idempotent: false }
      )
    )
    if (typeof data.access_token !== 'string') throw new WatahubApiError(data, status)
    return { accessToken: data.access_token }
  }

  /**
   * Subscribe App to WABA
   */
  async subscribeAppToWaba(
    wabaId: string,
    subscribedFields: readonly string[] = DEFAULT_WABA_SUBSCRIBED_FIELDS,
    overrideToken?: string
  ): Promise<boolean> {
    // Subscribing is a set operation: repeating it yields the same state
    const res = await this.post(
      `${wabaId}/subscribed_apps`,
      { subscribed_fields: subscribedFields },
      { idempotent: true },
      overrideToken
    )
    ensureOk(res)
    return true
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
    // Overwrites a single setting, so repeating it is safe
    const res = await this.post(
      phoneNumberId,
      { webhook_configuration: { override_callback_uri: callbackUrl, verify_token: verifyToken } },
      { idempotent: true },
      overrideToken
    )
    ensureOk(res)
    return true
  }

  /**
   * Resolve media ID to temporary downloadable CDN URL
   */
  async getMediaUrl(mediaId: string, overrideToken?: string): Promise<string> {
    const { data, status } = ensureOk(await this.get(mediaId, overrideToken))
    if (typeof data.url !== 'string') throw new WatahubApiError(data, status)
    return data.url
  }

  /**
   * Upload media file (multipart stream) to WhatsApp Cloud API
   */
  async uploadMedia(
    phoneNumberId: string,
    body: BodyInit,
    contentType?: string,
    overrideToken?: string
  ): Promise<{ id: string }> {
    const headers = new Headers({
      Authorization: `Bearer ${overrideToken || this.accessToken}`,
    })
    if (contentType) headers.set('Content-Type', contentType)
    const init: RequestInit = {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(60_000),
    }
    // @ts-expect-error duplex required in Node fetch when body is a stream
    init.duplex = 'half'

    const res = await this.fetchFn(this.url(`${phoneNumberId}/media`), init)
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || typeof data.id !== 'string') {
      throw new WatahubApiError(data, res.status)
    }
    return { id: data.id }
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

  /** Reads are idempotent */
  private get(endpoint: string, overrideToken?: string): Promise<GraphResponse> {
    return this.request(this.url(endpoint), { headers: this.headers(overrideToken) }, { idempotent: true })
  }

  private post(endpoint: string, body: unknown, options: RequestOptions, overrideToken?: string) {
    return this.request(
      this.url(endpoint),
      { method: 'POST', headers: this.headers(overrideToken), body: JSON.stringify(body) },
      options
    )
  }

  /**
   * Single transport entry point for every Graph call: per-attempt timeout and bounded retries.
   * - Rate limits (429 / 4 / 80007 / 130429) are retried for every call, honoring Retry-After.
   * - Timeouts, network errors and 5xx are retried only for idempotent calls.
   * Returns the last response (non-JSON bodies become `{}`); callers decide how to surface non-2xx results.
   */
  private async request(url: string, init: RequestInit, options: RequestOptions): Promise<GraphResponse> {
    const policy = this.retryPolicy

    for (let attempt = 0; ; attempt++) {
      const isLastAttempt = attempt >= policy.maxAttempts - 1

      let res: Response
      try {
        res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(policy.timeoutMs) })
      } catch (err) {
        if (!options.idempotent || isLastAttempt) throw err
        await this.sleep(backoffDelayMs(attempt, policy))
        continue
      }

      const json: unknown = await res.json().catch(() => undefined)
      const data: GraphBody = isRecord(json) ? json : {}
      if (res.ok || isLastAttempt) return { ok: res.ok, status: res.status, data }

      const code = metaErrorCode(data)
      if (isRateLimit(res.status, code)) {
        const hinted = retryAfterMs(res)
        await this.sleep(Math.min(policy.maxDelayMs, hinted ?? backoffDelayMs(attempt, policy)))
        continue
      }

      if (options.idempotent && isTransient(res.status, code)) {
        await this.sleep(backoffDelayMs(attempt, policy))
        continue
      }

      return { ok: res.ok, status: res.status, data }
    }
  }
}

/** Throws WatahubApiError unless the Graph response is 2xx. */
function ensureOk(res: GraphResponse): GraphResponse {
  if (!res.ok) throw new WatahubApiError(res.data, res.status)
  return res
}

/** Meta `/messages` request body. */
export interface MetaOutboundMessageBody {
  messaging_product: 'whatsapp'
  recipient_type: 'individual'
  to: string
  type: SendMessagePayload['kind']
  context?: { message_id: string }
  [field: string]: unknown
}

/**
 * Translates the gateway payload into Meta's `/messages` body.
 * Strips a leading `+` from the recipient. Throws on unsupported kinds.
 */
export function buildMetaMessageBody(payload: SendMessagePayload): MetaOutboundMessageBody {
  // Key order matches the historical wire format: context precedes type.
  const body: MetaOutboundMessageBody = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    // Trim first: a leading space would otherwise keep the + in place
    to: payload.to.trim().replace(/^\+/, ''),
    ...(payload.replyToMessageId ? { context: { message_id: payload.replyToMessageId } } : {}),
    type: payload.kind,
  }

  switch (payload.kind) {
    case 'text':
      body.text = { body: payload.text?.body || '' }
      break

    case 'template':
      body.template = payload.template
      break

    case 'reaction':
      body.reaction = {
        message_id: payload.reaction?.messageId,
        emoji: payload.reaction?.emoji ?? '',
      }
      break

    case 'image':
    case 'audio':
    case 'video':
    case 'document':
    case 'sticker':
      body[payload.kind] = buildMediaObject(payload)
      break

    case 'interactive': {
      if (payload.interactive?.type === 'flow') {
        const action = isRecord(payload.interactive.action) ? payload.interactive.action : undefined
        const params = isRecord(action?.parameters) ? action.parameters : undefined
        if (params && !params.flow_message_version) {
          body.interactive = {
            ...payload.interactive,
            action: {
              ...action,
              parameters: {
                flow_message_version: '3',
                ...params,
              },
            },
          }
          break
        }
      }
      body.interactive = payload.interactive
      break
    }

    case 'location': {
      const loc = payload.location
      body.location = {
        latitude: loc?.latitude,
        longitude: loc?.longitude,
        ...(loc?.name ? { name: loc.name } : {}),
        ...(loc?.address ? { address: loc.address } : {}),
      }
      break
    }

    case 'contacts':
      body.contacts = payload.contacts
      break

    default:
      throw new Error(`Unsupported message kind: ${String(payload.kind satisfies never)}`)
  }

  return body
}

function buildMediaObject({ kind, media }: SendMessagePayload): Record<string, unknown> {
  const mediaObj: Record<string, unknown> = {}
  if (media?.id) mediaObj.id = media.id
  if (media?.link) mediaObj.link = media.link
  if (kind !== 'sticker' && kind !== 'audio' && media?.caption) mediaObj.caption = media.caption
  if (kind === 'document' && media?.filename) mediaObj.filename = media.filename
  if (kind === 'audio' && media?.voice !== undefined) mediaObj.voice = media.voice
  return mediaObj
}
