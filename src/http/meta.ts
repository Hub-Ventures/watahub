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
  'Missing Meta access token. Set META_SYSTEM_USER_TOKEN, pass X-Meta-Access-Token header, or X-Phone-Number-Id for a connected line.'

/** Success from metaClientFor: client plus the token it was built with (one store read). */
export interface MetaClientHandle {
  client: MetaGraphClient
  accessToken: string
}

export interface MetaClientForOptions {
  /**
   * When true, the missing-token message mentions X-Phone-Number-Id.
   * Defaults to true when `phoneNumberId` is passed; set explicitly on routes
   * that accept an optional line id (media GETs) even when it is absent.
   */
  acceptsLine?: boolean
}

/**
 * Builds the Meta client for this request from the resolved access token and
 * API version. Answers 500 when no token is configured or supplied.
 * Pass `phoneNumberId` when the call targets a line so the stored business token can be used.
 * The resolved token is returned with the client so callers (e.g. media CDN download)
 * do not resolve it a second time.
 */
export async function metaClientFor(
  c: Context,
  deps: GatewayDeps,
  phoneNumberId?: string,
  options: MetaClientForOptions = {}
): Promise<Outcome<MetaClientHandle>> {
  const accessToken = await resolveMetaAccessToken(c, { phoneNumberId, lineStore: deps.lineStore })
  if (!accessToken) {
    const acceptsLine = options.acceptsLine ?? phoneNumberId !== undefined
    const error = acceptsLine ? MISSING_META_TOKEN_FOR_LINE : MISSING_META_TOKEN
    return { ok: false, response: c.json({ error }, 500) }
  }
  return {
    ok: true,
    value: {
      client: deps.createMetaClient({ accessToken, apiVersion: getConfig(c).metaApiVersion }),
      accessToken,
    },
  }
}
