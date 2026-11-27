# Event contract — appointment.requested v1

Authoritative contract: `contracts/appointment-requested.v1.schema.json` + `contracts/event-envelope.md`.

```json
{
  "event_id": "UUID",
  "event_type": "appointment.requested",
  "schema_version": 1,
  "source": "public.appointments",
  "source_id": "appointment-row-id",
  "occurred_at": "ISO-8601 timestamp",
  "payload": { "appointment_id": "appointment-row-id" }
}
```

## Field rules
- `event_id`: UUID string. Local V1 deterministic (UUIDv5 of `event_type|source|source_id`).
- `event_type`: exactly `appointment.requested`. Unknown → `unknown_event_type`, rejected.
- `schema_version`: `1`. Unknown version → rejected.
- `source`: `public.appointments`.
- `source_id`: appointments.id (bigint identity) as decimal string. Required. (`appointment-row-id`.)
- `occurred_at`: ISO-8601. Required.
- `payload.appointment_id`: correlation id; required; non-empty string; equals source row id. **Not patient_id.**
- `additionalProperties`: stripped on normalize; injected `recipients`/`recipient_id` rejected.
- No `scheduled_start`. `preferred_date` (date-only) not carried. No patient name/phone/reason/access code.

## Validation
Every incoming event validated (`src/core/event-validator.js`). Invalid → rejected + audited;
no routing; no notifications. Missing appointment identifier → invalid. Recipients never from input.

## Logical contract vs physical columns
Logical envelope is independent of physical `public.appointments` columns. Physical columns
(name, phone, doctor_id, preferred_date, reason, created_at, status) are NOT mirrored into the
event. Only `appointment_id` correlation crosses the boundary. Production outbox writes exactly
the logical envelope; physical schema changes don't leak into the contract.
