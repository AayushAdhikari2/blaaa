import { randomId } from '../core/event-id.js';
import { AUDIT_TYPES } from '../audit/audit-log.js';
import { idempotencyKey, CHANNEL_IN_APP, NOTIFICATION_TYPE_APPOINTMENT_REQUESTED } from './idempotency.js';

/**
 * Recipient-specific in-app notification generation (spec section 11).
 *
 * Notification body NEVER contains patient name, phone, access code or any appointment
 * details beyond the appointment id correlation key. Staff identify the request in the
 * existing Carepulse application after a future approved UI integration.
 */

export const NOTIFICATION_TITLE = 'New appointment request';
export const NOTIFICATION_BODY = 'A new online appointment request requires reception review.';

/**
 * @param {{ event: {event_id: string}, appointment_id: string, recipient_id: string, now: string,
 *   channel?: string, notification_type?: string }} args
 */
export function buildNotification({
  event,
  appointment_id,
  recipient_id,
  now,
  channel = CHANNEL_IN_APP,
  notification_type = NOTIFICATION_TYPE_APPOINTMENT_REQUESTED,
}) {
  const key = idempotencyKey({
    event_id: event.event_id,
    recipient_id,
    channel,
    notification_type,
  });
  return {
    notification_id: randomId(),
    event_id: event.event_id,
    appointment_id: String(appointment_id),
    recipient_id: String(recipient_id),
    channel,
    notification_type,
    title: NOTIFICATION_TITLE,
    body: NOTIFICATION_BODY,
    payload: {
      event_id: event.event_id,
      appointment_id: String(appointment_id),
      notification_type,
      created_at: now,
    },
    created_at: now,
    idempotency_key: key,
    delivery_status: 'pending',
  };
}

export class NotificationService {
  /**
   * @param {{ store: import('../adapters/mock/mock-store.js').MockStore,
   *   audit: import('../audit/audit-log.js').AuditLog, clock?: {now(): Date} }} deps
   */
  constructor({ store, audit, clock }) {
    this.store = store;
    this.audit = audit;
    this.clock = clock ?? { now: () => new Date() };
  }

  /**
   * Idempotent creation. Uniqueness is enforced inside the store mutex (and, in production,
   * by a DB unique constraint). Returns { created, notification, duplicate }.
   */
  async createNotification(args) {
    const notification = buildNotification({ ...args, now: args.now ?? this.clock.now().toISOString() });

    const outcome = await this.store.update((state) => {
      const existingId = state.notificationKeys[notification.idempotency_key];
      if (existingId && state.notifications[existingId]) {
        return { created: false, duplicate: true, notification: state.notifications[existingId] };
      }
      // Also guard against notification_id collision (defense in depth).
      while (state.notifications[notification.notification_id]) notification.notification_id = randomId();

      state.notifications[notification.notification_id] = notification;
      state.notificationKeys[notification.idempotency_key] = notification.notification_id;
      state.sequences.notification = (state.sequences.notification ?? 0) + 1;
      return { created: true, duplicate: false, notification };
    });

    // append-only audit (always; created or duplicate skipped)
    const event = args.event ?? { event_id: notification.event_id };
    await auditNotificationOutcome(this.audit, event, outcome.notification, outcome);
    return outcome;
  }

  async markDeliveryStatus(notificationId, status) {
    await this.store.update((state) => {
      const n = state.notifications[notificationId];
      if (n) n.delivery_status = status;
    });
  }

  async list(filter = {}) {
    const state = await this.store.read();
    let rows = Object.values(state.notifications);
    if (filter.event_id) rows = rows.filter((n) => n.event_id === filter.event_id);
    if (filter.recipient_id) rows = rows.filter((n) => n.recipient_id === filter.recipient_id);
    rows.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    return rows;
  }
}

/** Emit the appropriate audit record for a create/duplicate outcome. */
export async function auditNotificationOutcome(audit, event, notification, outcome) {
  if (outcome.created) {
    await audit.append(AUDIT_TYPES.NOTIFICATION_CREATED, {
      event_id: event.event_id,
      appointment_id: notification.appointment_id,
      recipient_id: notification.recipient_id,
      notification_id: notification.notification_id,
      channel: notification.channel,
      notification_type: notification.notification_type,
    });
  } else {
    await audit.append(AUDIT_TYPES.NOTIFICATION_DUPLICATE_SKIPPED, {
      event_id: event.event_id,
      appointment_id: notification.appointment_id,
      recipient_id: notification.recipient_id,
      notification_id: notification.notification_id,
      channel: notification.channel,
      notification_type: notification.notification_type,
      idempotency_key_suffix: notification.idempotency_key.slice(-24),
    });
  }
}
