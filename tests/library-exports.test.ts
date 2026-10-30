import { describe, it, expect } from 'vitest'
import * as watahub from '../src/index.js'
import type { MetaWebhookPayload } from '../src/types/meta.js'

/**
 * Wrappers that run their own webhook (watahub-ee) import these from the package
 * to apply the same replay rules as the core: the age window and duplicate check.
 */
describe('replay pieces exported from the package index', () => {
  it('exports isStale, DEFAULT_WEBHOOK_MAX_AGE_SECONDS and DeliveryIdCache', () => {
    expect(typeof watahub.isStale).toBe('function')
    expect(watahub.DEFAULT_WEBHOOK_MAX_AGE_SECONDS).toBe(7 * 24 * 60 * 60)
    expect(typeof watahub.DeliveryIdCache).toBe('function')
  })

  it('lets a wrapper reject an 8-day-old body and drop a duplicate', () => {
    const nowMs = 1_800_000_000_000
    const eightDaysAgo = nowMs / 1000 - 8 * 24 * 3600
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            {
              field: 'messages',
              value: { messages: [{ from: '1', id: 'wamid.X', timestamp: String(eightDaysAgo), type: 'text' }] },
            },
          ],
        },
      ],
    } as unknown as MetaWebhookPayload
    expect(watahub.isStale(payload, watahub.DEFAULT_WEBHOOK_MAX_AGE_SECONDS, nowMs)).toBe(true)

    const cache = new watahub.DeliveryIdCache()
    expect(cache.remember('delivery-1', nowMs)).toBe(true)
    expect(cache.has('delivery-1', nowMs + 6 * 24 * 3600 * 1000)).toBe(true)
  })
})
