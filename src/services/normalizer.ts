/**
 * Normalizes raw Meta Graph API v24.0 webhooks into clean WatahubNormalizedEvents.
 */

import { systemClock, type Clock } from '../clock.js'
import type { MetaInboundMessage, MetaMessageStatus, MetaWebhookPayload, MetaWebhookValue } from '../types/meta.js'
import type {
  NormalizedInteractiveReply,
  NormalizedMessage,
  NormalizedStatus,
  WatahubNormalizedEvent,
} from '../types/gateway.js'

type ChangeMetadata = MetaWebhookValue['metadata']

const EMPTY_METADATA: ChangeMetadata = { display_phone_number: '', phone_number_id: '' }

/**
 * Flattens every `messages` change of a WhatsApp webhook into events.
 * Within a change, inbound messages come first, then status updates.
 * The input is untrusted JSON, so every level is shape-checked at runtime.
 * `now` is only used when Meta sends an unparseable timestamp.
 */
export function normalizeMetaWebhook(payload: MetaWebhookPayload, now: Clock = systemClock): WatahubNormalizedEvent[] {
  const events: WatahubNormalizedEvent[] = []
  if (!payload || !Array.isArray(payload.entry)) return events

  for (const entry of payload.entry) {
    if (!Array.isArray(entry.changes)) continue

    for (const change of entry.changes) {
      if (change.field !== 'messages') continue
      const value = change.value
      if (value?.messaging_product !== 'whatsapp') continue

      events.push(...normalizeChangeValue(value, now))
    }
  }

  return events
}

function normalizeChangeValue(value: MetaWebhookValue, now: Clock): WatahubNormalizedEvent[] {
  const toMillis = (unixSeconds: string) => unixSecondsToMillis(unixSeconds, now)
  const metadata = value.metadata || EMPTY_METADATA
  const senderNames = indexSenderNames(value.contacts)
  const events: WatahubNormalizedEvent[] = []

  if (Array.isArray(value.messages)) {
    for (const msg of value.messages) {
      events.push({
        id: msg.id,
        timestamp: toMillis(msg.timestamp),
        phoneNumberId: metadata.phone_number_id,
        displayPhoneNumber: metadata.display_phone_number,
        type: 'message',
        message: normalizeMessage(msg, toMillis, senderNames.get(msg.from)),
      })
    }
  }

  if (Array.isArray(value.statuses)) {
    for (const status of value.statuses) {
      events.push({
        id: `${status.id}_${status.status}`,
        timestamp: toMillis(status.timestamp),
        phoneNumberId: metadata.phone_number_id,
        displayPhoneNumber: metadata.display_phone_number,
        type: 'status',
        status: normalizeStatus(status, toMillis),
      })
    }
  }

  return events
}

type ToMillis = (unixSeconds: string) => number

/** Meta sends unix seconds as strings; unparseable values fall back to "now". */
function unixSecondsToMillis(unixSeconds: string, now: Clock): number {
  return parseInt(unixSeconds, 10) * 1000 || now()
}

function indexSenderNames(contacts: MetaWebhookValue['contacts']): Map<string, string> {
  const names = new Map<string, string>()
  if (!Array.isArray(contacts)) return names

  for (const contact of contacts) {
    if (contact.wa_id && contact.profile?.name) {
      names.set(contact.wa_id, contact.profile.name)
    }
  }
  return names
}

function normalizeStatus(status: MetaMessageStatus, toMillis: ToMillis): NormalizedStatus {
  const firstError = status.errors?.[0]
  return {
    id: status.id,
    recipient: status.recipient_id,
    status: status.status,
    timestamp: toMillis(status.timestamp),
    category: status.pricing?.category,
    errorCode: firstError?.code,
    errorMessage: firstError?.message,
  }
}

function normalizeMessage(msg: MetaInboundMessage, toMillis: ToMillis, senderName?: string): NormalizedMessage {
  const base: NormalizedMessage = {
    id: msg.id,
    from: msg.from,
    senderName,
    timestamp: toMillis(msg.timestamp),
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

    case 'interactive': {
      const interactiveReply = toInteractiveReply(msg.interactive)
      return interactiveReply ? { ...base, interactiveReply } : base
    }

    case 'reaction':
      return {
        ...base,
        reaction: {
          targetMessageId: msg.reaction?.message_id || '',
          emoji: msg.reaction?.emoji || '',
        },
      }

    case 'location':
      return msg.location
        ? {
            ...base,
            location: {
              latitude: msg.location.latitude,
              longitude: msg.location.longitude,
              ...(msg.location.name ? { name: msg.location.name } : {}),
              ...(msg.location.address ? { address: msg.location.address } : {}),
              ...(msg.location.url ? { url: msg.location.url } : {}),
            },
          }
        : base

    default:
      return base
  }
}

/** Button and list replies only; flow (nfm) replies are not normalized yet. */
function toInteractiveReply(interactive: MetaInboundMessage['interactive']): NormalizedInteractiveReply | undefined {
  if (interactive?.type === 'button_reply') {
    return {
      id: interactive.button_reply?.id || '',
      title: interactive.button_reply?.title || '',
      type: 'button',
    }
  }
  if (interactive?.type === 'list_reply') {
    return {
      id: interactive.list_reply?.id || '',
      title: interactive.list_reply?.title || '',
      type: 'list',
    }
  }
  return undefined
}
