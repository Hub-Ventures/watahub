/**
 * Subscriber webhook delivery with bounded retries and a stable idempotency key.
 */

import { GATEWAY_USER_AGENT } from '../config.js'
import { consoleLogger, errorName, type Logger } from '../logger.js'
import { signSubscriberPayload } from './crypto.js'
import { exponentialDelayMs, sleep, type RetryPolicy, type Sleep } from './retry.js'

/** Same shape as every other outbound retry policy */
export type DeliveryPolicy = RetryPolicy

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

/** Collaborators, all optional: defaults are the global fetch, a real timer and the console. */
export interface DeliveryDeps {
  fetch?: typeof fetch
  sleep?: Sleep
  logger?: Logger
}

/** Retry on timeouts, network errors, 408, 425, 429 and 5xx; other 4xx are final */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export async function deliverToSubscriber(
  request: DeliveryRequest,
  policy: DeliveryPolicy = DEFAULT_DELIVERY_POLICY,
  deps: DeliveryDeps = {}
): Promise<DeliveryResult> {
  const fetchFn = deps.fetch ?? ((input, init) => fetch(input, init))
  const wait = deps.sleep ?? sleep
  const logger = deps.logger ?? consoleLogger

  const signature = await signSubscriberPayload(request.body, request.secret)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': GATEWAY_USER_AGENT,
    'x-watahub-signature': signature,
    // Subscribers should dedupe on this: retries and Meta redeliveries reuse it
    'x-watahub-delivery-id': request.deliveryId,
    'Idempotency-Key': request.deliveryId,
  }

  let lastStatus: number | undefined
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      const res = await fetchFn(request.url, {
        method: 'POST',
        headers,
        body: request.body,
        signal: AbortSignal.timeout(policy.timeoutMs),
      })
      lastStatus = res.status
      // Release the connection; the subscriber's response body is not used
      await res.body?.cancel().catch(() => undefined)

      if (res.ok) return { delivered: true, attempts: attempt, status: res.status }
      if (!isRetryableStatus(res.status)) {
        logger.error(`[watahub] Subscriber rejected delivery ${request.deliveryId} with HTTP ${res.status}`)
        return { delivered: false, attempts: attempt, status: res.status }
      }
    } catch (err) {
      lastStatus = undefined
      logger.error(`[watahub] Subscriber delivery ${request.deliveryId} attempt ${attempt} failed: ${errorName(err)}`)
    }

    if (attempt < policy.maxAttempts) {
      await wait(exponentialDelayMs(attempt - 1, policy))
    }
  }

  logger.error(
    `[watahub] Giving up on subscriber delivery ${request.deliveryId} after ${policy.maxAttempts} attempts` +
      (lastStatus ? ` (last HTTP ${lastStatus})` : '')
  )
  return { delivered: false, attempts: policy.maxAttempts, status: lastStatus }
}
