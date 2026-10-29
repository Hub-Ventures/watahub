import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { errorName, type Logger } from '../logger.js'
import { UNKNOWN_SEND_OUTCOME, WatahubApiError, classifyMetaError, transportFailure } from '../services/errors.js'

export interface MetaErrorResponseOptions {
  /** Include Meta's error `type` (e.g. OAuthException) in the body. */
  includeType?: boolean
  /**
   * The call was a message send, which is not idempotent: a transport failure or
   * a Meta 5xx leaves its outcome unknown, and the body says so.
   */
  messageSend?: boolean
}

/**
 * Maps anything thrown while calling Meta to the gateway's JSON error shape:
 * classified Meta errors keep their details, every other failure becomes a
 * generic 502/504 whose underlying message is never echoed.
 */
export function errorResponse(
  c: Context,
  err: unknown,
  logger: Logger,
  options: MetaErrorResponseOptions = {}
): Response {
  if (err instanceof WatahubApiError) return metaErrorResponse(c, err, options)

  logger.error(`[watahub] Meta Graph API call failed: ${errorName(err)}`)
  const failure = transportFailure(err)
  return c.json(
    { error: { message: failure.message, ...(options.messageSend ? UNKNOWN_SEND_OUTCOME : {}) } },
    failure.status
  )
}

/** Classified Meta error. Keeps Meta's 4xx/5xx status, anything else becomes 502. */
export function metaErrorResponse(c: Context, err: WatahubApiError, options: MetaErrorResponseOptions = {}): Response {
  const classification = options.messageSend && err.statusCode >= 500 ? UNKNOWN_SEND_OUTCOME : classifyMetaError(err)
  const status = (err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502) as ContentfulStatusCode

  return c.json(
    {
      error: {
        message: err.message,
        code: err.metaCode,
        subcode: err.metaSubcode,
        ...(options.includeType ? { type: err.metaType } : {}),
        category: classification.category,
        retryable: classification.retryable,
        action: classification.action,
      },
    },
    status
  )
}
