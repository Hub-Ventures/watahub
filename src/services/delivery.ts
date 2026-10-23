/**
 * Subscriber webhook delivery with bounded retries and a stable idempotency key.
 */

import { signSubscriberPayload } from './crypto.js'

export interface DeliveryPolicy {
  /** Total attempts including the first one */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  /** Per-attempt timeout */
  timeoutMs: number
}

/**
 * Worst case ≈ 3 × 5s + 1s + 2s = 18s, which fits inside the 30s Cloudflare
 * Workers allows for waitUntil work after the response is sent.
 */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
  timeoutMs: 5_000,
}

export interface DeliveryRequest {
  url: string
  body: string
  secret: string
  /** Stable across retries and across Meta redeliveries of the same payload */
  deliveryId: string
}

export interface DeliveryResult {
  delivered: boolean
  attempts: number
  status?: number
}

/** Retry on timeouts, network errors, 408, 425, 429 and 5xx; other 4xx are final */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function deliverToSubscriber(
  request: DeliveryRequest,
  policy: DeliveryPolicy = DEFAULT_DELIVERY_POLICY
): Promise<DeliveryResult> {
  const signature = await signSubscriberPayload(request.body, request.secret)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Watahub-Gateway/0.1.0',
    'x-watahub-signature': signature,
    // Subscribers should dedupe on this: retries and Meta redeliveries reuse it
    'x-watahub-delivery-id': request.deliveryId,
    'Idempotency-Key': request.deliveryId,
  }

  let lastStatus: number | undefined
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      const res = await fetch(request.url, {
        method: 'POST',
        headers,
        body: request.body,
        // A redirect would resend the signed body to a host nobody configured
        redirect: 'manual',
        signal: AbortSignal.timeout(policy.timeoutMs),
      })
      lastStatus = res.status
      // Release the connection; the subscriber's response body is not used
      await res.body?.cancel().catch(() => {})

      if (res.ok) return { delivered: true, attempts: attempt, status: res.status }
      if (!isRetryableStatus(res.status)) {
        console.error(`[watahub] Subscriber rejected delivery ${request.deliveryId} with HTTP ${res.status}`)
        return { delivered: false, attempts: attempt, status: res.status }
      }
    } catch (err) {
      lastStatus = undefined
      const reason = err instanceof Error ? err.name : 'unknown'
      console.error(`[watahub] Subscriber delivery ${request.deliveryId} attempt ${attempt} failed: ${reason}`)
    }

    if (attempt < policy.maxAttempts) {
      await sleep(Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)))
    }
  }

  console.error(
    `[watahub] Giving up on subscriber delivery ${request.deliveryId} after ${policy.maxAttempts} attempts` +
      (lastStatus ? ` (last HTTP ${lastStatus})` : '')
  )
  return { delivered: false, attempts: policy.maxAttempts, status: lastStatus }
}
