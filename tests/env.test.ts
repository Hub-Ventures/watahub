import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { validateEnv } from '../src/utils/env.js'

const validEnv = {
  META_APP_SECRET: 'meta-app-secret-value',
  META_WEBHOOK_VERIFY_TOKEN: 'verify-token-0123456789',
  WATAHUB_API_KEY: 'a'.repeat(64),
  META_API_VERSION: 'v24.0',
}

function errorsFor(env: Record<string, string | undefined>): string[] {
  const result = validateEnv(env)
  return result.ok ? [] : result.errors
}

describe('validateEnv', () => {
  it('accepts a complete production configuration', () => {
    expect(validateEnv(validEnv)).toEqual({ ok: true })
  })

  it('requires the secrets that gate authentication', () => {
    const errors = errorsFor({})
    expect(errors.some((e) => e.startsWith('META_APP_SECRET'))).toBe(true)
    expect(errors.some((e) => e.startsWith('WATAHUB_API_KEY'))).toBe(true)
    expect(errors.some((e) => e.startsWith('META_WEBHOOK_VERIFY_TOKEN'))).toBe(true)
  })

  it('treats empty values from .env files as missing', () => {
    expect(errorsFor({ ...validEnv, META_APP_SECRET: '' }).some((e) => e.startsWith('META_APP_SECRET'))).toBe(true)
  })

  it('rejects short or placeholder API keys', () => {
    for (const key of ['short', 'wata_sk_live_secret_key_here']) {
      const errors = errorsFor({ ...validEnv, WATAHUB_API_KEY: key })
      expect(errors.length).toBeGreaterThan(0)
      expect(errors.every((e) => e.startsWith('WATAHUB_API_KEY'))).toBe(true)
    }
  })

  it('requires an https subscriber URL with a signing secret', () => {
    const noSecret = errorsFor({ ...validEnv, SUBSCRIBER_WEBHOOK_URL: 'https://app.example/hook' })
    expect(noSecret.some((e) => e.startsWith('SUBSCRIBER_WEBHOOK_SECRET'))).toBe(true)

    const plainHttp = errorsFor({
      ...validEnv,
      SUBSCRIBER_WEBHOOK_URL: 'http://app.example/hook',
      SUBSCRIBER_WEBHOOK_SECRET: 's'.repeat(32),
    })
    expect(plainHttp.some((e) => e.startsWith('SUBSCRIBER_WEBHOOK_URL'))).toBe(true)

    expect(
      validateEnv({
        ...validEnv,
        SUBSCRIBER_WEBHOOK_URL: 'http://localhost:4000/hook',
        SUBSCRIBER_WEBHOOK_SECRET: 's'.repeat(32),
      })
    ).toEqual({ ok: true })
  })

  it('rejects malformed IDs and API versions', () => {
    expect(errorsFor({ ...validEnv, META_DEFAULT_WABA_ID: '../me' })).toHaveLength(1)
    expect(errorsFor({ ...validEnv, META_API_VERSION: 'latest' })).toHaveLength(1)
  })

  it('never echoes secret values in error messages', () => {
    const secret = 'wk_leaky_value'
    const errors = errorsFor({ ...validEnv, WATAHUB_API_KEY: secret })
    expect(errors.join('\n')).not.toContain(secret)
  })

  it('rejects the shipped .env.example until it is filled in', () => {
    const example = Object.fromEntries(
      readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => line.includes('=') && !line.startsWith('#'))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    )
    expect(validateEnv(example).ok).toBe(false)
    // Every variable documented in .env.example must be one the gateway reads
    expect(Object.keys(example)).not.toContain('META_GRAPH_VERSION')
    expect(Object.keys(example)).toContain('META_API_VERSION')
  })
})
