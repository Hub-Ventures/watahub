import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import app from '../src/index.js'
import { isPublicHttpsUrl } from '../src/schemas/common.js'

const KEY = 'k'.repeat(48)

describe('isPublicHttpsUrl', () => {
  it.each([
    'https://hooks.example.com/whatsapp',
    'https://hooks.example.com:8443/whatsapp?tenant=1',
    'https://8.8.8.8/hook',
    'https://[2606:4700:4700::1111]/hook',
  ])('accepts %s', (url) => {
    expect(isPublicHttpsUrl(url)).toBe(true)
  })

  it.each([
    ['plain http', 'http://hooks.example.com/whatsapp'],
    ['other scheme', 'ftp://hooks.example.com/'],
    ['credentials in URL', 'https://user:pass@hooks.example.com/'],
    ['localhost', 'https://localhost/hook'],
    ['localhost subdomain', 'https://api.localhost/hook'],
    ['mDNS name', 'https://printer.local/hook'],
    ['internal name', 'https://metadata.google.internal/computeMetadata/v1/'],
    ['single-label name', 'https://intranet/hook'],
    ['loopback', 'https://127.0.0.1/hook'],
    ['loopback shorthand', 'https://0x7f.1/hook'],
    ['loopback as integer', 'https://2130706433/hook'],
    ['unspecified', 'https://0.0.0.0/hook'],
    ['RFC 1918 10/8', 'https://10.1.2.3/hook'],
    ['RFC 1918 172.16/12', 'https://172.20.0.1/hook'],
    ['RFC 1918 192.168/16', 'https://192.168.1.10/hook'],
    ['CGNAT', 'https://100.64.0.1/hook'],
    ['link-local / cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['multicast', 'https://224.0.0.1/hook'],
    ['IPv6 loopback', 'https://[::1]/hook'],
    ['IPv6 unique local', 'https://[fd00::1]/hook'],
    ['IPv6 link-local', 'https://[fe80::1]/hook'],
    ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/hook'],
    ['not a URL', 'not a url'],
  ])('rejects %s', (_label, url) => {
    expect(isPublicHttpsUrl(url)).toBe(false)
  })
})

describe('POST /v1/onboarding/override-callback', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, WATAHUB_API_KEY: KEY, META_SYSTEM_USER_TOKEN: 'EAAG-system-token' }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  function override(callbackUrl: string) {
    return app.request('/v1/onboarding/override-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
      body: JSON.stringify({ phoneNumberId: '1234567890', callbackUrl, verifyToken: 'verify-token-123' }),
    })
  }

  it('rejects a private callback URL before calling Meta', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await override('https://169.254.169.254/latest/meta-data/')
    expect(res.status).toBe(422)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('forwards a public https callback URL to Meta', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"success":true}', { status: 200 }))
    const res = await override('https://hooks.example.com/whatsapp')
    expect(res.status).toBe(200)
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))
    expect(sent.webhook_configuration.override_callback_uri).toBe('https://hooks.example.com/whatsapp')
  })
})
