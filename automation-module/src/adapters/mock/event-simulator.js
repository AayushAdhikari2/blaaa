import { deterministicEventId } from '../../core/event-id.js';
import { EVENT_TYPE_APPOINTMENT_REQUESTED, APPOINTMENT_SOURCE, SCHEMA_VERSION } from '../../core/event-validator.js';

/**
 * Synthetic event simulator for local V1 (spec section 8).
 *
 * Carepulse has no appointment event hooks / outbox in V1. This simulator produces
 * appointment.requested envelopes for SYNTHETIC appointments only. Deterministic event ids
 * (UUID v5 of event_type|source|appointment_id) → repeat delivery of the same synthetic
 * appointment always yields the same event_id, demonstrating idempotent replay safely.
 *
 * NO real patient data. NO database. NO network. Synthetic appointment details generated
 * here are NOT copied into the event; the event carries only appointment_id.
 */

let syntheticCounter = 0;

export class EventSimulator {
  /** @param {{ clock?: {now(): Date}, appointmentIdStart?: number }} [options] */
  constructor(options = {}) {
    this.clock = options.clock ?? { now: () => new Date() };
    this._appointmentSeq = options.appointmentIdStart ?? 100_000;
  }

  /**
   * Generate a synthetic appointment.requested event.
   * @param {{ appointmentId?: string|number, occurredAt?: string }} [options]
   * @returns {{ event: object, syntheticAppointment: object }}
   */
  generateAppointmentRequested(options = {}) {
    const appointmentId = String(options.appointmentId ?? ++this._appointmentSeq);
    const occurredAt = options.occurredAt ?? this.clock.now().toISOString();
    const event = {
      event_id: deterministicEventId({
        eventType: EVENT_TYPE_APPOINTMENT_REQUESTED,
        source: APPOINTMENT_SOURCE,
        sourceId: appointmentId,
      }),
      event_type: EVENT_TYPE_APPOINTMENT_REQUESTED,
      schema_version: SCHEMA_VERSION,
      source: APPOINTMENT_SOURCE,
      source_id: appointmentId,
      occurred_at: occurredAt,
      payload: { appointment_id: appointmentId },
    };
    // Synthetic context for the human operator ONLY. Never emitted inside the event;
    // never persisted in logs; patient identity fields are placeholders, not real people.
    const syntheticAppointment = {
      appointment_id: appointmentId,
      status: 'requested',
      synthetic: true,
      note: 'synthetic appointment; name/phone intentionally excluded from the event contract',
    };
    return { event, syntheticAppointment };
  }

  /** Re-generate the identical event for repeat-delivery / replay demonstrations. */
  repeatLast(last) {
    return { event: structuredClone(last.event), syntheticAppointment: structuredClone(last.syntheticAppointment) };
  }
}

export function nextSyntheticAppointmentId() {
  syntheticCounter += 1;
  return `SYNTH-${syntheticCounter}`;
}
