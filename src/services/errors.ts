/**
 * Meta Cloud API Error Classification
 * Derived from production lessons in Yampi.
 */

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

export interface ErrorClassification {
  category: 'auth' | 'billing' | 'rate_limit' | 'meta_server' | 'validation' | 'unknown'
  retryable: boolean
  action: string
}

export class WatahubApiError extends Error {
  code: number
  subcode?: number
  type?: string
  fbtraceId?: string
  statusCode: number
  isRetryable: boolean
  isAuthError: boolean
  isBillingError: boolean

  get metaCode(): number {
    return this.code
  }

  get metaSubcode(): number | undefined {
    return this.subcode
  }

  get metaType(): string | undefined {
    return this.type
  }

  constructor(body: MetaApiErrorBody, status: number) {
    const err = body.error || { message: 'Unknown Meta API error', code: status, type: 'OAuthException' }
    super(`Meta Graph API Error (${err.code}): ${err.message}`)
    this.name = 'WatahubApiError'
    this.code = err.code
    this.subcode = err.error_subcode
    this.type = err.type
    this.fbtraceId = err.fbtrace_id
    this.statusCode = status

    // Server-side / Rate limit errors
    const RETRYABLE_CODES = [2, 130429, 131000, 131016, 133004]
    this.isRetryable = RETRYABLE_CODES.includes(this.code)

    // Token expired (190) or WABA unreachable/unauthorized (100 subcode 33)
    this.isAuthError = this.code === 190 || (this.code === 100 && this.subcode === 33)

    // WABA Credit card expired / payment issue (131042)
    this.isBillingError = this.code === 131042
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

  // 130429 Cloud API throughput, 4 app-level, 80007 WABA-level, or a bare HTTP 429
  if (err.code === 130429 || err.code === 4 || err.code === 80007 || err.statusCode === 429) {
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
