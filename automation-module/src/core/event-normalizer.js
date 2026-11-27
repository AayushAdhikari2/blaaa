import { EVENT_TYPE_APPOINTMENT_REQUESTED } from './event-validator.js';

/**
 * Normalize a validated raw event into the canonical internal form.
 * Unknown/extra fields are DROPPED (allow-list). Nothing patient-identifying can survive:
 * appointments physically contain name/phone, but the event contract only carries the
 * appointment id; normalization enforces that boundary again.
 */
export function normalizeEvent(raw) {
  const event = {
    event_id: String(raw.event_id),
    event_type: String(raw.event_type),
    schema_version: 1,
    source: String(raw.source),
    source_id: String(raw.source_id),
    occurred_at: new Date(raw.occurred_at).toISOString(),
    payload: {},
  };

  if (event.event_type === EVENT_TYPE_APPOINTMENT_REQUESTED) {
    event.payload = { appointment_id: normalizeAppointmentId(raw.payload.appointment_id) };
  }

  return event;
}

function normalizeAppointmentId(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return String(value);
}
