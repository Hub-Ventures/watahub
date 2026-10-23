/**
 * Minimal logging port. Everything the gateway prints goes through it, so a
 * deployment can swap console for a structured logger without touching routes.
 * Callers pass already-safe text: no secrets, no raw upstream error messages.
 */
export interface Logger {
  info(message: string): void
  error(message: string): void
}

export const consoleLogger: Logger = {
  // eslint-disable-next-line no-console -- the console is the default sink
  info: (message) => console.log(message),
  error: (message) => console.error(message),
}

/** Error name only: messages can carry hostnames, addresses or secrets. */
export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown'
}
