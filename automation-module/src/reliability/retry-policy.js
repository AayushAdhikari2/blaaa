/**
 * Bounded exponential backoff (spec section 12).
 *
 * delay(attempt) = min(baseMs * 2^(attempt-1), maxMs)   for attempt >= 1
 *
 * No random jitter: deterministic scheduling for testability; a trusted production worker
 * can add jitter downstream. No automatic retry after maxAttempts. `attempts` counts
 * attempts already made. Retry timestamps are absolute ISO-8601 instants from an injected clock.
 */

export const DEFAULT_RETRY_POLICY = Object.freeze({
  maxAttempts: 5,
  baseMs: 1_000,
  maxMs: 60_000,
});

/** @param {number} attempt 1-based attempt number that just failed */
export function backoffMs(attempt, policy = DEFAULT_RETRY_POLICY) {
  const a = Math.max(1, Math.floor(attempt));
  const raw = policy.baseMs * 2 ** (a - 1);
  return Math.min(raw, policy.maxMs);
}

/**
 * @param {number} attemptsMade attempts completed so far
 * @param {{maxAttempts:number, baseMs:number, maxMs:number}} policy
 * @param {string|number|Date} from ISO time / ms / Date base instant
 * @returns {{ shouldRetry: boolean, nextRetryAt: string | null, delayMs: number }}
 */
export function scheduleRetry(attemptsMade, policy = DEFAULT_RETRY_POLICY, from = new Date()) {
  if (attemptsMade >= policy.maxAttempts) {
    return { shouldRetry: false, nextRetryAt: null, delayMs: 0 };
  }
  const delayMs = backoffMs(attemptsMade, policy);
  const base = new Date(from).getTime();
  return { shouldRetry: true, nextRetryAt: new Date(base + delayMs).toISOString(), delayMs };
}
