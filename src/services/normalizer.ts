/**
 * Normalizes raw Meta Graph API v24.0 webhooks into clean WatahubNormalizedEvents.
 */

import type { MetaWebhookPayload, MetaInboundMessage, MetaMessageStatus } from '../types/meta.js'
import type { WatahubNormalizedEvent } from '../types/gateway.js'

export function normalizeMetaWebhook(payload: MetaWebhookPayload): WatahubNormalizedEvent[] {
  const events: WatahubNormalizedEvent[] = []

  if (!payload || !Array.isArray(payload.entry)) return events

  for (const entry of payload.entry) {
    if (!Array.isArray(entry.changes)) continue

    for (const change of entry.changes) {
      if (change.field !== 'messages') continue
      const value = change.value
      if (!value || value.messaging_product !== 'whatsapp') continue

      const metadata = value.metadata || { display_phone_number: '', phone_number_id: '' }
      const contactsMap = new Map<string, string>()

      if (Array.isArray(value.contacts)) {
        for (const c of value.contacts) {
          if (c.wa_id && c.profile?.name) {
            contactsMap.set(c.wa_id, c.profile.name)
          }
        }
      }

      // 1. Process Messages
      if (Array.isArray(value.messages)) {
        for (const msg of value.messages) {
          const normMsg = normalizeSingleMessage(msg, contactsMap.get(msg.from))
          events.push({
            id: msg.id,
            timestamp: parseInt(msg.timestamp, 10) * 1000 || Date.now(),
            phoneNumberId: metadata.phone_number_id,
            displayPhoneNumber: metadata.display_phone_number,
            type: 'message',
            message: normMsg,
          })
        }
      }

      // 2. Process Status Updates
      if (Array.isArray(value.statuses)) {
        for (const status of value.statuses) {
          events.push({
            id: `${status.id}_${status.status}`,
            timestamp: parseInt(status.timestamp, 10) * 1000 || Date.now(),
            phoneNumberId: metadata.phone_number_id,
            displayPhoneNumber: metadata.display_phone_number,
            type: 'status',
            status: {
              id: status.id,
              recipient: status.recipient_id,
              status: status.status,
              timestamp: parseInt(status.timestamp, 10) * 1000 || Date.now(),
              category: status.pricing?.category,
              errorCode: status.errors?.[0]?.code,
              errorMessage: status.errors?.[0]?.message,
            },
          })
        }
      }
    }
  }

  return events
}

function normalizeSingleMessage(
  msg: MetaInboundMessage,
  senderName?: string
): NonNullable<WatahubNormalizedEvent['message']> {
  const base = {
    id: msg.id,
    from: msg.from,
    senderName,
    timestamp: parseInt(msg.timestamp, 10) * 1000 || Date.now(),
    kind: msg.type,
    replyToMessageId: msg.context?.id,
  }

  switch (msg.type) {
    case 'text':
      return { ...base, text: msg.text?.body || '' }

    case 'image':
      return {
        ...base,
        mediaId: msg.image?.id,
        mediaMime: msg.image?.mime_type,
        caption: msg.image?.caption,
      }

    case 'audio':
      return {
        ...base,
        mediaId: msg.audio?.id,
        mediaMime: msg.audio?.mime_type,
        isVoice: msg.audio?.voice === true,
      }

    case 'document':
      return {
        ...base,
        mediaId: msg.document?.id,
        mediaMime: msg.document?.mime_type,
        filename: msg.document?.filename,
        caption: msg.document?.caption,
      }

    case 'interactive':
      if (msg.interactive?.type === 'button_reply') {
        return {
          ...base,
          interactiveReply: {
            id: msg.interactive.button_reply?.id || '',
            title: msg.interactive.button_reply?.title || '',
            type: 'button',
          },
        }
      }
      if (msg.interactive?.type === 'list_reply') {
        return {
          ...base,
          interactiveReply: {
            id: msg.interactive.list_reply?.id || '',
            title: msg.interactive.list_reply?.title || '',
            type: 'list',
          },
        }
      }
      return base

    case 'reaction':
      return {
        ...base,
        reaction: {
          targetMessageId: msg.reaction?.message_id || '',
          emoji: msg.reaction?.emoji || '',
        },
      }

    default:
      return base
  }
}
