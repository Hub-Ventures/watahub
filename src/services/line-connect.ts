import type { LineStore } from '../deps.js'
import { DEFAULT_WABA_SUBSCRIBED_FIELDS, type MetaClientConfig, type MetaGraphClient } from './meta-client.js'

/** Which Graph step of a line connect failed. The token is never part of this error. */
export type ConnectStep = 'exchange' | 'subscribe' | 'register'

export class LineConnectError extends Error {
  readonly step: ConnectStep

  constructor(step: ConnectStep, cause: unknown) {
    super(`WhatsApp line connect failed during ${step}`, { cause })
    this.name = 'LineConnectError'
    this.step = step
  }
}

export interface ConnectLineInput {
  code: string
  wabaId: string
  phoneNumberId: string
  pin: string
  appId: string
  appSecret: string
  apiVersion: string
}

export interface ConnectLineResult {
  phoneNumberId: string
  wabaId: string
  subscribed: true
  registered: true
}

export interface ConnectLineDeps {
  createMetaClient: (config: MetaClientConfig) => MetaGraphClient
  lineStore: LineStore
}

async function runStep<T>(step: ConnectStep, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err: unknown) {
    throw new LineConnectError(step, err)
  }
}

/**
 * Exchange, store, subscribe, register. The business token is written to the
 * line store and is not part of the result: a later step can fail without
 * handing the token back, and a retry of subscribe/register can use the store.
 * Subscribe uses the business token, not META_SYSTEM_USER_TOKEN, and does not
 * override the app's callback URL.
 */
export async function connectLine(input: ConnectLineInput, deps: ConnectLineDeps): Promise<ConnectLineResult> {
  const client = deps.createMetaClient({ accessToken: '', apiVersion: input.apiVersion })

  const { accessToken } = await runStep('exchange', () =>
    client.exchangeCodeForToken(input.code, input.appId, input.appSecret)
  )

  // Kept even if subscribe or register fails, so the token is not only in this stack frame.
  await deps.lineStore.put({
    phoneNumberId: input.phoneNumberId,
    wabaId: input.wabaId,
    accessToken,
  })

  await runStep('subscribe', () => client.subscribeAppToWaba(input.wabaId, DEFAULT_WABA_SUBSCRIBED_FIELDS, accessToken))
  await runStep('register', () => client.registerPhone(input.phoneNumberId, input.pin, accessToken))

  return {
    phoneNumberId: input.phoneNumberId,
    wabaId: input.wabaId,
    subscribed: true,
    registered: true,
  }
}
