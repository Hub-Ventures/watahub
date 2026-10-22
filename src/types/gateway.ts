/**
 * Watahub Gateway Public Types & Contracts
 */

export type OutboundMessageKind =
  | 'text'
  | 'template'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'reaction'
  | 'interactive'

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
    components?: Array<{
      type: 'header' | 'body' | 'button'
      sub_type?: 'quick_reply' | 'url'
      index?: string | number
      parameters: Array<Record<string, unknown>>
    }>
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

export interface WatahubNormalizedEvent {
  id: string
  timestamp: number
  phoneNumberId: string
  displayPhoneNumber: string
  type: 'message' | 'status' | 'error'
  message?: {
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
    interactiveReply?: {
      id: string
      title: string
      type: string
    }
    reaction?: {
      targetMessageId: string
      emoji: string
    }
    referral?: Record<string, unknown>
    replyToMessageId?: string
  }
  status?: {
    id: string
    recipient: string
    status: 'sent' | 'delivered' | 'read' | 'failed'
    timestamp: number
    category?: string
    errorCode?: number
    errorMessage?: string
  }
}
