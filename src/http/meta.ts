import type { Context } from 'hono'
import { getConfig } from '../config.js'
import type { GatewayDeps } from '../deps.js'
import type { MetaGraphClient } from '../services/meta-client.js'
import { resolveMetaAccessToken } from './auth.js'
import type { Outcome } from './outcome.js'

/** Base 500 when a Meta token is missing. Used by routes that cannot use a line store. */
export const MISSING_META_TOKEN =
  'Missing Meta access token. Set META_SYSTEM_USER_TOKEN or pass X-Meta-Access-Token header.'

/** Same as MISSING_META_TOKEN, plus the line hint for routes that accept a phone number ID. */
export const MISSING_META_TOKEN_FOR_LINE =
  'Missing Meta access token. Set META_SYSTEM_USER_TOKEN, pass X-Meta-Access-Token header, or name a line connected with POST /v1/onboarding/connect.'

/** Same as MISSING_META_TOKEN, plus the connect hint for WABA routes (templates, subscribe). */
export const MISSING_META_TOKEN_FOR_WABA =
  'Missing Meta access token. Set META_SYSTEM_USER_TOKEN, pass X-Meta-Access-Token header, or connect a line of this WABA with POST /v1/onboarding/connect.'

/** Success from metaClientFor: client plus the token it was built with (one store read). */
export interface MetaClientHandle {
  client: MetaGraphClient
  accessToken: string
}

export interface MetaClientForOptions {
  /**
   * When true, the missing-token message also points to a line connected with POST /v1/onboarding/connect.
   * Defaults to true when `phoneNumberId` is passed; set explicitly on routes
   * that accept an optional line id (media GETs) even when it is absent.
   */
  acceptsLine?: boolean
  /**
   * WABA routes (templates, subscribe) pass the WABA so the token of the line last connected for it can be used.
   * Ignored for the lookup when `phoneNumberId` is passed. The missing-token message then names connect.
   */
  wabaId?: string
}

/**
 * Builds the Meta client for this request from the resolved access token and
 * API version. Answers 500 when no token is configured or supplied.
 * Pass `phoneNumberId` when the call targets a line so the stored business token can be used,
 * or `options.wabaId` when it targets a WABA.
 * The resolved token is returned with the client so callers (e.g. media CDN download)
 * do not resolve it a second time.
 */
export async function metaClientFor(
  c: Context,
  deps: GatewayDeps,
  phoneNumberId?: string,
  options: MetaClientForOptions = {}
): Promise<Outcome<MetaClientHandle>> {
  const accessToken = await resolveMetaAccessToken(c, {
    phoneNumberId,
    wabaId: options.wabaId,
    lineStore: deps.lineStore,
  })
  if (!accessToken) {
    return { ok: false, response: c.json({ error: missingTokenMessage(phoneNumberId, options) }, 500) }
  }
  return {
    ok: true,
    value: {
      client: deps.createMetaClient({ accessToken, apiVersion: getConfig(c).metaApiVersion }),
      accessToken,
    },
  }
}

function missingTokenMessage(phoneNumberId: string | undefined, options: MetaClientForOptions): string {
  if (options.acceptsLine ?? phoneNumberId !== undefined) return MISSING_META_TOKEN_FOR_LINE
  if (options.wabaId !== undefined) return MISSING_META_TOKEN_FOR_WABA
  return MISSING_META_TOKEN
}
