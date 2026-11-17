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
    expect(
      normalizeOne({ type: 'video', video: { id: 'V', mime_type: 'video/mp4', caption: 'my clip' } })
    ).toMatchObject({
      mediaId: 'V',
      mediaMime: 'video/mp4',
      caption: 'my clip',
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
    ).toEqual({
      type: 'nfm_reply',
      name: 'f',
      body: '',
      responseJson: {},
      responseJsonText: '{}',
    })
    expect(
      normalizeOne({
        type: 'interactive',
        interactive: { type: 'nfm_reply', nfm_reply: { response_json: 'invalid-json', body: 'b', name: 'n' } },
      })?.interactiveReply
    ).toEqual({
      type: 'nfm_reply',
      name: 'n',
      body: 'b',
      responseJsonError: true,
      responseJsonText: 'invalid-json',
    })
    expect(
      normalizeOne({
        type: 'interactive',
        interactive: { type: 'nfm_reply', nfm_reply: { response_json: '["not","an","object"]', body: '', name: 'n' } },
      })?.interactiveReply
    ).toEqual({
      type: 'nfm_reply',
      name: 'n',
      body: '',
      responseJsonError: true,
      responseJsonText: '["not","an","object"]',
    })
    expect(
      normalizeOne({
        type: 'interactive',
        interactive: { type: 'nfm_reply' },
      })?.interactiveReply
    ).toEqual({
      type: 'nfm_reply',
      name: '',
      body: '',
    })
    expect(
      normalizeOne({
        type: 'interactive',
        interactive: { type: 'other' as any },
      })?.interactiveReply
    ).toBeUndefined()
    expect(
      normalizeOne({
        type: 'poll',
        poll: {
          selected_options: [{ title: 'Option C' }, {} as any, ''],
        },
      })?.pollVote
    ).toEqual({
      pollMessageId: '',
      selectedOptionIds: ['Option C'],
    })
    expect(normalizeOne({ type: 'order' })?.order).toBeUndefined()
    expect(
      normalizeOne({
        type: 'order',
        order: {
          catalog_id: 'C',
          product_items: [{ product_retailer_id: '', quantity: 'abc', item_price: 'def', currency: '' }],
        },
      })?.order
    ).toEqual({
      catalogId: 'C',
      productItems: [
        {
          productRetailerId: '',
          quantity: 0,
          itemPrice: 0,
          currency: '',
        },
      ],
    })
    expect(normalizeOne({ type: 'poll' })?.pollVote).toBeUndefined()
    expect(normalizeOne({ type: 'reaction', reaction: { message_id: 'wamid.t', emoji: '❤️' } })?.reaction).toEqual({
      targetMessageId: 'wamid.t',
      emoji: '❤️',
    })
  })

  describe('interactive replies keep what Meta sent', () => {
    const replyTo = (interactive: MetaInboundMessage['interactive']) =>
      normalizeOne({ type: 'interactive', interactive })?.interactiveReply

    // toStrictEqual, not toEqual: an optional field must be absent, not present as undefined
    it('adds a list row description only when Meta sends one', () => {
      expect(
        replyTo({ type: 'list_reply', list_reply: { id: 'row_1', title: 'Combo', description: 'Burger + fries' } })
      ).toStrictEqual({ id: 'row_1', title: 'Combo', type: 'list', description: 'Burger + fries' })
      expect(replyTo({ type: 'list_reply', list_reply: { id: 'row_2', title: 'Soda' } })).toStrictEqual({
        id: 'row_2',
        title: 'Soda',
        type: 'list',
      })
    })

    it('keeps a parsed Flow answer as Meta wrote it, spacing included', () => {
      const raw = '{\n  "flow_token" : "booking-42",\t"date":"2026-11-20" }'
      const reply = replyTo({ type: 'nfm_reply', nfm_reply: { response_json: raw, body: 'Sent', name: 'flow' } })
      expect(reply).toStrictEqual({
        type: 'nfm_reply',
        name: 'flow',
        body: 'Sent',
        responseJson: { flow_token: 'booking-42', date: '2026-11-20' },
        responseJsonText: raw,
      })
      expect(reply?.responseJsonText).not.toBe(JSON.stringify(reply?.responseJson))
    })

    it('keeps the text of a Flow answer that is JSON but not an object', () => {
      for (const raw of ['[1, 2]', '"done"', '42', 'null']) {
        expect(replyTo({ type: 'nfm_reply', nfm_reply: { response_json: raw, body: '', name: 'flow' } })).toStrictEqual(
          { type: 'nfm_reply', name: 'flow', body: '', responseJsonError: true, responseJsonText: raw }
        )
      }
    })

    it('keeps the text of a Flow answer that is not valid JSON', () => {
      const raw = '{"flow_token": "booking-42", '
      expect(replyTo({ type: 'nfm_reply', nfm_reply: { response_json: raw, body: '', name: 'flow' } })).toStrictEqual({
        type: 'nfm_reply',
        name: 'flow',
        body: '',
        responseJsonError: true,
        responseJsonText: raw,
      })
    })

    it('never puts a non-string response_json in responseJsonText', () => {
      // Webhook bodies are untrusted: a malformed delivery may carry any JSON value here
      const nfm_reply = { response_json: { flow_token: 'x' }, body: '', name: 'flow' } as unknown as NonNullable<
        MetaInboundMessage['interactive']
      >['nfm_reply']
      expect(replyTo({ type: 'nfm_reply', nfm_reply })).toStrictEqual({
        type: 'nfm_reply',
        name: 'flow',
        body: '',
        responseJsonError: true,
      })
    })
  })

  it('keeps only base fields for unknown kinds', () => {
    const base = { id: 'wamid.x', from: '1', senderName: undefined, timestamp: 10_000, replyToMessageId: undefined }
    expect(normalizeOne({ type: 'unknown' })).toEqual({
      ...base,
      kind: 'unknown',
    })
    expect(normalizeOne({ type: 'location' })).toEqual({ ...base, kind: 'location' })
  })

  it('safely parses referral payload with undefined source fields', () => {
    const msg = normalizeOne({
      type: 'text',
      text: { body: 'hello' },
      referral: {},
    })
    expect(msg?.referral).toEqual({
      sourceType: '',
      sourceId: '',
    })
  })
})
