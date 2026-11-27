# Event envelope contract

The **logical event contract** is separate from **physical database columns**.

## Logical envelope

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

- `appointment_id` (== `source_id`) is the **correlation identifier**.
- **No `patient_id`.** Patients are not Supabase Auth identities; patient identity on a patient
  portal is bill number + six-digit access code, which are never copied into events or logs.
- **No `scheduled_start`.** `appointments.preferred_date` is a **date-only** field, not a
  confirmed appointment time, and is intentionally excluded from this event.
- **Recipients are never supplied by the browser.** There is no `recipients`/`recipient_id`
  field in the contract; recipients are resolved server-side at processing time.
- No patient name / phone / reason / access code / secrets in the event.

## Physical origin (separate from logical contract)

Real Carepulse V4 `public.appointments`:

```
id bigint generated always as identity primary key
name text not null                      -- never copied into the event
phone text not null                     -- never copied into the event
doctor_id text not null references doctors(id)
preferred_date date null                -- date-only; NOT scheduled_start; not in event
reason text null                        -- never copied into the event
status text not null default 'requested' check (status in ('requested','converted','cancelled'))
created_at timestamptz not null default now()
```

Source event is exactly: **`INSERT` into `public.appointments` with `status='requested'`.**
Carepulse creates appointments via `request_appointment(p_name,p_phone,p_doctor,p_date,p_reason)`
(SECURITY DEFINER; anon + authenticated; returns void; **no event-emission mechanism**;
inserts with status `requested` by default). V1 adds no trigger to any existing SQL file.

`appointments.id` is `bigint`; JSON has no bigint, so `source_id` / `appointment_id` are
serialized as **decimal strings**; precision is never truncated. Validation accepts a string
or safe integer and normalizes to string.

## Unknown events

Unknown `event_type` → rejected (`unknown_event_type`), audited, never routed, no notifications.
Incoming events are validated (`src/core/event-validator.js`); unknown fields are stripped
during normalization (allow-list); any `recipients`/`recipient_id` injection is rejected.

## Versioning

`schema_version: 1`. Consumers must reject unknown major versions. JSON Schema:
`contracts/appointment-requested.v1.schema.json`.
