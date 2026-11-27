-- PROPOSAL ONLY — DO NOT APPLY. 0004 — delivery state machine + append-only attempt history.

create table if not exists automation.automation_deliveries (
  delivery_id     uuid primary key default gen_random_uuid(),
  notification_id uuid not null references automation.automation_notifications(notification_id),
  event_id        uuid not null,
  appointment_id  text,
  recipient_id    uuid not null,
  channel         text not null,
  notification_type text not null,
  idempotency_key text not null,
  status          text not null default 'pending'
                    check (status in ('pending','processing','succeeded','retry_scheduled','failed','dead_letter')),
  attempts        integer not null default 0,
  max_attempts    integer not null default 5,
  next_retry_at   timestamptz,                    -- bounded exponential backoff target
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  claimed_at      timestamptz,                    -- safe claiming lease
  claimed_by      text,
  lease_expires_at timestamptz,
  last_error      text,                           -- sanitized
  last_failure_class text check (last_failure_class in ('transient','permanent')),
  constraint automation_deliveries_idempotency_key_unique unique (idempotency_key)
);

create index if not exists automation_deliveries_due_idx
  on automation.automation_deliveries (status, next_retry_at);
create index if not exists automation_deliveries_claim_idx
  on automation.automation_deliveries (status, lease_expires_at);
-- terminal success is immutable: workers must never reset succeeded rows.

create table if not exists automation.automation_delivery_attempts (
  attempt_id      uuid primary key default gen_random_uuid(),
  delivery_id     uuid not null references automation.automation_deliveries(delivery_id),
  event_id        uuid not null,
  recipient_id    uuid not null,
  attempt         integer not null,               -- 1-based; replay appends, never rewrites
  attempted_at    timestamptz not null default now(),
  outcome         text not null check (outcome in ('succeeded','failed','replay')),
  failure_class   text check (failure_class in ('transient','permanent')),
  error           text,                           -- sanitized, bounded; no secrets/PII
  next_retry_at   timestamptz
);

create index if not exists automation_delivery_attempts_delivery_idx
  on automation.automation_delivery_attempts (delivery_id, attempt);
