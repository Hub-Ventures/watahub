import { describe, it, expect, vi, afterEach } from 'vitest'
import { MetaClient, backoffDelayMs, DEFAULT_RETRY_POLICY } from '../src/services/meta-client.js'
import { WatahubApiError, classifyMetaError } from '../src/services/errors.js'
import type { SendMessagePayload } from '../src/types/gateway.js'
import { jsonResponse as okJson, metaError, mockFetch } from './helpers/fetch-mock.js'

const FAST_RETRY = { baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 200 }

const textMessage: SendMessagePayload = { to: '573001234567', kind: 'text', text: { body: 'hi' } }

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

const rateLimited = () => jsonResponse(429, { error: { message: 'Rate limit hit', code: 130429 } })
const serverError = () => jsonResponse(500, { error: { message: 'Something went wrong', code: 131000 } })
const sent = () => jsonResponse(200, { messages: [{ id: 'wamid.OK' }] })

describe('MetaClient resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retries a send rejected with 130429 and succeeds', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(sent())
    const client = new MetaClient({ accessToken: 't', retry: FAST_RETRY })

    const result = await client.sendMessage('123', textMessage)
    expect(result.messageId).toBe('wamid.OK')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('stops after maxAttempts and surfaces a rate_limit classification', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(rateLimited()))
    const client = new MetaClient({ accessToken: 't', retry: { ...FAST_RETRY, maxAttempts: 3 } })

    const error = await client.sendMessage('123', textMessage).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(WatahubApiError)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(classifyMetaError(error as WatahubApiError).category).toBe('rate_limit')
  })

  it('never retries a send after a 5xx (the message may already be delivered)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(serverError()))
    const client = new MetaClient({ accessToken: 't', retry: FAST_RETRY })

    await expect(client.sendMessage('123', textMessage)).rejects.toBeInstanceOf(WatahubApiError)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('never retries a send after a network error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const client = new MetaClient({ accessToken: 't', retry: FAST_RETRY })

    await expect(client.sendMessage('123', textMessage)).rejects.toThrow('fetch failed')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('retries idempotent reads after 5xx and network errors', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(serverError())
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ name: 'welcome' }] }))
    const client = new MetaClient({ accessToken: 't', retry: FAST_RETRY })

    const templates = await client.listTemplates('456')
    expect(templates).toEqual([{ name: 'welcome' }])
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('aborts a hung request after timeoutMs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error))
        })
    )
    const client = new MetaClient({ accessToken: 't', retry: { ...FAST_RETRY, timeoutMs: 20 } })

    const error = await client.sendMessage('123', textMessage).catch((err: unknown) => err)
    expect((error as Error).name).toBe('TimeoutError')
  })

  it('honors Retry-After (capped at maxDelayMs) on 429', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'slow down', code: 4 } }, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(sent())
    const client = new MetaClient({ accessToken: 't', retry: { ...FAST_RETRY, maxDelayMs: 30 } })

    const started = Date.now()
    await client.sendMessage('123', textMessage)
    // Retry-After asked for 1000ms, the policy caps the wait at 30ms
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('backoffDelayMs', () => {
  it('stays within [0, min(maxDelay, base * 2^attempt))', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const delay = backoffDelayMs(attempt, DEFAULT_RETRY_POLICY)
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThan(
        Math.min(DEFAULT_RETRY_POLICY.maxDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs * 2 ** attempt)
      )
    }
  })
})

const sentBody = (spy: ReturnType<typeof mockFetch>, call = 0) =>
  JSON.parse(String((spy.mock.calls[call][1] as RequestInit).body)) as Record<string, unknown>

