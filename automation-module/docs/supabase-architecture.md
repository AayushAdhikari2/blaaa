# Supabase production integration proposal (PREPARATION ONLY — NOT APPLIED)

**No live Supabase calls in V1. No migration applied. No Edge Function deployed. Nothing outside
`automation-module/`. Nothing in this document changes existing Carepulse code or schema.**
SQL proposals: `db/proposals/`. References below are to the **actual Carepulse V4** schema
(`schema.sql`, `schema_v3.sql`, `schema_v4.sql`, `supabase/functions/admin-staff/index.ts`).

Carepulse reality today: `appointments` has **no event-emission mechanism**; **no outbox**;
**no notification tables**; **no retry infrastructure**; **no general audit log**; appointment
conversion is not atomic; etc. (see "Integration risks"). This proposal adds an **automation-owned
`automation` schema** and leaves existing tables untouched.

## Reference: real V4 objects
- `public.appointments(id bigint identity, name, phone, doctor_id text not null→doctors.id, preferred_date date, reason, status default 'requested' check requested|converted|cancelled, created_at timestamptz)`; RLS reception+admin; `request_appointment(...)` SECURITY DEFINER anon+authenticated→void.
- `public.profiles(id uuid→auth.users, full_name, role check reception|doctor|lab|admin, doctor_id→doctors.id)`; `my_role()`.
- V4 `public.doctors.active`; `admin_list_staff()` admin-only security definer. Patient not auth.
- `public.visits`, `public.bill_items`, `public.lookup_attempts`. `register_visit(...)` returns visits; patient_status(bill,code).

## 1. Transactional outbox (`0001`)
`automation.automation_outbox`. `AFTER INSERT` trigger on `public.appointments`, `WHEN (NEW.status='requested')`,
writes one outbox row in the **same transaction**. Only new inserts with status=requested. No events
for updates. Event payload = `{"appointment_id": "<id>"}` only; **no patient name/phone**. Unique
`(event_type, source, source_id)`. Trigger justified + reviewed `SECURITY DEFINER`, pinned search_path,
revoked from public/anon/authenticated. Not added to any existing SQL file; not applied.

## 2. Automation-owned event storage (`0002`)
`automation.automation_events` keyed `event_id`, logical envelope stored, status machine, sanitized
`last_error`, `claimed_*`/lease, `replay_count`. Separate from outbox (outbox=emit; events=process).
Unique event id; duplicate ingestion no-op.

## 3. Per-recipient notification table (`0003`)
`automation.automation_notifications`, `recipient_id→profiles.id`, role reception/admin, `in_app`,
fixed title/body, minimal payload, `idempotency_key` UNIQUE + `UNIQUE(event_id,recipient_id,channel,notification_type)`.
One row per eligible recipient. No patient name/phone/access code. No real patient identity.

## 4. Delivery attempt table (`0004`)
`automation.automation_deliveries` + append-only `automation.automation_delivery_attempts`. State
machine pending→processing→succeeded / retry_scheduled→failed→dead_letter; `attempts/max_attempts`;
`next_retry_at`; `last_error` sanitized; `last_failure_class transient|permanent`; `claimed_*`/lease.
`succeeded` terminal. Attempt history append-only; replay appends. `idempotency_key` UNIQUE.

## 5. Execution log table (`0005`)
`automation.automation_execution_log` append-only (no update/delete triggers + revoked privileges),
safe columns, sanitized `data`, no patient keys; `automation_metrics` view. Mirrors local audit.

## 6. Idempotency constraints
DB-enforced UNIQUE (not app-only): outbox `(event_type,source,source_id)`; events `event_id`;
notifications `idempotency_key` + `(event_id,recipient_id,channel,notification_type)`; deliveries
`idempotency_key`. `INSERT ... ON CONFLICT DO NOTHING`. **At-least-once + idempotent effects; NOT exactly-once.**

## 7. RLS (`0007`)
`automation` schema service-role/worker-only; `revoke all from anon/authenticated/public`; RLS on all
automation tables; append-only log; **no browser access to sensitive tables**; optional documented
reception/admin read-own-notifications policy (not enabled); existing appointment RLS unchanged;
service-role key server-side only.

