import { describe, it, expect, vi, afterEach } from 'vitest'
import { MetaClient, backoffDelayMs, DEFAULT_RETRY_POLICY } from '../src/services/meta-client.js'
import { WatahubApiError, classifyMetaError } from '../src/services/errors.js'
import type { SendMessagePayload } from '../src/types/gateway.js'

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
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => rateLimited())
    const client = new MetaClient({ accessToken: 't', retry: { ...FAST_RETRY, maxAttempts: 3 } })

    const error = await client.sendMessage('123', textMessage).catch((err) => err)
    expect(error).toBeInstanceOf(WatahubApiError)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(classifyMetaError(error).category).toBe('rate_limit')
  })

  it('never retries a send after a 5xx (the message may already be delivered)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => serverError())
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
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
    )
    const client = new MetaClient({ accessToken: 't', retry: { ...FAST_RETRY, timeoutMs: 20 } })

    const error = await client.sendMessage('123', textMessage).catch((err) => err)
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
      expect(delay).toBeLessThan(Math.min(DEFAULT_RETRY_POLICY.maxDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs * 2 ** attempt))
    }
  })
})
