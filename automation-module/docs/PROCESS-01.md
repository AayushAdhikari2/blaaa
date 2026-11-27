# Process 01 — appointment.requested

## Trigger / source
`INSERT` into `public.appointments` with `status='requested'`. In Carepulse, appointments are
created via `request_appointment(p_name,p_phone,p_doctor,p_date,p_reason)` (SECURITY DEFINER,
anon + authenticated, returns void, status `requested`, **no event-emission mechanism**).
**V1 local** uses a synthetic `EventSimulator`. **Production** requires a transactional outbox
trigger in the *proposal* (`db/proposals/0001`); nothing is added to existing SQL; no migration applied.

Only new appointment inserts with status `requested` produce events. Not emitted for appointment
updates (e.g. requested→converted/cancelled) or unrelated appointment changes.

## Event
`appointment.requested` v1 (`contracts/`). Envelope carries only `payload.appointment_id`
(= `appointments.id`, bigint → decimal string). appointment_id is the correlation identifier.
No patient_id. No scheduled_start. `preferred_date` is date-only and excluded. No patient
name/phone. Recipients never supplied by browser.

## Recipients
Production: `profiles` where `role in ('reception','admin')`; `profiles.id` (Supabase Auth UUID);
trusted server-side query (service-role, server-only); eligibility re-checked at processing time.
**One in-app notification per eligible staff profile.**

Never recipients: doctors (`role='doctor'`), laboratory (`role='lab'`), anonymous users, patients.
**Doctor notification** belongs to a later separate workflow after reception registration + final
doctor assignment. **Patient notification** belongs to a future workflow; patients have no
authenticated notification identity (bill + six-digit code is not auth).

## Notification (recipient-specific, in-app, mock/local V1)
- Title: `New appointment request`
- Body: `A new online appointment request requires reception review.`
- Payload: `event_id`, `appointment_id`, `notification_type`, `created_at`
- No patient name/phone/access code. No email/SMS/WhatsApp.
- Staff identify the request in existing Carepulse after future approved UI integration.

## Idempotency
key = `event_id + recipient_id + channel + notification_type` (`in_app` + `appointment.requested`).
Event-level dedupe on `event_id`. Per-recipient + per-delivery uniqueness. Duplicate event,
duplicate recipient, concurrent processing, replay, previously-succeeded → skipped. Storage-layer
uniqueness in proposal.

## Reliability
Per-recipient partial success; failed recipients retried independently; successful recipients not
repeated; transient/permanent; bounded exponential backoff; max attempts (default 5); retry
timestamps; sanitized errors; manual retry + replay; append-only attempt history + audit.

## Audit (append-only, sanitized)
event.received · event.validation · recipients.resolved · notification.created ·
notification.duplicate_skipped · delivery.attempt · delivery.result · retry.attempt ·
retry.scheduled · event.failed · delivery.failed · dead_letter · manual.replay · event.duplicate ·
event.rejected · recipient.skipped · dry_run. No patient names/phones/codes/passwords/tokens/secrets.

## Not in Process 01
No doctor notification. No patient notification. No appointment conversion handling (see integration
risks). No Process 02. No AI.
