import { randomId } from '../core/event-id.js';
import { AUDIT_TYPES } from '../audit/audit-log.js';
import { idempotencyKey } from '../notifications/idempotency.js';
import { classifyError, errorSummary } from './error-classification.js';
import { DEFAULT_RETRY_POLICY, scheduleRetry } from './retry-policy.js';

/**
 * Per-recipient delivery queue with retry + dead-letter (spec sections 9, 12, 13).
 *
 * States: pending → processing → succeeded
 *                         → retry_scheduled → processing → ...
 *                         → failed → dead_letter
 * manual replay: dead_letter / failed → pending → processing ...
 *
 * A delivery in `succeeded` is TERMINAL. Retry and replay never repeat successful deliveries.
 * Attempt history is append-only. Claiming is atomic inside the store mutex; production
 * mirrors this with SELECT ... FOR UPDATE SKIP LOCKED (see db/proposals/).
 */

export const DELIVERY_STATES = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  SUCCEEDED: 'succeeded',
  RETRY_SCHEDULED: 'retry_scheduled',
  FAILED: 'failed',
  DEAD_LETTER: 'dead_letter',
});

export class DeliveryQueue {
  /**
   * @param {{ store: import('../adapters/mock/mock-store.js').MockStore,
   *   audit: import('../audit/audit-log.js').AuditLog, clock?: {now(): Date},
   *   policy?: {maxAttempts:number, baseMs:number, maxMs:number},
   *   onNotificationStatus?: (notificationId: string, status: string) => Promise<void> }} deps
   */
  constructor({ store, audit, clock, policy = DEFAULT_RETRY_POLICY, onNotificationStatus }) {
    this.store = store;
    this.audit = audit;
    this.clock = clock ?? { now: () => new Date() };
    this.policy = policy;
    this.onNotificationStatus = onNotificationStatus ?? null;
  }

  nowIso() {
    return this.clock.now().toISOString();
  }

  /** Idempotently enqueue a delivery for a notification. */
  async enqueue({ notification }) {
    const key = notification.idempotency_key ??
      idempotencyKey({
        event_id: notification.event_id,
        recipient_id: notification.recipient_id,
        channel: notification.channel,
        notification_type: notification.notification_type,
      });
    return this.store.update((state) => {
      const existingId = state.deliveryKeys[key];
      if (existingId && state.deliveries[existingId]) return state.deliveries[existingId];
      const now = this.nowIso();
      const delivery = {
        delivery_id: randomId(),
        notification_id: notification.notification_id,
        event_id: notification.event_id,
        appointment_id: notification.appointment_id ?? null,
        recipient_id: notification.recipient_id,
        channel: notification.channel,
        notification_type: notification.notification_type,
        idempotency_key: key,
        status: DELIVERY_STATES.PENDING,
        attempts: 0,
        max_attempts: this.policy.maxAttempts,
        next_retry_at: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
        claimed_at: null,
        last_error: null,
        last_failure_class: null,
        history: [], // append-only attempt history
      };
      state.deliveries[delivery.delivery_id] = delivery;
      state.deliveryKeys[key] = delivery.delivery_id;
      state.sequences.delivery = (state.sequences.delivery ?? 0) + 1;
      return delivery;
    });
  }

  /**
   * Atomically claim a delivery for processing. Returns null if not claimable.
   * `allowedFrom` restricts which states may transition to processing.
   */
  async _claim(deliveryId, allowedFrom) {
    return this.store.update((state) => {
      const d = state.deliveries[deliveryId];
      if (!d) return null;
      if (!allowedFrom.includes(d.status)) return null;
      if (d.status === DELIVERY_STATES.SUCCEEDED) return null; // never repeat success
      d.status = DELIVERY_STATES.PROCESSING;
      d.claimed_at = this.nowIso();
      d.updated_at = d.claimed_at;
      d.attempts += 1;
      return structuredClone(d);
    });
  }

