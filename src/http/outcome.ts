/**
 * Result of a request step that can short-circuit with an HTTP response
 * (validation error, missing configuration...). Handlers return `response` as is.
 */
export type Outcome<T> = { ok: true; value: T } | { ok: false; response: Response }
