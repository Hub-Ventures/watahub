import { describe, it, expect } from 'vitest'
import { WatahubApiError, classifyMetaError } from '../src/services/errors.js'

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
