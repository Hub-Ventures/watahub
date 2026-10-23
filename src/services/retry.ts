/**
 * Retry primitives shared by every outbound call (Meta Graph and subscriber delivery).
 */

export interface RetryPolicy {
  /** Total attempts including the first one */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  /** Per-attempt timeout */
  timeoutMs: number
}

export type Sleep = (ms: number) => Promise<void>

export const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Exponential backoff with full jitter: random(0, min(max, base * 2^attempt)). `attempt` is 0-based. */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  return Math.floor(random() * exponentialDelayMs(attempt, policy))
}

/** Deterministic exponential backoff: min(max, base * 2^attempt). `attempt` is 0-based. */
export function exponentialDelayMs(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt)
}
