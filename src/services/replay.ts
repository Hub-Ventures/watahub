/**
 * Webhook replay protection.
 *
 * Meta's X-Hub-Signature-256 covers the body but carries no timestamp, so a
 * captured signed delivery stays valid forever. Two checks bound that:
 * - Age: every message/status carries Meta's own `timestamp` (unix seconds,
 *   inside the signed body). Deliveries whose newest event is older than the
 *   window are acknowledged but not forwarded.
 * - Duplicates: the delivery ID (SHA-256 of the signed body) is remembered once
 *   the subscriber confirmed it, so an identical body is not forwarded twice.
 *   A failed delivery is not remembered and can be replayed.
 *   The cache is per process / per Worker isolate: subscribers must still
 *   dedupe on x-watahub-delivery-id.
 */

import type { MetaWebhookPayload } from '../types/meta.js'

/** Meta retries failed deliveries for up to 7 days; a tighter default would drop real retries */
export const DEFAULT_WEBHOOK_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

/** Newest Meta event timestamp in the payload (unix seconds), or undefined when it has none */
export function newestEventTimestamp(payload: MetaWebhookPayload): number | undefined {
  let newest: number | undefined
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      // Only live message traffic is aged; history sync legitimately carries old timestamps
      if (change?.field !== 'messages') continue
      const value = change?.value
      const items = [
        ...(Array.isArray(value?.messages) ? value.messages : []),
        ...(Array.isArray(value?.statuses) ? value.statuses : []),
      ]
      for (const item of items) {
        const seconds = Number(item?.timestamp)
        if (Number.isFinite(seconds) && seconds > 0 && (newest === undefined || seconds > newest)) newest = seconds
      }
    }
  }
  return newest
}

export function isStale(payload: MetaWebhookPayload, maxAgeSeconds: number, nowMs = Date.now()): boolean {
  const newest = newestEventTimestamp(payload)
  // Updates without event timestamps (e.g. template status) cannot be aged
  if (newest === undefined) return false
  return nowMs / 1000 - newest > maxAgeSeconds
}

/** Bounded, time-limited set of recently seen delivery IDs */
export class DeliveryIdCache {
  private seen = new Map<string, number>()

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly maxEntries = 10_000
  ) {}

  has(id: string, nowMs = Date.now()): boolean {
    const expiresAt = this.seen.get(id)
    return expiresAt !== undefined && expiresAt > nowMs
  }

  /** Records the ID; returns false if it was already seen inside the TTL */
  remember(id: string, nowMs = Date.now()): boolean {
    if (this.has(id, nowMs)) return false

    this.seen.delete(id)
    if (this.seen.size >= this.maxEntries) this.evict(nowMs)
    this.seen.set(id, nowMs + this.ttlMs)
    return true
  }

  clear(): void {
    this.seen.clear()
  }

  private evict(nowMs: number): void {
    for (const [id, expiresAt] of this.seen) {
      if (expiresAt <= nowMs) this.seen.delete(id)
    }
    // Still full: drop the oldest insertions (Map keeps insertion order)
    for (const id of this.seen.keys()) {
      if (this.seen.size < this.maxEntries) break
      this.seen.delete(id)
    }
  }
}

export const webhookDeliveryIds = new DeliveryIdCache()
