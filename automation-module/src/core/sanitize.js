/**
 * Sanitization for logs, audit records, error summaries and notifications.
 *
 * Hard rule (spec section 13): never log patient names, phone numbers, access codes,
 * passwords, tokens, secrets, or any other credential. Keys matching SENSITIVE_KEY_RE
 * are replaced with REDACTED; string values are scrubbed for token/secret shapes and
 * phone-number shapes. Appointment IDs, event IDs, recipient IDs (synthetic staff IDs)
 * are not sensitive and are preserved.
 */

export const REDACTED = '[REDACTED]';

// Key names whose values must never be persisted. Note: 'code' covers access codes
// (six-digit patient codes, OTPs); appointment payloads do not use a 'code' key.
const SENSITIVE_KEY_RE =
  /(name|phone|mobile|email|mail|code|token|secret|password|passwd|pwd|authorization|auth|credential|api[_-]?key|service[_-]?role|bill(?!_)|access|ssn|dob|birth)/i;

// Specific keys that are safe even though they contain a sensitive substring.
const SAFE_KEYS = new Set([
  'event_type',
  'notification_type',
  'source',
  'status',
  'schema_version',
  'error_code',
  'failure_class',
]);

// Value shapes that look like secrets / tokens.
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEYVALUE_RE = /\b(api[_-]?key|token|secret|password|passwd|authorization|service[_-]?role[_-]?key|access[_-]?code|code)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const SUPABASE_KEY_RE = /\bsb[a-z]*-[A-Za-z0-9._-]{8,}/g;
// Phone-number shapes (loose): +1-555-123-4567, 555 123 4567, 5551234567 (10-15 digit runs).
// Guarded so UUIDs / ids embedded in larger tokens are not scrubbed; six-digit access codes
// are handled by key-based redaction, never by value-shape scrubbing.
const PHONE_RE = /(?<![\w-])(\+\d[\d\s().-]{7,}\d|\d{3}[\s().-]\d{3}[\s().-]\d{4}|\d{10,15})(?![\w-])/g;
// Long opaque tokens (24+ base64ish/hex chars). UUID-shaped ids are NOT secrets; preserved.
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{24,}\b/g;
const UUID_LIKE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function scrubString(value) {
  return value
    .replace(JWT_RE, REDACTED)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(KEYVALUE_RE, (_m, k) => `${k}=${REDACTED}`)
    .replace(SUPABASE_KEY_RE, REDACTED)
    .replace(PHONE_RE, REDACTED)
    .replace(LONG_TOKEN_RE, (m) => (m.length >= 24 && !UUID_LIKE_RE.test(m) ? REDACTED : m));
}

function isSensitiveKey(key) {
  if (SAFE_KEYS.has(key)) return false;
  return SENSITIVE_KEY_RE.test(key);
}

/**
 * Recursively sanitize any value for safe persistence/logging.
 * @param {unknown} value
 * @param {string} [key]
 */
export function sanitize(value, key = '') {
  if (key && isSensitiveKey(key)) return REDACTED;
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return sanitizeErrorSummary(value);
  if (Array.isArray(value)) return value.map((v) => sanitize(v));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, k);
    return out;
  }
  return REDACTED; // functions, symbols, anything exotic
}

/** Sanitized, single-line, length-bounded error summary safe for audit + DLQ. */
export function sanitizeErrorSummary(error, maxLength = 200) {
  let message = '';
  if (error instanceof Error) message = error.message ?? '';
  else if (typeof error === 'string') message = error;
  else if (error && typeof error === 'object') {
    message = typeof error.message === 'string' ? error.message : JSON.stringify(error);
  } else message = String(error);
  const cleaned = scrubString(message)
    .replace(/\b\d{6}\b/g, REDACTED) // six-digit patient access codes / OTPs in free text
    .replace(/[\r\n\t]+/g, ' ').trim();
  const summary = cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
  return summary || 'unknown error';
}

/**
 * Assert that a serialized string contains no obviously sensitive material.
 * Used by tests and as a defense-in-depth check before persisting audit entries.
 */
export function assertNoSensitiveMaterial(serialized, { forbidden = [] } = {}) {
  const problems = [];
  for (const needle of forbidden) {
    if (needle && serialized.includes(needle)) problems.push(`contains forbidden value`);
  }
  if (JWT_RE.test(serialized)) problems.push('contains JWT-shaped token');
  return problems;
}
