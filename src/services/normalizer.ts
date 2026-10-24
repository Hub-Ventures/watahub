/**
 * Normalizes raw Meta Graph API v24.0 webhooks into clean WatahubNormalizedEvents.
 */

import { systemClock, type Clock } from '../clock.js'
import { isRecord } from '../utils/guards.js'
import type {
  MetaInboundContact,
  MetaInboundMessage,
  MetaInboundOrder,
  MetaInboundReferral,
  MetaMessageStatus,
  MetaWebhookPayload,
  MetaWebhookValue,
} from '../types/meta.js'
import type {
  ContactCard,
  NormalizedInteractiveReply,
  NormalizedMessage,
  NormalizedOrder,
  NormalizedOrderItem,
  NormalizedPollVote,
  NormalizedReferral,
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
  const referral = normalizeReferral(msg.referral)
  const base: NormalizedMessage = {
    id: msg.id,
    from: msg.from,
    senderName,
    timestamp: toMillis(msg.timestamp),
    kind: msg.type,
    replyToMessageId: msg.context?.id,
    ...(referral ? { referral } : {}),
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

    case 'video':
      return {
        ...base,
        mediaId: msg.video?.id,
        mediaMime: msg.video?.mime_type,
        caption: msg.video?.caption,
      }

    case 'sticker':
      return {
        ...base,
        mediaId: msg.sticker?.id,
        mediaMime: msg.sticker?.mime_type || 'image/webp',
        animated: msg.sticker?.animated === true,
      }

    case 'interactive': {
      if (msg.interactive?.type === 'poll_update') {
        const pollVote = extractPollVote(msg.interactive.poll_update, toMillis, msg.context?.id)
        return pollVote ? { ...base, pollVote } : base
      }
      const interactiveReply = toInteractiveReply(msg.interactive)
      return interactiveReply ? { ...base, interactiveReply } : base
    }

    case 'poll_update':
    case 'poll': {
      const pollData = msg.poll_update || msg.poll
      const pollVote = extractPollVote(pollData, toMillis, msg.context?.id)
      return pollVote ? { ...base, pollVote } : base
    }

    case 'order': {
      const order = normalizeInboundOrder(msg.order)
      return order ? { ...base, order } : base
    }

    case 'reaction':
      return {
        ...base,
        reaction: {
          targetMessageId: msg.reaction?.message_id || '',
          emoji: msg.reaction?.emoji ?? '',
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

    case 'contacts': {
      const contacts = normalizeInboundContacts(msg.contacts)
      return contacts ? { ...base, contacts } : base
    }

    default:
      return base
  }
}

function normalizeInboundContacts(contacts?: MetaInboundContact[]): ContactCard[] | undefined {
  if (!Array.isArray(contacts) || contacts.length === 0) return undefined
  return contacts.map((c) => ({
    name: {
      formatted_name: c.name?.formatted_name || '',
      ...(c.name?.first_name ? { first_name: c.name.first_name } : {}),
      ...(c.name?.last_name ? { last_name: c.name.last_name } : {}),
      ...(c.name?.middle_name ? { middle_name: c.name.middle_name } : {}),
      ...(c.name?.suffix ? { suffix: c.name.suffix } : {}),
      ...(c.name?.prefix ? { prefix: c.name.prefix } : {}),
    },
    ...(Array.isArray(c.phones) && c.phones.length > 0
      ? {
          phones: c.phones.map((p) => ({
            phone: p.phone || '',
            ...(p.type ? { type: p.type } : {}),
            ...(p.wa_id ? { wa_id: p.wa_id } : {}),
          })),
        }
      : {}),
    ...(Array.isArray(c.emails) && c.emails.length > 0
      ? {
          emails: c.emails.map((e) => ({
            email: e.email || '',
            ...(e.type ? { type: e.type } : {}),
          })),
        }
      : {}),
    ...(Array.isArray(c.addresses) && c.addresses.length > 0
      ? {
          addresses: c.addresses.map((a) => ({
            ...(a.street ? { street: a.street } : {}),
            ...(a.city ? { city: a.city } : {}),
            ...(a.state ? { state: a.state } : {}),
            ...(a.zip ? { zip: a.zip } : {}),
            ...(a.country ? { country: a.country } : {}),
            ...(a.country_code ? { country_code: a.country_code } : {}),
            ...(a.type ? { type: a.type } : {}),
          })),
        }
      : {}),
    ...(c.org && (c.org.company || c.org.department || c.org.title)
      ? {
          org: {
            ...(c.org.company ? { company: c.org.company } : {}),
            ...(c.org.department ? { department: c.org.department } : {}),
            ...(c.org.title ? { title: c.org.title } : {}),
          },
        }
      : {}),
    ...(Array.isArray(c.urls) && c.urls.length > 0
      ? {
          urls: c.urls.map((u) => ({
            url: u.url || '',
            ...(u.type ? { type: u.type } : {}),
          })),
        }
      : {}),
    ...(c.birthday ? { birthday: c.birthday } : {}),
  }))
}

/** Normalizes button, list, and Flow (nfm_reply) user responses. */
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
  if (interactive?.type === 'nfm_reply') {
    const nfm = interactive.nfm_reply
    let responseJson: Record<string, unknown> | undefined
    if (nfm?.response_json) {
      try {
        const parsed: unknown = JSON.parse(nfm.response_json)
        if (isRecord(parsed)) {
          responseJson = parsed
        }
      } catch {
        // malformed json string remains undefined
      }
    }
    return {
      type: 'nfm_reply',
      name: nfm?.name || '',
      body: nfm?.body || '',
      ...(responseJson ? { responseJson } : {}),
    }
  }
  return undefined
}

interface RawPollData {
  poll_id?: string
  message_id?: string
  selected_options?: Array<string | { id?: string; title?: string; name?: string }>
  timestamp?: string
}

function extractPollVote(
  data?: RawPollData,
  toMillis?: (t: string) => number,
  contextId?: string
): NormalizedPollVote | undefined {
  if (!data) return undefined
  const pollMessageId = data.poll_id || data.message_id || contextId || ''
  const selectedOptionIds: string[] = []
  if (Array.isArray(data.selected_options)) {
    for (const opt of data.selected_options) {
      if (typeof opt === 'string' && opt.length > 0) {
        selectedOptionIds.push(opt)
      } else if (opt && typeof opt === 'object') {
        const id = opt.id || opt.name || opt.title
        if (id) selectedOptionIds.push(id)
      }
    }
  }
  return {
    pollMessageId,
    selectedOptionIds,
    ...(data.timestamp && toMillis ? { timestamp: toMillis(data.timestamp) } : {}),
  }
}

function normalizeInboundOrder(raw?: MetaInboundOrder): NormalizedOrder | undefined {
  if (!raw) return undefined
  const productItems: NormalizedOrderItem[] = []
  if (Array.isArray(raw.product_items)) {
    for (const item of raw.product_items) {
      const quantity = typeof item.quantity === 'number' ? item.quantity : Number(item.quantity) || 0
      const itemPrice = typeof item.item_price === 'number' ? item.item_price : Number(item.item_price) || 0
      productItems.push({
        productRetailerId: item.product_retailer_id || '',
        quantity,
        itemPrice,
        currency: item.currency || '',
      })
    }
  }
  return {
    catalogId: raw.catalog_id || '',
    ...(raw.text ? { text: raw.text } : {}),
    productItems,
  }
}

function normalizeReferral(raw?: MetaInboundReferral): NormalizedReferral | undefined {
  if (!raw) return undefined
  return {
    sourceType: raw.source_type || '',
    sourceId: raw.source_id || '',
    ...(raw.source_url ? { sourceUrl: raw.source_url } : {}),
    ...(raw.headline ? { headline: raw.headline } : {}),
    ...(raw.body ? { body: raw.body } : {}),
    ...(raw.media_type ? { mediaType: raw.media_type } : {}),
    ...(raw.image_url ? { imageUrl: raw.image_url } : {}),
    ...(raw.video_url ? { videoUrl: raw.video_url } : {}),
    ...(raw.thumbnail_url ? { thumbnailUrl: raw.thumbnail_url } : {}),
    ...(raw.ctwa_clid ? { ctwaClid: raw.ctwa_clid } : {}),
  }
}
