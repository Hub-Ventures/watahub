/**
 * Watahub Gateway Public Types & Contracts
 */

export const OUTBOUND_MESSAGE_KINDS = [
  'text',
  'template',
  'image',
  'audio',
  'video',
  'document',
  'reaction',
  'interactive',
] as const

export type OutboundMessageKind = (typeof OUTBOUND_MESSAGE_KINDS)[number]

/** Kinds whose content lives in `media` (id or link) */
export const MEDIA_MESSAGE_KINDS = [
  'image',
  'audio',
  'video',
  'document',
] as const satisfies readonly OutboundMessageKind[]

export type MediaMessageKind = (typeof MEDIA_MESSAGE_KINDS)[number]

export function isMediaKind(kind: OutboundMessageKind): kind is MediaMessageKind {
  return (MEDIA_MESSAGE_KINDS as readonly OutboundMessageKind[]).includes(kind)
}

/**
 * A template component as sent to Meta (`type`, `sub_type`, `index`, `parameters`...).
 * The gateway forwards components verbatim and Meta validates them, so they are open records.
 */
export type TemplateComponent = Record<string, unknown>

export interface SendMessagePayload {
  to: string
  phoneNumberId?: string
  tenantId?: string
  kind: OutboundMessageKind
  text?: {
    body: string
  }
  template?: {
    name: string
    language: {
      code: string
    }
    components?: TemplateComponent[]
  }
  media?: {
    id?: string
    link?: string
    caption?: string
    filename?: string
  }
  reaction?: {
    messageId: string
    emoji: string
  }
  interactive?: Record<string, unknown>
  replyToMessageId?: string
}

export interface SendMessageResponse {
  success: boolean
  messageId: string
  recipient: string
  phoneNumberId: string
}

/** A message template exactly as Graph returns it (`id`, `name`, `status`, `language`, `components`...) */
export type MetaMessageTemplate = Record<string, unknown>

export interface NormalizedInteractiveReply {
  id: string
  title: string
  type: 'button' | 'list'
}

export interface NormalizedMessage {
  id: string
  from: string
  senderName?: string
  timestamp: number
  kind: string
  text?: string
  mediaId?: string
  mediaMime?: string
  caption?: string
  filename?: string
  isVoice?: boolean
  interactiveReply?: NormalizedInteractiveReply
  reaction?: {
    targetMessageId: string
    emoji: string
  }
  referral?: Record<string, unknown>
  replyToMessageId?: string
}

export interface NormalizedStatus {
  id: string
  recipient: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  timestamp: number
  category?: string
  errorCode?: number
  errorMessage?: string
}

export interface WatahubNormalizedEvent {
  id: string
  timestamp: number
  phoneNumberId: string
  displayPhoneNumber: string
  type: 'message' | 'status' | 'error'
  message?: NormalizedMessage
  status?: NormalizedStatus
}

/** Body POSTed to SUBSCRIBER_WEBHOOK_URL */
export interface SubscriberPayload {
  timestamp: number
  events: WatahubNormalizedEvent[]
  raw: unknown
}
