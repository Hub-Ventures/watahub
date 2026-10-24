import type { Context } from 'hono'
import { getConfig } from '../config.js'
import type { GatewayDeps } from '../deps.js'
import type { MetaGraphClient } from '../services/meta-client.js'
import { resolveMetaAccessToken } from './auth.js'
import type { Outcome } from './outcome.js'

export const MISSING_META_TOKEN =
  'Missing Meta access token. Set META_SYSTEM_USER_TOKEN or pass X-Meta-Access-Token header.'

/**
 * Builds the Meta client for this request from the resolved access token and
 * API version. Answers 500 when no token is configured or supplied.
 */
export async function metaClientFor(
  c: Context,
  deps: GatewayDeps,
  phoneNumberId?: string
): Promise<Outcome<MetaGraphClient>> {
  const accessToken = await resolveMetaAccessToken(c, deps, phoneNumberId)
  if (!accessToken) {
    return { ok: false, response: c.json({ error: MISSING_META_TOKEN }, 500) }
  }
  return { ok: true, value: deps.createMetaClient({ accessToken, apiVersion: getConfig(c).metaApiVersion }) }
}
