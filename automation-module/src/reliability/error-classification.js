/**
 * Transient vs permanent error classification (spec section 12).
 *
 * transient  → retryable with bounded exponential backoff
 * permanent  → no automatic retry; straight to failed → dead-letter
 */
import { sanitizeErrorSummary } from '../core/sanitize.js';

const TRANSIENT_NAME_RE = /transient|timeout|timedout|temporarily|unavailable|overloaded|retry/i;
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND',
  'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'SERVICE_UNAVAILABLE', 'RATE_LIMITED',
  'TRANSIENT_ERROR', 'NETWORK_ERROR', 'FETCH_FAILED',
  '429', '500', '502', '503', '504',
]);

/** @returns {'transient' | 'permanent'} */
export function classifyError(error) {
  if (error && typeof error === 'object') {
    if (error.transient === true) return 'transient';
    if (error.transient === false) return 'permanent';
    const code = String(error.code ?? error.status ?? error.statusCode ?? '').toUpperCase();
    if (TRANSIENT_CODES.has(code)) return 'transient';
    if (/^5\d\d$/.test(code)) return 'transient';
    const name = String(error.name ?? '');
    if (TRANSIENT_NAME_RE.test(name)) return 'transient';
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/timeout|timed out|temporarily|try again|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|429|50[234]/i.test(message)) {
    return 'transient';
  }
  return 'permanent';
}

export function isTransient(error) {
  return classifyError(error) === 'transient';
}

/** Sanitized, single-line, bounded error summary for storage. */
export function errorSummary(error, maxLength = 200) {
  return sanitizeErrorSummary(error, maxLength);
}