## 8. Worker authentication
Dedicated trusted server-side worker (Supabase **Edge Function** OR other trusted worker; **not**
reusing `admin-staff`). Least-privilege `automation_worker` role / service-role on server only;
never browser. Worker identity for `claimed_by`. No PII in worker logs. Service-role key in platform
secrets. Future worker reads outbox→writes events→resolves recipients (server `profiles` query,
re-check)→writes notifications→delivers→records attempts→updates status.

## 9. Safe event claiming (`0006`)
`FOR UPDATE SKIP LOCKED` batch claim; worker lease + `lease_expires_at`; expired claims reclaimable;
concurrent workers can't claim same row; atomic claim + unique keys prevent duplicates.
Outbox `status` pending→claimed→published; retry `status='failed'`.

## 10. Retry process (mirrors local)
transient vs permanent; bounded exponential backoff `min(base*2^(n-1), cap)`; `max_attempts`;
`next_retry_at`; sanitized `last_error`; `retry_scheduled`; exhausted→`failed`→`dead_letter`;
permanent→`failed`→`dead_letter`; **manual replay** resets bounded round, preserves history, no
duplicate notifications, never repeats successful deliveries; audit `retry.*`, `dead_letter`, `manual.replay`.
A **trusted server-side scheduled worker** processes due rows. **Local browser timers are NOT
reliable production workers.** Recipient re-checked at processing time.

## 11. Monitoring API (documented; local dashboard implements demo subset)
GET `/health`, `/metrics`, `/events`, `/events/:id`, `/notifications`, `/retries`, `/dead-letter`,
`/executions`, `/audit`; POST retry/replay (trusted admin auth). Metrics: total events, processed,
failed, notification count, pending deliveries, retry count, dead-letter count, success rate,
processing duration. Safe fields only. (Local V1 exposes these under `/api/*` in DEMO MODE.)

## Local V1 adapters vs production
Local `MockStore`(atomic JSON, single-process mutex) / `MockRecipientProvider` / `MockNotificationSink`
/ `EventSimulator`. Production `SupabaseRecipientProvider` / `SupabaseNotificationSink` prepared
(injected trusted-server client; service-role server-only; **no live calls in V1**; proposal SQL not applied).

## Integration risks (documented, NOT fixed — spec section 16)
Do not silently change teammates' files:
1. **Appointment conversion is two steps**: `register_visit()` then a separate `appointments`
   status update to `converted`. Not atomic; no event emitted for Process 01 on conversion; partial
   conversion possible. (Not implemented; not changed.)
2. **No `appointment_id` on `visits`.** Cannot correlate a created visit back to the appointment.
3. **Conversion errors are not checked properly in existing frontend.** Failed `register_visit` /
   status update not surfaced; no rollback. Documented only.
4. **No appointment event history.** No record of appointment lifecycle events.
5. **No automation outbox.** Nothing emits appointment events today (hence V1 synthetic simulator;
   production needs `0001`).
6. **No notification tables.** No in-app/staff notifications exist; proposal adds automation-owned ones.
7. **No retry infrastructure.** No queue/DLQ/retry scheduling; proposal adds automation-owned ones.
8. **No general audit log.** `lookup_attempts` is patient-portal rate limiting, not automation audit;
   proposal adds append-only `automation_execution_log`.
9. **`reports` storage bucket is public** (`schema_v3.sql`: `insert into storage.buckets ... public=true`)
   despite roadmap "private signed links" + private-upload policy. Documented; not modified.
10. **Database setup documentation contains inconsistencies.** e.g. `schema.sql` "run once" vs
    `schema_v3.sql` "safe to run once" vs `schema_v4.sql` "safe to re-run"; `setup.sql` claims "same
    as schema.sql + schema_v3.sql"; `schema_v4.sql` says run after schema+v3 or setup; main repo vs
    separate V4 package not merged; schema wording re: reports public vs private links. A reviewed
    canonical migration order should be established. Not fixed.

## Remaining decisions for reviewers
- Apply order + review of proposal SQL against live project; exact `automation_worker` role grants.
- Worker hosting (Edge Function vs external), scheduling cadence, lease duration, batch size.
- Whether to enable optional staff read-own-notifications policy for future UI.
- Retention/archival of events + execution log; PII policy; backoff/jitter in production.
- Confirm `request_appointment` already emits nothing; confirm production doctor seed + `profiles`.
- Decide remediation for integration risks 1–10 separately (owned by respective teams).
