import type { Context } from 'hono'

const inFlightTasks = new Set<Promise<unknown>>()

/**
 * Keeps `task` alive after the response is sent. On Workers it is handed to
 * waitUntil; on Node there is no ExecutionContext (Hono's getter throws) and
 * the already-running promise completes on its own while being tracked in-flight
 * for graceful shutdown.
 */
export function runInBackground(c: Context, task: Promise<unknown>): void {
  inFlightTasks.add(task)
  void task.finally(() => inFlightTasks.delete(task))

  try {
    if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
      c.executionCtx.waitUntil(task)
    }
  } catch {
    // Node.js or runtimes without executionCtx
  }
}

/**
 * Awaits all pending background tasks up to `timeoutMs` during graceful shutdown.
 */
export async function drainBackgroundTasks(timeoutMs = 15_000): Promise<void> {
  if (inFlightTasks.size === 0) return
  const drainPromise = Promise.allSettled(Array.from(inFlightTasks))
  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  await Promise.race([drainPromise, timeoutPromise])
  if (timer) clearTimeout(timer)
}

export function getInFlightTaskCount(): number {
  return inFlightTasks.size
}

export function clearInFlightTasksForTests(): void {
  inFlightTasks.clear()
}
