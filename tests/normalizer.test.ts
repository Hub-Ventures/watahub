import { describe, it, expect } from 'vitest'
import { normalizeMetaWebhook } from '../src/services/normalizer.js'
import type { MetaWebhookPayload } from '../src/types/meta.js'

describe('Meta Webhook Normalizer', () => {
  it('normalizes inbound text message with contact name', () => {
    const rawPayload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550293848',
                  phone_number_id: 'PHONE_456',
                },
                contacts: [
                  {
                    profile: { name: 'Sadeuz Dev' },
                    wa_id: '573001234567',
                  },
                ],
                messages: [
                  {
                    from: '573001234567',
                    id: 'wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...',
                    timestamp: '1729620000',
                    type: 'text',
                    text: { body: 'Hola Watahub!' },
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    const events = normalizeMetaWebhook(rawPayload)
    expect(events).toHaveLength(1)

    const event = events[0]
    expect(event.type).toBe('message')
    expect(event.phoneNumberId).toBe('PHONE_456')
    expect(event.displayPhoneNumber).toBe('15550293848')
    expect(event.message?.id).toBe('wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...')
    expect(event.message?.from).toBe('573001234567')
    expect(event.message?.senderName).toBe('Sadeuz Dev')
    expect(event.message?.kind).toBe('text')
    expect(event.message?.text).toBe('Hola Watahub!')
    expect(event.message?.timestamp).toBe(1729620000000)
  })

  it('normalizes inbound audio/voice message', () => {
    const rawPayload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550293848',
                  phone_number_id: 'PHONE_456',
                },
                messages: [
                  {
                    from: '573001234567',
                    id: 'wamid.audio123',
                    timestamp: '1729620000',
                    type: 'audio',
                    audio: {
                      id: 'MEDIA_999',
                      mime_type: 'audio/ogg; codecs=opus',
                      voice: true,
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    const events = normalizeMetaWebhook(rawPayload)
    expect(events).toHaveLength(1)
    expect(events[0].message?.kind).toBe('audio')
    expect(events[0].message?.mediaId).toBe('MEDIA_999')
    expect(events[0].message?.mediaMime).toBe('audio/ogg; codecs=opus')
    expect(events[0].message?.isVoice).toBe(true)
  })

  it('normalizes interactive button and list replies', () => {
    const rawPayload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550293848',
                  phone_number_id: 'PHONE_456',
                },
                messages: [
                  {
                    from: '573001234567',
                    id: 'wamid.button_reply_1',
                    timestamp: '1729620000',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: {
                        id: 'btn_confirm',
                        title: 'Confirmar Orden',
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    const events = normalizeMetaWebhook(rawPayload)
    expect(events).toHaveLength(1)
    expect(events[0].message?.kind).toBe('interactive')
    expect(events[0].message?.interactiveReply).toEqual({
      id: 'btn_confirm',
      title: 'Confirmar Orden',
      type: 'button',
    })
  })

  it('normalizes inbound location message with coordinates, name and address', () => {
    const rawPayload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550293848',
                  phone_number_id: 'PHONE_456',
                },
                messages: [
                  {
                    from: '573001234567',
                    id: 'wamid.loc123',
                    timestamp: '1729620000',
                    type: 'location',
                    location: {
                      latitude: 37.758056,
                      longitude: -122.425332,
                      name: 'Meta HQ',
                      address: '1 Hacker Way, Menlo Park, CA',
                      url: 'https://maps.google.com/?q=37.758056,-122.425332',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    const events = normalizeMetaWebhook(rawPayload)
    expect(events).toHaveLength(1)
    expect(events[0].message?.kind).toBe('location')
    expect(events[0].message?.location).toEqual({
      latitude: 37.758056,
      longitude: -122.425332,
      name: 'Meta HQ',
      address: '1 Hacker Way, Menlo Park, CA',
      url: 'https://maps.google.com/?q=37.758056,-122.425332',
    })
  })

  it('normalizes inbound location message with missing location payload gracefully', () => {
    const rawPayload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550293848',
                  phone_number_id: 'PHONE_456',
                },
                messages: [
                  {
                    from: '573001234567',
                    id: 'wamid.loc_empty',
                    timestamp: '1729620000',
                    type: 'location',
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    const events = normalizeMetaWebhook(rawPayload)
    expect(events).toHaveLength(1)
    expect(events[0].message?.kind).toBe('location')
    expect(events[0].message?.location).toBeUndefined()
  })

  it('normalizes inbound contacts message with rich vCard information', () => {
    const rawPayload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550293848',
                  phone_number_id: 'PHONE_456',
                },
                messages: [
                  {
                    from: '573001234567',
                    id: 'wamid.contacts123',
                    timestamp: '1729620000',
                    type: 'contacts',
                    contacts: [
                      {
                        name: {
                          formatted_name: 'Jane Smith',
                          first_name: 'Jane',
                          last_name: 'Smith',
                        },
                        phones: [{ phone: '+15559876543', type: 'CELL', wa_id: '15559876543' }],
                        emails: [{ email: 'jane@example.com', type: 'WORK' }],
                        addresses: [{ street: '200 Main St', city: 'Springfield', zip: '12345' }],
                        org: { company: 'Tech Inc', department: 'R&D', title: 'Director' },
                        urls: [{ url: 'https://jane.example.com', type: 'WORK' }],
                        birthday: '1985-05-15',
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    const events = normalizeMetaWebhook(rawPayload)
    expect(events).toHaveLength(1)
    expect(events[0].message?.kind).toBe('contacts')
    expect(events[0].message?.contacts).toEqual([
      {
        name: {
          formatted_name: 'Jane Smith',
          first_name: 'Jane',
          last_name: 'Smith',
        },
        phones: [{ phone: '+15559876543', type: 'CELL', wa_id: '15559876543' }],
        emails: [{ email: 'jane@example.com', type: 'WORK' }],
        addresses: [{ street: '200 Main St', city: 'Springfield', zip: '12345' }],
        org: { company: 'Tech Inc', department: 'R&D', title: 'Director' },
        urls: [{ url: 'https://jane.example.com', type: 'WORK' }],
        birthday: '1985-05-15',
      },
    ])
  })

  it('normalizes inbound contacts message with minimal contact card', () => {
    const rawPayload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550293848',
                  phone_number_id: 'PHONE_456',
                },
                messages: [
                  {
                    from: '573001234567',
                    id: 'wamid.contacts_minimal',
                    timestamp: '1729620000',
                    type: 'contacts',
                    contacts: [
                      {
                        name: {
                          formatted_name: 'Only Name',
                        },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    const events = normalizeMetaWebhook(rawPayload)
    expect(events).toHaveLength(1)
    expect(events[0].message?.kind).toBe('contacts')
    expect(events[0].message?.contacts).toEqual([
      {
        name: {
          formatted_name: 'Only Name',
        },
      },
    ])
  })

  it('normalizes inbound contacts message with empty contacts array gracefully', () => {
    const rawPayload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550293848',
                  phone_number_id: 'PHONE_456',
                },
                messages: [
                  {
                    from: '573001234567',
                    id: 'wamid.contacts_empty',
                    timestamp: '1729620000',
                    type: 'contacts',
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    const events = normalizeMetaWebhook(rawPayload)
    expect(events).toHaveLength(1)
    expect(events[0].message?.kind).toBe('contacts')
    expect(events[0].message?.contacts).toBeUndefined()
  })

  it('normalizes status delivery reports (sent, delivered, read)', () => {
    const rawPayload: MetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550293848',
                  phone_number_id: 'PHONE_456',
                },
                statuses: [
                  {
                    id: 'wamid.outbound_123',
                    status: 'delivered',
                    timestamp: '1729620005',
                    recipient_id: '573001234567',
                    pricing: {
                      billable: true,
                      pricing_model: 'CBP',
                      category: 'service',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    const events = normalizeMetaWebhook(rawPayload)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('status')
    expect(events[0].status?.id).toBe('wamid.outbound_123')
    expect(events[0].status?.status).toBe('delivered')
    expect(events[0].status?.recipient).toBe('573001234567')
    expect(events[0].status?.category).toBe('service')
  })
})
