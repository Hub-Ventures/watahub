import { describe, it, expect } from 'vitest'
import {
  META_ERROR_CODES,
  WatahubApiError,
  classifyMetaError,
  isRateLimit,
  isTransient,
  metaErrorCode,
  transportFailure,
} from '../src/services/errors.js'

describe('Error Handling & Classification', () => {
  it('correctly classifies token expiration (code 190)', () => {
    const err = new WatahubApiError(
      {
        error: {
          message: 'Error validating access token: Session has expired',
          type: 'OAuthException',
          code: 190,
          error_subcode: 463,
        },
      },
      401
    )

    expect(err.isAuthError).toBe(true)
    expect(err.isRetryable).toBe(false)
    const classification = classifyMetaError(err)
    expect(classification.category).toBe('auth')
    expect(classification.retryable).toBe(false)
  })

  it('correctly classifies rate limits (code 130429)', () => {
    const err = new WatahubApiError(
      {
        error: {
          message: 'Cloud API message throughput limit reached',
          type: 'OAuthException',
          code: 130429,
        },
      },
      429
    )

    expect(err.isRetryable).toBe(true)
    const classification = classifyMetaError(err)
    expect(classification.category).toBe('rate_limit')
    expect(classification.retryable).toBe(true)
  })

  it('correctly classifies billing payment issue (code 131042)', () => {
    const err = new WatahubApiError(
      {
        error: {
          message: 'Payment issue with Business Manager credit card',
          type: 'OAuthException',
          code: 131042,
        },
      },
      400
    )

    expect(err.isBillingError).toBe(true)
    expect(err.isRetryable).toBe(false)
    const classification = classifyMetaError(err)
    expect(classification.category).toBe('billing')
    expect(classification.retryable).toBe(false)
  })

  it('correctly classifies transient server errors (code 131016)', () => {
    const err = new WatahubApiError(
      {
        error: {
          message: 'A service error occurred. Please try again later',
          type: 'OAuthException',
          code: 131016,
        },
      },
      503
    )

    expect(err.isRetryable).toBe(true)
    const classification = classifyMetaError(err)
    expect(classification.category).toBe('meta_server')
    expect(classification.retryable).toBe(true)
  })
})

describe('Meta error model', () => {
  it('names every code the gateway reacts to', () => {
    expect(META_ERROR_CODES).toMatchObject({
      API_UNKNOWN: 1,
      API_TOO_MANY_CALLS: 4,
      ACCESS_TOKEN_EXPIRED: 190,
      WABA_RATE_LIMIT: 80007,
      CLOUD_API_RATE_LIMIT: 130429,
      BUSINESS_PAYMENT_ISSUE: 131042,
    })
  })

  it('shares one rate-limit and transient rule with the client retry logic', () => {
    expect(isRateLimit(429, undefined)).toBe(true)
    expect([4, 80007, 130429].every((code) => isRateLimit(400, code))).toBe(true)
    expect(isRateLimit(400, 131000)).toBe(false)
    expect(isTransient(503, undefined)).toBe(true)
    expect([1, 2, 131000, 131016, 133004].every((code) => isTransient(400, code))).toBe(true)
    expect(isTransient(400, 190)).toBe(false)
  })

  it('classifies code 1 (API Unknown) as a retryable server error', () => {
    const err = new WatahubApiError({ error: { message: 'unknown', code: 1 } }, 500)
    expect(classifyMetaError(err)).toMatchObject({ category: 'meta_server', retryable: true })
  })

  it('classifies a bare HTTP 429 and WABA-level 80007 as rate limits', () => {
    expect(classifyMetaError(new WatahubApiError({}, 429)).category).toBe('rate_limit')
    expect(classifyMetaError(new WatahubApiError({ error: { message: 'x', code: 80007 } }, 400)).category).toBe(
      'rate_limit'
    )
  })

  it('classifies WABA unreachable (100 / subcode 33) as an auth error', () => {
    const err = new WatahubApiError({ error: { message: 'x', code: 100, error_subcode: 33 } }, 400)
    expect(classifyMetaError(err).category).toBe('auth')
  })

  it('falls back to the HTTP status for bodies that are not Meta errors', () => {
    for (const body of [null, 'html', {}, { error: 'nope' }, { error: { code: 'x' } }]) {
      const err = new WatahubApiError(body, 502)
      expect(err.code).toBe(502)
      expect(err.message).toBe('Meta Graph API Error (502): Unknown Meta API error')
      expect(classifyMetaError(err).category).toBe('unknown')
    }
    expect(metaErrorCode({ error: { code: 4 } })).toBe(4)
    expect(metaErrorCode({ error: { code: '4' } })).toBeUndefined()
  })

  it('maps transport failures to generic 504 / 502 without the original message', () => {
    const timeout = Object.assign(new Error('10.0.0.1 timed out'), { name: 'TimeoutError' })
    expect(transportFailure(timeout)).toEqual({ status: 504, message: 'Meta Graph API request timed out' })
    expect(transportFailure('weird')).toEqual({ status: 502, message: 'Meta Graph API unreachable' })
  })
})
