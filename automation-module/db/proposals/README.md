# Production database proposal (NOT APPLIED)

Everything in this directory is a **proposal** for review. **Do not apply.** No migration is
run against any database. Nothing here modifies existing Carepulse schema; automation-owned
objects live in a separate `automation` schema. References use the **actual Carepulse V4
schema** (`schema.sql` + `schema_v3.sql` + `schema_v4.sql`; `appointments`, `profiles`,
`doctors`, `visits`, `bill_items`, `lookup_attempts`, `my_role()`, roles
reception/doctor/lab/admin).

- `0001_transactional_outbox.sql` — automation-owned outbox + `AFTER INSERT` trigger on `public.appointments`.
- `0002_automation_event_store.sql` — durable event storage + status + claiming fields.
- `0003_notifications.sql` — per-recipient in-app notifications + idempotency.
- `0004_delivery_queue.sql` — delivery state machine + append-only attempt history.
- `0005_execution_log.sql` — append-only audit.
- `0006_safe_claiming.sql` — `FOR UPDATE SKIP LOCKED` claim functions.
- `0007_rls.sql` — row-level security + privileges for automation tables.

See `docs/supabase-architecture.md`.