describe('MetaClient requests and bodies', () => {
  afterEach(() => vi.restoreAllMocks())

  const client = new MetaClient({ accessToken: 'TOKEN' })

  describe('sendMessage', () => {
    const send = async (payload: SendMessagePayload) => {
      const spy = mockFetch(okJson({ messages: [{ id: 'wamid.1' }] }))
      const result = await client.sendMessage('PHONE', payload)
      return { spy, result, body: sentBody(spy) }
    }

    it('posts to the versioned messages endpoint with bearer auth', async () => {
      const { spy, result } = await send({ to: '+573001234567', kind: 'text', text: { body: 'hi' } })
      const [url, init] = spy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://graph.facebook.com/v24.0/PHONE/messages')
      expect(init.method).toBe('POST')
      expect(init.headers).toEqual({ Authorization: 'Bearer TOKEN', 'Content-Type': 'application/json' })
      expect(result).toEqual({ success: true, messageId: 'wamid.1', recipient: '573001234567', phoneNumberId: 'PHONE' })
    })

    it('honors apiVersion, baseUrl and override token', async () => {
      const custom = new MetaClient({ accessToken: 'A', apiVersion: 'v99.0', baseUrl: 'https://graph.test' })
      const spy = mockFetch(okJson({ messages: [{ id: 'x' }] }))
      await custom.sendMessage('P', { to: '1', kind: 'text', text: { body: 'b' } }, 'OVERRIDE')
      const [url, init] = spy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://graph.test/v99.0/P/messages')
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer OVERRIDE')
    })

    it('builds a text body with reply context', async () => {
      const { body } = await send({ to: '1', kind: 'text', text: { body: 'hola' }, replyToMessageId: 'wamid.ctx' })
      expect(body).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '1',
        context: { message_id: 'wamid.ctx' },
        type: 'text',
        text: { body: 'hola' },
      })
      expect(Object.keys(body)).toEqual(['messaging_product', 'recipient_type', 'to', 'context', 'type', 'text'])
    })

    it('defaults text body to empty string', async () => {
      const { body } = await send({ to: '1', kind: 'text' })
      expect(body.text).toEqual({ body: '' })
    })

    it('passes template and interactive objects through', async () => {
      const template = { name: 'hello', language: { code: 'es' } }
      expect((await send({ to: '1', kind: 'template', template })).body.template).toEqual(template)
      const interactive = { type: 'button', body: { text: 'x' } }
      expect((await send({ to: '1', kind: 'interactive', interactive })).body.interactive).toEqual(interactive)
    })

    it('maps reactions to Meta field names', async () => {
      const { body } = await send({ to: '1', kind: 'reaction', reaction: { messageId: 'wamid.t', emoji: '👍' } })
      expect(body.type).toBe('reaction')
      expect(body.reaction).toEqual({ message_id: 'wamid.t', emoji: '👍' })
    })

    it('builds a location body with latitude and longitude, including optional name and address', async () => {
      const full = await send({
        to: '1',
        kind: 'location',
        location: { latitude: 37.758056, longitude: -122.425332, name: 'Meta HQ', address: '1 Hacker Way' },
      })
      expect(full.body.type).toBe('location')
      expect(full.body.location).toEqual({
        latitude: 37.758056,
        longitude: -122.425332,
        name: 'Meta HQ',
        address: '1 Hacker Way',
      })

      const minimal = await send({
        to: '1',
        kind: 'location',
        location: { latitude: 10.5, longitude: -74.8 },
      })
      expect(minimal.body.location).toEqual({
        latitude: 10.5,
        longitude: -74.8,
      })
    })

    it('builds a contacts body preserving vCard structures', async () => {
      const contact = {
        name: { formatted_name: 'John Doe', first_name: 'John', last_name: 'Doe' },
        phones: [{ phone: '+123456789', type: 'WORK', wa_id: '123456789' }],
        emails: [{ email: 'john@example.com', type: 'WORK' }],
        org: { company: 'Acme Inc', title: 'VP' },
      }
      const { body } = await send({ to: '1', kind: 'contacts', contacts: [contact] })
      expect(body.type).toBe('contacts')
      expect(body.contacts).toEqual([contact])
    })

    it('includes only provided media fields, filename only for documents', async () => {
      const media = { link: 'https://x/y.pdf', caption: 'c', filename: 'y.pdf' }
      const image = await send({ to: '1', kind: 'image', media })
      expect(image.body.image).toEqual({ link: 'https://x/y.pdf', caption: 'c' })
      const doc = await send({ to: '1', kind: 'document', media })
      expect(doc.body.document).toEqual(media)
      const audio = await send({ to: '1', kind: 'audio', media: { id: 'MID' } })
      expect(audio.body).toMatchObject({ type: 'audio', audio: { id: 'MID' } })
    })

    it('builds a video body with caption and id or link', async () => {
      const videoWithId = await send({
        to: '1',
        kind: 'video',
        media: { id: 'VID_123', caption: 'Promo clip' },
      })
      expect(videoWithId.body.type).toBe('video')
      expect(videoWithId.body.video).toEqual({ id: 'VID_123', caption: 'Promo clip' })

      const videoWithLink = await send({
        to: '1',
        kind: 'video',
        media: { link: 'https://example.com/video.mp4' },
      })
      expect(videoWithLink.body.type).toBe('video')
      expect(videoWithLink.body.video).toEqual({ link: 'https://example.com/video.mp4' })
    })

    it('builds an audio body with voice flag and omits caption', async () => {
      const voiceNote = await send({
        to: '1',
        kind: 'audio',
        media: { id: 'VOICE_123', voice: true, caption: 'Ignored in audio' },
      })
      expect(voiceNote.body.type).toBe('audio')
      expect(voiceNote.body.audio).toEqual({ id: 'VOICE_123', voice: true })
    })

    it('builds a sticker body with id or link, omitting caption', async () => {
      const stickerWithId = await send({ to: '1', kind: 'sticker', media: { id: 'STK_123', caption: 'ignore me' } })
      expect(stickerWithId.body.type).toBe('sticker')
      expect(stickerWithId.body.sticker).toEqual({ id: 'STK_123' })

      const stickerWithLink = await send({ to: '1', kind: 'sticker', media: { link: 'https://example.com/s.webp' } })
      expect(stickerWithLink.body.sticker).toEqual({ link: 'https://example.com/s.webp' })
    })

    it('rejects unsupported kinds before calling Meta', async () => {
      const spy = vi.spyOn(globalThis, 'fetch')
      await expect(client.sendMessage('P', { to: '1', kind: 'fax' } as unknown as SendMessagePayload)).rejects.toThrow(
        'Unsupported message kind: fax'
      )
      expect(spy).not.toHaveBeenCalled()
    })

    it('returns empty messageId when Meta omits it', async () => {
      mockFetch(okJson({}))
      const result = await client.sendMessage('P', { to: '1', kind: 'text', text: { body: 'b' } })
      expect(result.messageId).toBe('')
    })

    it('throws WatahubApiError with HTTP status on Meta errors', async () => {
      mockFetch(okJson(metaError(131042, 'billing'), 400))
      const err = await client.sendMessage('P', { to: '1', kind: 'text' }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(WatahubApiError)
      expect((err as WatahubApiError).statusCode).toBe(400)
      expect((err as WatahubApiError).code).toBe(131042)
    })

    it('falls back to a status-coded error when the body is not JSON', async () => {
      mockFetch(new Response('<html>bad gateway</html>', { status: 502 }))
      const err = (await client.sendMessage('P', { to: '1', kind: 'text' }).catch((e: unknown) => e)) as WatahubApiError
      expect(err.code).toBe(502)
      expect(err.message).toBe('Meta Graph API Error (502): Unknown Meta API error')
    })
  })

  describe('listTemplates', () => {
    it('GETs templates and returns data array', async () => {
      const spy = mockFetch(okJson({ data: [{ name: 't1' }] }))
      expect(await client.listTemplates('WABA')).toEqual([{ name: 't1' }])
      const [url, init] = spy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://graph.facebook.com/v24.0/WABA/message_templates')
      expect(init.method).toBeUndefined()
    })

    it('returns [] when data is missing and throws on errors', async () => {
      mockFetch(okJson({}), okJson(metaError(190), 401))
      expect(await client.listTemplates('WABA')).toEqual([])
      await expect(client.listTemplates('WABA')).rejects.toBeInstanceOf(WatahubApiError)
    })
  })

  describe('exchangeCodeForToken', () => {
    it('POSTs the credentials as a form body, never in the URL, without a bearer token', async () => {
      const spy = mockFetch(okJson({ access_token: 'LONG' }))
      expect(await client.exchangeCodeForToken('CODE', 'ID', 'SECRET')).toEqual({ accessToken: 'LONG' })
      const [url, init] = spy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://graph.facebook.com/v24.0/oauth/access_token')
      expect(init.method).toBe('POST')
      expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' })
      expect(String(init.body)).toBe('client_id=ID&client_secret=SECRET&code=CODE')
    })

    it('throws when access_token is missing even on 200', async () => {
      mockFetch(okJson({}))
      await expect(client.exchangeCodeForToken('C', 'I', 'S')).rejects.toBeInstanceOf(WatahubApiError)
    })
  })

  describe('subscribeAppToWaba / overridePhoneNumberCallback', () => {
    it('returns true on success and throws WatahubApiError on Meta errors', async () => {
      const spy = mockFetch(okJson({ success: true }), okJson(metaError(100), 400))
      expect(await client.subscribeAppToWaba('WABA')).toBe(true)
      await expect(client.subscribeAppToWaba('WABA')).rejects.toBeInstanceOf(WatahubApiError)
      expect(spy.mock.calls[0][0]).toBe('https://graph.facebook.com/v24.0/WABA/subscribed_apps')
      expect(sentBody(spy)).toEqual({
        subscribed_fields: ['messages', 'smb_message_echoes', 'history', 'smb_app_state_sync'],
      })
    })

    it('posts webhook_configuration to the phone number node', async () => {
      const spy = mockFetch(okJson({ success: true }))
      expect(await client.overridePhoneNumberCallback('PHONE', 'https://cb', 'VT')).toBe(true)
      expect(spy.mock.calls[0][0]).toBe('https://graph.facebook.com/v24.0/PHONE')
      expect(sentBody(spy)).toEqual({
        webhook_configuration: { override_callback_uri: 'https://cb', verify_token: 'VT' },
      })
    })
  })

  describe('getMediaUrl', () => {
    it('returns url or throws when absent', async () => {
      const spy = mockFetch(okJson({ url: 'https://cdn/x' }), okJson({}))
      expect(await client.getMediaUrl('MID')).toBe('https://cdn/x')
      expect(spy.mock.calls[0][0]).toBe('https://graph.facebook.com/v24.0/MID')
      await expect(client.getMediaUrl('MID')).rejects.toBeInstanceOf(WatahubApiError)
    })
  })
})
