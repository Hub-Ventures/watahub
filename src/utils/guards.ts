/** Narrowing for untrusted JSON (Graph responses, webhook bodies) */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