  /**
   * Attempt delivery once. Retry scheduling / dead-letter transitions applied atomically.
   * @param {string} deliveryId
   * @param {{ sink: { deliver(notification: unknown): Promise<void> }, recheck?: () => Promise<boolean> }} args
   */
  async attempt(deliveryId, { sink, recheck, allowedFrom = [DELIVERY_STATES.PENDING, DELIVERY_STATES.RETRY_SCHEDULED], force = false } = {}) {
    const from = force
      ? [DELIVERY_STATES.PENDING, DELIVERY_STATES.RETRY_SCHEDULED, DELIVERY_STATES.FAILED, DELIVERY_STATES.DEAD_LETTER]
      : allowedFrom;

    const claimed = await this._claim(deliveryId, from);
    if (!claimed) {
      const state = await this.store.read();
      const d = state.deliveries[deliveryId];
      return { attempted: false, status: d?.status ?? 'missing', delivery: d ?? null };
    }

    await this.audit.append(AUDIT_TYPES.DELIVERY_ATTEMPT, {
      event_id: claimed.event_id,
      recipient_id: claimed.recipient_id,
      delivery_id: claimed.delivery_id,
      notification_id: claimed.notification_id,
      attempt: claimed.attempts,
      channel: claimed.channel,
    });
    if (claimed.attempts > 1) {
      await this.audit.append(AUDIT_TYPES.RETRY_ATTEMPT, {
        event_id: claimed.event_id,
        recipient_id: claimed.recipient_id,
        delivery_id: claimed.delivery_id,
        attempt: claimed.attempts,
        max_attempts: claimed.max_attempts,
      });
    }

    const now = this.nowIso();
    const attemptRecord = { attempt: claimed.attempts, at: now, outcome: null, error: null, failure_class: null };

    // Re-check recipient eligibility at processing time (spec section 10). Failure here is permanent.
    if (recheck) {
      let eligible = false;
      try {
        eligible = await recheck(claimed.recipient_id);
      } catch (err) {
        eligible = false;
        attemptRecord.error = errorSummary(err);
      }
      if (!eligible) {
        return this._finishPermanent(claimed, attemptRecord, 'recipient no longer eligible', 'permanent');
      }
    }

    // Fetch the notification to deliver (never mutate it here).
    const state = await this.store.read();
    const notification = state.notifications[claimed.notification_id];

    try {
      await sink.deliver(structuredClone(notification ?? { ...claimed }));
      return this._finishSuccess(claimed, attemptRecord);
    } catch (err) {
      const failureClass = classifyError(err);
      attemptRecord.outcome = 'failed';
      attemptRecord.error = errorSummary(err);
      attemptRecord.failure_class = failureClass;
      if (failureClass === 'transient' && claimed.attempts < claimed.max_attempts) {
        return this._finishRetry(claimed, attemptRecord);
      }
      return this._finishPermanent(claimed, attemptRecord, errorSummary(err), failureClass);
    }
  }

  async _finishSuccess(claimed, attemptRecord) {
    attemptRecord.outcome = 'succeeded';
    const now = this.nowIso();
    const delivery = await this.store.update((state) => {
      const d = state.deliveries[claimed.delivery_id];
      d.status = DELIVERY_STATES.SUCCEEDED;
      d.updated_at = now;
      d.completed_at = now;
      d.claimed_at = null;
      d.next_retry_at = null;
      d.last_error = null;
      d.last_failure_class = null;
      d.history.push(attemptRecord);
      const n = state.notifications[d.notification_id];
      if (n) n.delivery_status = DELIVERY_STATES.SUCCEEDED;
      return structuredClone(d);
    });
    await this.audit.append(AUDIT_TYPES.DELIVERY_RESULT, {
      event_id: claimed.event_id,
      recipient_id: claimed.recipient_id,
      delivery_id: claimed.delivery_id,
      notification_id: claimed.notification_id,
      outcome: 'succeeded',
      attempt: claimed.attempts,
    });
    return { attempted: true, status: DELIVERY_STATES.SUCCEEDED, delivery };
  }

