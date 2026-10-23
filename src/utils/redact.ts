/**
 * Query parameters that carry secrets. Meta sends hub.verify_token on the
 * webhook handshake, and Graph accepts access_token / client_secret / code.
 */
const SECRET_QUERY_PARAMS = [
  'hub.verify_token',
  'access_token',
  'client_secret',
  'code',
  'input_token',
  'appsecret_proof',
  'refresh_token',
]

const SECRET_PARAM_PATTERN = new RegExp(
  `([?&](?:${SECRET_QUERY_PARAMS.map((p) => p.replace('.', '\\.')).join('|')})=)[^&\\s#]*`,
  'gi'
)

/** Replaces secret query-string values in any log line with [REDACTED]. */
export function redactSecrets(line: string): string {
  return line.replace(SECRET_PARAM_PATTERN, '$1[REDACTED]')
}
