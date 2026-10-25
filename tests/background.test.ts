import { afterEach, describe, expect, it } from 'vitest'
import {
  clearInFlightTasksForTests,
  drainBackgroundTasks,
  getInFlightTaskCount,
  runInBackground,
} from '../src/http/background.js'
import type { Context } from 'hono'

describe('Background tasks & graceful shutdown', () => {
  afterEach(() => {
    clearInFlightTasksForTests()
  })

  it('tracks in-flight tasks and removes them upon completion', async () => {
    let resolved = false
    const promise = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolved = true
        resolve()
      }, 20)
    })

    const fakeContext = {} as Context
    runInBackground(fakeContext, promise)

    expect(getInFlightTaskCount()).toBe(1)
    await promise
    // Wait microtask tick for .finally() to execute
    await new Promise((r) => setTimeout(r, 5))
    expect(getInFlightTaskCount()).toBe(0)
    expect(resolved).toBe(true)
  })

  it('drains active background tasks gracefully', async () => {
    let completed = 0
    const task1 = new Promise<void>((resolve) =>
      setTimeout(() => {
        completed++
        resolve()
      }, 10)
    )
    const task2 = new Promise<void>((resolve) =>
      setTimeout(() => {
        completed++
        resolve()
      }, 20)
    )

    const fakeContext = {} as Context
    runInBackground(fakeContext, task1)
    runInBackground(fakeContext, task2)

    expect(getInFlightTaskCount()).toBe(2)
    await drainBackgroundTasks(1000)
    expect(completed).toBe(2)
  })

  it('drain returns immediately when no in-flight tasks exist', async () => {
    expect(getInFlightTaskCount()).toBe(0)
    await expect(drainBackgroundTasks()).resolves.toBeUndefined()
  })

  it('delegates to executionCtx.waitUntil when available', () => {
    let passedPromise: Promise<unknown> | undefined
    const mockCtx = {
      executionCtx: {
        waitUntil: (p: Promise<unknown>) => {
          passedPromise = p
        },
      },
    } as unknown as Context

    const task = Promise.resolve('ok')
    runInBackground(mockCtx, task)
    expect(passedPromise).toBe(task)
  })
})
