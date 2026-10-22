import { Hono } from 'hono'
import { getEnvVar } from '../utils/env.js'
import { MetaClient } from '../services/meta-client.js'
import { WatahubApiError, classifyMetaError } from '../services/errors.js'

export const templatesRouter = new Hono()

/**
 * List WhatsApp Message Templates
 * GET /v1/templates or GET /v1/templates/:wabaId
 */
templatesRouter.get('/v1/templates/:wabaId?', async (c) => {
  const apiKey = getEnvVar(c, 'WATAHUB_API_KEY')
  if (apiKey) {
    const authHeader = c.req.header('authorization')
    const headerKey = c.req.header('x-api-key')
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

    if (bearer !== apiKey && headerKey !== apiKey) {
      return c.json({ error: 'Unauthorized: Invalid Watahub API key' }, 401)
    }
  }

  const wabaId =
    c.req.param('wabaId') ||
    c.req.query('wabaId') ||
    getEnvVar(c, 'META_DEFAULT_WABA_ID')

  if (!wabaId) {
    return c.json(
      {
        error: 'Missing wabaId. Provide it in URL path, ?wabaId query param, or META_DEFAULT_WABA_ID env var.',
      },
      400
    )
  }

  const defaultToken = getEnvVar(c, 'META_SYSTEM_USER_TOKEN')
  const overrideToken = c.req.header('x-meta-access-token')
  const accessToken = overrideToken || defaultToken

  if (!accessToken) {
    return c.json(
      {
        error: 'Missing Meta access token. Set META_SYSTEM_USER_TOKEN or pass X-Meta-Access-Token header.',
      },
      500
    )
  }

  const apiVersion = getEnvVar(c, 'META_API_VERSION') || 'v24.0'
  const client = new MetaClient({ accessToken, apiVersion })

  try {
    const templates = await client.listTemplates(wabaId)
    return c.json({ data: templates }, 200)
  } catch (err: unknown) {
    if (err instanceof WatahubApiError) {
      const classification = classifyMetaError(err)
      return c.json(
        {
          error: {
            message: err.message,
            code: err.metaCode,
            subcode: err.metaSubcode,
            category: classification.category,
            retryable: classification.retryable,
            action: classification.action,
          },
        },
        (err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502) as 502
      )
    }

    const message = err instanceof Error ? err.message : 'Unknown gateway error'
    return c.json({ error: { message } }, 500)
  }
})
