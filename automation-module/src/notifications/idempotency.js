/**
 * Deterministic idempotency keys.
 *
 * key = event_id + recipient_id + channel + notification_type   (spec section 9)
 *
 * Uniqueness is enforced at the storage layer:
 *  - local V1: unique map key + check-and-set inside the store mutex
 *  - production proposal: UNIQUE (event_id, recipient_id, channel, notification_type) /
 *    UNIQUE (idempotency_key) in Postgres (see db/proposals/)
 */

export const CHANNEL_IN_APP = 'in_app';
export const NOTIFICATION_TYPE_APPOINTMENT_REQUESTED = 'appointment.requested';

/** @param {{ event_id: string, recipient_id: string, channel: string, notification_type: string }} parts */
export function idempotencyKey({ event_id, recipient_id, channel, notification_type }) {
  return [event_id, recipient_id, channel, notification_type].join('|');
}
