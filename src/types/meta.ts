/**
 * Meta Graph API v24.0 WhatsApp Types
 */

export interface MetaWebhookEntry {
  id: string
  changes: Array<{
    value: MetaWebhookValue
    field: string
  }>
}

export interface MetaWebhookPayload {
  object: string
  entry: MetaWebhookEntry[]
}

export interface MetaWebhookValue {
  messaging_product: 'whatsapp'
  metadata: {
    display_phone_number: string
    phone_number_id: string
  }
  contacts?: Array<{
    profile: {
      name: string
    }
    wa_id: string
  }>
  messages?: MetaInboundMessage[]
  statuses?: MetaMessageStatus[]
  errors?: MetaWebhookError[]
}

export interface MetaInboundLocation {
  latitude: number
  longitude: number
  name?: string
  address?: string
  url?: string
}

export interface MetaInboundMessage {
  from: string
  id: string
  timestamp: string
  type:
    | 'text'
    | 'image'
    | 'audio'
    | 'video'
    | 'document'
    | 'interactive'
    | 'button'
    | 'reaction'
    | 'location'
    | 'contacts'
    | 'unknown'
  text?: {
    body: string
  }
  image?: MetaMediaAttachment
  audio?: MetaMediaAttachment & { voice?: boolean }
  video?: MetaMediaAttachment
  document?: MetaMediaAttachment & { filename?: string }
  location?: MetaInboundLocation
  interactive?: {
    type: 'button_reply' | 'list_reply' | 'nfm_reply'
    button_reply?: {
      id: string
      title: string
    }
    list_reply?: {
      id: string
      title: string
      description?: string
    }
    nfm_reply?: {
      response_json: string
      body: string
      name: string
    }
  }
  button?: {
    payload: string
    text: string
  }
  reaction?: {
    message_id: string
    emoji: string
  }
  context?: {
    from: string
    id: string
    referred_product?: {
      catalog_id: string
      product_retailer_id: string
    }
  }
  referral?: {
    source_url: string
    source_type: string
    source_id: string
    headline: string
    body: string
    media_type: string
    image_url?: string
    video_url?: string
    thumbnail_url?: string
    ctwa_clid?: string
  }
}

export interface MetaMediaAttachment {
  id: string
  mime_type: string
  sha256?: string
  caption?: string
}

export interface MetaMessageStatus {
  id: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  timestamp: string
  recipient_id: string
  conversation?: {
    id: string
    expiration_timestamp?: string
    origin?: {
      type: 'user_initiated' | 'business_initiated' | 'referral_conversion'
    }
  }
  pricing?: {
    billable: boolean
    pricing_model: string
    category: 'service' | 'utility' | 'authentication' | 'marketing'
  }
  errors?: MetaWebhookError[]
}

export interface MetaWebhookError {
  code: number
  title: string
  message: string
  error_data?: {
    details: string
  }
}