  async _finishRetry(claimed, attemptRecord) {
    const { nextRetryAt, delayMs } = scheduleRetry(claimed.attempts, this.policy, this.clock.now());
    const now = this.nowIso();
    const delivery = await this.store.update((state) => {
      const d = state.deliveries[claimed.delivery_id];
      d.status = DELIVERY_STATES.RETRY_SCHEDULED;
      d.updated_at = now;
      d.claimed_at = null;
      d.next_retry_at = nextRetryAt;
      d.last_error = attemptRecord.error;
      d.last_failure_class = attemptRecord.failure_class;
      d.history.push(attemptRecord);
      const n = state.notifications[d.notification_id];
      if (n) n.delivery_status = DELIVERY_STATES.RETRY_SCHEDULED;
      return structuredClone(d);
    });
    await this.audit.append(AUDIT_TYPES.DELIVERY_RESULT, {
      event_id: claimed.event_id,
      recipient_id: claimed.recipient_id,
      delivery_id: claimed.delivery_id,
      outcome: 'failed',
      failure_class: attemptRecord.failure_class,
      error: attemptRecord.error,
      attempt: claimed.attempts,
    });
    await this.audit.append(AUDIT_TYPES.RETRY_SCHEDULED, {
      event_id: claimed.event_id,
      recipient_id: claimed.recipient_id,
      delivery_id: claimed.delivery_id,
      attempt: claimed.attempts,
      max_attempts: claimed.max_attempts,
      next_retry_at: nextRetryAt,
      delay_ms: delayMs,
    });
    return { attempted: true, status: DELIVERY_STATES.RETRY_SCHEDULED, delivery };
  }

  async _finishPermanent(claimed, attemptRecord, error, failureClass) {
    attemptRecord.outcome = attemptRecord.outcome ?? 'failed';
    attemptRecord.error = attemptRecord.error ?? error;
    attemptRecord.failure_class = attemptRecord.failure_class ?? failureClass;
    const now = this.nowIso();
    const delivery = await this.store.update((state) => {
      const d = state.deliveries[claimed.delivery_id];
      d.status = DELIVERY_STATES.DEAD_LETTER; // failed → dead-letter; transition recorded
      d.updated_at = now;
      d.completed_at = now;
      d.claimed_at = null;
      d.next_retry_at = null;
      d.last_error = attemptRecord.error;
      d.last_failure_class = attemptRecord.failure_class;
      d.history.push(attemptRecord);
      const n = state.notifications[d.notification_id];
      if (n) n.delivery_status = DELIVERY_STATES.FAILED;
      return structuredClone(d);
    });
    await this.audit.append(AUDIT_TYPES.DELIVERY_FAILED, {
      event_id: claimed.event_id,
      recipient_id: claimed.recipient_id,
      delivery_id: claimed.delivery_id,
      attempt: claimed.attempts,
      failure_class: attemptRecord.failure_class,
      error: attemptRecord.error,
    });
    await this.audit.append(AUDIT_TYPES.EVENT_FAILED, {
      event_id: claimed.event_id,
      recipient_id: claimed.recipient_id,
      delivery_id: claimed.delivery_id,
    });
    await this.audit.append(AUDIT_TYPES.DEAD_LETTER, {
      event_id: claimed.event_id,
      recipient_id: claimed.recipient_id,
      delivery_id: claimed.delivery_id,
      attempts: claimed.attempts,
      failure_class: attemptRecord.failure_class,
      error: attemptRecord.error,
    });
    return { attempted: true, status: DELIVERY_STATES.DEAD_LETTER, delivery };
  }

