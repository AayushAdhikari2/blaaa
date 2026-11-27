import { UnknownEventError } from './errors.js';
import { isUuid } from './event-id.js';

/** The single production-intended event in V1. */
export const EVENT_TYPE_APPOINTMENT_REQUESTED = 'appointment.requested';

/** Physical origin of appointment.requested (kept separate from the logical envelope). */
export const APPOINTMENT_SOURCE = 'public.appointments';

/** Event types this engine knows how to route. Unknown types are rejected. */
export const KNOWN_EVENT_TYPES = new Set([EVENT_TYPE_APPOINTMENT_REQUESTED]);

export const SCHEMA_VERSION = 1;

const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isIso8601(v) {
  if (typeof v !== 'string' || !ISO_8601_RE.test(v)) return false;
  return !Number.isNaN(Date.parse(v));
}

/**
 * Appointment identifier may arrive as a string or a safe integer (Postgres bigint → JSON).
 * It is always normalized to a decimal string. bigint values beyond JS safe range must be
 * passed as strings by the caller; we never silently truncate precision.
 */
function normalizeAppointmentId(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}

/**
 * Validate an incoming event envelope. Pure; performs no mutation.
 * @returns {{ valid: boolean, errors: Array<{field: string, message: string}>, knownEventType: boolean }}
 */
export function validateEvent(raw) {
  const errors = [];

  if (!isPlainObject(raw)) {
    return { valid: false, errors: [{ field: '', message: 'event must be a JSON object' }], knownEventType: false };
  }

  // event_id
  if (!('event_id' in raw)) errors.push({ field: 'event_id', message: 'missing event_id' });
  else if (!isNonEmptyString(raw.event_id)) errors.push({ field: 'event_id', message: 'event_id must be a non-empty string' });
  else if (!isUuid(raw.event_id)) errors.push({ field: 'event_id', message: 'event_id must be a UUID string' });

  // event_type
  let knownEventType = false;
  if (!('event_type' in raw)) errors.push({ field: 'event_type', message: 'missing event_type' });
  else if (!isNonEmptyString(raw.event_type)) errors.push({ field: 'event_type', message: 'event_type must be a non-empty string' });
  else if (!KNOWN_EVENT_TYPES.has(raw.event_type)) {
    knownEventType = false;
    errors.push({ field: 'event_type', message: `unknown event type: ${raw.event_type}` });
  } else knownEventType = true;

  // schema_version
  if (!('schema_version' in raw)) errors.push({ field: 'schema_version', message: 'missing schema_version' });
  else if (raw.schema_version !== SCHEMA_VERSION) {
    errors.push({ field: 'schema_version', message: `unsupported schema_version (expected ${SCHEMA_VERSION})` });
  }

  // source
  if (!('source' in raw)) errors.push({ field: 'source', message: 'missing source' });
  else if (!isNonEmptyString(raw.source)) errors.push({ field: 'source', message: 'source must be a non-empty string' });

  // source_id
  if (!('source_id' in raw)) errors.push({ field: 'source_id', message: 'missing source_id' });
  else if (raw.source_id === null || typeof raw.source_id === 'object') {
    errors.push({ field: 'source_id', message: 'source_id must be a non-empty scalar' });
  } else if (String(raw.source_id).trim() === '') {
    errors.push({ field: 'source_id', message: 'source_id must be a non-empty string' });
  }

  // occurred_at
  if (!('occurred_at' in raw)) errors.push({ field: 'occurred_at', message: 'missing occurred_at' });
  else if (!isIso8601(raw.occurred_at)) {
    errors.push({ field: 'occurred_at', message: 'occurred_at must be an ISO-8601 timestamp' });
  }

  // payload
  if (!('payload' in raw)) errors.push({ field: 'payload', message: 'missing payload' });
  else if (!isPlainObject(raw.payload)) errors.push({ field: 'payload', message: 'payload must be an object' });

  // appointment.requested specifics
  if (isPlainObject(raw.payload) && (raw.event_type === EVENT_TYPE_APPOINTMENT_REQUESTED || !('event_type' in raw))) {
    const appointmentId = normalizeAppointmentId(raw.payload.appointment_id);
    if (!('appointment_id' in raw.payload)) {
      errors.push({ field: 'payload.appointment_id', message: 'missing appointment identifier (payload.appointment_id)' });
    } else if (appointmentId === null || appointmentId === '') {
      errors.push({ field: 'payload.appointment_id', message: 'appointment identifier must be a non-empty string or integer' });
    }
    // source + type must match the documented physical contract for this event type
    if (raw.event_type === EVENT_TYPE_APPOINTMENT_REQUESTED && isNonEmptyString(raw.source) && raw.source !== APPOINTMENT_SOURCE) {
      errors.push({ field: 'source', message: `appointment.requested source must be '${APPOINTMENT_SOURCE}'` });
    }
  }

  // Security: recipients must never be supplied by the caller (browser).
  if (isPlainObject(raw.payload) && ('recipients' in raw.payload || 'recipient_ids' in raw.payload || 'recipient_id' in raw.payload)) {
    errors.push({ field: 'payload.recipients', message: 'recipients must never be supplied in the event; resolved server-side' });
  }
  if ('recipients' in raw || 'recipient_ids' in raw) {
    errors.push({ field: 'recipients', message: 'recipients must never be supplied in the event; resolved server-side' });
  }

  return { valid: errors.length === 0, errors, knownEventType };
}

/** @throws {import('./errors.js').ValidationError} */
export function assertKnownEventType(eventType) {
  if (!KNOWN_EVENT_TYPES.has(eventType)) throw new UnknownEventError(eventType);
}
