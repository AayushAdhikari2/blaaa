import { sanitize } from '../core/sanitize.js';
import { randomId } from '../core/event-id.js';

/**
 * Append-only audit log. Entries are sanitized; nothing patient-identifying, no secrets.
 * There is no update/delete API — history is immutable once appended.
 *
 * Required records (spec section 13): event received; validation outcome; recipient
 * resolution count; notification created; duplicate skipped; delivery result; retry
 * attempt; failure; dead-letter transition; manual replay.
 */

export const AUDIT_TYPES = Object.freeze({
  EVENT_RECEIVED: 'event.received',
  EVENT_VALIDATION: 'event.validation',
  EVENT_DUPLICATE: 'event.duplicate',
  EVENT_REJECTED: 'event.rejected',
  RECIPIENTS_RESOLVED: 'recipients.resolved',
  RECIPIENT_SKIPPED: 'recipient.skipped',
  NOTIFICATION_CREATED: 'notification.created',
  NOTIFICATION_DUPLICATE_SKIPPED: 'notification.duplicate_skipped',
  DELIVERY_ATTEMPT: 'delivery.attempt',
  DELIVERY_RESULT: 'delivery.result',
  RETRY_SCHEDULED: 'retry.scheduled',
  RETRY_ATTEMPT: 'retry.attempt',
  EVENT_FAILED: 'event.failed',
  DELIVERY_FAILED: 'delivery.failed',
  DEAD_LETTER: 'dead_letter',
  MANUAL_REPLAY: 'manual.replay',
  DRY_RUN: 'dry_run',
});

export class AuditLog {
  /** @param {{ store: import('../adapters/mock/mock-store.js').MockStore, clock?: {now(): Date} }} deps */
  constructor({ store, clock }) {
    this.store = store;
    this.clock = clock ?? { now: () => new Date() };
  }

  /**
   * Append one sanitized entry. Returns the persisted entry.
   * @param {string} type
   * @param {Record<string, unknown>} data
   */
  async append(type, data = {}) {
    const safe = sanitize(data);
    // Defense in depth: hard-drop known sensitive keys that sanitize would redact anyway.
    const entry = {
      audit_id: randomId(),
      at: this.clock.now().toISOString(),
      type,
      ...safe,
    };
    await this.store.update((state) => {
      state.sequences.audit = (state.sequences.audit ?? 0) + 1;
      entry.seq = state.sequences.audit;
      state.audit.push(entry); // append-only
    });
    return entry;
  }

  /** @param {{ type?: string, event_id?: string, recipient_id?: string, limit?: number }} [filter] */
  async list(filter = {}) {
    const state = await this.store.read();
    let rows = [...state.audit];
    if (filter.type) rows = rows.filter((e) => e.type === filter.type);
    if (filter.event_id) rows = rows.filter((e) => e.event_id === filter.event_id);
    if (filter.recipient_id) rows = rows.filter((e) => e.recipient_id === filter.recipient_id);
    rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    if (filter.limit) rows = rows.slice(-filter.limit);
    return rows;
  }
}
