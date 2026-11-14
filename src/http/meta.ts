import type { Context } from 'hono'
import { getConfig } from '../config.js'
import type { GatewayDeps } from '../deps.js'
import type { MetaGraphClient } from '../services/meta-client.js'
import { resolveMetaAccessToken } from './auth.js'
import type { Outcome } from './outcome.js'

export const MISSING_META_TOKEN =
  'Missing Meta access token. Set META_SYSTEM_USER_TOKEN, pass X-Meta-Access-Token header, or X-Phone-Number-Id for a connected line.'

/** Success from metaClientFor: client plus the token it was built with (one store read). */
export interface MetaClientHandle {
  client: MetaGraphClient
  accessToken: string
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
  phoneNumberId?: string
): Promise<Outcome<MetaClientHandle>> {
  const accessToken = await resolveMetaAccessToken(c, { phoneNumberId, lineStore: deps.lineStore })
  if (!accessToken) {
    return { ok: false, response: c.json({ error: MISSING_META_TOKEN }, 500) }
  }
  return {
    ok: true,
    value: {
      client: deps.createMetaClient({ accessToken, apiVersion: getConfig(c).metaApiVersion }),
      accessToken,
    },
  }
}
