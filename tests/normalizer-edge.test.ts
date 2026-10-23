import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeMetaWebhook } from '../src/services/normalizer.js'
import type { MetaInboundMessage, MetaMessageStatus, MetaWebhookPayload, MetaWebhookValue } from '../src/types/meta.js'

const metadata = { display_phone_number: 'D', phone_number_id: 'P' }

function payloadWith(value: Partial<MetaWebhookValue>, field = 'messages'): MetaWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'W', changes: [{ field, value: { messaging_product: 'whatsapp', metadata, ...value } }] }],
  }
}

const message = (msg: Partial<MetaInboundMessage>): MetaInboundMessage => ({
  from: '1',
  id: 'wamid.x',
  timestamp: '10',
  type: 'text',
  ...msg,
})

const normalizeOne = (msg: Partial<MetaInboundMessage>) =>
  normalizeMetaWebhook(payloadWith({ messages: [message(msg)] }))[0].message

describe('normalizeMetaWebhook edge cases', () => {
  afterEach(() => vi.useRealTimers())

  it('returns [] for missing or malformed payloads', () => {
    expect(normalizeMetaWebhook(undefined as unknown as MetaWebhookPayload)).toEqual([])
    expect(normalizeMetaWebhook({ object: 'x' } as unknown as MetaWebhookPayload)).toEqual([])
    expect(normalizeMetaWebhook({ object: 'x', entry: [{ id: 'W' }] } as unknown as MetaWebhookPayload)).toEqual([])
  })

  it('skips non-messages fields and non-whatsapp products', () => {
    expect(normalizeMetaWebhook(payloadWith({ messages: [message({})] }, 'account_update'))).toEqual([])
    const other = payloadWith({ messages: [message({})] })
    ;(other.entry[0].changes[0].value as { messaging_product: string }).messaging_product = 'instagram'
    expect(normalizeMetaWebhook(other)).toEqual([])
  })

  it('falls back to Date.now() for unparseable timestamps and empty metadata', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(5_000))
    const payload = payloadWith({ messages: [message({ timestamp: 'nope' })] })
    delete (payload.entry[0].changes[0].value as Partial<MetaWebhookValue>).metadata
    const [event] = normalizeMetaWebhook(payload)
    expect(event.timestamp).toBe(5_000)
    expect(event.message?.timestamp).toBe(5_000)
    expect(event.phoneNumberId).toBe('')
    expect(event.displayPhoneNumber).toBe('')
  })

  it('emits messages before statuses within one change', () => {
    const status: MetaMessageStatus = { id: 'wamid.out', status: 'read', timestamp: '20', recipient_id: '2' }
    const events = normalizeMetaWebhook(payloadWith({ messages: [message({})], statuses: [status] }))
    expect(events.map((e) => e.type)).toEqual(['message', 'status'])
    // Subscribers receive this JSON verbatim, so key order is part of the contract.
    expect(Object.keys(events[0])).toEqual([
      'id',
      'timestamp',
      'phoneNumberId',
      'displayPhoneNumber',
      'type',
      'message',
    ])
    expect(Object.keys(events[0].message!)).toEqual([
      'id',
      'from',
      'senderName',
      'timestamp',
      'kind',
      'replyToMessageId',
      'text',
    ])
    expect(Object.keys(events[1].status!)).toEqual([
      'id',
      'recipient',
      'status',
      'timestamp',
      'category',
      'errorCode',
      'errorMessage',
    ])
    expect(events[1]).toEqual({
      id: 'wamid.out_read',
      timestamp: 20_000,
      phoneNumberId: 'P',
      displayPhoneNumber: 'D',
      type: 'status',
      status: {
        id: 'wamid.out',
        recipient: '2',
        status: 'read',
        timestamp: 20_000,
        category: undefined,
        errorCode: undefined,
        errorMessage: undefined,
      },
    })
  })

  it('surfaces the first status error', () => {
    const status: MetaMessageStatus = {
      id: 'wamid.f',
      status: 'failed',
      timestamp: '1',
      recipient_id: '2',
      errors: [
        { code: 131047, title: 'Re-engagement', message: 'More than 24 hours' },
        { code: 1, title: 'x', message: 'y' },
      ],
    }
    const [event] = normalizeMetaWebhook(payloadWith({ statuses: [status] }))
    expect(event.status).toMatchObject({ errorCode: 131047, errorMessage: 'More than 24 hours' })
  })

  it('maps sender names by wa_id and reply context', () => {
    const events = normalizeMetaWebhook(
      payloadWith({
        contacts: [
          { wa_id: '1', profile: { name: 'Ana' } },
          { wa_id: '2', profile: { name: 'Beto' } },
        ],
        messages: [message({ from: '2', context: { from: '1', id: 'wamid.parent' } }), message({ from: '3' })],
      })
    )
    expect(events[0].message).toMatchObject({ senderName: 'Beto', replyToMessageId: 'wamid.parent' })
    expect(events[1].message?.senderName).toBeUndefined()
  })

  it('normalizes each inbound kind', () => {
    expect(normalizeOne({ type: 'text' })?.text).toBe('')
    expect(normalizeOne({ type: 'image', image: { id: 'I', mime_type: 'image/jpeg', caption: 'c' } })).toMatchObject({
      mediaId: 'I',
      mediaMime: 'image/jpeg',
      caption: 'c',
    })
    expect(normalizeOne({ type: 'audio', audio: { id: 'A', mime_type: 'audio/ogg' } })?.isVoice).toBe(false)
    expect(
      normalizeOne({ type: 'document', document: { id: 'F', mime_type: 'application/pdf', filename: 'f.pdf' } })
    ).toMatchObject({ mediaId: 'F', filename: 'f.pdf' })
    expect(
      normalizeOne({
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'row', title: 'Row' } },
      })?.interactiveReply
    ).toEqual({ id: 'row', title: 'Row', type: 'list' })
    expect(
      normalizeOne({
        type: 'interactive',
        interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{}', body: '', name: 'f' } },
      })?.interactiveReply
    ).toBeUndefined()
    expect(normalizeOne({ type: 'reaction', reaction: { message_id: 'wamid.t', emoji: '❤️' } })?.reaction).toEqual({
      targetMessageId: 'wamid.t',
      emoji: '❤️',
    })
  })

  it('keeps only base fields for video and unknown kinds', () => {
    const base = { id: 'wamid.x', from: '1', senderName: undefined, timestamp: 10_000, replyToMessageId: undefined }
    expect(normalizeOne({ type: 'video', video: { id: 'V', mime_type: 'video/mp4' } })).toEqual({
      ...base,
      kind: 'video',
    })
    expect(normalizeOne({ type: 'location' })).toEqual({ ...base, kind: 'location' })
  })
})
