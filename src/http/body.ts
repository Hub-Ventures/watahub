import type { Context } from 'hono'
import type { z } from 'zod'
import type { Outcome } from './outcome.js'

/**
 * Reads the JSON body and validates it against `schema`.
 * 400 on malformed JSON, 422 with zod field errors on validation failure.
 */
export async function parseJsonBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<Outcome<z.output<S>>> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return { ok: false, response: c.json({ error: 'Malformed JSON payload' }, 400) }
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return { ok: false, response: validationError(c, parsed.error.flatten().fieldErrors) }
  }

  return { ok: true, value: parsed.data as z.output<S> }
}

/** 422 in the same shape the body validator uses, for values read from headers, path or query. */
export function validationError(c: Context, details: Record<string, string[] | undefined>): Response {
  return c.json({ error: 'Validation failed', details }, 422)
}
