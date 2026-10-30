import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import app from '../src/index.js'
import { signSubscriberPayload } from '../src/services/crypto.js'
import { webhookDeliveryIds } from '../src/services/replay.js'
import { jsonResponse, metaError, mockFetch, postJson } from './helpers/fetch-mock.js'

/**
 * Contract tests that pin the HTTP behavior of every route (status codes,
 * response bodies and the requests sent to Meta) on the hardened gateway.
 * Security-specific rules (auth, allowlists, limits) live in security.test.ts.
 */
describe('HTTP route contracts', () => {
  const originalEnv = process.env
  const KEY = 'wk_test_0123456789abcdef0123456789abcdef'
  const authed = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), 'x-api-key': KEY },
  })

  beforeEach(() => {
    process.env = { ...originalEnv, META_SYSTEM_USER_TOKEN: 'SYS_TOKEN', WATAHUB_API_KEY: KEY }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Fail loudly instead of reaching the real Graph API when a test forgets to mock.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network call'))
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  const json = async (res: Response) => (await res.json()) as Record<string, any>

  describe('app', () => {
    it('returns JSON 404 for unknown endpoints', async () => {
      const res = await app.request('/nope')
      expect(res.status).toBe(404)
      expect(await json(res)).toEqual({ error: 'Endpoint not found', path: '/nope' })
    })

    it('prefers Worker bindings over process.env', async () => {
      const bindingKey = 'wk_binding_0123456789abcdef0123456789abcdef'
      mockFetch(jsonResponse({ data: [] }))
      const res = await app.request(
        '/v1/templates/456',
        { headers: { 'x-api-key': bindingKey } },
        { WATAHUB_API_KEY: bindingKey }
      )
      expect(res.status).toBe(200)
    })

    it('serves /health without auth', async () => {
      const res = await app.request('/health')
      expect(res.status).toBe(200)
      expect(await json(res)).toMatchObject({ status: 'ok', service: 'watahub', version: '0.1.0' })
    })
  })

  describe('POST /v1/messages', () => {
    const valid = { to: '+573001234567', phoneNumberId: '123', kind: 'text', text: { body: 'Hola' } }

    it('rejects malformed JSON with 400', async () => {
      const res = await app.request('/v1/messages', authed(postJson('{nope')))
      expect(res.status).toBe(400)
      expect(await json(res)).toEqual({ error: 'Malformed JSON payload' })
    })

    it('returns field errors with 422', async () => {
      const res = await app.request('/v1/messages', authed(postJson({ to: '', kind: 'fax' })))
      expect(res.status).toBe(422)
      const body = await json(res)
      expect(body.error).toBe('Validation failed')
      expect(Object.keys(body.details).sort()).toEqual(['kind', 'to'])
    })

    it('requires a phone number id', async () => {
      const res = await app.request('/v1/messages', authed(postJson({ ...valid, phoneNumberId: undefined })))
      expect(res.status).toBe(400)
      expect((await json(res)).error).toMatch(/^Missing phoneNumberId/)
    })

    it('requires an access token (500)', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      const res = await app.request('/v1/messages', authed(postJson(valid)))
      expect(res.status).toBe(500)
      expect(await json(res)).toEqual({
        error: 'Missing Meta access token. Set META_SYSTEM_USER_TOKEN or pass X-Meta-Access-Token header.',
      })
    })

    it('sends through Meta and returns the normalized result', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.OK' }] }))
      const res = await app.request('/v1/messages', authed(postJson(valid)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.OK',
        recipient: '573001234567',
        phoneNumberId: '123',
      })
      const [url, init] = spy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://graph.facebook.com/v24.0/123/messages')
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer SYS_TOKEN')
    })

    it('resolves phone id from header, then env; token and version overrides', async () => {
      process.env.META_DEFAULT_PHONE_NUMBER_ID = '999'
      process.env.META_API_VERSION = 'v30.0'
      const spy = mockFetch(jsonResponse({ messages: [] }), jsonResponse({ messages: [] }))
      const body = { ...valid, phoneNumberId: undefined }
      await app.request(
        '/v1/messages',
        authed(postJson(body, { 'x-phone-number-id': '555', 'x-meta-access-token': 'OVR' }))
      )
      await app.request('/v1/messages', authed(postJson(body)))
      expect(spy.mock.calls[0][0]).toBe('https://graph.facebook.com/v30.0/555/messages')
      expect(((spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer OVR')
      expect(spy.mock.calls[1][0]).toBe('https://graph.facebook.com/v30.0/999/messages')
    })

    it('resolves phone access token from X-Meta-Access-Token header when META_SYSTEM_USER_TOKEN is absent', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.DIR' }] }))

      const res = await app.request(
        '/v1/messages',
        authed(postJson(valid, { 'x-meta-access-token': 'EXPLICIT_TOKEN' }))
      )
      expect(res.status).toBe(200)
      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer EXPLICIT_TOKEN')
    })

    it('maps Meta errors to classified error bodies (with type)', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(metaError(130429, 'slow down', { error_subcode: 7 })), {
            status: 429,
            headers: { 'Retry-After': '0' },
          })
        )
      )
      const res = await app.request('/v1/messages', authed(postJson(valid)))
      expect(res.status).toBe(429)
      expect(await json(res)).toEqual({
        error: {
          message: 'Meta Graph API Error (130429): slow down',
          code: 130429,
          subcode: 7,
          type: 'OAuthException',
          category: 'rate_limit',
          retryable: true,
          action: 'Back off with exponential jitter before retrying request',
        },
      })
    })

    it('uses 502 when the Meta status is outside 4xx/5xx', async () => {
      mockFetch(jsonResponse(metaError(1), 302))
      const res = await app.request('/v1/messages', authed(postJson(valid)))
      expect(res.status).toBe(502)
    })

    const unknownOutcome = {
      category: 'unknown_outcome',
      retryable: false,
      action: 'The message may have been sent. Confirm it with the status webhook before retrying',
    }

    it('returns a generic 502 for transport failures, flagged as an unknown outcome, without echoing the error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('socket hang up 10.0.0.7'))
      const res = await app.request('/v1/messages', authed(postJson(valid)))
      expect(res.status).toBe(502)
      expect(await json(res)).toEqual({ error: { message: 'Meta Graph API unreachable', ...unknownOutcome } })
    })

    it('flags a send timeout (504) as an unknown outcome that must not be retried blindly', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      )
      const res = await app.request('/v1/messages', authed(postJson(valid)))
      expect(res.status).toBe(504)
      expect(await json(res)).toEqual({ error: { message: 'Meta Graph API request timed out', ...unknownOutcome } })
    })

    it('flags a Meta 5xx on a send as an unknown outcome instead of retryable', async () => {
      mockFetch(jsonResponse(metaError(1, 'An unknown error occurred'), 500))
      const res = await app.request('/v1/messages', authed(postJson(valid)))
      expect(res.status).toBe(500)
      expect(await json(res)).toMatchObject({ error: { code: 1, ...unknownOutcome } })
    })

    it('keeps the classification of a Meta 4xx on a send, where Meta did not send it', async () => {
      mockFetch(jsonResponse(metaError(100, 'Invalid parameter'), 400))
      const res = await app.request('/v1/messages', authed(postJson(valid)))
      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error).toMatchObject({ code: 100 })
      expect(body.error.category).not.toBe('unknown_outcome')
    })

    it('keeps the plain transport error body on routes that do not send messages', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('socket hang up 10.0.0.7'))
      const res = await app.request('/v1/templates/456', authed())
      expect(res.status).toBe(502)
      expect(await json(res)).toEqual({ error: { message: 'Meta Graph API unreachable' } })
    })

    it.each([
      [' +573001234567 ', 'leading space before the +'],
      ['+573001234567', 'plain +'],
      ['573001234567', 'no +'],
    ])('normalizes the recipient %j (%s) to digits only', async (to) => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.TO' }] }))
      const res = await app.request('/v1/messages', authed(postJson({ ...valid, to })))
      expect(res.status).toBe(200)
      const sent = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string) as { to: string }
      expect(sent.to).toBe('573001234567')
      expect(await json(res)).toMatchObject({ recipient: '573001234567' })
    })

    it('sends location message with coordinates and optional metadata', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.LOC' }] }))
      const locPayload = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'location',
        location: {
          latitude: 4.711,
          longitude: -74.0721,
          name: 'Bogotá DC',
          address: 'Plaza de Bolívar',
        },
      }
      const res = await app.request('/v1/messages', authed(postJson(locPayload)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.LOC',
        recipient: '573001234567',
        phoneNumberId: '123',
      })

      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(String(init.body)) as Record<string, any>
      expect(sentBody.type).toBe('location')
      expect(sentBody.location).toEqual({
        latitude: 4.711,
        longitude: -74.0721,
        name: 'Bogotá DC',
        address: 'Plaza de Bolívar',
      })
    })

    it('rejects location with coordinates out of bounds', async () => {
      const invalidLat = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'location',
        location: { latitude: 95, longitude: -74 },
      }
      const res = await app.request('/v1/messages', authed(postJson(invalidLat)))
      expect(res.status).toBe(422)
      const body = await json(res)
      expect(body.error).toBe('Validation failed')
      expect(body.details.location).toBeDefined()
    })

    it('sends contacts message with structured contact cards', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.CONTACTS' }] }))
      const contactPayload = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'contacts',
        contacts: [
          {
            name: { formatted_name: 'Alice Cooper', first_name: 'Alice', last_name: 'Cooper' },
            phones: [{ phone: '+123456789', type: 'WORK' }],
            emails: [{ email: 'alice@example.com', type: 'WORK' }],
            org: { company: 'Rock Inc' },
          },
        ],
      }
      const res = await app.request('/v1/messages', authed(postJson(contactPayload)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.CONTACTS',
        recipient: '573001234567',
        phoneNumberId: '123',
      })

      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(String(init.body)) as Record<string, any>
      expect(sentBody.type).toBe('contacts')
      expect(sentBody.contacts).toEqual(contactPayload.contacts)
    })

    it('rejects contacts message when contacts array is empty or missing formatted_name', async () => {
      const emptyContacts = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'contacts',
        contacts: [],
      }
      const res1 = await app.request('/v1/messages', authed(postJson(emptyContacts)))
      expect(res1.status).toBe(422)
      expect((await json(res1)).details.contacts).toBeDefined()

      const missingName = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'contacts',
        contacts: [{ name: { formatted_name: '' } }],
      }
      const res2 = await app.request('/v1/messages', authed(postJson(missingName)))
      expect(res2.status).toBe(422)
      expect((await json(res2)).details.contacts).toBeDefined()
    })

    it('sends sticker message without caption', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.STICKER' }] }))
      const stickerPayload = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'sticker',
        media: { id: '987654321' },
      }
      const res = await app.request('/v1/messages', authed(postJson(stickerPayload)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.STICKER',
        recipient: '573001234567',
        phoneNumberId: '123',
      })

      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(String(init.body)) as Record<string, any>
      expect(sentBody.type).toBe('sticker')
      expect(sentBody.sticker).toEqual({ id: '987654321' })
    })

    it('rejects sticker message if caption or filename is provided', async () => {
      const stickerWithCaption = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'sticker',
        media: { id: '987654321', caption: 'Stickers cannot have caption' },
      }
      const res = await app.request('/v1/messages', authed(postJson(stickerWithCaption)))
      expect(res.status).toBe(422)
      expect((await json(res)).details.media).toBeDefined()
    })

    it('sends video message with caption and id', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.VID' }] }))
      const videoPayload = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'video',
        media: { id: '987654321', caption: 'Product demo' },
      }
      const res = await app.request('/v1/messages', authed(postJson(videoPayload)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.VID',
        recipient: '573001234567',
        phoneNumberId: '123',
      })

      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(String(init.body)) as Record<string, any>
      expect(sentBody.type).toBe('video')
      expect(sentBody.video).toEqual({ id: '987654321', caption: 'Product demo' })
    })

    it('sends audio message with voice flag', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.VOICE' }] }))
      const audioPayload = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'audio',
        media: { id: '987654321', voice: true },
      }
      const res = await app.request('/v1/messages', authed(postJson(audioPayload)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.VOICE',
        recipient: '573001234567',
        phoneNumberId: '123',
      })

      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(String(init.body)) as Record<string, any>
      expect(sentBody.type).toBe('audio')
      expect(sentBody.audio).toEqual({ id: '987654321', voice: true })
    })

    it('rejects video message if filename is provided', async () => {
      const videoWithFilename = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'video',
        media: { id: '987654321', filename: 'clip.mp4' },
      }
      const res = await app.request('/v1/messages', authed(postJson(videoWithFilename)))
      expect(res.status).toBe(422)
      expect((await json(res)).details.media).toBeDefined()
    })

    it('rejects audio message if caption or filename is provided', async () => {
      const audioWithCaption = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'audio',
        media: { id: '987654321', caption: 'Audio with caption' },
      }
      const res = await app.request('/v1/messages', authed(postJson(audioWithCaption)))
      expect(res.status).toBe(422)
      expect((await json(res)).details.media).toBeDefined()
    })

    it('rejects voice flag on non-audio messages', async () => {
      const videoWithVoice = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'video',
        media: { id: '987654321', voice: true },
      }
      const res = await app.request('/v1/messages', authed(postJson(videoWithVoice)))
      expect(res.status).toBe(422)
      expect((await json(res)).details.media).toBeDefined()
    })

    it('sends reaction message with emoji', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.REACT' }] }))
      const reactPayload = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'reaction',
        reaction: { messageId: 'wamid.original123', emoji: '❤️' },
      }
      const res = await app.request('/v1/messages', authed(postJson(reactPayload)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.REACT',
        recipient: '573001234567',
        phoneNumberId: '123',
      })

      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(String(init.body)) as Record<string, any>
      expect(sentBody.type).toBe('reaction')
      expect(sentBody.reaction).toEqual({ message_id: 'wamid.original123', emoji: '❤️' })
    })

    it('clears reaction with empty emoji string', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.UNREACT' }] }))
      const clearPayload = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'reaction',
        reaction: { messageId: 'wamid.original123', emoji: '' },
      }
      const res = await app.request('/v1/messages', authed(postJson(clearPayload)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.UNREACT',
        recipient: '573001234567',
        phoneNumberId: '123',
      })

      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(String(init.body)) as Record<string, any>
      expect(sentBody.type).toBe('reaction')
      expect(sentBody.reaction).toEqual({ message_id: 'wamid.original123', emoji: '' })
    })

    it('rejects reaction message with missing messageId or oversized emoji', async () => {
      const missingId = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'reaction',
        reaction: { messageId: '', emoji: '👍' },
      }
      const res1 = await app.request('/v1/messages', authed(postJson(missingId)))
      expect(res1.status).toBe(422)
      expect((await json(res1)).details.reaction).toBeDefined()

      const oversizedEmoji = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'reaction',
        reaction: { messageId: 'wamid.123', emoji: '12345678901234567' },
      }
      const res2 = await app.request('/v1/messages', authed(postJson(oversizedEmoji)))
      expect(res2.status).toBe(422)
      expect((await json(res2)).details.reaction).toBeDefined()
    })

    it('sends interactive flow message with full payload structure', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.FLOW' }] }))
      const flowPayload = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'interactive',
        interactive: {
          type: 'flow',
          header: { type: 'text', text: 'Appointment Booking' },
          body: { text: 'Select an available slot' },
          footer: { text: 'Powered by Watahub' },
          action: {
            name: 'flow',
            parameters: {
              flow_token: 'session_token_123',
              flow_id: '12345678901234',
              flow_cta: 'Book Now',
              flow_action: 'navigate',
              flow_action_payload: {
                screen: 'APPOINTMENT_SCREEN',
                data: { doctor_id: 'doc_1' },
              },
            },
          },
        },
      }
      const res = await app.request('/v1/messages', authed(postJson(flowPayload)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.FLOW',
        recipient: '573001234567',
        phoneNumberId: '123',
      })

      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(String(init.body)) as Record<string, any>
      expect(sentBody.type).toBe('interactive')
      expect(sentBody.interactive.type).toBe('flow')
      expect(sentBody.interactive.action.parameters.flow_message_version).toBe('3')
      expect(sentBody.interactive.action.parameters.flow_id).toBe('12345678901234')
    })

    it('rejects interactive flow with invalid flow_id or missing required fields', async () => {
      const invalidFlow = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'interactive',
        interactive: {
          type: 'flow',
          body: { text: 'Test' },
          action: {
            name: 'flow',
            parameters: {
              flow_token: '',
              flow_id: 'NON_NUMERIC_ID',
              flow_cta: 'This CTA label is way too long for Meta',
              flow_action: 'invalid_action',
            },
          },
        },
      }
      const res = await app.request('/v1/messages', authed(postJson(invalidFlow)))
      expect(res.status).toBe(422)
      const body = await json(res)
      expect(body.error).toBe('Validation failed')
      expect(body.details.interactive).toBeDefined()
    })

    it('sends interactive location request message', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.LOC_REQ' }] }))
      const locReqPayload = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'interactive',
        interactive: {
          type: 'location_request_message',
          body: { text: 'Please share your delivery location.' },
          action: { name: 'send_location' },
        },
      }
      const res = await app.request('/v1/messages', authed(postJson(locReqPayload)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.LOC_REQ',
        recipient: '573001234567',
        phoneNumberId: '123',
      })

      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(String(init.body)) as Record<string, any>
      expect(sentBody.type).toBe('interactive')
      expect(sentBody.interactive).toEqual(locReqPayload.interactive)
    })

    it('sends interactive cta_url button message', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.CTA' }] }))
      const ctaPayload = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: 'View your account statement online:' },
          footer: { text: 'Valid for 30 days' },
          action: {
            name: 'cta_url',
            parameters: {
              display_text: 'View Statement',
              url: 'https://example.com/statements/ST-999',
            },
          },
        },
      }
      const res = await app.request('/v1/messages', authed(postJson(ctaPayload)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.CTA',
        recipient: '573001234567',
        phoneNumberId: '123',
      })

      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(String(init.body)) as Record<string, any>
      expect(sentBody.type).toBe('interactive')
      expect(sentBody.interactive).toEqual(ctaPayload.interactive)
    })

    it('rejects location request message with invalid action name or missing body text', async () => {
      const invalidLocReq = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'interactive',
        interactive: {
          type: 'location_request_message',
          body: { text: '' },
          action: { name: 'invalid_action' },
        },
      }
      const res = await app.request('/v1/messages', authed(postJson(invalidLocReq)))
      expect(res.status).toBe(422)
      expect((await json(res)).details.interactive).toBeDefined()
    })

    it('rejects cta_url with invalid URL or oversized display_text', async () => {
      const invalidCta = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: 'Check link' },
          action: {
            name: 'cta_url',
            parameters: {
              display_text: 'This display text exceeds the maximum 20 chars',
              url: 'not-a-valid-url',
            },
          },
        },
      }
      const res = await app.request('/v1/messages', authed(postJson(invalidCta)))
      expect(res.status).toBe(422)
      expect((await json(res)).details.interactive).toBeDefined()
    })

    it('rejects an interactive poll locally with 422, since the Cloud API cannot send polls', async () => {
      const spy = vi.spyOn(globalThis, 'fetch')
      const pollPayload = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'interactive',
        interactive: {
          type: 'poll',
          action: {
            name: 'Which session will you attend?',
            options: [
              { id: 'opt_1', title: 'Morning (9:00 AM)' },
              { id: 'opt_2', title: 'Afternoon (2:00 PM)' },
            ],
          },
        },
      }
      const res = await app.request('/v1/messages', authed(postJson(pollPayload)))
      expect(res.status).toBe(422)
      const body = await json(res)
      expect(body.error).toBe('Validation failed')
      expect(JSON.stringify(body.details)).toContain('cannot send polls')
      expect(spy).not.toHaveBeenCalled()
    })

    it('sends single product message', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.SPM' }] }))
      const productPayload = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'interactive',
        interactive: {
          type: 'product',
          body: { text: 'Check out our featured sneaker' },
          action: {
            catalog_id: 'CATALOG_123',
            product_retailer_id: 'SKU_SNEAKER_RED',
          },
        },
      }
      const res = await app.request('/v1/messages', authed(postJson(productPayload)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.SPM',
        recipient: '573001234567',
        phoneNumberId: '123',
      })

      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(String(init.body)) as Record<string, any>
      expect(sentBody.type).toBe('interactive')
      expect(sentBody.interactive).toEqual(productPayload.interactive)
    })

    it('sends multi-product list message with catalog sections', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.MPM' }] }))
      const mpmPayload = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'interactive',
        interactive: {
          type: 'product_list',
          header: { type: 'text', text: 'Summer Collection' },
          body: { text: 'Explore our latest arrivals' },
          footer: { text: 'Free shipping on orders over $50' },
          action: {
            catalog_id: 'CATALOG_123',
            sections: [
              {
                title: 'T-Shirts',
                product_items: [{ product_retailer_id: 'SKU_TSHIRT_1' }, { product_retailer_id: 'SKU_TSHIRT_2' }],
              },
            ],
          },
        },
      }
      const res = await app.request('/v1/messages', authed(postJson(mpmPayload)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.MPM',
        recipient: '573001234567',
        phoneNumberId: '123',
      })

      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(String(init.body)) as Record<string, any>
      expect(sentBody.type).toBe('interactive')
      expect(sentBody.interactive).toEqual(mpmPayload.interactive)
    })

    it('sends order details interactive message', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.ORDER_DET' }] }))
      const orderDetPayload = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'interactive',
        interactive: {
          type: 'order_details',
          body: { text: 'Here is your order summary:' },
          action: {
            name: 'review_and_pay',
            parameters: {
              reference_id: 'ORDER_123',
              total_amount: { value: 5000, offset: 100 },
              currency: 'USD',
            },
          },
        },
      }
      const res = await app.request('/v1/messages', authed(postJson(orderDetPayload)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.ORDER_DET',
        recipient: '573001234567',
        phoneNumberId: '123',
      })

      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      const sentBody = JSON.parse(String(init.body)) as Record<string, any>
      expect(sentBody.type).toBe('interactive')
      expect(sentBody.interactive).toEqual(orderDetPayload.interactive)
    })

    it('rejects invalid product list message (missing catalog_id or empty sections)', async () => {
      const invalidMpm = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'interactive',
        interactive: {
          type: 'product_list',
          header: { type: 'text', text: 'Title' },
          body: { text: 'Body' },
          action: {
            catalog_id: '',
            sections: [],
          },
        },
      }
      const res = await app.request('/v1/messages', authed(postJson(invalidMpm)))
      expect(res.status).toBe(422)
      expect((await json(res)).details.interactive).toBeDefined()
    })

    it('rejects invalid single product message (missing catalog_id)', async () => {
      const invalidProduct = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'interactive',
        interactive: {
          type: 'product',
          action: {
            catalog_id: '',
            product_retailer_id: '',
          },
        },
      }
      const res = await app.request('/v1/messages', authed(postJson(invalidProduct)))
      expect(res.status).toBe(422)
      expect((await json(res)).details.interactive).toBeDefined()
    })

    it('rejects invalid order details message (missing action name)', async () => {
      const invalidOrderDetails = {
        to: '+573001234567',
        phoneNumberId: '123',
        kind: 'interactive',
        interactive: {
          type: 'order_details',
          action: {
            name: '',
            parameters: {},
          },
        },
      }
      const res = await app.request('/v1/messages', authed(postJson(invalidOrderDetails)))
      expect(res.status).toBe(422)
      expect((await json(res)).details.interactive).toBeDefined()
    })
  })

  describe('GET /v1/templates', () => {
    it('resolves wabaId from path, query, then env', async () => {
      process.env.META_DEFAULT_WABA_ID = '3'
      const spy = mockFetch(
        jsonResponse({ data: [{ name: 'a' }] }),
        jsonResponse({ data: [{ name: 'b' }] }),
        jsonResponse({ data: [{ name: 'c' }] })
      )
      expect(await json(await app.request('/v1/templates/1', authed()))).toEqual({ data: [{ name: 'a' }] })
      expect(await json(await app.request('/v1/templates?wabaId=2', authed()))).toEqual({ data: [{ name: 'b' }] })
      expect(await json(await app.request('/v1/templates', authed()))).toEqual({ data: [{ name: 'c' }] })
      expect(spy.mock.calls.map((call) => call[0])).toEqual([
        'https://graph.facebook.com/v24.0/1/message_templates',
        'https://graph.facebook.com/v24.0/2/message_templates',
        'https://graph.facebook.com/v24.0/3/message_templates',
      ])
    })

    it('requires wabaId and token', async () => {
      const missingWaba = await app.request('/v1/templates', authed())
      expect(missingWaba.status).toBe(400)
      expect((await json(missingWaba)).error).toMatch(/^Missing wabaId/)
      delete process.env.META_SYSTEM_USER_TOKEN
      expect((await app.request('/v1/templates/1', authed())).status).toBe(500)
    })

    it('maps Meta errors without the type field', async () => {
      mockFetch(jsonResponse(metaError(190, 'expired'), 401))
      const res = await app.request('/v1/templates/1', authed())
      expect(res.status).toBe(401)
      const body = await json(res)
      expect(body.error).not.toHaveProperty('type')
      expect(body.error).toMatchObject({ code: 190, category: 'auth', retryable: false })
    })
  })

  describe('POST /v1/onboarding/exchange', () => {
    it('validates the body', async () => {
      expect((await app.request('/v1/onboarding/exchange', authed(postJson('x')))).status).toBe(400)
      expect((await app.request('/v1/onboarding/exchange', authed(postJson({})))).status).toBe(422)
    })

    it('requires app credentials from body or env', async () => {
      delete process.env.META_APP_ID
      delete process.env.META_APP_SECRET
      const res = await app.request('/v1/onboarding/exchange', authed(postJson({ code: 'C' })))
      expect(res.status).toBe(400)
      expect(await json(res)).toEqual({ error: 'Missing META_APP_ID or META_APP_SECRET configuration' })
    })

    it('exchanges the code with the gateway app credentials, without a system token', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      process.env.META_APP_ID = '111'
      process.env.META_APP_SECRET = 'ENV_SECRET'
      const spy = mockFetch(jsonResponse({ access_token: 'T' }))
      const res = await app.request('/v1/onboarding/exchange', authed(postJson({ code: 'C' })))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({ accessToken: 'T' })
      expect(String((spy.mock.calls[0][1] as RequestInit).body)).toBe('client_id=111&client_secret=ENV_SECRET&code=C')
    })

    it('maps Meta errors without the type field', async () => {
      process.env.META_APP_ID = '111'
      process.env.META_APP_SECRET = 'S'
      mockFetch(jsonResponse(metaError(100), 400))
      const res = await app.request('/v1/onboarding/exchange', authed(postJson({ code: 'C' })))
      expect(res.status).toBe(400)
      expect((await json(res)).error).not.toHaveProperty('type')
    })
  })

  describe('POST /v1/onboarding/subscribe and override-callback', () => {
    it('subscribe returns success, and classified Meta errors without the type field', async () => {
      mockFetch(jsonResponse({}), jsonResponse(metaError(100), 400))
      const ok = await app.request('/v1/onboarding/subscribe', authed(postJson({ wabaId: '456' })))
      expect(await json(ok)).toEqual({ success: true, wabaId: '456' })
      const ko = await app.request('/v1/onboarding/subscribe', authed(postJson({ wabaId: '456' })))
      expect(ko.status).toBe(400)
      const body = await json(ko)
      expect(body.error).toMatchObject({ code: 100, category: 'unknown', retryable: false })
      expect(body.error).not.toHaveProperty('type')
    })

    it('subscribe validates and needs a token', async () => {
      expect((await app.request('/v1/onboarding/subscribe', authed(postJson({})))).status).toBe(422)
      delete process.env.META_SYSTEM_USER_TOKEN
      const res = await app.request('/v1/onboarding/subscribe', authed(postJson({ wabaId: '456' })))
      expect(res.status).toBe(500)
      // Same message on every route that needs a Meta token
      expect(await json(res)).toEqual({
        error: 'Missing Meta access token. Set META_SYSTEM_USER_TOKEN or pass X-Meta-Access-Token header.',
      })
    })

    it('subscribe accepts optional subscribedFields list', async () => {
      mockFetch(jsonResponse({}))
      const res = await app.request(
        '/v1/onboarding/subscribe',
        authed(postJson({ wabaId: '456', subscribedFields: ['messages', 'smb_message_echoes'] }))
      )
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({ success: true, wabaId: '456' })
    })

    it('override-callback validates URL and returns success flag', async () => {
      const bad = await app.request(
        '/v1/onboarding/override-callback',
        authed(postJson({ phoneNumberId: '123', callbackUrl: 'not-a-url', verifyToken: 'V' }))
      )
      expect(bad.status).toBe(422)
      mockFetch(jsonResponse({}))
      const ok = await app.request(
        '/v1/onboarding/override-callback',
        authed(postJson({ phoneNumberId: '123', callbackUrl: 'https://cb.example', verifyToken: 'V' }))
      )
      expect(await json(ok)).toEqual({ success: true, phoneNumberId: '123' })
    })
  })

  describe('/v24.0/* proxy', () => {
    it('forwards method, body, content type and token', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'm' }] }, 201))
      const res = await app.request('/v24.0/123/messages', authed(postJson({ a: 1 }, { 'x-meta-access-token': 'OVR' })))
      expect(res.status).toBe(201)
      expect(await json(res)).toEqual({ messages: [{ id: 'm' }] })
      const [url, init] = spy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://graph.facebook.com/v24.0/123/messages')
      expect(init.method).toBe('POST')
      const headers = init.headers as Headers
      expect(headers.get('authorization')).toBe('Bearer OVR')
      expect(headers.get('content-type')).toBe('application/json')
      const bodyText =
        init.body instanceof ArrayBuffer
          ? new TextDecoder().decode(init.body)
          : await new Response(init.body as ReadableStream).text()
      expect(bodyText).toBe('{"a":1}')
    })

    it('sends no body on GET and strips encoding headers', async () => {
      const spy = mockFetch(
        new Response('{}', { status: 200, headers: { 'content-length': '2', 'x-fb-trace-id': 'T' } })
      )
      const res = await app.request('/v24.0/789', authed())
      expect((spy.mock.calls[0][1] as RequestInit).body).toBeUndefined()
      expect(res.headers.get('content-length')).toBeNull()
      expect(res.headers.get('x-fb-trace-id')).toBe('T')
    })

    it('needs a token', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      expect((await app.request('/v24.0/789', authed())).status).toBe(500)
    })

    it('sends proxied calls to the META_API_VERSION that /v1 uses, whatever the path says', async () => {
      process.env.META_API_VERSION = 'v25.0'
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'm' }] }), jsonResponse({ messages: [{ id: 'm2' }] }))
      await app.request('/v24.0/123/messages', authed(postJson({ a: 1 })))
      await app.request(
        '/v1/messages',
        authed(postJson({ to: '1', phoneNumberId: '123', kind: 'text', text: { body: 'x' } }))
      )
      expect(String(spy.mock.calls[0][0])).toBe('https://graph.facebook.com/v25.0/123/messages')
      expect(String(spy.mock.calls[1][0])).toBe('https://graph.facebook.com/v25.0/123/messages')
    })

    it("flags a Meta 5xx on a proxied send with X-Watahub-Outcome and leaves Meta's body untouched", async () => {
      const metaBody = metaError(1, 'An unknown error occurred')
      mockFetch(jsonResponse(metaBody, 500))
      const res = await app.request('/v24.0/123/messages', authed(postJson({ a: 1 })))
      expect(res.status).toBe(500)
      expect(res.headers.get('x-watahub-outcome')).toBe('unknown')
      expect(await json(res)).toEqual(metaBody)
    })

    it('does not flag proxied sends that succeed, or a 5xx on a media lookup', async () => {
      mockFetch(jsonResponse({ messages: [{ id: 'm' }] }, 200), jsonResponse(metaError(1), 500))
      const sent = await app.request('/v24.0/123/messages', authed(postJson({ a: 1 })))
      const media = await app.request('/v24.0/789', authed())
      expect(sent.headers.get('x-watahub-outcome')).toBeNull()
      expect(media.status).toBe(500)
      expect(media.headers.get('x-watahub-outcome')).toBeNull()
    })

    it('flags a proxied send that times out as an unknown outcome in the body', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      )
      const res = await app.request('/v24.0/123/messages', authed(postJson({ a: 1 })))
      expect(res.status).toBe(504)
      expect(await json(res)).toMatchObject({ error: { category: 'unknown_outcome', retryable: false } })
    })

    it('resolves token from X-Meta-Access-Token when proxying', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'm' }] }, 201))
      const res = await app.request(
        '/v24.0/123/messages',
        authed(postJson({ a: 1 }, { 'x-meta-access-token': 'PROXY_TOKEN' }))
      )
      expect(res.status).toBe(201)
      const [, init] = spy.mock.calls[0] as [string, RequestInit]
      expect((init.headers as Headers).get('authorization')).toBe('Bearer PROXY_TOKEN')
    })
  })

  describe('POST /webhook', () => {
    const APP_SECRET = 'APP_SECRET'
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: 'D', phone_number_id: 'P' },
                messages: [
                  {
                    id: 'wamid.in',
                    from: '1',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'x' },
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    const raw = JSON.stringify(payload)
    const signed = async (body = raw): Promise<RequestInit> => ({
      method: 'POST',
      body,
      headers: { 'x-hub-signature-256': await signSubscriberPayload(body, APP_SECRET) },
    })

    beforeEach(() => {
      process.env.META_APP_SECRET = APP_SECRET
      process.env.SUBSCRIBER_WEBHOOK_URL = 'https://subscriber.example/hook'
      process.env.SUBSCRIBER_WEBHOOK_SECRET = 'SUB_SECRET_32_CHARS_MINIMUM_LENGTH!'
      mockFetch(jsonResponse({}))
      webhookDeliveryIds.clear()
    })

    it('acknowledges with the number of normalized events', async () => {
      const res = await app.request('/webhook', await signed())
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({ status: 'received', eventsCount: 1 })
    })

    it('rejects bad signatures with 401 and signed bad JSON with 400', async () => {
      const unsigned = await app.request('/webhook', { method: 'POST', body: raw })
      expect(unsigned.status).toBe(401)
      expect(await json(unsigned)).toEqual({ error: 'Invalid HMAC signature' })
      expect((await app.request('/webhook', await signed('{'))).status).toBe(400)
    })

    it('forwards signed events to the subscriber via waitUntil in async mode', async () => {
      process.env.WEBHOOK_DELIVERY_MODE = 'async'
      process.env.SUBSCRIBER_WEBHOOK_URL = 'https://subscriber.example/hook'
      process.env.SUBSCRIBER_WEBHOOK_SECRET = 'SUB_SECRET_32_CHARS_MINIMUM_LENGTH!'
      const spy = mockFetch(jsonResponse({}))
      const pending: Array<Promise<unknown>> = []
      const executionCtx = {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException: () => {},
        props: {},
      }
      const res = await app.request('/webhook', await signed(), {}, executionCtx)
      expect(res.status).toBe(200)
      await Promise.all(pending)

      const [url, init] = spy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://subscriber.example/hook')
      const headers = init.headers as Record<string, string>
      expect(headers['User-Agent']).toBe('Watahub-Gateway/0.1.0')
      expect(headers['x-watahub-signature']).toBe(
        await signSubscriberPayload(String(init.body), 'SUB_SECRET_32_CHARS_MINIMUM_LENGTH!')
      )
      const forwarded = JSON.parse(String(init.body))
      expect(forwarded.raw).toEqual(payload)
      expect(forwarded.events).toHaveLength(1)
    })
  })
})
