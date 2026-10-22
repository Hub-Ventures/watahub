/**
 * Direct Meta Graph API v24.0 Client
 */

import { WatahubApiError, type MetaApiErrorBody } from './errors.js'
import type { SendMessagePayload, SendMessageResponse } from '../types/gateway.js'

export interface MetaClientConfig {
  accessToken: string
  apiVersion?: string
  baseUrl?: string
}

export class MetaClient {
  private accessToken: string
  private apiVersion: string
  private baseUrl: string

  constructor(config: MetaClientConfig) {
    this.accessToken = config.accessToken
    this.apiVersion = config.apiVersion || 'v24.0'
    this.baseUrl = config.baseUrl || 'https://graph.facebook.com'
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

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: this.headers(overrideToken),
      body: JSON.stringify(metaBody),
    })

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>

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
    const res = await fetch(endpoint, {
      headers: this.headers(overrideToken),
    })

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
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
    const url = new URL(endpoint)
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('client_secret', clientSecret)
    url.searchParams.set('code', code)

    const res = await fetch(url.toString())
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>

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
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: this.headers(overrideToken),
      body: JSON.stringify({
        subscribed_fields: ['messages', 'smb_message_echoes', 'history', 'smb_app_state_sync'],
      }),
    })

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
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: this.headers(overrideToken),
      body: JSON.stringify({
        webhook_configuration: {
          override_callback_uri: callbackUrl,
          verify_token: verifyToken,
        },
      }),
    })

    return res.ok
  }

  /**
   * Resolve media ID to temporary downloadable CDN URL
   */
  async getMediaUrl(mediaId: string, overrideToken?: string): Promise<string> {
    const endpoint = this.url(mediaId)
    const res = await fetch(endpoint, {
      headers: this.headers(overrideToken),
    })

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || typeof data.url !== 'string') {
      throw new WatahubApiError(data as unknown as MetaApiErrorBody, res.status)
    }

    return data.url
  }
}
