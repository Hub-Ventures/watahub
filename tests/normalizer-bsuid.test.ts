import { describe, it, expect } from 'vitest'
import { normalizeMetaWebhook } from '../src/services/normalizer.js'
import type { MetaWebhookPayload } from '../src/types/meta.js'

/**
 * Business-scoped user IDs (BSUID), from Meta's guide:
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/
 * Since April 2026 `from` and `contacts[].wa_id` can be missing for users with a
 * WhatsApp username; `from_user_id` and `contacts[].user_id` carry the BSUID.
 * `from` stays a phone number: the BSUID goes in its own fields.
 */
const BSUID = 'CO.13491208655302741918'
const PARENT_BSUID = 'CO.ENT.11815799212886844830'

function webhook(value: Record<string, unknown>): MetaWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: '987' },
              ...value,
            },
          },
        ],
      },
    ],
  } as unknown as MetaWebhookPayload
}

const textMessage = (sender: Record<string, string>) => ({
  ...sender,
  id: 'wamid.BSUID',
  timestamp: '1800000000',
  type: 'text',
  text: { body: 'hola' },
})

describe('normalizing business-scoped user IDs (BSUID)', () => {
  it('a user who hides their phone: no from, with fromUserId, username and senderName', () => {
    const [event] = normalizeMetaWebhook(
      webhook({
        contacts: [{ profile: { name: 'Ana', username: 'ana.co' }, user_id: BSUID }],
        messages: [textMessage({ from_user_id: BSUID })],
      })
    )
    expect(event?.message).toMatchObject({ fromUserId: BSUID, username: 'ana.co', senderName: 'Ana', text: 'hola' })
    expect(event?.message).not.toHaveProperty('from')
  })

  it('a user who shares their phone: both the phone in from and the BSUID', () => {
    const [event] = normalizeMetaWebhook(
      webhook({
        contacts: [{ profile: { name: 'Ana' }, wa_id: '573001234567', user_id: BSUID }],
        messages: [textMessage({ from: '573001234567', from_user_id: BSUID })],
      })
    )
    expect(event?.message).toMatchObject({ from: '573001234567', fromUserId: BSUID, senderName: 'Ana' })
  })

  it('takes the phone from contacts[].wa_id and the BSUID from contacts[].user_id when the message lacks them', () => {
    const [event] = normalizeMetaWebhook(
      webhook({
        contacts: [{ profile: { name: 'Ana' }, wa_id: '573001234567', user_id: BSUID }],
        messages: [textMessage({ from: '573001234567' })],
      })
    )
    expect(event?.message).toMatchObject({ from: '573001234567', fromUserId: BSUID })
  })

  it('carries the parent BSUID for enrolled businesses', () => {
    const [event] = normalizeMetaWebhook(
      webhook({
        contacts: [{ profile: { name: 'Ana' }, user_id: BSUID, parent_user_id: PARENT_BSUID }],
        messages: [textMessage({ from_user_id: BSUID, from_parent_user_id: PARENT_BSUID })],
      })
    )
    expect(event?.message).toMatchObject({ fromUserId: BSUID, fromParentUserId: PARENT_BSUID, senderName: 'Ana' })
  })

  it('a status for a message sent to a BSUID: no recipient phone, with recipientUserId', () => {
    const [event] = normalizeMetaWebhook(
      webhook({
        statuses: [
          {
            id: 'wamid.OUT',
            status: 'delivered',
            timestamp: '1800000000',
            recipient_user_id: BSUID,
            recipient_parent_user_id: PARENT_BSUID,
          },
        ],
      })
    )
    expect(event?.status).toMatchObject({ recipientUserId: BSUID, recipientParentUserId: PARENT_BSUID })
    expect(event?.status).not.toHaveProperty('recipient')
  })

  it('an echo sent to a BSUID: recipientUserId, and the business stays the sender', () => {
    const [event] = normalizeMetaWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'smb_message_echoes',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550001111', phone_number_id: '987' },
                contacts: [{ profile: { name: 'Ana' }, user_id: BSUID }],
                message_echoes: [
                  {
                    from: '15550001111',
                    to_user_id: BSUID,
                    id: 'wamid.ECHO',
                    timestamp: '1800000000',
                    type: 'text',
                    text: { body: 'respuesta' },
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as MetaWebhookPayload)
    expect(event?.message).toMatchObject({ from: '15550001111', recipientUserId: BSUID, isEcho: true })
    expect(event?.message).not.toHaveProperty('recipient')
    expect(event?.message?.senderName).toBeUndefined()
  })

  it('a message with only a phone stays exactly as before', () => {
    const [event] = normalizeMetaWebhook(
      webhook({
        contacts: [{ profile: { name: 'Ana' }, wa_id: '573001234567' }],
        messages: [textMessage({ from: '573001234567' })],
      })
    )
    expect(event?.message).toEqual({
      id: 'wamid.BSUID',
      from: '573001234567',
      senderName: 'Ana',
      timestamp: 1_800_000_000_000,
      kind: 'text',
      text: 'hola',
    })
  })
})