  /** Process all due deliveries (pending + retry_scheduled whose next_retry_at <= now). */
  async processDue({ sink, recheck } = {}) {
    const state = await this.store.read();
    const nowMs = this.clock.now().getTime();
    const due = Object.values(state.deliveries).filter((d) => {
      if (d.status === DELIVERY_STATES.PENDING) return true;
      if (d.status === DELIVERY_STATES.RETRY_SCHEDULED) {
        return !d.next_retry_at || new Date(d.next_retry_at).getTime() <= nowMs;
      }
      return false;
    });
    const results = [];
    for (const d of due) {
      results.push(await this.attempt(d.delivery_id, { sink, recheck }));
    }
    return results;
  }

  /**
   * Manual retry of one delivery. Never repeats successful deliveries.
   * Works on retry_scheduled regardless of next_retry_at.
   */
  async retryOne(deliveryId, { sink, recheck } = {}) {
    const state = await this.store.read();
    const d = state.deliveries[deliveryId];
    if (!d) return { attempted: false, status: 'missing' };
    if (d.status === DELIVERY_STATES.SUCCEEDED) return { attempted: false, status: DELIVERY_STATES.SUCCEEDED, delivery: d };
    if (d.status === DELIVERY_STATES.DEAD_LETTER || d.status === DELIVERY_STATES.FAILED) {
      return this.replayOne(deliveryId, { sink, recheck });
    }
    return this.attempt(deliveryId, { sink, recheck, force: true });
  }

  /**
   * Manual replay of a failed / dead-lettered delivery (spec sections 9, 12).
   * Resets to pending, preserves attempt history, appends replay marker, re-attempts.
   * Idempotent: a delivery already succeeded is skipped. Successful deliveries are never repeated.
   */
  async replayOne(deliveryId, { sink, recheck, replayContext = 'manual' } = {}) {
    const prep = await this.store.update((state) => {
      const d = state.deliveries[deliveryId];
      if (!d) return { ok: false, status: 'missing' };
      if (d.status === DELIVERY_STATES.SUCCEEDED) return { ok: false, status: DELIVERY_STATES.SUCCEEDED, delivery: structuredClone(d) };
      if (d.status === DELIVERY_STATES.PROCESSING) return { ok: false, status: DELIVERY_STATES.PROCESSING, delivery: structuredClone(d) };
      d.status = DELIVERY_STATES.PENDING;
      d.updated_at = this.nowIso();
      d.next_retry_at = null;
      d.claimed_at = null;
      // Manual replay starts a fresh bounded attempt round; attempt history is preserved.
      const priorAttempts = d.attempts;
      d.attempts = 0;
      // Preserve history; record replay as a marker entry, not a deletion.
      d.history.push({ attempt: null, at: d.updated_at, outcome: `replay:${replayContext}`, error: null, failure_class: null, prior_attempts: priorAttempts });
      return { ok: true, delivery: structuredClone(d) };
    });
    if (!prep.ok) return { attempted: false, status: prep.status, delivery: prep.delivery ?? null };

    await this.audit.append(AUDIT_TYPES.MANUAL_REPLAY, {
      event_id: prep.delivery.event_id,
      recipient_id: prep.delivery.recipient_id,
      delivery_id: prep.delivery.delivery_id,
      notification_id: prep.delivery.notification_id,
      replay_context: replayContext,
      prior_attempts: prep.delivery.attempts,
    });

    return this.attempt(deliveryId, {
      sink,
      recheck,
      allowedFrom: [DELIVERY_STATES.PENDING],
    });
  }

  async list(filter = {}) {
    const state = await this.store.read();
    let rows = Object.values(state.deliveries);
    if (filter.status) rows = rows.filter((d) => d.status === filter.status);
    if (filter.event_id) rows = rows.filter((d) => d.event_id === filter.event_id);
    if (filter.recipient_id) rows = rows.filter((d) => d.recipient_id === filter.recipient_id);
    return rows;
  }

  async get(deliveryId) {
    const state = await this.store.read();
    return state.deliveries[deliveryId] ?? null;
  }
}
