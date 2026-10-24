import { Hono } from 'hono'
import { getConfig } from '../config.js'
import type { GatewayDeps } from '../deps.js'
import { validationError } from '../http/body.js'
import { errorResponse } from '../http/errors.js'
import { metaClientFor } from '../http/meta.js'
import { isGraphId } from '../schemas/common.js'

export function createTemplatesRouter(deps: GatewayDeps): Hono {
  const router = new Hono()

  /**
   * List WhatsApp Message Templates
   * GET /v1/templates or GET /v1/templates/:wabaId
   */
  router.get('/v1/templates/:wabaId?', async (c) => {
    const wabaId = c.req.param('wabaId') || c.req.query('wabaId') || getConfig(c).metaDefaultWabaId
    if (!wabaId) {
      return c.json(
        { error: 'Missing wabaId. Provide it in URL path, ?wabaId query param, or META_DEFAULT_WABA_ID env var.' },
        400
      )
    }
    // wabaId becomes a Graph path segment; anything non-numeric could address other Graph objects
    if (!isGraphId(wabaId)) {
      return validationError(c, { wabaId: ['Must be a numeric Meta Graph ID'] })
    }

    const meta = await metaClientFor(c, deps)
    if (!meta.ok) return meta.response

    try {
      return c.json({ data: await meta.value.listTemplates(wabaId) }, 200)
    } catch (err: unknown) {
      return errorResponse(c, err, deps.logger)
    }
  })

  return router
}
