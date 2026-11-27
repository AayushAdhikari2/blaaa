-- =============================================================================
-- PROPOSAL ONLY — DO NOT APPLY. No migration. Nothing outside automation-module/.
-- 0001 — Transactional outbox for appointment.requested (spec section 8)
--
-- Goal: the appointment INSERT and the corresponding outbox event are recorded in the
-- SAME database transaction. Worker polls outbox separately; local V1 never claims
-- exactly-once. Delivery is at-least-once + idempotent processing.
--
-- Uses the real Carepulse V4 table public.appointments
--   (id bigint identity pk, name, phone, doctor_id text not null, preferred_date date,
--    reason, status text not null default 'requested'
--    check (status in ('requested','converted','cancelled')), created_at timestamptz).
-- Does NOT modify public.appointments. Does NOT touch any existing SQL file.
-- =============================================================================

create schema if not exists automation;

create table if not exists automation.automation_outbox (
  event_id        uuid primary key default gen_random_uuid(),
  event_type      text not null,                          -- 'appointment.requested'
  schema_version  integer not null default 1,
  source          text not null default 'public.appointments',
  source_id       text not null,                          -- appointments.id::text
  occurred_at     timestamptz not null default now(),
  payload         jsonb not null,                         -- {"appointment_id": "<id>"} ONLY; no patient data
  status          text not null default 'pending'
                    check (status in ('pending','claimed','published','failed')),
  attempts        integer not null default 0,
  claimed_at      timestamptz,
  claimed_by      text,
  lease_expires_at timestamptz,
  last_error      text,                                   -- sanitized; no secrets/PII
  created_at      timestamptz not null default now(),
  -- hard idempotency: one appointment.requested per appointment row
  constraint automation_outbox_appointment_requested_once
    unique (event_type, source, source_id)
);

create index if not exists automation_outbox_pending_idx
  on automation.automation_outbox (status, created_at)
  where status in ('pending','failed');

-- ---------------------------------------------------------------------------
-- Trigger: emit appointment.requested ONLY for NEW appointment rows with status='requested'.
-- NOT emitted for appointment updates (e.g. requested→converted/cancelled, reception edits).
-- Same transaction as the appointments INSERT: if either fails, both roll back.
-- ---------------------------------------------------------------------------
create or replace function automation.emit_appointment_requested()
returns trigger
language plpgsql
security definer                         -- justified: writer (anon via request_appointment,
                                         -- reception/admin) lacks automation-schema privileges;
set search_path = public, automation     -- automation tables are service-role-only (see 0007).
as $$
begin
  insert into automation.automation_outbox
    (event_id, event_type, schema_version, source, source_id, occurred_at, payload)
  values
    (gen_random_uuid(), 'appointment.requested', 1, 'public.appointments',
     NEW.id::text, now(), jsonb_build_object('appointment_id', NEW.id::text));
  return NEW;
end;
$$;

-- No appointment data besides the id is captured. Name/phone/reason are NOT copied.
revoke all on function automation.emit_appointment_requested() from public, anon, authenticated;

drop trigger if exists appointments_emit_requested on public.appointments;
create trigger appointments_emit_requested
  after insert on public.appointments
  for each row
  when (NEW.status = 'requested')
  execute function automation.emit_appointment_requested();

-- NOTE on SECURITY DEFINER (required review): the trigger must write to an automation-owned
-- table that normal writers cannot access; search_path is pinned; function EXECUTE revoked
-- from public/anon/authenticated; it only reads NEW.id; it cannot be called directly.
-- request_appointment(...) is ALREADY security definer in Carepulse; we do not alter it.
