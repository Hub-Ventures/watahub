/**
 * Meta Cloud API error model: named codes, the typed error thrown by the
 * Meta client, and the classification returned to callers.
 * Derived from production lessons in Yampi.
 */

import { isRecord } from '../utils/guards.js'

/** Error envelope Graph returns on failures (documentation of the shape WatahubApiError reads) */
export interface MetaApiErrorBody {
  error: {
    message: string
    type?: string
    code: number
    error_subcode?: number
    error_data?: {
      details?: string
    }
    fbtrace_id?: string
  }
}

export type ErrorCategory = 'auth' | 'billing' | 'rate_limit' | 'meta_server' | 'validation' | 'unknown'

export interface ErrorClassification {
  category: ErrorCategory
  retryable: boolean
  action: string
}

/** Meta error codes the gateway reacts to. See Meta's WhatsApp Cloud API error reference. */
export const META_ERROR_CODES = {
  API_UNKNOWN: 1,
  API_SERVICE: 2,
  API_TOO_MANY_CALLS: 4,
  INVALID_PARAMETER: 100,
  ACCESS_TOKEN_EXPIRED: 190,
  WABA_RATE_LIMIT: 80007,
  CLOUD_API_RATE_LIMIT: 130429,
  SOMETHING_WENT_WRONG: 131000,
  SERVICE_UNAVAILABLE: 131016,
  BUSINESS_PAYMENT_ISSUE: 131042,
  TEMPORARILY_UNAVAILABLE: 133004,
} as const

/** Subcode paired with INVALID_PARAMETER when the WABA is unreachable or unauthorized. */
const WABA_UNREACHABLE_SUBCODE = 33

/**
 * Rate limits: Meta rejected the request without processing it, so retrying is
 * safe for every method (app-level, WABA-level and Cloud API throughput).
 */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([
  META_ERROR_CODES.API_TOO_MANY_CALLS,
  META_ERROR_CODES.WABA_RATE_LIMIT,
  META_ERROR_CODES.CLOUD_API_RATE_LIMIT,
])

/**
 * Transient server errors. The request may have been processed, so these are
 * only retried for idempotent calls (never for sending a message).
 */
const TRANSIENT_CODES: ReadonlySet<number> = new Set([
  META_ERROR_CODES.API_UNKNOWN,
  META_ERROR_CODES.API_SERVICE,
  META_ERROR_CODES.SOMETHING_WENT_WRONG,
  META_ERROR_CODES.SERVICE_UNAVAILABLE,
  META_ERROR_CODES.TEMPORARILY_UNAVAILABLE,
])

/** HTTP 429 or a Meta rate-limit code. */
export function isRateLimit(status: number, code: number | undefined): boolean {
  return status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))
}

/** HTTP 5xx or a Meta transient-server code. */
export function isTransient(status: number, code: number | undefined): boolean {
  return status >= 500 || (code !== undefined && TRANSIENT_CODES.has(code))
}

/** Reads `error.code` from an untrusted Graph response body. */
export function metaErrorCode(body: unknown): number | undefined {
  const code = errorObject(body)?.code
  return typeof code === 'number' ? code : undefined
}

function errorObject(body: unknown): Record<string, unknown> | undefined {
  return isRecord(body) && isRecord(body.error) ? body.error : undefined
}

const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined)
const optionalNumber = (value: unknown) => (typeof value === 'number' ? value : undefined)

/** Thrown by the Meta client for every non-2xx (or unusable) Graph response. */
export class WatahubApiError extends Error {
  readonly code: number
  readonly subcode?: number
  readonly type?: string
  readonly fbtraceId?: string
  readonly statusCode: number
  readonly isRetryable: boolean
  readonly isAuthError: boolean
  readonly isBillingError: boolean

  get metaCode(): number {
    return this.code
  }

  get metaSubcode(): number | undefined {
    return this.subcode
  }

  get metaType(): string | undefined {
    return this.type
  }

  /** `body` is the raw Graph response; anything that is not a Meta error falls back to the HTTP status. */
  constructor(body: unknown, status: number) {
    const error = errorObject(body)
    const code = optionalNumber(error?.code) ?? status
    super(`Meta Graph API Error (${code}): ${optionalString(error?.message) ?? 'Unknown Meta API error'}`)
    this.name = 'WatahubApiError'
    this.code = code
    this.subcode = optionalNumber(error?.error_subcode)
    this.type = error ? optionalString(error.type) : 'OAuthException'
    this.fbtraceId = optionalString(error?.fbtrace_id)
    this.statusCode = status

    this.isRetryable = RATE_LIMIT_CODES.has(code) || TRANSIENT_CODES.has(code)
    this.isAuthError =
      code === META_ERROR_CODES.ACCESS_TOKEN_EXPIRED ||
      (code === META_ERROR_CODES.INVALID_PARAMETER && this.subcode === WABA_UNREACHABLE_SUBCODE)
    this.isBillingError = code === META_ERROR_CODES.BUSINESS_PAYMENT_ISSUE
  }
}

export function classifyMetaError(err: WatahubApiError): ErrorClassification {
  if (err.isAuthError) {
    return {
      category: 'auth',
      retryable: false,
      action: 'Re-authenticate with Meta Embedded Signup or refresh System User Token',
    }
  }

  if (err.isBillingError) {
    return {
      category: 'billing',
      retryable: false,
      action: 'Verify Meta Business Manager payment method and credit card validity',
    }
  }

  if (isRateLimit(err.statusCode, err.code)) {
    return {
      category: 'rate_limit',
      retryable: true,
      action: 'Back off with exponential jitter before retrying request',
    }
  }

  if (err.isRetryable) {
    return {
      category: 'meta_server',
      retryable: true,
      action: 'Retry request with exponential backoff',
    }
  }

  return {
    category: 'unknown',
    retryable: false,
    action: 'Inspect error code and payload details in Meta developer documentation',
  }
}

export interface TransportFailure {
  status: 502 | 504
  message: string
}

/**
 * Maps a non-Meta failure (timeout, DNS, connection reset...) to a generic
 * response. The caller logs the error name only; its message can carry
 * internal hostnames or addresses and is never returned.
 */
export function transportFailure(err: unknown): TransportFailure {
  return err instanceof Error && err.name === 'TimeoutError'
    ? { status: 504, message: 'Meta Graph API request timed out' }
    : { status: 502, message: 'Meta Graph API unreachable' }
}
