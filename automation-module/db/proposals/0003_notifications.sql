-- PROPOSAL ONLY — DO NOT APPLY. 0003 — per-recipient in-app notifications + idempotency.

create table if not exists automation.automation_notifications (
  notification_id  uuid primary key default gen_random_uuid(),
  event_id         uuid not null,
  appointment_id   text not null,                 -- correlation; appointments.id::text (bigint→text)
  recipient_id     uuid not null,                 -- profiles.id (Supabase Auth); re-checked eligible
  recipient_role   text not null check (recipient_role in ('reception','admin')),
  channel          text not null default 'in_app' check (channel in ('in_app')),  -- V1 mock/local; no email/SMS/WhatsApp
  notification_type text not null default 'appointment.requested',
  title            text not null,                 -- 'New appointment request'; no patient data
  body             text not null,                 -- fixed copy; no patient name/phone; no access code
  payload          jsonb not null,                -- {event_id, appointment_id, notification_type, created_at}
  created_at       timestamptz not null default now(),
  delivery_status  text not null default 'pending'
                     check (delivery_status in ('pending','processing','succeeded','retry_scheduled','failed','dead_letter')),
  -- IDEMPOTENCY, hard-enforced at the storage layer (spec section 9):
  idempotency_key  text not null,                 -- event_id|recipient_id|channel|notification_type
  constraint automation_notifications_idempotency_key_unique unique (idempotency_key),
  constraint automation_notifications_unique
    unique (event_id, recipient_id, channel, notification_type)
);

create index if not exists automation_notifications_event_idx on automation.automation_notifications (event_id);
create index if not exists automation_notifications_recipient_idx on automation.automation_notifications (recipient_id, created_at);

-- recipient must be a real staff profile in an eligible role at insert time (proposal-level note):
-- worker re-checks `profiles.role in ('reception','admin')` immediately before insert; FK below optional.
-- alter table automation.automation_notifications
--   add constraint automation_notifications_recipient_fk foreign key (recipient_id) references public.profiles(id);
