const SENSITIVE_KEY_PATTERN =
  /^(password|passwd|pwd|secret|token|accessToken|refreshToken|apiKey|apikey|api_key|authorization|auth|privateKey|private_key|clientSecret|client_secret|pin|ssn|cvv|cvc)$/i;

/**
 * Deep-clone a value while replacing known-sensitive field values with '[REDACTED]'.
 * Used before persisting request payloads into audit_logs jsonb columns.
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (value == null || depth > 8) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? '[REDACTED]'
        : redactSensitive(nested, depth + 1);
    }
    return out;
  }

  return value;
}
