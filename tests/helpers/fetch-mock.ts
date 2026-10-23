import { vi } from 'vitest'

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function mockFetch(...responses: Response[]) {
  const spy = vi.spyOn(globalThis, 'fetch')
  for (const res of responses) spy.mockResolvedValueOnce(res)
  return spy
}

export const metaError = (code: number, message = 'Meta failure', extra: Record<string, unknown> = {}) => ({
  error: { message, code, type: 'OAuthException', ...extra },
})

export function postJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }
}
