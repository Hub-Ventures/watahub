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
  contacts?: MetaWebhookContact[]
  messages?: MetaInboundMessage[]
  message_echoes?: MetaInboundMessage[]
  statuses?: MetaMessageStatus[]
  errors?: MetaWebhookError[]
}

/**
 * Sender (or, in echoes, recipient) of the changes in this value. Since April 2026
 * `wa_id` can be missing when the user has a WhatsApp username and does not share
 * their phone; `user_id` (their business-scoped user ID, BSUID) is always sent.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/
 */
export interface MetaWebhookContact {
  profile: {
    name: string
    username?: string
  }
  wa_id?: string
  user_id?: string
  /** Only for businesses enrolled in parent BSUIDs */
  parent_user_id?: string
}

export interface MetaInboundLocation {
  latitude: number
  longitude: number
  name?: string
  address?: string
  url?: string
}

export interface MetaOrderItem {
  product_retailer_id: string
  quantity: number | string
  item_price: number | string
  currency: string
}

export interface MetaInboundOrder {
  catalog_id: string
  text?: string
  product_items: MetaOrderItem[]
}

export interface MetaContactAddress {
  street?: string
  city?: string
  state?: string
  zip?: string
  country?: string
  country_code?: string
  type?: string
}

export interface MetaContactEmail {
  email?: string
  type?: string
}

export interface MetaContactName {
  formatted_name: string
  first_name?: string
  last_name?: string
  middle_name?: string
  suffix?: string
  prefix?: string
}

export interface MetaContactOrg {
  company?: string
  department?: string
  title?: string
}

export interface MetaContactPhone {
  phone?: string
  type?: string
  wa_id?: string
}

export interface MetaContactUrl {
  url?: string
  type?: string
}

export interface MetaInboundContact {
  addresses?: MetaContactAddress[]
  birthday?: string
  emails?: MetaContactEmail[]
  name: MetaContactName
  org?: MetaContactOrg
  phones?: MetaContactPhone[]
  urls?: MetaContactUrl[]
}

export interface MetaInboundReferral {
  source_url?: string
  source_type?: string
  source_id?: string
  headline?: string
  body?: string
  media_type?: string
  image_url?: string
  video_url?: string
  thumbnail_url?: string
  ctwa_clid?: string
}

export interface MetaInboundMessage {
  /** Sender's phone number; missing when a user with a username does not share it */
  from?: string
  /** Sender's BSUID */
  from_user_id?: string
  from_parent_user_id?: string
  /** Echoes: the customer's phone number, which can also be missing */
  to?: string
  /** Echoes: the customer's BSUID */
  to_user_id?: string
  to_parent_user_id?: string
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
    | 'sticker'
    | 'poll'
    | 'poll_update'
    | 'order'
    | 'unknown'
  text?: {
    body: string
  }
  image?: MetaMediaAttachment
  audio?: MetaMediaAttachment & { voice?: boolean }
  video?: MetaMediaAttachment
  document?: MetaMediaAttachment & { filename?: string }
  sticker?: MetaMediaAttachment & { animated?: boolean }
  location?: MetaInboundLocation
  contacts?: MetaInboundContact[]
  interactive?: {
    type: 'button_reply' | 'list_reply' | 'nfm_reply' | 'poll_update'
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
    poll_update?: {
      poll_id?: string
      message_id?: string
      selected_options?: Array<string | { id?: string; title?: string; name?: string }>
      timestamp?: string
    }
  }
  button?: {
    payload: string
    text: string
  }
  reaction?: {
    message_id: string
    emoji?: string
  }
  poll_update?: {
    poll_id?: string
    message_id?: string
    selected_options?: Array<string | { id?: string; title?: string; name?: string }>
    timestamp?: string
  }
  poll?: {
    poll_id?: string
    selected_options?: Array<string | { id?: string; title?: string; name?: string }>
    timestamp?: string
  }
  order?: MetaInboundOrder
  context?: {
    from: string
    id: string
    referred_product?: {
      catalog_id: string
      product_retailer_id: string
    }
  }
  referral?: MetaInboundReferral
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
  /** Recipient's phone number; missing when the message went to a BSUID without a shared phone */
  recipient_id?: string
  recipient_user_id?: string
  recipient_parent_user_id?: string
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
