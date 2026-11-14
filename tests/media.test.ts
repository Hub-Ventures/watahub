import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import app, { createApp, MemoryLineStore } from '../src/index.js'
import { jsonResponse, mockFetch } from './helpers/fetch-mock.js'

const KEY = 'wh_secret_key_0123456789abcdef0123456789'
const auth = { 'X-API-Key': KEY }
const LINE_PHONE = '100609346426000'
const LINE_TOKEN = 'LINE_BIZ_TOKEN'

function gatewayWithLine() {
  const store = new MemoryLineStore()
  store.put({ phoneNumberId: LINE_PHONE, wabaId: '222', accessToken: LINE_TOKEN })
  return createApp({ lineStore: store })
}

describe('Media Routes: GET /v1/media/:mediaId and POST /v1/media', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      WATAHUB_API_KEY: KEY,
      META_SYSTEM_USER_TOKEN: 'test-meta-token',
    }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  describe('GET /v1/media/:mediaId', () => {
    it('requires API key', async () => {
      const res = await app.request('/v1/media/123456789')
      expect(res.status).toBe(401)
    })

    it('rejects non-numeric mediaId with 422', async () => {
      const res = await app.request('/v1/media/not-a-number', { headers: auth })
      expect(res.status).toBe(422)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.error).toBe('Validation failed')
    })

    it('returns media url on success', async () => {
      mockFetch(jsonResponse({ url: 'https://lookaside.fbsbx.com/media/test.jpg' }))
      const res = await app.request('/v1/media/123456789', { headers: auth })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        mediaId: '123456789',
        url: 'https://lookaside.fbsbx.com/media/test.jpg',
      })
    })

    it('redirects with 302 when redirect=true is passed', async () => {
      mockFetch(jsonResponse({ url: 'https://lookaside.fbsbx.com/media/test.jpg' }))
      const res = await app.request('/v1/media/123456789?redirect=true', { headers: auth })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('https://lookaside.fbsbx.com/media/test.jpg')
    })

    it('surfaces 500 when Meta access token is missing', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      const res = await app.request('/v1/media/123456789', { headers: auth })
      expect(res.status).toBe(500)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.error).toContain('Missing Meta access token')
    })

    it('surfaces Meta API errors', async () => {
      mockFetch(
        jsonResponse(
          {
            error: {
              message: 'Unsupported get request',
              type: 'GraphMethodException',
              code: 100,
            },
          },
          400
        )
      )
      const res = await app.request('/v1/media/123456789', { headers: auth })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.error).toBeDefined()
    })

    it('resolves phone token from X-Meta-Access-Token header when META_SYSTEM_USER_TOKEN is absent', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      const fetchSpy = mockFetch(jsonResponse({ url: 'https://cdn.example.com/file' }))

      const res = await app.request('/v1/media/123456789', {
        headers: {
          ...auth,
          'X-Meta-Access-Token': 'MEDIA_GET_TOKEN',
        },
      })
      expect(res.status).toBe(200)
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer MEDIA_GET_TOKEN')
    })

    it('uses the stored connect token when X-Phone-Number-Id names the line', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      const fetchSpy = mockFetch(jsonResponse({ url: 'https://cdn.example.com/line.jpg' }))
      const gateway = gatewayWithLine()

      const res = await gateway.request('/v1/media/123456789', {
        headers: { ...auth, 'X-Phone-Number-Id': LINE_PHONE },
      })
      expect(res.status).toBe(200)
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${LINE_TOKEN}`)
    })

    it('accepts ?phone_number_id= for the line token, and header wins over query', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      const store = new MemoryLineStore()
      store.put({ phoneNumberId: LINE_PHONE, wabaId: '222', accessToken: LINE_TOKEN })
      store.put({ phoneNumberId: '999888777666', wabaId: '222', accessToken: 'OTHER_LINE' })
      const gateway = createApp({ lineStore: store })
      const fetchSpy = mockFetch(
        jsonResponse({ url: 'https://cdn.example.com/q.jpg' }),
        jsonResponse({ url: 'https://cdn.example.com/h.jpg' })
      )

      const viaQuery = await gateway.request(`/v1/media/123456789?phone_number_id=${LINE_PHONE}`, {
        headers: auth,
      })
      expect(viaQuery.status).toBe(200)
      expect(
        ((fetchSpy.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>).Authorization
      ).toBe(`Bearer ${LINE_TOKEN}`)

      const headerWins = await gateway.request(`/v1/media/123456789?phone_number_id=999888777666`, {
        headers: { ...auth, 'X-Phone-Number-Id': LINE_PHONE },
      })
      expect(headerWins.status).toBe(200)
      expect(
        ((fetchSpy.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>).Authorization
      ).toBe(`Bearer ${LINE_TOKEN}`)
    })

    it('rejects a non-numeric X-Phone-Number-Id with 422 and does not call Meta', async () => {
      const fetchSpy = mockFetch(jsonResponse({ url: 'https://cdn.example.com/x' }))
      const res = await app.request('/v1/media/123456789', {
        headers: { ...auth, 'X-Phone-Number-Id': 'not-a-graph-id' },
      })
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({
        error: 'Validation failed',
        details: { phoneNumberId: ['Must be a numeric Meta Graph ID'] },
      })
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('still skips the line store when no phone number ID is supplied', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      const gateway = gatewayWithLine()
      const res = await gateway.request('/v1/media/123456789', { headers: auth })
      expect(res.status).toBe(500)
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        error: expect.stringContaining('Missing Meta access token'),
      })
    })

    it('falls back to META_SYSTEM_USER_TOKEN when the phone number ID is not in the store', async () => {
      const fetchSpy = mockFetch(jsonResponse({ url: 'https://cdn.example.com/sys.jpg' }))
      const gateway = createApp({ lineStore: new MemoryLineStore() })

      const res = await gateway.request('/v1/media/123456789', {
        headers: { ...auth, 'X-Phone-Number-Id': LINE_PHONE },
      })
      expect(res.status).toBe(200)
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-meta-token')
    })
  })

  describe('GET /v1/media/:mediaId/content', () => {
    const lookup = () => jsonResponse({ url: 'https://lookaside.fbsbx.com/media/test.jpg' })

    it('downloads the file from the CDN with the token and streams it back, without a redirect', async () => {
      const spy = mockFetch(
        lookup(),
        new Response('JPEG-BYTES', {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-disposition': 'inline; filename="a.jpg"',
            'set-cookie': 'x=1',
          },
        })
      )
      const res = await app.request('/v1/media/123456789/content', { headers: auth })

      expect(res.status).toBe(200)
      expect(await res.text()).toBe('JPEG-BYTES')
      expect(res.headers.get('content-type')).toBe('image/jpeg')
      expect(res.headers.get('content-disposition')).toBe('inline; filename="a.jpg"')
      expect(res.headers.get('set-cookie')).toBeNull()
      expect(res.headers.get('location')).toBeNull()

      const [cdnUrl, cdnInit] = spy.mock.calls[1] as [string, RequestInit]
      expect(cdnUrl).toBe('https://lookaside.fbsbx.com/media/test.jpg')
      expect(new Headers(cdnInit.headers).get('authorization')).toBe('Bearer test-meta-token')
    })

    it('uses the X-Meta-Access-Token header for the download when given', async () => {
      const spy = mockFetch(lookup(), new Response('B', { status: 200 }))
      await app.request('/v1/media/123456789/content', { headers: { ...auth, 'X-Meta-Access-Token': 'OVERRIDE' } })
      expect(new Headers((spy.mock.calls[1] as [string, RequestInit])[1].headers).get('authorization')).toBe(
        'Bearer OVERRIDE'
      )
    })

    it('uses the stored connect token for both Graph lookup and CDN download', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      const spy = mockFetch(lookup(), new Response('LINE-BYTES', { status: 200 }))
      const gateway = gatewayWithLine()

      const res = await gateway.request('/v1/media/123456789/content', {
        headers: { ...auth, 'X-Phone-Number-Id': LINE_PHONE },
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('LINE-BYTES')

      const [, graphInit] = spy.mock.calls[0] as [string, RequestInit]
      const [, cdnInit] = spy.mock.calls[1] as [string, RequestInit]
      expect(new Headers(graphInit.headers).get('authorization')).toBe(`Bearer ${LINE_TOKEN}`)
      expect(new Headers(cdnInit.headers).get('authorization')).toBe(`Bearer ${LINE_TOKEN}`)
    })

    it('rejects a non-numeric phone_number_id on /content with 422', async () => {
      const spy = mockFetch(lookup())
      const res = await app.request('/v1/media/123456789/content?phone_number_id=bad', { headers: auth })
      expect(res.status).toBe(422)
      expect(spy).not.toHaveBeenCalled()
    })

    it('answers 502 when the CDN rejects the download', async () => {
      mockFetch(lookup(), new Response('nope', { status: 404 }))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const res = await app.request('/v1/media/123456789/content', { headers: auth })
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: { message: 'Media download from Meta failed' } })
    })

    it('never sends the token to a non-https URL', async () => {
      const spy = mockFetch(jsonResponse({ url: 'http://lookaside.fbsbx.com/media/test.jpg' }))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const res = await app.request('/v1/media/123456789/content', { headers: auth })
      expect(res.status).toBe(502)
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('surfaces a failed media lookup with the standard error envelope, without downloading', async () => {
      const spy = mockFetch(
        jsonResponse({ error: { message: 'Invalid token', code: 190, type: 'OAuthException' } }, 401)
      )
      const res = await app.request('/v1/media/123456789/content', { headers: auth })
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ error: { code: 190, category: 'auth' } })
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('rejects a non-numeric mediaId with 422', async () => {
      const res = await app.request('/v1/media/abc/content', { headers: auth })
      expect(res.status).toBe(422)
    })
  })

  describe('POST /v1/media and POST /v1/media/:phoneNumberId', () => {
    it('requires API key', async () => {
      const res = await app.request('/v1/media/123456', { method: 'POST' })
      expect(res.status).toBe(401)
    })

    it('returns 400 when phoneNumberId is missing across all resolution paths', async () => {
      const res = await app.request('/v1/media', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'multipart/form-data; boundary=xyz' },
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.error).toContain('Missing phoneNumberId')
    })

    it('returns 422 when resolved phoneNumberId is not a numeric Graph ID', async () => {
      const res = await app.request('/v1/media/invalid-phone-id', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'multipart/form-data; boundary=xyz' },
      })
      expect(res.status).toBe(422)
    })

    it('returns 400 when Content-Type is not multipart/form-data', async () => {
      const res = await app.request('/v1/media/123456', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'data' }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.error).toBe('Content-Type must be multipart/form-data')
    })

    it('streams media upload successfully via param phoneNumberId', async () => {
      const fetchSpy = mockFetch(jsonResponse({ id: 'UPLOADED_MEDIA_789' }, 200))
      const res = await app.request('/v1/media/987654321', {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'multipart/form-data; boundary=----WebKitFormBoundaryX',
        },
        body: '----WebKitFormBoundaryX\r\nContent-Disposition: form-data; name="file"; filename="doc.pdf"\r\n\r\ncontent\r\n----WebKitFormBoundaryX--',
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ id: 'UPLOADED_MEDIA_789' })

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://graph.facebook.com/v24.0/987654321/media')
      expect(init.method).toBe('POST')
      const headers = init.headers as Headers
      expect(headers.get('authorization')).toBe('Bearer test-meta-token')
      expect(headers.get('content-type')).toContain('multipart/form-data')
    })

    it('resolves phoneNumberId from X-Phone-Number-Id header, query param, or env var', async () => {
      const fetchSpy = mockFetch(jsonResponse({ id: 'UPLOADED_MEDIA_1' }), jsonResponse({ id: 'UPLOADED_MEDIA_2' }))

      // Via Header
      const res1 = await app.request('/v1/media', {
        method: 'POST',
        headers: {
          ...auth,
          'X-Phone-Number-Id': '111222333',
          'Content-Type': 'multipart/form-data; boundary=xyz',
        },
        body: 'file-stream',
      })
      expect(res1.status).toBe(200)
      expect(fetchSpy.mock.calls[0][0]).toBe('https://graph.facebook.com/v24.0/111222333/media')

      // Via Query
      const res2 = await app.request('/v1/media?phone_number_id=444555666', {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'multipart/form-data; boundary=xyz',
        },
        body: 'file-stream',
      })
      expect(res2.status).toBe(200)
      expect(fetchSpy.mock.calls[1][0]).toBe('https://graph.facebook.com/v24.0/444555666/media')
    })

    it('resolves phoneNumberId from META_DEFAULT_PHONE_NUMBER_ID env var', async () => {
      process.env.META_DEFAULT_PHONE_NUMBER_ID = '999888777'
      const fetchSpy = mockFetch(jsonResponse({ id: 'MEDIA_DEFAULT' }))

      const res = await app.request('/v1/media', {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'multipart/form-data; boundary=xyz',
        },
        body: 'file-stream',
      })
      expect(res.status).toBe(200)
      expect(fetchSpy.mock.calls[0][0]).toBe('https://graph.facebook.com/v24.0/999888777/media')
    })

    it('allows media uploads above 1 MB (up to 100 MB media limit)', async () => {
      mockFetch(jsonResponse({ id: 'LARGE_MEDIA_ID' }))
      const largeBody = 'x'.repeat(2 * 1024 * 1024) // 2 MB (exceeds 1 MB jsonBodyLimit)
      const res = await app.request('/v1/media/123456789', {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'multipart/form-data; boundary=xyz',
        },
        body: largeBody,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ id: 'LARGE_MEDIA_ID' })
    })

    it('surfaces Meta API upload error properly', async () => {
      mockFetch(
        jsonResponse(
          {
            error: {
              message: 'Invalid file format',
              type: 'OAuthException',
              code: 100,
            },
          },
          400
        )
      )
      const res = await app.request('/v1/media/123456789', {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'multipart/form-data; boundary=xyz',
        },
        body: 'invalid-content',
      })
      expect(res.status).toBe(400)
    })

    it('resolves phone token from X-Meta-Access-Token header when META_SYSTEM_USER_TOKEN is absent', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      const fetchSpy = mockFetch(jsonResponse({ id: 'UPLOADED_MEDIA_PHONE' }))

      const res = await app.request('/v1/media/123456789', {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'multipart/form-data; boundary=xyz',
          'X-Meta-Access-Token': 'MEDIA_PHONE_TOKEN',
        },
        body: 'file-stream',
      })
      expect(res.status).toBe(200)
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect((init.headers as Headers).get('authorization')).toBe('Bearer MEDIA_PHONE_TOKEN')
    })
  })
})
