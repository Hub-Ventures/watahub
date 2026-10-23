import type { Context } from 'hono'

/**
 * Keeps `task` alive after the response is sent. On Workers it is handed to
 * waitUntil; on Node there is no ExecutionContext (Hono's getter throws) and
 * the already-running promise simply completes on its own.
 */
export function runInBackground(c: Context, task: Promise<unknown>): void {
  let executionCtx: { waitUntil(promise: Promise<unknown>): void }
  try {
    executionCtx = c.executionCtx
  } catch {
    return
  }
  executionCtx.waitUntil(task)
}
