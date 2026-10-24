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

  it('normalizes inbound general audio message (isVoice: false)', () => {
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
                    id: 'wamid.audio_general',
                    timestamp: '1729620000',
                    type: 'audio',
                    audio: {
                      id: 'MEDIA_AUDIO_1',
                      mime_type: 'audio/mp3',
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
    expect(events[0].message?.mediaId).toBe('MEDIA_AUDIO_1')
    expect(events[0].message?.mediaMime).toBe('audio/mp3')
    expect(events[0].message?.isVoice).toBe(false)
  })

  it('normalizes inbound video message with caption', () => {
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
                    id: 'wamid.video123',
                    timestamp: '1729620000',
                    type: 'video',
                    video: {
                      id: 'MEDIA_VID_1',
                      mime_type: 'video/mp4',
                      caption: 'Check this out!',
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
    expect(events[0].message?.kind).toBe('video')
    expect(events[0].message?.mediaId).toBe('MEDIA_VID_1')
    expect(events[0].message?.mediaMime).toBe('video/mp4')
    expect(events[0].message?.caption).toBe('Check this out!')
  })

  it('normalizes inbound video message without caption', () => {
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
                    id: 'wamid.video456',
                    timestamp: '1729620000',
                    type: 'video',
                    video: {
                      id: 'MEDIA_VID_2',
                      mime_type: 'video/mp4',
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
    expect(events[0].message?.kind).toBe('video')
    expect(events[0].message?.mediaId).toBe('MEDIA_VID_2')
    expect(events[0].message?.mediaMime).toBe('video/mp4')
    expect(events[0].message?.caption).toBeUndefined()
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

  it('normalizes inbound WhatsApp Flow completion (nfm_reply)', () => {
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
                    id: 'wamid.nfm_reply_1',
                    timestamp: '1729620000',
                    type: 'interactive',
                    interactive: {
                      type: 'nfm_reply',
                      nfm_reply: {
                        name: 'flow',
                        body: 'Sent',
                        response_json: JSON.stringify({
                          flow_token: 'session_xyz123',
                          appointment_date: '2026-11-01',
                          service_id: 'dental_cleaning',
                        }),
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
      type: 'nfm_reply',
      name: 'flow',
      body: 'Sent',
      responseJson: {
        flow_token: 'session_xyz123',
        appointment_date: '2026-11-01',
        service_id: 'dental_cleaning',
      },
    })
  })

  it('normalizes inbound poll vote event (poll_update)', () => {
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
                    id: 'wamid.poll_vote_1',
                    timestamp: '1729620000',
                    type: 'poll_update',
                    context: {
                      from: '15550293848',
                      id: 'wamid.original_poll_msg',
                    },
                    poll_update: {
                      poll_id: 'wamid.original_poll_msg',
                      selected_options: ['opt_choice_1', 'opt_choice_2'],
                      timestamp: '1729620005',
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
    expect(events[0].message?.kind).toBe('poll_update')
    expect(events[0].message?.pollVote).toEqual({
      pollMessageId: 'wamid.original_poll_msg',
      selectedOptionIds: ['opt_choice_1', 'opt_choice_2'],
      timestamp: 1729620005000,
    })
  })

  it('normalizes inbound interactive poll_update with object options', () => {
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
                    id: 'wamid.poll_vote_2',
                    timestamp: '1729620000',
                    type: 'interactive',
                    context: {
                      from: '15550293848',
                      id: 'wamid.parent_poll',
                    },
                    interactive: {
                      type: 'poll_update',
                      poll_update: {
                        selected_options: [{ id: 'choice_A' }, { name: 'choice_B' }],
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
    expect(events[0].message?.pollVote).toEqual({
      pollMessageId: 'wamid.parent_poll',
      selectedOptionIds: ['choice_A', 'choice_B'],
    })
  })

  it('normalizes inbound customer order message with product items and buyer note', () => {
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
                    id: 'wamid.order_msg_1',
                    timestamp: '1729620000',
                    type: 'order',
                    order: {
                      catalog_id: 'CATALOG_999',
                      text: 'Please deliver after 2 PM',
                      product_items: [
                        {
                          product_retailer_id: 'SKU_SHIRT_BLUE',
                          quantity: 2,
                          item_price: 29.99,
                          currency: 'USD',
                        },
                        {
                          product_retailer_id: 'SKU_SOCKS_WHITE',
                          quantity: '3',
                          item_price: '5.50',
                          currency: 'USD',
                        },
                      ],
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
    expect(events[0].message?.kind).toBe('order')
    expect(events[0].message?.order).toEqual({
      catalogId: 'CATALOG_999',
      text: 'Please deliver after 2 PM',
      productItems: [
        {
          productRetailerId: 'SKU_SHIRT_BLUE',
          quantity: 2,
          itemPrice: 29.99,
          currency: 'USD',
        },
        {
          productRetailerId: 'SKU_SOCKS_WHITE',
          quantity: 3,
          itemPrice: 5.5,
          currency: 'USD',
        },
      ],
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

  it('normalizes inbound sticker message with animated flag', () => {
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
                    id: 'wamid.sticker123',
                    timestamp: '1729620000',
                    type: 'sticker',
                    sticker: {
                      id: 'STK_999',
                      mime_type: 'image/webp',
                      sha256: 'abc123sha',
                      animated: true,
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
    expect(events[0].message?.kind).toBe('sticker')
    expect(events[0].message?.mediaId).toBe('STK_999')
    expect(events[0].message?.mediaMime).toBe('image/webp')
    expect(events[0].message?.animated).toBe(true)
  })

  it('normalizes inbound sticker message when static and mime_type is omitted', () => {
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
                    id: 'wamid.sticker456',
                    timestamp: '1729620000',
                    type: 'sticker',
                    sticker: {
                      id: 'STK_STATIC',
                      mime_type: '',
                      sha256: 'xyz',
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
    expect(events[0].message?.kind).toBe('sticker')
    expect(events[0].message?.mediaId).toBe('STK_STATIC')
    expect(events[0].message?.mediaMime).toBe('image/webp')
    expect(events[0].message?.animated).toBe(false)
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

  it('normalizes inbound reaction and reaction removal (empty emoji)', () => {
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
                    id: 'wamid.reaction_1',
                    timestamp: '1729620000',
                    type: 'reaction',
                    reaction: {
                      message_id: 'wamid.target_1',
                      emoji: '🎉',
                    },
                  },
                  {
                    from: '573001234567',
                    id: 'wamid.reaction_2',
                    timestamp: '1729620010',
                    type: 'reaction',
                    reaction: {
                      message_id: 'wamid.target_1',
                      emoji: '',
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
    expect(events).toHaveLength(2)

    expect(events[0].message?.kind).toBe('reaction')
    expect(events[0].message?.reaction).toEqual({
      targetMessageId: 'wamid.target_1',
      emoji: '🎉',
    })

    expect(events[1].message?.kind).toBe('reaction')
    expect(events[1].message?.reaction).toEqual({
      targetMessageId: 'wamid.target_1',
      emoji: '',
    })
  })
})
