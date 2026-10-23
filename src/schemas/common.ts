import { z } from 'zod'

/**
 * Meta Graph object IDs (phone number IDs, WABA IDs, media IDs, app IDs) are
 * numeric. Enforcing that is what keeps caller input from turning into Graph
 * path segments such as `../../me?fields=...` signed with the system token.
 */
export const GraphIdSchema = z.string().regex(/^\d{1,32}$/, 'Must be a numeric Meta Graph ID')

export function isGraphId(value: string): boolean {
  return GraphIdSchema.safeParse(value).success
}

/** HTTPS-only URL (Meta rejects non-TLS callback and media URLs). */
export const HttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), 'URL must use https://')
