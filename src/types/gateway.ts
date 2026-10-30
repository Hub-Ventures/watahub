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
  'location',
  'contacts',
  'sticker',
] as const

export type OutboundMessageKind = (typeof OUTBOUND_MESSAGE_KINDS)[number]

/** Kinds whose content lives in `media` (id or link) */
export const MEDIA_MESSAGE_KINDS = [
  'image',
  'audio',
  'video',
  'document',
  'sticker',
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
    /**
     * If true for kind 'audio', instructs WhatsApp to render as a voice note (PTT / push-to-talk).
     * WhatsApp requires audio encoded with `audio/ogg; codecs=opus` for voice bubble rendering.
     */
    voice?: boolean
  }
  reaction?: {
    messageId: string
    emoji: string
  }
  interactive?: Record<string, unknown>
  location?: {
    latitude: number
    longitude: number
    name?: string
    address?: string
  }
  contacts?: ContactCard[]
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

export interface ContactAddress {
  street?: string
  city?: string
  state?: string
  zip?: string
  country?: string
  country_code?: string
  type?: string
}

export interface ContactEmail {
  email?: string
  type?: string
}

export interface ContactName {
  formatted_name: string
  first_name?: string
  last_name?: string
  middle_name?: string
  suffix?: string
  prefix?: string
}

export interface ContactOrg {
  company?: string
  department?: string
  title?: string
}

export interface ContactPhone {
  phone?: string
  type?: string
  wa_id?: string
}

export interface ContactUrl {
  url?: string
  type?: string
}

export interface ContactCard {
  name: ContactName
  phones?: ContactPhone[]
  emails?: ContactEmail[]
  addresses?: ContactAddress[]
  org?: ContactOrg
  urls?: ContactUrl[]
  birthday?: string
}

export interface FlowActionParameters {
  flow_token: string
  flow_id: string
  flow_cta: string
  flow_action: 'navigate' | 'data_exchange'
  flow_action_payload?: {
    screen?: string
    data?: Record<string, unknown>
  }
  flow_message_version?: string
  mode?: 'draft' | 'published'
}

export interface InteractiveFlowMessage {
  type: 'flow'
  header?: {
    type: 'text' | 'image' | 'video' | 'document'
    text?: string
    image?: Record<string, unknown>
    video?: Record<string, unknown>
    document?: Record<string, unknown>
  }
  body: {
    text: string
  }
  footer?: {
    text: string
  }
  action: {
    name: 'flow'
    parameters: FlowActionParameters
  }
}

export interface InteractiveLocationRequestMessage {
  type: 'location_request_message'
  body: {
    text: string
  }
  action: {
    name: 'send_location'
  }
}

export interface InteractiveCtaUrlMessage {
  type: 'cta_url'
  header?: {
    type: 'text' | 'image' | 'video' | 'document'
    text?: string
    image?: Record<string, unknown>
    video?: Record<string, unknown>
    document?: Record<string, unknown>
  }
  body: {
    text: string
  }
  footer?: {
    text: string
  }
  action: {
    name: 'cta_url'
    parameters: {
      display_text: string
      url: string
    }
  }
}

export interface InteractiveProductMessage {
  type: 'product'
  body?: { text: string }
  footer?: { text: string }
  action: {
    catalog_id: string
    product_retailer_id: string
  }
}

export interface InteractiveProductListSection {
  title: string
  product_items: Array<{ product_retailer_id: string }>
}

export interface InteractiveProductListMessage {
  type: 'product_list'
  header: {
    type: 'text'
    text: string
  }
  body: { text: string }
  footer?: { text: string }
  action: {
    catalog_id: string
    sections: InteractiveProductListSection[]
  }
}

export interface InteractiveOrderDetailsMessage {
  type: 'order_details'
  header?: {
    type?: string
    text?: string
  }
  body?: { text: string }
  footer?: { text: string }
  action: {
    name: string
    parameters: Record<string, unknown>
  }
}

export interface NormalizedOrderItem {
  productRetailerId: string
  quantity: number
  itemPrice: number
  currency: string
}

export interface NormalizedOrder {
  catalogId: string
  text?: string
  productItems: NormalizedOrderItem[]
}

export interface NormalizedPollVote {
  pollMessageId?: string
  selectedOptionIds: string[]
  timestamp?: number
}

export interface NormalizedInteractiveReply {
  id?: string
  title?: string
  type: 'button' | 'list' | 'nfm_reply'
  name?: string
  body?: string
  responseJson?: Record<string, unknown>
  /** nfm_reply only: Meta sent a response_json that is not a JSON object, so responseJson is missing */
  responseJsonError?: true
}

export interface NormalizedLocation {
  latitude: number
  longitude: number
  name?: string
  address?: string
  url?: string
}

export interface NormalizedReferral {
  sourceType: string
  sourceId: string
  sourceUrl?: string
  headline?: string
  body?: string
  mediaType?: string
  imageUrl?: string
  videoUrl?: string
  thumbnailUrl?: string
  ctwaClid?: string
}

export interface NormalizedMessage {
  id: string
  from: string
  recipient?: string
  senderName?: string
  timestamp: number
  kind: string
  text?: string
  mediaId?: string
  mediaMime?: string
  caption?: string
  filename?: string
  isVoice?: boolean
  animated?: boolean
  isEcho?: boolean
  interactiveReply?: NormalizedInteractiveReply
  button?: {
    payload: string
    text: string
  }
  reaction?: {
    targetMessageId: string
    emoji: string
  }
  pollVote?: NormalizedPollVote
  order?: NormalizedOrder
  location?: NormalizedLocation
  contacts?: ContactCard[]
  referral?: NormalizedReferral
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
  type: 'message' | 'status' | 'error' | 'echo'
  message?: NormalizedMessage
  status?: NormalizedStatus
}

/** Body POSTed to SUBSCRIBER_WEBHOOK_URL */
export interface SubscriberPayload {
  timestamp: number
  events: WatahubNormalizedEvent[]
  raw: unknown
}
